/**
 * Simulation (mock of POST /sims): configure a seeded multi-agent ensemble (world description,
 * agents with their level of detail, steps, runs, seed), run it progressively, and read it as an
 * ensemble fan chart (p10–p90 band and median of cash over months, with a table alternative),
 * outcome probabilities ("lease renegotiated before month 6 in 64% of runs"), the world state and
 * action log of any run at any step (in-simulation speech in the simulation voice), the token
 * estimate, and an agent field (three.js, loaded only when that tab opens) animated over steps.
 * @module editors/simulation
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { tableView, tableToggle } from '../shared/chart-table.js';
import { glAvailable } from '../shared/gl-pool.js';
import { loadCss, loadLib, LIBS } from '../../core/lazy.js';
import { applyChartTheme } from '../../theme/adapters/chartjs.js';
import { usd, usdCompact, pct, int } from '../../model/format.js';
import { METRICS, metricById, fanData, createFanChart, updateFanChart, fanTableSpec, fanSummary } from './fan.js';
import { AgentFieldView, FIELD_STATES, stateCounts } from './field.js';

const TABS = [
  { id: 'setup', label: 'Setup' },
  { id: 'ensemble', label: 'Ensemble' },
  { id: 'runs', label: 'Runs' },
  { id: 'field', label: 'Agent field' },
];
const LOD_TEXT = {
  L0: 'population statistics only',
  L1: 'simple behavioral rules',
  L2: 'goals, beliefs and relationships',
  L3: 'goals, beliefs, relationships and nested models of other parties',
};
const LIMITS = { steps: [1, 120], runs: [10, 1000], seed: [0, 2147483647] };
const OUTCOME_OF_RUN = {
  reneg6: (m) => (m.renegotiatedAt > 0 && m.renegotiatedAt < 6 ? `yes, month ${m.renegotiatedAt}` : m.renegotiatedAt > 0 ? `no (month ${m.renegotiatedAt})` : 'no'),
  cut12: (m) => (m.rivalCutAt > 0 && m.rivalCutAt <= 12 ? `yes, month ${m.rivalCutAt}` : m.rivalCutAt > 0 ? `no (month ${m.rivalCutAt})` : 'no'),
  review: (m) => (m.reviewAt > 0 ? `yes, month ${m.reviewAt}` : 'no'),
  breach: (m) => (m.breachAt > 0 ? `yes, month ${m.breachAt}` : 'no'),
};

/** Token estimate before a run (the service reports the same figure once a run starts). */
export function estimateTokens(runs, steps) {
  return Math.round(runs * steps * 2 * 1250);
}

/** "≈6M tokens" @param {number} n */
export function approxTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 tokens';
  const t = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ''));
  if (n >= 1e9) return `≈${t(n / 1e9)}B tokens`;
  if (n >= 1e6) return `≈${t(n / 1e6)}M tokens`;
  if (n >= 1e3) return `≈${Math.round(n / 1e3)}k tokens`;
  return `≈${n} tokens`;
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** @param {string} name */
function icon(name) {
  const i = h('span', `codicon codicon-${name}`);
  i.setAttribute('aria-hidden', 'true');
  return i;
}

export default class SimulationEditor extends BaseEditor {
  static id = 'simulation';
  static label = 'Simulation';
  static icon = 'play-circle';
  static group = 'Minds & Sim';
  static needs = ['chartjs'];

  async mount(ctx, state) {
    await loadCss(new URL('./simulation.css', import.meta.url));
    this.Chart = ctx.libs.chartjs.Chart;
    applyChartTheme(this.Chart);
    /** @type {any} */
    this.sim = ctx.services.sim || null;
    const cfg = this.sim?.config || { world: '', steps: 24, runs: 100, seed: 7 };
    const f = state.form || {};
    this.state = {
      tab: TABS.some((t) => t.id === state.tab) ? state.tab : this.sim?.result ? 'ensemble' : 'setup',
      table: !!state.table,
      metric: METRICS.some((m) => m.id === state.metric) ? state.metric : 'cash',
      run: Number.isInteger(state.run) ? state.run : 0,
      step: Number.isInteger(state.step) ? state.step : null,
      form: {
        world: typeof f.world === 'string' ? f.world : cfg.world,
        steps: Number.isFinite(f.steps) ? f.steps : cfg.steps,
        runs: Number.isFinite(f.runs) ? f.runs : cfg.runs,
        seed: Number.isFinite(f.seed) ? f.seed : cfg.seed,
      },
    };
    /** @type {Set<string>} parts to redraw on the next frame */
    this.dirty = new Set();
    /** @type {any} */
    this.chart = null;
    /** @type {AgentFieldView|null} */
    this.field = null;
    this.fieldState = 'idle'; // idle | loading | ready | failed | nogl
    /** @type {any} */
    this.playAnim = null;
    this.optionCount = 0;
    this.stale = false;

    this.root = h('div', 'ms-ed ms-sim');
    ctx.el.appendChild(this.root);
    if (!this.sim) {
      this.root.appendChild(emptyState({ icon: 'beaker', title: 'Simulation is not available in this build', text: 'The simulation service (mock of POST /sims) is not loaded.' }));
      return;
    }
    this.build();
    this.on('sim:progress', (p) => this.onProgress(p));
    if (this.sim.running) ctx.setBusy?.(true);
    this.markAll();
    this.checkStale();
  }

  // ------------------------------------------------------------------ model helpers

  /** @returns {any} */
  get result() { return this.sim?.result || null; }

  /** Runs available for inspection (grows while running). */
  available() { return this.result ? this.result.cash.length : 0; }

  runIndex() {
    const n = this.available();
    return n ? Math.max(0, Math.min(n - 1, this.state.run)) : 0;
  }

  stepIndex() {
    const steps = this.result ? this.result.steps : this.state.form.steps;
    const s = this.state.step;
    return s === null || s === undefined ? steps : Math.max(0, Math.min(steps, s));
  }

  runLabel(i = this.runIndex()) { return `run ${i + 1}`; }

  /** Cached replay of a run's action log. */
  logFor(run) {
    const key = `${this.result?.runId}:${run}`;
    if (this._logKey !== key) {
      this._logKey = key;
      this._log = this.sim.runLog(run) || [];
    }
    return this._log;
  }

  /** Cached agent field for a run. */
  fieldFor(run) {
    const key = `${this.result?.runId}:${run}:${this.result?.steps}`;
    if (this._fieldKey !== key) {
      this._fieldKey = key;
      this._field = this.sim.agentField(run);
    }
    return this._field;
  }

  // ------------------------------------------------------------------ DOM

  build() {
    const root = this.root;
    // tabs + status
    const bar = h('div', 'ms-tabs ms-sim-tabs');
    const list = h('div', 'ms-sim-tablist');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Simulation views');
    this.tabButtons = new Map();
    this.panels = new Map();
    const uidBase = `sim-${this.ctx?.areaId || 'x'}`;
    for (const t of TABS) {
      const b = h('button', 'ms-tab', t.label);
      b.type = 'button';
      b.id = `${uidBase}-tab-${t.id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', `${uidBase}-panel-${t.id}`);
      b.dataset.tab = t.id;
      this.listen(b, 'click', () => this.setTab(t.id, true));
      list.appendChild(b);
      this.tabButtons.set(t.id, b);
    }
    this.listen(list, 'keydown', (e) => this.onTabKey(/** @type {KeyboardEvent} */ (e)));
    this.status = h('div', 'ms-sim-status');
    this.statusText = h('span', 'ms-sim-status-text');
    this.staleBtn = h('button', 'ms-btn is-secondary is-small ms-sim-stale');
    this.staleBtn.type = 'button';
    this.staleBtn.append(icon('warning'), document.createTextNode('Inputs changed · run again'));
    this.staleBtn.hidden = true;
    this.staleBtn.dataset.tooltip = 'The model inputs changed since this ensemble ran (rent, Landlord flexibility, Rival1 price-cut probability…). Run again to update it.';
    this.listen(this.staleBtn, 'click', () => this.startRun());
    const banner = h('span', 'ms-sim-banner');
    banner.append(icon('beaker'), document.createTextNode('simulation, not assessment'));
    banner.title = 'Simulated people acting in a modeled situation; not an assessment of any real person.';
    this.status.append(this.statusText, this.staleBtn, banner);
    bar.append(list, this.status);

    this.progress = h('div', 'ms-sim-progress');
    this.progress.setAttribute('role', 'progressbar');
    this.progress.setAttribute('aria-label', 'Simulation progress');
    this.progress.setAttribute('aria-valuemin', '0');
    this.progressFill = h('i');
    this.progress.appendChild(this.progressFill);
    this.progress.hidden = true;

    const panels = h('div', 'ms-sim-panels');
    for (const t of TABS) {
      const p = h('div', `ms-sim-panel ms-sim-panel-${t.id}`);
      p.id = `${uidBase}-panel-${t.id}`;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', `${uidBase}-tab-${t.id}`);
      p.hidden = true;
      panels.appendChild(p);
      this.panels.set(t.id, p);
    }
    this.buildSetup(/** @type {HTMLElement} */ (this.panels.get('setup')));
    this.buildEnsemble(/** @type {HTMLElement} */ (this.panels.get('ensemble')));
    this.buildRuns(/** @type {HTMLElement} */ (this.panels.get('runs')));
    this.buildField(/** @type {HTMLElement} */ (this.panels.get('field')));

    this.transport = this.buildTransport();
    this.live = h('div', 'ms-sr-only');
    this.live.setAttribute('aria-live', 'polite');
    root.append(bar, this.progress, panels, this.transport, this.live);
    this.setTab(this.state.tab, false);
  }

  // ---- setup tab

  /** @param {HTMLElement} panel */
  buildSetup(panel) {
    panel.classList.add('ms-ed-scroll');
    const form = h('form', 'ms-sim-form');
    form.setAttribute('aria-label', 'Simulation setup');
    this.listen(form, 'submit', (e) => { e.preventDefault(); this.startRun(); });
    const field = (label, control, hint) => {
      const row = h('div', 'ms-sim-frow');
      const id = `${this.ctx?.areaId || 'x'}-sim-${label.toLowerCase().replace(/\W+/g, '-')}`;
      const l = h('label', 'ms-sim-flabel', label);
      l.htmlFor = id;
      control.id = id;
      row.append(l, control);
      if (hint) {
        const hh = h('div', 'ms-sim-hint', hint);
        hh.id = `${id}-hint`;
        control.setAttribute('aria-describedby', hh.id);
        row.appendChild(hh);
      }
      return row;
    };
    const world = /** @type {HTMLTextAreaElement} */ (h('textarea', 'ms-textarea ms-sim-world-input'));
    world.rows = 2;
    world.value = this.state.form.world;
    this.listen(world, 'change', () => { this.state.form.world = world.value.trim(); this.save(); });
    form.appendChild(field('World', world, 'What the game master simulates. Monthly steps after opening Location B.'));

    // agents with level-of-detail chips
    const agents = h('div', 'ms-sim-frow');
    const al = h('div', 'ms-sim-flabel', 'Agents');
    al.id = `${this.ctx?.areaId || 'x'}-sim-agents`;
    const ul = h('ul', 'ms-sim-agents');
    ul.setAttribute('aria-labelledby', al.id);
    for (const a of this.sim.agents || []) {
      const li = h('li', 'ms-sim-agent');
      const chip = h('span', 'ms-chip is-lod', a.lod);
      chip.title = `${a.lod}: ${LOD_TEXT[a.lod] || ''}`;
      chip.setAttribute('aria-label', `level of detail ${a.lod}, ${LOD_TEXT[a.lod] || ''}`);
      const name = a.scope
        ? h('button', 'ms-sim-agent-name is-link', a.name)
        : h('span', 'ms-sim-agent-name', a.name);
      if (a.scope) {
        /** @type {HTMLButtonElement} */ (name).type = 'button';
        name.title = `Select the ${a.name} scope`;
        this.listen(name, 'click', () => this.select([a.scope]));
      }
      const kind = h('span', 'ms-sim-agent-kind', a.kind === 'population' ? 'population (rendered as L1 points in the agent field)' : a.kind);
      li.append(chip, name, kind);
      ul.appendChild(li);
    }
    agents.append(al, ul);
    form.appendChild(agents);

    const nums = h('div', 'ms-sim-nums');
    const num = (key, label, hint) => {
      const inp = /** @type {HTMLInputElement} */ (h('input', 'ms-input ms-sim-num'));
      inp.type = 'number';
      inp.min = String(LIMITS[key][0]);
      inp.max = String(LIMITS[key][1]);
      inp.step = '1';
      inp.value = String(this.state.form[key]);
      inp.inputMode = 'numeric';
      this.listen(inp, 'change', () => {
        const [lo, hi] = LIMITS[key];
        const v = Math.round(Number(inp.value));
        const c = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : this.state.form[key];
        inp.value = String(c);
        this.state.form[key] = c;
        this.save();
        this.updateEstimate();
        this.dirty.add('status');
        this.invalidate();
      });
      return field(label, inp, hint);
    };
    nums.append(
      num('steps', 'Steps (months)', '1–120'),
      num('runs', 'Runs', '10–1000'),
      num('seed', 'Seed', 'same seed, same ensemble'),
    );
    form.appendChild(nums);
    this.estimate = h('p', 'ms-sim-estimate');
    form.appendChild(this.estimate);
    const actions = h('div', 'ms-row ms-sim-actions');
    this.runBtn = h('button', 'ms-btn');
    /** @type {HTMLButtonElement} */ (this.runBtn).type = 'submit';
    this.stopBtn = h('button', 'ms-btn is-secondary');
    /** @type {HTMLButtonElement} */ (this.stopBtn).type = 'button';
    this.stopBtn.append(icon('debug-stop'), document.createTextNode('Stop'));
    this.listen(this.stopBtn, 'click', () => this.stopRun());
    actions.append(this.runBtn, this.stopBtn);
    form.appendChild(actions);
    const note = h('p', 'ms-sim-hint', 'Each run is a pure function of the seed, the run index and the model inputs, so any run can be replayed and inspected at any step. Inputs are read from the live graph (rent, Landlord flexibility, Rival1 price-cut probability, loan payment).');
    form.appendChild(note);
    panel.appendChild(form);
    this.updateEstimate();
  }

  updateEstimate() {
    const f = this.state.form;
    if (this.estimate) this.estimate.textContent = `Estimate: ${approxTokens(estimateTokens(f.runs, f.steps))}, mostly cached prefixes (${int(f.runs)} runs × ${int(f.steps)} months).`;
    if (this.runBtn) {
      this.runBtn.replaceChildren(icon('play'), document.createTextNode(`Run ${int(f.runs)} simulations`));
    }
  }

  // ---- ensemble tab

  /** @param {HTMLElement} panel */
  buildEnsemble(panel) {
    const body = h('div', 'ms-sim-ens');
    this.fanBox = h('section', 'ms-sim-fan');
    this.fanBox.setAttribute('aria-label', 'Ensemble fan chart');
    // persistent head: metric picker + summary (kept while runs stream in)
    const head = h('div', 'ms-sim-fanhead');
    const title = h('div', 'ms-sim-fantitle');
    this.metricSel = /** @type {HTMLSelectElement} */ (h('select', 'ms-select is-small ms-sim-metric'));
    this.metricSel.setAttribute('aria-label', 'World metric');
    this.metricSel.dataset.tooltip = 'World metric shown in the fan chart';
    for (const m of METRICS) {
      const o = /** @type {HTMLOptionElement} */ (h('option', '', m.label));
      o.value = m.id;
      this.metricSel.appendChild(o);
    }
    this.metricSel.value = this.state.metric;
    this.listen(this.metricSel, 'change', () => {
      this.state.metric = this.metricSel.value;
      this.save();
      this.dirty.add('fan');
      this.invalidate();
    });
    this.fanLegendNote = h('span', 'ms-muted ms-sim-fannote');
    title.append(this.metricSel, this.fanLegendNote);
    this.fanSum = h('div', 'ms-sim-fansum ms-muted');
    head.append(title, this.fanSum);
    this.fanBody = h('div', 'ms-sim-fanbody');
    this.fanBox.append(head, this.fanBody);
    this.outcomes = h('section', 'ms-sim-outcomes');
    this.outcomes.setAttribute('aria-label', 'Outcome probabilities');
    body.append(this.fanBox, this.outcomes);
    panel.appendChild(body);
  }

  // ---- runs tab

  /** @param {HTMLElement} panel */
  buildRuns(panel) {
    panel.classList.add('ms-ed-scroll');
    this.world = h('section', 'ms-sim-worldstate');
    this.world.setAttribute('aria-label', 'World state at the inspected step');
    this.logEl = h('section', 'ms-sim-logbox');
    // one delegated listener: month buttons are rebuilt with the log
    this.listen(this.logEl, 'click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest?.('.ms-sim-logmonth');
      if (b) this.setStep(Number(/** @type {HTMLElement} */ (b).dataset.step), true);
    });
    panel.append(this.world, this.logEl);
  }

  // ---- agent field tab

  /** @param {HTMLElement} panel */
  buildField(panel) {
    this.fieldHost = h('div', 'ms-sim-field-host');
    this.fieldHost.tabIndex = 0;
    this.fieldHost.setAttribute('role', 'group');
    this.fieldHost.setAttribute('aria-roledescription', 'agent field');
    this.fieldHost.setAttribute('aria-label', 'Agent field. Arrow keys orbit, plus and minus zoom.');
    this.fieldMsg = h('div', 'ms-sim-msg');
    this.fieldMsg.hidden = true;
    this.listen(this.fieldMsg, 'click', () => this.field?.resume());
    this.listen(this.fieldMsg, 'keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      if (ke.key === 'Enter' || ke.key === ' ') { ke.preventDefault(); this.field?.resume(); }
    });
    this.fieldLegend = h('div', 'ms-sim-legend');
    this.fieldHost.append(this.fieldMsg, this.fieldLegend);
    this.listen(this.fieldHost, 'keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      if (this.field && this.field.onKey(ke)) { ke.preventDefault(); ke.stopPropagation(); }
    });
    this.fieldAlt = h('div', 'ms-sim-field-alt');
    panel.append(this.fieldHost, this.fieldAlt);
  }

  // ---- transport (run picker + step scrubber)

  buildTransport() {
    const bar = h('div', 'ms-sim-transport');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Inspect a run at a step');
    const runLabel = h('label', 'ms-sim-tlabel', 'Run');
    this.runSel = /** @type {HTMLSelectElement} */ (h('select', 'ms-select is-small ms-sim-runsel'));
    this.runSel.id = `${this.ctx?.areaId || 'x'}-sim-run`;
    runLabel.htmlFor = this.runSel.id;
    this.runSel.setAttribute('aria-label', 'Run to inspect');
    this.listen(this.runSel, 'change', () => this.setRun(Number(this.runSel.value)));
    const btn = (name, label, run) => {
      const b = h('button', 'ms-icon-btn is-small');
      /** @type {HTMLButtonElement} */ (b).type = 'button';
      b.setAttribute('aria-label', label);
      b.dataset.tooltip = label;
      b.appendChild(icon(name));
      this.listen(b, 'click', run);
      return b;
    };
    this.backBtn = btn('chevron-left', 'Previous month', () => this.setStep(this.stepIndex() - 1, true));
    this.playBtn = btn('play', 'Play months', () => this.togglePlay());
    this.playBtn.setAttribute('aria-pressed', 'false');
    this.fwdBtn = btn('chevron-right', 'Next month', () => this.setStep(this.stepIndex() + 1, true));
    this.range = /** @type {HTMLInputElement} */ (h('input', 'ms-range ms-sim-range'));
    this.range.type = 'range';
    this.range.min = '0';
    this.range.step = '1';
    this.range.setAttribute('aria-label', 'Month to inspect');
    this.listen(this.range, 'input', () => this.setStep(Number(this.range.value), true));
    this.stepLabel = h('span', 'ms-sim-steplabel');
    this.stepLabel.setAttribute('aria-hidden', 'true');
    bar.append(runLabel, this.runSel, this.backBtn, this.playBtn, this.fwdBtn, this.range, this.stepLabel);
    return bar;
  }

  // ------------------------------------------------------------------ tabs

  /** @param {string} id @param {boolean} focus */
  setTab(id, focus) {
    const prev = this.state.tab;
    this.state.tab = id;
    for (const [tid, b] of this.tabButtons) {
      const on = tid === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      /** @type {HTMLElement} */ (this.panels.get(tid)).hidden = !on;
    }
    if (focus) this.tabButtons.get(id)?.focus();
    if (prev === 'field' && id !== 'field') this.field?.release();
    if (id === 'field') this.ensureField();
    if (prev !== id) {
      this.save();
      this.ctx?.refreshHeader();
    }
    this.markAll();
  }

  /** @param {KeyboardEvent} e */
  onTabKey(e) {
    const ids = TABS.map((t) => t.id);
    const i = ids.indexOf(this.state.tab);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = ids.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.setTab(ids[j], true);
  }

  markAll() {
    for (const k of ['status', 'fan', 'outcomes', 'world', 'log', 'transport', 'field', 'runs']) this.dirty.add(k);
    this.invalidate();
  }

  // ------------------------------------------------------------------ run control

  startRun() {
    if (!this.sim) return;
    const f = this.state.form;
    this.state.step = null;
    this.stopPlay();
    this.sim.run({ world: f.world, steps: f.steps, runs: f.runs, seed: f.seed }).catch((err) => {
      console.error('[simulation] run failed', err);
      this.announce(`Simulation failed: ${err?.message || err}`);
    });
  }

  stopRun() {
    this.sim?.stop();
    this.announce('Stopping the simulation…');
  }

  /** @param {{runId: string, phase: string, done: number, total: number, result: any}} p */
  onProgress(p) {
    const ctx = /** @type {any} */ (this.ctx);
    if (p.phase === 'start') {
      this.cust = null;
      this.optionCount = 0;
      this.runSel.replaceChildren();
      this._logKey = null;
      this._fieldKey = null;
      this.stale = false;
      this.state.step = null;
      if (this.state.run >= p.total) this.state.run = 0;
      ctx.setBusy?.(true);
      ctx.refreshHeader();
      if (this.state.tab === 'setup') this.setTab('ensemble', false);
      this.announce(`Simulation started: ${p.total} runs.`);
    } else if (p.phase === 'done') {
      ctx.setBusy?.(false);
      ctx.refreshHeader();
      const r = p.result;
      this.announce(r.done ? `Simulation finished: ${p.done} runs.` : `Simulation stopped after ${p.done} of ${p.total} runs.`);
    }
    this.markAll();
  }

  // ------------------------------------------------------------------ run / step selection

  /** @param {number} run */
  setRun(run) {
    const n = this.available();
    if (!n) return;
    this.state.run = Math.max(0, Math.min(n - 1, run));
    this.saveSoon();
    for (const k of ['fan', 'outcomes', 'world', 'log', 'field', 'transport']) this.dirty.add(k);
    this.invalidate();
  }

  /** @param {number} step @param {boolean} animate */
  setStep(step, animate) {
    const steps = this.result ? this.result.steps : this.state.form.steps;
    const s = Math.max(0, Math.min(steps, Math.round(step)));
    const changed = s !== this.stepIndex();
    this.state.step = s;
    this.fieldAnimate = animate && !(/** @type {any} */ (this.ctx).scheduler.reducedMotion);
    this.saveSoon();
    if (!changed) return;
    for (const k of ['fan', 'world', 'log', 'field', 'transport']) this.dirty.add(k);
    this.invalidate();
  }

  togglePlay() {
    if (this.playAnim) { this.stopPlay(); return; }
    if (!this.result || !this.available()) return;
    const ctx = /** @type {any} */ (this.ctx);
    const steps = this.result.steps;
    if (this.stepIndex() >= steps) this.setStep(0, false);
    const reduced = ctx.scheduler.reducedMotion;
    const every = reduced ? 1000 : 650;
    let last = performance.now();
    this.playAnim = ctx.scheduler.animate(this, () => {
      const now = performance.now();
      if (now - last < every) return;
      last = now;
      if (this.stepIndex() >= steps) { this.stopPlay(); return; }
      this.setStep(this.stepIndex() + 1, !reduced);
    });
    this.playBtn.setAttribute('aria-pressed', 'true');
    this.playBtn.setAttribute('aria-label', 'Pause');
    this.playBtn.dataset.tooltip = 'Pause';
    this.playBtn.replaceChildren(icon('debug-pause'));
  }

  stopPlay() {
    if (!this.playAnim) return;
    this.playAnim.dispose();
    this.playAnim = null;
    if (this.playBtn) {
      this.playBtn.setAttribute('aria-pressed', 'false');
      this.playBtn.setAttribute('aria-label', 'Play months');
      this.playBtn.dataset.tooltip = 'Play months';
      this.playBtn.replaceChildren(icon('play'));
    }
  }

  saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 300);
  }

  /** @param {string} text */
  announce(text) {
    if (this.live) this.live.textContent = text;
  }

  // ------------------------------------------------------------------ rendering

  render() {
    if (!this.sim || !this.root) return;
    const d = this.dirty;
    const tab = this.state.tab;
    if (d.has('status')) { d.delete('status'); this.renderStatus(); }
    if (d.has('runs')) { d.delete('runs'); this.renderRunOptions(); }
    if (d.has('transport')) { d.delete('transport'); this.renderTransport(); }
    if (tab === 'ensemble') {
      if (d.has('fan')) { d.delete('fan'); this.renderFan(); }
      if (d.has('outcomes')) { d.delete('outcomes'); this.renderOutcomes(); }
    }
    if (tab === 'runs') {
      if (d.has('world')) { d.delete('world'); this.renderWorld(); }
      if (d.has('log')) { d.delete('log'); this.renderLog(); }
    }
    if (tab === 'field') {
      if (d.has('field')) { d.delete('field'); this.renderFieldData(); }
      this.field?.render();
    }
  }

  renderStatus() {
    const r = this.result;
    const running = !!this.sim.running;
    let text;
    if (r) {
      const done = r.cash.length;
      text = `${running ? `Running ${int(done)}/${int(r.runs)} runs` : `${int(done)}${done < r.runs ? ` of ${int(r.runs)}` : ''} runs`} × ${int(r.steps)} months · seed ${r.seed} · ${approxTokens(r.tokens)}, mostly cached prefixes`;
      this.progress.hidden = !running;
      this.progress.setAttribute('aria-valuemax', String(r.runs));
      this.progress.setAttribute('aria-valuenow', String(done));
      this.progress.setAttribute('aria-valuetext', `${done} of ${r.runs} runs`);
      this.progressFill.style.width = `${(100 * done) / Math.max(1, r.runs)}%`;
    } else {
      const f = this.state.form;
      text = `Not run yet · estimate ${approxTokens(estimateTokens(f.runs, f.steps))}, mostly cached prefixes`;
      this.progress.hidden = true;
    }
    this.statusText.textContent = text;
    this.statusText.title = text;
    this.staleBtn.hidden = !(this.stale && r && !running);
    this.runBtn.toggleAttribute('disabled', running);
    this.stopBtn.toggleAttribute('disabled', !running);
  }

  /** Append options for runs that finished since the last frame. */
  renderRunOptions() {
    const r = this.result;
    const n = this.available();
    if (!r) { this.runSel.replaceChildren(); this.optionCount = 0; return; }
    if (n < this.optionCount) { this.runSel.replaceChildren(); this.optionCount = 0; }
    const frag = document.createDocumentFragment();
    for (let i = this.optionCount; i < n; i++) {
      const m = r.runsMeta[i] || {};
      const o = /** @type {HTMLOptionElement} */ (h('option'));
      o.value = String(i);
      const tags = [];
      if (m.renegotiatedAt > 0) tags.push(`renegotiated M${m.renegotiatedAt}`);
      if (m.rivalCutAt > 0) tags.push(`rival cut M${m.rivalCutAt}`);
      if (m.breachAt > 0) tags.push(`breach M${m.breachAt}`);
      o.textContent = `Run ${i + 1}${tags.length ? ` · ${tags.join(', ')}` : ''}`;
      frag.appendChild(o);
    }
    this.runSel.appendChild(frag);
    this.optionCount = n;
    this.runSel.value = String(this.runIndex());
  }

  renderTransport() {
    const r = this.result;
    const show = !!r && this.available() > 0 && this.state.tab !== 'setup';
    this.transport.hidden = !show;
    if (!r) return;
    const steps = r.steps;
    const s = this.stepIndex();
    this.range.max = String(steps);
    this.range.value = String(s);
    this.range.style.setProperty('--ms-range-pct', `${(100 * s) / Math.max(1, steps)}%`);
    this.range.setAttribute('aria-valuetext', `Month ${s} of ${steps}`);
    this.stepLabel.textContent = `Month ${s} / ${steps}`;
    if (this.runSel.value !== String(this.runIndex()) && this.optionCount) this.runSel.value = String(this.runIndex());
    this.backBtn.toggleAttribute('disabled', s <= 0);
    this.fwdBtn.toggleAttribute('disabled', s >= steps);
  }

  /** @param {HTMLElement} el @param {string} title @param {string} text */
  renderNoResult(el, title, text) {
    el.replaceChildren(emptyState({
      icon: 'play-circle',
      title,
      text,
      action: this.sim.running ? undefined : { label: `Run ${int(this.state.form.runs)} simulations`, run: () => this.startRun() },
    }));
  }

  renderFan() {
    const r = this.result;
    if (!r || !r.cash.length) {
      this.destroyChart();
      this.fanSum.textContent = '';
      this.fanLegendNote.textContent = '';
      this.renderNoResult(this.fanBody, this.sim.running ? 'Starting the ensemble…' : 'No ensemble yet', 'Run the simulation to see the p10–p90 band and the median of a world metric over months across runs. Configure it under Setup, or type /sim 100 runs in the composer.');
      return;
    }
    const metric = metricById(this.state.metric);
    if (this.metricSel.value !== metric.id) this.metricSel.value = metric.id;
    let computing = false;
    if (metric.id === 'customersB' && !this.computeCustomers()) {
      // agent fields are replayed a few runs per frame; keep filling in
      computing = true;
      this.dirty.add('fan');
      this.invalidate();
    }
    const run = this.runIndex();
    const d = fanData(r, metric.id, run, (i) => this.custFor(i));
    const label = this.runLabel(run);
    const last = d.p50.length - 1;
    this.fanLegendNote.textContent = ` · p10–p90 band, median, dashed ${label}`;
    const note = computing ? ` · replaying agent fields, ${d.used} of ${r.cash.length} runs` : r.cash.length < r.runs ? ` · ${r.cash.length} of ${r.runs} runs so far` : ` · ${d.used} runs`;
    this.fanSum.textContent = last >= 0 && Number.isFinite(d.p50[last])
      ? `Month ${last}: median ${metric.fmt(d.p50[last])} (p10 ${metric.tick(d.p10[last])}, p90 ${metric.tick(d.p90[last])})${note}`
      : note.replace(/^ · /, '');
    if (this.state.table) {
      this.destroyChart();
      const table = tableView(fanTableSpec(d, label, metric));
      table.querySelectorAll('tbody tr')[this.stepIndex()]?.classList.add('is-selected');
      this.fanBody.replaceChildren(table);
      return;
    }
    if (!this.chart) {
      const wrap = h('div', 'ms-chart-wrap ms-sim-chart');
      const canvas = /** @type {HTMLCanvasElement} */ (h('canvas'));
      canvas.setAttribute('role', 'img');
      wrap.appendChild(canvas);
      this.fanBody.replaceChildren(wrap);
      this.canvas = canvas;
      this.chart = createFanChart(this.Chart, canvas, { step: () => this.stepIndex(), metric: () => metricById(this.state.metric) });
    }
    updateFanChart(this.chart, d, label, metric);
    this.canvas.setAttribute('aria-label', `${fanSummary(d, r.runs, metric)} The dashed line is ${label}. Use the Table view for every value.`);
  }

  /** Customers at Location B per step for a run (from its agent field), once computed. @param {number} run */
  custFor(run) {
    const c = this.cust;
    return c && c.runId === this.result?.runId ? c.counts[run] || null : null;
  }

  /** Replay agent fields of finished runs within a small time budget; true when all are counted. */
  computeCustomers(budgetMs = 8) {
    const r = this.result;
    if (!r) return true;
    if (!this.cust || this.cust.runId !== r.runId || this.cust.steps !== r.steps) this.cust = { runId: r.runId, steps: r.steps, counts: [] };
    const c = this.cust;
    const t0 = performance.now();
    while (c.counts.length < r.cash.length) {
      const f = this.sim.agentField(c.counts.length);
      const out = new Int32Array(r.steps + 1);
      if (f) {
        for (let t = 0; t < f.states.length && t <= r.steps; t++) {
          const st = f.states[t];
          let k = 0;
          for (let j = 0; j < st.length; j++) if (st[j] === 2) k++;
          out[t] = k;
        }
      }
      c.counts.push(out);
      if (performance.now() - t0 > budgetMs) break;
    }
    return c.counts.length >= r.cash.length;
  }

  renderOutcomes() {
    const r = this.result;
    const el = this.outcomes;
    el.replaceChildren();
    if (!r || !r.cash.length) { el.hidden = true; return; }
    el.hidden = false;
    const n = r.cash.length;
    const head = h('div', 'ms-sim-outhead');
    head.append(h('strong', '', 'Outcomes'), h('span', 'ms-muted', ` · ${n < r.runs ? `so far, ${n} of ${r.runs}` : `${n}`} runs`));
    const ul = h('ul', 'ms-sim-outlist');
    const meta = r.runsMeta[this.runIndex()];
    for (const o of r.outcomes || []) {
      const li = h('li', 'ms-sim-outcome');
      const text = h('div', 'ms-sim-outtext');
      text.append(document.createTextNode(`${o.label} in `), h('strong', 'ms-tabular', pct(o.p)), document.createTextNode(' of runs'));
      const meter = h('div', 'ms-sim-meter');
      meter.setAttribute('aria-hidden', 'true');
      const fill = h('i');
      fill.style.width = `${Math.round(o.p * 1000) / 10}%`;
      meter.appendChild(fill);
      const sub = h('div', 'ms-sim-outsub ms-muted');
      const own = meta && OUTCOME_OF_RUN[o.id] ? ` · ${this.runLabel()}: ${OUTCOME_OF_RUN[o.id](meta)}` : '';
      sub.textContent = `${int(o.count)} of ${int(n)} runs${own}`;
      li.append(text, meter, sub);
      ul.appendChild(li);
    }
    el.append(head, ul);
  }

  renderWorld() {
    const r = this.result;
    const el = this.world;
    if (!r || !r.cash.length) {
      this.renderNoResult(el, this.sim.running ? 'Starting the ensemble…' : 'No runs to inspect yet', 'Run the simulation, then pick a run and a month to inspect its world state and action log.');
      return;
    }
    const run = this.runIndex();
    const t = this.stepIndex();
    const m = r.runsMeta[run] || {};
    const cash = r.cash[run]?.[t];
    el.replaceChildren();
    const head = h('div', 'ms-sim-worldhead');
    head.append(h('strong', '', `Run ${run + 1}, month ${t} of ${r.steps}`), h('span', 'ms-muted', ` · seed ${r.seed}`));
    const dl = h('dl', 'ms-kv ms-sim-kv');
    const row = (k, v, cls) => {
      const dd = h('dd', cls || '');
      if (typeof v === 'string') dd.textContent = v;
      else dd.append(...v);
      dl.append(h('dt', '', k), dd);
    };
    const f = r.fan;
    row('Cash', [
      h('span', `ms-tabular${cash < 0 ? ' ms-bad' : ''}`, usd(cash)),
      h('span', 'ms-muted', f.p50[t] === undefined ? '' : `  ensemble median ${usd(f.p50[t])} (p10 ${usdCompact(f.p10[t])}, p90 ${usdCompact(f.p90[t])})`),
    ]);
    const when = (at, yes, notYet, never) => (at > 0 && at <= t ? `${yes} in month ${at}` : at > t ? notYet(at) : never);
    row('Lease', when(m.renegotiatedAt, 'renegotiated (six percent off, longer term)', (at) => `as written (renegotiated later, month ${at})`, 'as written'));
    row('Rival1', when(m.rivalCutAt, 'cut prices', (at) => `no price cut yet (cuts in month ${at})`, 'no price cut'));
    row('Loan', when(m.reviewAt, 'covenant review', (at) => `no review yet (review in month ${at})`, 'covenant checks passed'));
    row('Cash buffer', when(m.breachAt, 'breached', (at) => `positive (breached in month ${at})`, 'never below zero'), m.breachAt > 0 && m.breachAt <= t ? 'ms-bad' : '');
    const field = this.fieldFor(run);
    if (field) {
      const c = stateCounts(field, t);
      const parts = FIELD_STATES.map((s, k) => {
        const sp = h('span', 'ms-sim-count');
        const sw = h('i', 'ms-sim-swatch');
        sw.style.background = s.css;
        sw.setAttribute('aria-hidden', 'true');
        sp.append(sw, document.createTextNode(`${int(c[k])} ${s.label}`));
        return sp;
      });
      row('Customers', parts);
    }
    el.append(head, dl);
  }

  renderLog() {
    const r = this.result;
    const el = this.logEl;
    if (!r || !r.cash.length) {
      el.replaceChildren();
      this._logRenderKey = null;
      return;
    }
    const run = this.runIndex();
    const t = this.stepIndex();
    const key = `${r.runId}:${run}:${t}`;
    if (key === this._logRenderKey && el.firstChild) return;
    const moved = this._logRenderKey !== key;
    this._logRenderKey = key;
    el.replaceChildren();
    const log = this.logFor(run);
    const head = h('div', 'ms-sim-loghead');
    head.append(h('strong', '', 'Action log'), h('span', 'ms-muted', ` · ${this.runLabel(run)} · ${log.length} events; speech is simulated`));
    const ol = h('ol', 'ms-sim-log');
    ol.setAttribute('aria-label', `Action log for ${this.runLabel(run)}`);
    /** @type {Map<number, any[]>} */
    const bySteps = new Map();
    for (const e of log) {
      if (!bySteps.has(e.step)) bySteps.set(e.step, []);
      /** @type {any[]} */ (bySteps.get(e.step)).push(e);
    }
    let current = null;
    for (const [step, entries] of bySteps) {
      const li = h('li', `ms-sim-logstep${step > t ? ' is-future' : ''}${step === t ? ' is-current' : ''}`);
      const mb = h('button', 'ms-sim-logmonth', `Month ${step}`);
      /** @type {HTMLButtonElement} */ (mb).type = 'button';
      mb.dataset.step = String(step);
      mb.setAttribute('aria-label', `Inspect month ${step}`);
      if (step === t) mb.setAttribute('aria-current', 'step');
      li.appendChild(mb);
      for (const e of entries) {
        const row = h('div', 'ms-sim-logentry');
        row.append(h('span', 'ms-sim-actor', e.actor), document.createTextNode(` ${e.action}`));
        if (e.outcome) row.append(document.createTextNode(' '), h('span', `ms-status ms-sim-outcome-tag is-${e.outcome.replace(/\W+/g, '-')}`, e.outcome));
        li.appendChild(row);
        if (e.speech) li.appendChild(simVoice(e.actor, e.speech));
      }
      ol.appendChild(li);
      if (step <= t) current = li;
    }
    if (!bySteps.size) ol.appendChild(h('li', 'ms-muted', 'No events in this run.'));
    el.append(head, ol);
    // keep the inspected month in view (instant; no smooth scrolling)
    if (moved && current && this.state.tab === 'runs') {
      const box = /** @type {HTMLElement} */ (this.panels.get('runs'));
      const top = current.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = Math.max(0, top - 40);
    }
  }

  // ------------------------------------------------------------------ agent field

  async ensureField() {
    if (this.fieldState !== 'idle') return;
    const ctx = /** @type {any} */ (this.ctx);
    if (!glAvailable()) {
      this.fieldState = 'nogl';
      this.dirty.add('field');
      this.invalidate();
      return;
    }
    this.fieldState = 'loading';
    this.fieldMsg.hidden = false;
    this.fieldMsg.classList.remove('is-clickable');
    this.fieldMsg.textContent = `Loading three.js (${LIBS.three.version})…`;
    try {
      const three = await loadLib('three');
      if (this._disposed) return;
      this.field = new AgentFieldView({
        host: this.fieldHost,
        THREE: three.THREE,
        OrbitControls: three.OrbitControls,
        scheduler: ctx.scheduler,
        owner: this,
        isVisible: () => this.isVisible() && this.state.tab === 'field',
        onPaused: (text) => this.showFieldMsg(text),
      });
      this.fieldState = 'ready';
      this.fieldMsg.hidden = true;
      this._fieldShownKey = null;
      this.dirty.add('field');
      this.invalidate();
    } catch (err) {
      if (this._disposed) return;
      this.fieldState = 'failed';
      this.fieldMsg.hidden = true;
      this.fieldAlt.replaceChildren(emptyState({
        icon: 'warning',
        title: 'Could not load three.js for the agent field',
        text: `${/** @type {Error} */ (err).message || err}. The counts by state are still listed under Runs.`,
        action: { label: 'Retry', run: () => { this.fieldState = 'idle'; this.fieldAlt.replaceChildren(); this.ensureField(); } },
      }));
    }
  }

  /** @param {string|null} text */
  showFieldMsg(text) {
    if (!this.fieldMsg) return;
    if (!text) { this.fieldMsg.hidden = true; return; }
    this.fieldMsg.textContent = text;
    this.fieldMsg.hidden = false;
    this.fieldMsg.classList.add('is-clickable');
    this.fieldMsg.setAttribute('role', 'button');
    this.fieldMsg.tabIndex = 0;
  }

  renderFieldData() {
    const r = this.result;
    const ctx = /** @type {any} */ (this.ctx);
    if (this.fieldState === 'nogl') {
      this.fieldHost.hidden = true;
      this.fieldAlt.replaceChildren(emptyState({
        icon: 'warning',
        title: 'WebGL is not available',
        text: 'This browser or device cannot create a WebGL context, so the agent field cannot render. The table below lists the customers by state for each month of the selected run.',
        action: { label: 'Open the 2D Scope Graph', run: () => ctx.commands.executeWith('area.setType.graph', { areaId: ctx.areaId }) },
      }));
      if (r && r.cash.length) this.fieldAlt.appendChild(this.countsTable(this.fieldFor(this.runIndex())));
      return;
    }
    if (!r || !r.cash.length) {
      this.fieldHost.hidden = true;
      this.renderNoResult(this.fieldAlt, this.sim.running ? 'Starting the ensemble…' : 'No agent field yet', 'Run the simulation to see the customer population of a run as points, colored by state and animated over months.');
      this.field?.setField(null, 0);
      this._fieldShownKey = null;
      return;
    }
    if (this.fieldState !== 'ready' || !this.field) {
      this.fieldHost.hidden = false;
      return;
    }
    this.fieldHost.hidden = false;
    if (this.fieldAlt.firstChild) this.fieldAlt.replaceChildren();
    const run = this.runIndex();
    const t = this.stepIndex();
    const key = `${r.runId}:${run}:${r.steps}`;
    const data = this.fieldFor(run);
    if (this._fieldShownKey !== key) {
      this._fieldShownKey = key;
      this.field.setField(data, t);
    } else this.field.setStep(t, !!this.fieldAnimate);
    this.fieldAnimate = false;
    this.renderFieldLegend(data, run, t);
    this.field.resize();
  }

  /** @param {any} data @param {number} run @param {number} t */
  renderFieldLegend(data, run, t) {
    const c = stateCounts(data, t);
    const el = this.fieldLegend;
    el.replaceChildren();
    el.appendChild(h('div', 'ms-sim-legend-title', `${this.runLabel(run)} · month ${t} · ${int(data.count)} customers (L0 population as L1 points)`));
    const ul = h('ul', 'ms-sim-legend-list');
    FIELD_STATES.forEach((s, k) => {
      const li = h('li');
      const sw = h('i', 'ms-sim-swatch');
      sw.style.background = s.css;
      sw.setAttribute('aria-hidden', 'true');
      li.append(sw, h('span', '', s.label), h('span', 'ms-tabular ms-sim-legend-n', int(c[k])));
      ul.appendChild(li);
    });
    el.appendChild(ul);
    this.fieldHost.setAttribute('aria-label', `Agent field for ${this.runLabel(run)} at month ${t}: ${FIELD_STATES.map((s, k) => `${c[k]} ${s.label}`).join(', ')}. Arrow keys orbit, plus and minus zoom.`);
  }

  /** Accessible fallback: customers by state for each month. @param {any} data */
  countsTable(data) {
    const rows = data.states.map((_, t) => [String(t), ...stateCounts(data, t).map((x) => int(x))]);
    return tableView({
      caption: `Customers by state per month, ${this.runLabel()}`,
      columns: [{ label: 'Month' }, ...FIELD_STATES.map((s) => ({ label: s.label, align: /** @type {'right'} */ ('right') }))],
      rows,
    });
  }

  // ------------------------------------------------------------------ editor hooks

  /** @param {boolean} visible */
  onVisibility(visible) {
    if (!visible) {
      this.field?.release();
      return;
    }
    if (this.field?.paused) this.field.resume();
    this.markAll();
  }

  resize() {
    this.field?.resize();
    this.invalidate();
  }

  onRecompute(changed, payload) {
    if (!this.result || this.sim?.running) return;
    if (!changed.length && !payload?.structural && !payload?.full) return;
    this.checkStaleSoon();
  }

  onStructure() {
    this.checkStaleSoon();
  }

  checkStaleSoon() {
    clearTimeout(this._staleTimer);
    this._staleTimer = setTimeout(() => this.checkStale(), 400);
  }

  /** Did the model inputs change since the ensemble ran? */
  checkStale() {
    const r = this.result;
    if (!r || !r.inputs || this.sim.running || this._disposed) return;
    let stale = false;
    try {
      stale = JSON.stringify(this.sim.inputs()) !== JSON.stringify(r.inputs);
    } catch { stale = false; }
    if (stale !== this.stale) {
      this.stale = stale;
      this.dirty.add('status');
      this.invalidate();
    }
  }

  onTheme() {
    applyChartTheme(this.Chart);
    this.destroyChart();
    this.field?.retheme();
    this.markAll();
  }

  getHeaderTools() {
    if (!this.sim) return [];
    const wrap = h('div', 'ms-row');
    const running = !!this.sim.running;
    const b = h('button', `ms-btn is-small${running ? ' is-secondary' : ''}`);
    /** @type {HTMLButtonElement} */ (b).type = 'button';
    b.append(icon(running ? 'debug-stop' : 'play'), document.createTextNode(running ? 'Stop' : 'Run'));
    b.dataset.tooltip = running ? 'Stop the simulation' : `Run ${int(this.state.form.runs)} seeded simulations`;
    b.addEventListener('click', () => (running ? this.stopRun() : this.startRun()));
    wrap.appendChild(b);
    if (this.state.tab === 'ensemble') {
      wrap.appendChild(tableToggle(this.state.table, (v) => {
        this.state.table = v;
        this.save();
        this.destroyChart();
        this.dirty.add('fan');
        this.invalidate();
        this.ctx?.refreshHeader();
      }));
    }
    return [wrap];
  }

  getHeaderMenus() {
    if (!this.sim) return [];
    return [{
      label: 'Simulation',
      items: () => [
        { label: this.sim.running ? 'Stop' : `Run ${int(this.state.form.runs)} Simulations`, run: () => (this.sim.running ? this.stopRun() : this.startRun()) },
        { separator: true },
        { label: 'View as Table', checked: this.state.table, run: () => { this.state.table = !this.state.table; this.save(); this.destroyChart(); this.dirty.add('fan'); this.invalidate(); this.ctx?.refreshHeader(); } },
        { separator: true },
        ...TABS.map((t) => ({ label: `Show ${t.label}`, checked: this.state.tab === t.id, run: () => this.setTab(t.id, true) })),
      ],
    }];
  }

  getState() {
    return { tab: this.state.tab, table: this.state.table, metric: this.state.metric, run: this.state.run, step: this.state.step, form: { ...this.state.form } };
  }

  destroyChart() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
      this.canvas = null;
    }
  }

  dispose() {
    clearTimeout(this._saveTimer);
    clearTimeout(this._staleTimer);
    this.stopPlay();
    this.destroyChart();
    this.field?.dispose();
    this.field = null;
    if (this.sim?.running) this.ctx?.setBusy?.(false);
    this.root?.remove();
    super.dispose();
  }
}

/**
 * In-simulation speech, always in the simulation voice (never styled like the assistant).
 * @param {string} who @param {string} text
 */
function simVoice(who, text) {
  const box = h('div', 'ms-sim-voice');
  box.setAttribute('role', 'note');
  box.setAttribute('aria-label', `Simulated speech by ${who}`);
  const av = h('span', 'ms-sim-voice-avatar', who.slice(0, 1));
  av.setAttribute('aria-hidden', 'true');
  const label = h('div');
  const tag = h('span', 'ms-sim-voice-label');
  tag.append(icon('beaker'), document.createTextNode('simulation'));
  label.append(tag, h('span', 'ms-sim-voice-who', who));
  const q = h('q', '', text);
  box.append(av, label, q);
  return box;
}
