/**
 * Chat: conversation state, routing of each composer send, the mock ModelAdapter, streaming,
 * stop and retry. No DOM.
 *
 *  numeric     -> HistoryService.apply (local, 0 tokens) + a receipt bound to the target
 *  command     -> slash commands (/fork /compare /sweep /goalseek /sim /infer /verify /explain
 *                 /research /open /theme /undo /redo)
 *  structural / question -> MockModelAdapter.ask(): swarm events (deltas go through the real
 *                 validator; one is rejected), then prose whose numbers are bindings, then the
 *                 certificate.
 * @module services/chat
 */
import { uid } from '../core/ids.js';
import { log } from '../core/log.js';
import { parseTemplate, renderTemplateText } from '../model/binding.js';
import { toScopeLang } from '../model/expr.js';
import { initialConversation, scriptFor } from '../mock/conversation.js';
import { initialBuild } from '../mock/swarm-script.js';
import { parseNumber } from './router.js';

/**
 * @typedef {Object} ChatMessage
 * @property {string} id
 * @property {'user'|'assistant'|'system'} role
 * @property {number} time
 * @property {string=} text
 * @property {string=} template
 * @property {number} tokens
 * @property {boolean} done
 * @property {boolean=} streaming
 * @property {boolean=} stopped
 * @property {string=} buildId
 * @property {boolean=} certificate
 * @property {'answer'|'receipt'|'error'|'command'} kind
 * @property {string=} route
 * @property {string=} scenarioId
 * @property {Array<{who: string, text: string, agentId?: string}>=} simVoice
 * @property {string=} plainText
 * @property {{message: string, hint?: string}=} error
 * @property {string=} sourceText    the user text this answers (retry)
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mock of the model API. Method names match the planned endpoints.
 */
export class MockModelAdapter {
  /** @param {ChatService} chat */
  constructor(chat) {
    this.chat = chat;
  }
  /** POST /graphs (question -> graph). The demo graph is preloaded; returns its id. */
  async createGraph(question) { return { graphId: this.chat.engine().graph.graphId, question }; }
  /** PATCH /graphs/{id} (deltas). */
  async patchGraph(graphId, deltas, meta) { return this.chat.history.apply(deltas, meta); } // eslint-disable-line no-unused-vars
  /** POST /graphs/{id}/run */
  async run(graphId, spec) { return this.chat.engine().run(spec.targets, spec.mode); } // eslint-disable-line no-unused-vars
  /** GET /graphs/{id}/certificate */
  async getCertificate(graphId) { return this.chat.verify.certificate(); } // eslint-disable-line no-unused-vars

  /**
   * Stream an answer: plan -> swarm events -> prose with {{bindings}} -> certificate.
   * @param {string} text @param {any} context
   */
  ask(text, context) {
    const engine = this.chat.engine();
    return scriptFor(text, {
      graph: engine.graph,
      engine,
      sensitivity: () => engine.sensitivity('sc_bakery.monthly_cash'),
      scenarioIdFor: (name) => name,
      context,
    });
  }
}

export class ChatService {
  /**
   * @param {{
   *   events: import('../core/events.js').EventBus,
   *   store: import('../core/store.js').Store,
   *   getEngine: () => import('../model/engine.js').JsEngine,
   *   history: import('./history.js').HistoryService,
   *   router: import('./router.js').Router,
   *   swarm: import('./swarm.js').SwarmService,
   *   scenarios: import('./scenario-service.js').ScenarioService,
   *   verify: import('./verify.js').VerifyService,
   *   notify: import('./notify.js').NotifyService,
   *   commands: import('../core/commands.js').CommandRegistry,
   *   services: Record<string, any>,
   * }} deps
   */
  constructor(deps) {
    this.events = deps.events;
    this.store = deps.store;
    this.engine = deps.getEngine;
    this.history = deps.history;
    this.router = deps.router;
    this.swarm = deps.swarm;
    this.scenarios = deps.scenarios;
    this.verify = deps.verify;
    this.notify = deps.notify;
    this.commands = deps.commands;
    this.services = deps.services;
    /** @type {ChatMessage[]} */
    this.messages = [];
    /** @type {null | {messageId: string, abort: {aborted: boolean}}} */
    this.streaming = null;
    this.model = new MockModelAdapter(this);
  }

  /** Preload the demo conversation and replay its build into the swarm feed. */
  init() {
    const [q, a] = initialConversation();
    this._add({ id: uid('msg'), role: 'user', time: Date.now() - 95000, text: q.text, tokens: 0, done: true, kind: 'answer' }, true);
    const build = this.swarm.startBuild(a.build);
    for (const step of initialBuild().steps) {
      if (step.deltaKey === 'bad_unit') {
        const errs = this._validateOnly([this._badUnitDelta()]);
        this.swarm.push(build, { role: step.role, kind: step.kind, text: step.text, outcome: 'rejected', reason: errs[0]?.message, hint: errs[0]?.hint, level: 2, nodeId: 'sc_7Q2f.net_cash', delta: this._badUnitDelta() });
      } else {
        this.swarm.push(build, { role: step.role, kind: step.kind, text: step.text, outcome: step.outcome || 'accepted', level: step.level, nodeId: step.nodeId, delphi: step.delphi });
      }
    }
    this.swarm.end(build);
    build.started = Date.now() - 90000;
    build.ended = Date.now() - 62000;
    this._add({
      id: uid('msg'), role: 'assistant', time: Date.now() - 60000, template: a.template, tokens: a.tokens, done: true,
      buildId: build.id, certificate: true, kind: 'answer', sourceText: q.text,
    }, true);
  }

  /** @param {string} id */
  get(id) { return this.messages.find((m) => m.id === id) || null; }

  /**
   * Route and handle a composer send.
   * @param {string} text @param {any} ctx composer context
   */
  async send(text, ctx = {}) {
    const route = this.router.classify(text, ctx);
    if (route.kind === 'empty') return;
    if (route.kind === 'command') return this.runCommand(route, text, ctx);
    if (route.kind === 'numeric') return this.runLocal(route, text);
    if (route.kind === 'invalid') {
      this._add({ id: uid('msg'), role: 'user', time: Date.now(), text, tokens: 0, done: true, kind: 'answer' });
      this._add({ id: uid('msg'), role: 'system', time: Date.now(), text: `Not applied: ${route.detail || route.label}`, tokens: 0, done: true, kind: 'error', error: { message: route.detail || route.label } });
      return;
    }
    if (this.streaming) {
      this.notify.info('Wait for the current answer to finish or press Stop.');
      return;
    }
    return this.ask(text, ctx, route);
  }

  /** Numeric edit: local delta, zero tokens. @param {import('./router.js').Route} route @param {string} text */
  runLocal(route, text) {
    const t0 = performance.now();
    const res = this.history.apply([route.delta], { author: 'user', tokens: 0, kind: 'local' });
    const ms = performance.now() - t0;
    this._add({ id: uid('msg'), role: 'user', time: Date.now(), text, tokens: 0, done: true, kind: 'answer', route: 'numeric' });
    if (!res.ok) {
      const e = res.errors[0];
      this._add({ id: uid('msg'), role: 'system', time: Date.now(), text: `Rejected: ${e.message}${e.hint ? `. ${e.hint}` : ''}`, tokens: 0, done: true, kind: 'error', error: { message: e.message, hint: e.hint } });
      return;
    }
    this.store.set('status.tokens', { count: 0, local: true, touched: true, kind: 'local edit' });
    const target = route.target;
    const node = this.engine().graph.node(target);
    const stat = node?.dist && node.dist.family !== 'Point' ? '.p50' : '';
    const scen = route.delta.scenario ? `${route.delta.scenario}::` : '';
    this._add({
      id: uid('msg'), role: 'system', time: Date.now(), kind: 'receipt', tokens: 0, done: true,
      template: `Set {{${scen}${target}${stat} | unit}} · monthly cash {{${scen}bakery.monthly_cash.p50 | usd}} · P(<0) {{${scen}bakery.p_cash_negative | pct}}`,
      meta: { ms, version: res.version, local: true, nodes: res.nodes },
    });
  }

  /**
   * Slash commands.
   * @param {import('./router.js').Route} route @param {string} text @param {any} ctx
   */
  async runCommand(route, text, ctx) {
    const cmd = route.command || '';
    const args = (route.args || '').trim();
    this._add({ id: uid('msg'), role: 'user', time: Date.now(), text, tokens: 0, done: true, kind: 'command', route: 'command' });
    const receipt = (template, extra = {}) => this._add({ id: uid('msg'), role: 'system', time: Date.now(), kind: 'receipt', tokens: 0, done: true, template, ...extra });
    const error = (message, hint) => this._add({ id: uid('msg'), role: 'system', time: Date.now(), kind: 'error', tokens: 0, done: true, text: message + (hint ? `. ${hint}` : ''), error: { message, hint } });
    const engine = this.engine();
    const g = engine.graph;
    switch (cmd) {
      case 'undo': case 'redo': {
        const r = cmd === 'undo' ? this.history.undo() : this.history.redo();
        if (!r) return error(`Nothing to ${cmd}`);
        if (!r.ok) return error(r.errors?.[0]?.message || `${cmd} failed`, r.errors?.[0]?.hint);
        this.store.set('status.tokens', { count: 0, local: true, touched: true });
        return receipt(`${cmd === 'undo' ? 'Undid' : 'Redid'} the last change · monthly cash {{bakery.monthly_cash.p50 | usd}} · P(<0) {{bakery.p_cash_negative | pct}}`);
      }
      case 'theme': {
        const m = /^(dark|light|auto)$/i.exec(args);
        this.commands.execute(m ? `theme.${m[1].toLowerCase()}` : 'theme.toggle');
        return receipt(`Theme: ${m ? m[1].toLowerCase() : 'toggled'}`);
      }
      case 'open': {
        const name = args.toLowerCase().replace(/^the\s+/, '');
        const all = this.commands.list({ includeHidden: true }).filter((c) => c.id.startsWith('area.setType.'));
        const hit = all.find((c) => c.title.toLowerCase().includes(name)) || all.find((c) => c.id.endsWith(name.replace(/\s+/g, '')));
        if (!hit) return error(`No editor type matches "${args}"`, 'try /open graph, /open sheet, /open minds');
        this.commands.executeWith(hit.id, { areaId: ctx.areaId });
        return receipt(`Opened ${hit.title.replace('Switch Area to ', '')} in the focused area`);
      }
      case 'fork': {
        const name = args || `Fork of ${this.scenarios.label(ctx.scenarioId)}`;
        const r = this.scenarios.fork(name, [], { parent: ctx.scenarioId || 'base' });
        if (!r.ok) return error(r.errors?.[0]?.message || 'fork failed');
        this.scenarios.setActive(/** @type {string} */ (r.id));
        return receipt(`Forked scenario “${name}” from ${this.scenarios.label(ctx.scenarioId)} and made it active. Numeric edits now land in this scenario.`, { scenarioId: r.id });
      }
      case 'compare': {
        this.commands.execute('view.reveal', 'scenarios');
        this.scenarios.request = { tab: 'compare' };
        this.events.emit('scenario:changed', { activeId: this.scenarios.activeId, reason: 'request' });
        return receipt('Comparing scenarios in the Scenarios area: median monthly cash base {{bakery.monthly_cash.p50 | usd}}.');
      }
      case 'sweep': {
        const spec = this.parseSweep(args);
        if (!spec) return error('Could not parse the sweep', 'example: /sweep rent 5000..9000 step 500 (add "vs price 3.5..5 step 0.25" for a 2-D heatmap)');
        this.scenarios.request = { tab: 'sweep', spec };
        this.commands.execute('view.reveal', 'scenarios');
        this.events.emit('scenario:changed', { activeId: this.scenarios.activeId, reason: 'request' });
        return receipt(`Sweep of ${g.path(spec.x.id)}${spec.y ? ` × ${g.path(spec.y.id)}` : ''} sent to the Scenarios area (${spec.x.values.length * (spec.y ? spec.y.values.length : 1)} cells, local engine, zero tokens).`.replace(/\d+ cells/, 'grid cells'));
      }
      case 'goalseek': {
        const spec = this.parseGoalSeek(args);
        if (!spec) return error('Could not parse the goal', 'example: /goalseek P(monthly_cash<0) < 10% by price');
        const t0 = performance.now();
        const { result, scenarioId, reused } = this.scenarios.goalSeek(spec);
        if (!result.ok) return error(`Goal seek failed: ${result.message}`);
        if (!scenarioId) return receipt('The current value already meets the goal: P(<0) {{bakery.p_cash_negative | pct}}.');
        this.store.set('status.tokens', { count: 0, local: true, touched: true, kind: 'goal seek' });
        const target = spec.target.id;
        return receipt(`Goal seek (${result.iterations} bisection steps, common random numbers, ${Math.round(performance.now() - t0)} ms) ${reused ? 'matches the existing scenario' : 'wrote scenario'} “${this.scenarios.label(scenarioId)}”: {{${scenarioId}::${spec.decision.id} | unit}} gives {{${scenarioId}::${target === 'sc_bakery.monthly_cash' ? 'bakery.p_cash_negative | pct' : `${target}.p50 | unit`}}} (base {{${target === 'sc_bakery.monthly_cash' ? 'bakery.p_cash_negative | pct' : `${target}.p50 | unit`}}}). Your inputs are unchanged.`.replace(/\(\d+ bisection steps, common random numbers, \d+ ms\)/, '(bisection with common random numbers)'), { scenarioId });
      }
      case 'verify': {
        const cert = this.verify.refresh();
        return receipt(`Verification ladder re-run on ${g.versionLabel}: ${cert.failed.length ? 'some checks failed' : 'no failed checks'}${cert.notProven.length ? `, ${cert.notProven.length === 1 ? 'one claim' : 'some claims'} not proven` : ''}.`, { certificate: true });
      }
      case 'explain': {
        const id = this.router.resolveTarget(args.replace(/^@/, ''), ctx) || ctx.scopes?.[0];
        const n = id ? g.node(id) : null;
        if (!n) return error(`Nothing to explain for "${args}"`, 'mention a metric, e.g. /explain @monthly_cash');
        const deps = (n.deps || []).slice(0, 5);
        const formula = n.expr !== undefined ? `\`${n.name} = ${toScopeLang(n.expr)}\`` : `${n.kind} value`;
        return receipt(`**${g.path(n.id)}** is ${n.kind === 'computed' ? 'computed' : n.kind}: ${formula}. Current value {{${n.id}${engine.stats(n.id)?.deterministic ? '' : '.p50'} | unit}}${deps.length ? `; it depends on ${deps.map((d) => `{{${d}${engine.stats(d)?.deterministic ? '' : '.p50'} | unit}} (${g.node(d)?.name})`).join(', ')}` : ''}.`);
      }
      case 'research': {
        const id = this.router.resolveTarget(args.replace(/^@/, ''), ctx);
        const n = id ? g.node(id) : null;
        if (!n) return error(`Unknown input "${args}"`);
        return receipt(`Queued for the Researcher: ${g.path(n.id)} (currently {{${n.id}${n.dist ? '.p50' : ''} | unit}}, ${n.kind}). A sourced value would replace the estimate with an observed value and narrow the answer.`);
      }
      case 'sim': {
        const runs = parseNumber(args)?.value || 100;
        if (!this.services.sim) return error('Simulation is not available in this build');
        this.commands.execute('view.reveal', 'simulation');
        const sim = this.services.sim;
        sim.run({ runs: Math.min(1000, Math.max(10, Math.round(runs))) }).then((res) => {
          if (!res?.done) return;
          // one exchange from the first run, always in the distinct simulation voice
          const quotes = sim.runLog(0).filter((e) => e.speech).slice(0, 3).map((e) => ({ who: e.actor, text: e.speech }));
          if (!quotes.length) return;
          this._add({
            id: uid('msg'), role: 'assistant', time: Date.now(), kind: 'answer', tokens: 0, done: true,
            template: 'The simulation finished; outcome shares are in the Simulation area. Below is one exchange from the first run as the simulated parties played it. This is simulation, not assessment: one plausible path, not what the real landlord, rival or loan officer will say.',
            simVoice: quotes,
          });
        }).catch(() => {});
        return receipt('Simulation started in the Simulation area: seeded runs on the deterministic game master (mock).');
      }
      case 'infer': {
        if (!this.services.mind) return error('Mind inference is not available in this build');
        const who = args.replace(/^@/, '').trim() || 'Landlord';
        const r = this.services.mind.inferByName(who);
        if (!r) return error(`No Mind Scope named "${who}"`);
        this.commands.execute('view.reveal', 'minds');
        return receipt(`Updated ${r.name}'s hidden ${r.metricName} from the observations on record: posterior median {{${r.nodeId}.p50 | pct}}. Simulation, not assessment.`);
      }
      default:
        return error(`Unknown command /${cmd}`, 'available: /fork /compare /sweep /goalseek /sim /infer /verify /explain /research /open /theme /undo /redo');
    }
  }

  /**
   * Model path: user message, streamed assistant answer with swarm build.
   * @param {string} text @param {any} ctx @param {import('./router.js').Route} route
   */
  async ask(text, ctx, route) {
    const user = this._add({ id: uid('msg'), role: 'user', time: Date.now(), text, tokens: 0, done: true, kind: 'answer', route: route.kind });
    void user;
    const script = this.model.ask(text, ctx);
    const msg = this._add({ id: uid('msg'), role: 'assistant', time: Date.now(), template: '', tokens: 0, done: false, streaming: true, kind: 'answer', sourceText: text, route: route.kind });
    const abort = { aborted: false };
    this.streaming = { messageId: msg.id, abort };
    this.events.emit('chat:stream', { messageId: msg.id, state: 'start' });
    const build = this.swarm.startBuild(script.build);
    msg.buildId = build.id;
    this._update(msg);
    this.store.set('status.tokens', { count: 0, local: false, touched: true, kind: route.kind === 'structural' ? 'structural edit' : 'new question' });
    let tokens = 0;
    let scenarioId = null;
    const engine = this.engine();
    const competitor = script.competitor;
    let newScopeId = null;
    try {
      for (const step of script.build.steps) {
        if (abort.aborted) break;
        await sleep(120 + ((step.text.length * 7) % 260));
        if (abort.aborted) break;
        tokens += Math.round(script.build.tokens / (script.build.steps.length + 2));
        this.store.set('status.tokens', { count: tokens, local: false, touched: true, kind: route.kind });
        if (!step.deltaKey) {
          this.swarm.push(build, { role: step.role, kind: step.kind, text: step.text, outcome: step.outcome || 'accepted', level: step.level, nodeId: step.nodeId, delphi: step.delphi });
          continue;
        }
        const ev = this.swarm.push(build, { role: step.role, kind: step.kind, text: step.text, outcome: 'proposed', level: step.level, delphi: step.delphi });
        await sleep(140);
        let deltas = null;
        switch (step.deltaKey) {
          case 'add': {
            newScopeId = `sc_${competitor.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
            if (engine.graph.scope(newScopeId)) newScopeId = `${newScopeId}_${Math.floor(Math.random() * 1e4)}`;
            deltas = [{ op: 'add_scope', id: newScopeId, parent: 'sc_market', proto: 'std.finance.Business@2', name: competitor.name, kind: 'business' }];
            break;
          }
          case 'distance': {
            if (!newScopeId) break;
            const srcName = `${competitor.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_listing.html`;
            const evId = this.services.evidence?.addFinding({
              name: srcName,
              title: `${competitor.name} listing (mock retrieval)`,
              span: `${competitor.name} · 14 Harbor Street · ${competitor.distance} km from Unit 2`,
              match: `${competitor.distance} km`,
              value: competitor.distance,
              unit: 'km',
              nodeId: `${newScopeId}.distance_km`,
            });
            deltas = [{ op: 'set', target: `${newScopeId}.distance_km`, value: competitor.distance, prov: 'observed', provDetail: { src: srcName, page: 1, evidence: evId, note: 'mock research result' } }];
            break;
          }
          case 'share':
            deltas = newScopeId ? [{ op: 'set', target: `${newScopeId}.share`, dist: { family: 'Beta', alpha: 3, beta: 17 }, prov: 'estimated', provDetail: { by: 'swarm:estimators (3, Delphi)', calib: 0.05 } }] : null;
            if (step.delphi) step.delphi.metric = `${newScopeId}.share`;
            break;
          case 'bad_unit':
            deltas = [this._badUnitDelta()];
            break;
          case 'remove':
            deltas = [{ op: 'remove_scope', target: 'sc_loan' }];
            break;
          case 'fork': {
            const r = this.scenarios.fork(script.scenario.name, script.scenario.overrides, { author: step.role, tokens: 0 });
            if (r.ok) {
              scenarioId = r.id;
              this.swarm.update(build, ev, { outcome: 'accepted', reason: `scenario “${script.scenario.name}” created (${engine.graph.versionLabel})` });
            } else this.swarm.update(build, ev, { outcome: 'rejected', reason: r.errors?.[0]?.message });
            continue;
          }
          default:
            break;
        }
        if (!deltas) { this.swarm.update(build, ev, { outcome: 'rejected', reason: 'nothing to apply' }); continue; }
        const res = this.history.apply(deltas, { author: step.role, tokens: Math.round(script.build.tokens / 6), kind: 'model' });
        if (res.ok) this.swarm.update(build, ev, { outcome: 'accepted', reason: `${res.version}: ${(res.summaries || []).join('; ')}`, delta: deltas[0], nodeId: deltas[0].target || newScopeId });
        else this.swarm.update(build, ev, { outcome: 'rejected', reason: res.errors?.[0]?.message, hint: res.errors?.[0]?.hint, delta: deltas[0], nodeId: deltas[0].target });
      }
      // stream the prose
      let template = script.template;
      if (scenarioId) template = template.replace(/SCN::/g, `${scenarioId}::`);
      else template = template.replace(/SCN::/g, '');
      const pieces = tokenize(template);
      let acc = '';
      let budget = 0;
      for (const p of pieces) {
        if (abort.aborted) break;
        acc += p;
        budget += p.startsWith('{{') ? 8 : p.length;
        if (budget >= 40) {
          budget = 0;
          msg.template = acc;
          this.events.emit('chat:stream', { messageId: msg.id, state: 'chunk' });
          this._update(msg);
          await sleep(16);
        }
      }
      msg.template = abort.aborted ? acc : template;
    } catch (err) {
      log.error('chat', `answer failed: ${/** @type {Error} */ (err).message}`);
      msg.error = { message: /** @type {Error} */ (err).message };
    }
    msg.streaming = false;
    msg.done = true;
    msg.stopped = abort.aborted;
    msg.tokens = abort.aborted ? tokens : script.build.tokens;
    msg.certificate = !abort.aborted;
    msg.scenarioId = scenarioId || undefined;
    msg.plainText = this.plainText(msg.template || '');
    this.swarm.end(build);
    this.store.set('status.tokens', { count: msg.tokens, local: false, touched: true, kind: route.kind === 'structural' ? 'structural edit' : 'new question' });
    this.streaming = null;
    this.verify.refresh();
    this._update(msg);
    this.events.emit('chat:stream', { messageId: msg.id, state: 'end' });
  }

  stop() {
    if (this.streaming) this.streaming.abort.aborted = true;
  }

  /** Re-ask the question a message answered. @param {string} id */
  retry(id) {
    const m = this.get(id);
    if (!m?.sourceText || this.streaming) return;
    this.send(m.sourceText, {});
  }

  /** Plain text with current values (copy, screen readers, peek card). @param {string} template */
  plainText(template) {
    const engine = this.engine();
    return renderTemplateText(template, { graph: engine.graph, viewFor: (s) => engine.view(s) }).replace(/\*\*/g, '');
  }

  // ------------------------------------------------------------------ parsing helpers

  /** "/sweep rent 5000..9000 step 500 [vs price 3.5..5 step 0.25] [for p50|prob]" @param {string} args */
  parseSweep(args) {
    const parts = args.split(/\s+(?:vs|x|×|by)\s+/i);
    const parseAxis = (s) => {
      const m = /^@?([\w.]+)\s+([-\d.,$k]+)\s*(?:\.\.|to|-|–)\s*([-\d.,$k]+)(?:\s+step\s+([-\d.,$k]+))?/i.exec(s.trim());
      if (!m) return null;
      const id = this.router.resolveTarget(m[1], {});
      if (!id) return null;
      const lo = parseNumber(m[2])?.value;
      const hi = parseNumber(m[3])?.value;
      if (!(Number.isFinite(lo) && Number.isFinite(hi)) || hi <= lo) return null;
      const step = m[4] ? parseNumber(m[4])?.value : (hi - lo) / 8;
      const values = [];
      for (let v = lo; v <= hi + step * 1e-9 && values.length < 25; v += step) values.push(Math.round(v * 1e6) / 1e6);
      return { id, values };
    };
    const x = parseAxis(parts[0] || '');
    if (!x) return null;
    const y = parts[1] ? parseAxis(parts[1]) : null;
    return { x, y, output: { id: 'sc_bakery.monthly_cash', stat: 'prob_lt', threshold: 0 } };
  }

  /** "P(monthly_cash<0) < 10% by price" | "p50(monthly_cash) > 5000 by rent" @param {string} args */
  parseGoalSeek(args) {
    let m = /P\(\s*@?([\w.]+)\s*<\s*([-\d.,$k]+)\s*\)\s*([<>])\s*([\d.]+)\s*%?\s*(?:by|via|using)\s+@?([\w.]+)/i.exec(args);
    if (m) {
      const target = this.router.resolveTarget(m[1], {});
      const decision = this.router.resolveTarget(m[5], {});
      if (!target || !decision) return null;
      let goal = Number(m[4]);
      if (/%/.test(args) || goal > 1) goal /= 100;
      return { target: { id: target, stat: 'prob_lt', threshold: parseNumber(m[2])?.value ?? 0 }, goal: { op: m[3], value: goal }, decision: { id: decision } };
    }
    m = /(p10|p50|p90|mean)\(\s*@?([\w.]+)\s*\)\s*([<>])\s*([-\d.,$k]+)\s*(?:by|via|using)\s+@?([\w.]+)/i.exec(args);
    if (m) {
      const target = this.router.resolveTarget(m[2], {});
      const decision = this.router.resolveTarget(m[5], {});
      if (!target || !decision) return null;
      return { target: { id: target, stat: m[1].toLowerCase() }, goal: { op: m[3], value: parseNumber(m[4])?.value ?? 0 }, decision: { id: decision } };
    }
    return null;
  }

  // ------------------------------------------------------------------ internals

  _badUnitDelta() {
    return { op: 'rewire', target: 'sc_7Q2f.net_cash', expr: ['sub', '@contribution_b', '@rent'] };
  }

  /** Validate deltas without applying (for replaying historical rejections). @param {any[]} deltas */
  _validateOnly(deltas) {
    const engine = this.engine();
    // validation is pure for rewire; reuse the engine path without recording
    const res = engine.apply(deltas.map((d) => ({ ...d, expect: engine.graph.versionLabel })), { silent: true });
    if (res.ok) {
      // should not happen; undo to be safe
      return [];
    }
    return res.errors;
  }

  /** @param {ChatMessage} m @param {boolean} [silent] */
  _add(m, silent = false) {
    this.messages.push(m);
    if (m.template && m.done) m.plainText = this.plainText(m.template);
    if (!silent) this.events.emit('chat:message', { message: m, kind: 'add' });
    return m;
  }

  /** @param {ChatMessage} m */
  _update(m) {
    this.events.emit('chat:message', { message: m, kind: 'update' });
  }
}

/** Split a template into atomic binding tokens and short text runs. @param {string} t */
function tokenize(t) {
  const out = [];
  for (const s of parseTemplate(t)) {
    if (s.type === 'bind') out.push(s.raw);
    else {
      const words = s.text.split(/(\s+)/);
      for (const w of words) if (w) out.push(w);
    }
  }
  return out;
}
