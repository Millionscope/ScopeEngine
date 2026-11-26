/**
 * Change router: classifies composer input as it is typed.
 *
 *   numeric     "set rent to 7000", "price 4.50", "rent +10%", "make demand p90 450"
 *               -> a local `set` delta, zero model tokens
 *   structural  "add a competitor named Crumb & Co", "remove the loan"   -> model, ~1k-5k tokens
 *   question    anything else                                          -> model, ~20k-80k tokens
 *   command     "/fork", "/sweep", ...
 * No DOM.
 * @module services/router
 */
import { unitValue } from '../model/format.js';
import { describe, makeDist, shiftDist } from '../model/distributions.js';
import { parseUnit, sameDims, convertFactor } from '../model/units.js';

/**
 * @typedef {Object} Route
 * @property {'numeric'|'structural'|'question'|'command'|'invalid'|'empty'} kind
 * @property {string} label            routing indicator text
 * @property {number} tokens           estimated model tokens
 * @property {string=} detail          tooltip
 * @property {any=} delta              for numeric edits
 * @property {string=} target
 * @property {string=} summary
 * @property {string=} command
 * @property {string=} args
 */

const STRUCTURAL = /\b(add|remove|delete|drop|rename|link|unlink|connect|disconnect|split|merge|introduce|insert|create|hire|fire|open another|close down|skip|without)\b/i;
const NUMBER_RE = /([-+−]?\$?\s*\d[\d,]*(?:\.\d+)?)\s*(k|m|%|percent)?/i;

/** @param {string} raw @returns {{value: number, percent: boolean}|null} */
export function parseNumber(raw) {
  const m = NUMBER_RE.exec(raw);
  if (!m) return null;
  let v = Number(m[1].replace(/[$,\s]/g, '').replace('−', '-'));
  if (!Number.isFinite(v)) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') v *= 1e3;
  if (suf === 'm') v *= 1e6;
  return { value: v, percent: suf === '%' || suf === 'percent' };
}

export class Router {
  /** @param {{ getEngine: () => import('../model/engine.js').JsEngine }} deps */
  constructor({ getEngine }) {
    this.getEngine = getEngine;
  }

  /**
   * @param {string} text
   * @param {{scopes?: string[], scenarioId?: string|null}} [ctx]
   * @returns {Route}
   */
  classify(text, ctx = {}) {
    const t = text.trim();
    if (!t) return { kind: 'empty', label: 'type to see routing', tokens: 0 };
    if (t.startsWith('/')) {
      const [cmd, ...rest] = t.slice(1).split(/\s+/);
      return { kind: 'command', label: 'command', tokens: 0, command: cmd.toLowerCase(), args: rest.join(' '), detail: `Slash command /${cmd}` };
    }
    const numeric = this.parseNumeric(t, ctx);
    if (numeric) return numeric;
    if (STRUCTURAL.test(t)) {
      return { kind: 'structural', label: 'model · ~3k tokens', tokens: 3000, detail: 'Structural change: the model proposes ScopeDeltas (1k-5k tokens); the compiler and verifiers check them before they land' };
    }
    return { kind: 'question', label: 'model · ~40k tokens', tokens: 40000, detail: 'New question: a swarm build on the model (20k-80k tokens)' };
  }

  /**
   * Recognize numeric edits and build the delta.
   * @param {string} t @param {{scopes?: string[], scenarioId?: string|null}} ctx
   * @returns {Route|null}
   */
  parseNumeric(t, ctx) {
    const engine = this.getEngine();
    const g = engine?.graph;
    if (!g) return null;
    const s = t.replace(/[?!]+$/, '').trim();
    let m;
    /** @type {{name: string, op: 'set'|'add'|'mul'|'param', raw: string, param?: string}|null} */
    let parsed = null;
    if ((m = /^(?:set|change|make|put|update)\s+(.+?)\s+(?:to|=|at)\s+(.+)$/i.exec(s))) parsed = { name: m[1], op: 'set', raw: m[2] };
    else if ((m = /^(?:make|set)\s+(.+?)\s+(p10|p50|p90|median|mean|sd|min|max|mode|alpha|beta)\s+(?:to\s+|=\s*)?(.+)$/i.exec(s))) parsed = { name: m[1], op: 'param', param: m[2].toLowerCase(), raw: m[3] };
    else if ((m = /^(?:increase|raise|bump)\s+(.+?)\s+by\s+(.+)$/i.exec(s))) parsed = { name: m[1], op: 'add', raw: m[2] };
    else if ((m = /^(?:decrease|lower|reduce|cut|drop)\s+(.+?)\s+by\s+(.+)$/i.exec(s))) parsed = { name: m[1], op: 'add', raw: `-${m[2].replace(/^[-+]/, '')}` };
    else if ((m = /^(.+?)\s*(?:=|:|to)\s*([-+−]?\$?\s*\d[\d,.]*\s*(?:k|m|%)?\s*(?:[A-Za-z/]+)?)$/i.exec(s))) parsed = { name: m[1], op: 'set', raw: m[2] };
    else if ((m = /^(@?[A-Za-z_][\w.&@ ]*?)\s+([+\-−]\s*\$?\d[\d,.]*\s*(?:k|%)?)$/i.exec(s))) parsed = { name: m[1], op: 'add', raw: m[2] };
    else if ((m = /^(@?[A-Za-z_][\w.@]*)\s+(\$?\d[\d,.]*\s*(?:k|m|%)?\s*(?:[A-Za-z/]+)?)$/i.exec(s))) parsed = { name: m[1], op: 'set', raw: m[2] };
    if (!parsed) return null;
    const num = parseNumber(parsed.raw);
    if (!num) return null;
    const target = this.resolveTarget(parsed.name, ctx);
    if (!target) return null;
    const node = /** @type {any} */ (g.node(target));
    const path = g.path(target);
    if (node.kind === 'computed') {
      const ins = (node.deps || []).slice(0, 3).map((d) => g.node(d)?.name).join(', ');
      return { kind: 'invalid', label: 'computed: edit its inputs', tokens: 0, detail: `${path} is computed; edit its inputs (${ins}) or ask the model to rewire it`, target };
    }
    const unit = node.type.unit;
    // explicit unit in the text (e.g. "rent to 230 USD/day")
    const unitMatch = /\d\s*(?:k|m)?\s*([A-Za-z$][A-Za-z$/0-9]*)\s*$/.exec(parsed.raw.trim());
    let factor = 1;
    if (unitMatch && !/^(k|m|percent)$/i.test(unitMatch[1])) {
      try {
        const from = parseUnit(unitMatch[1]);
        const to = parseUnit(unit);
        if (sameDims(from, to)) factor = convertFactor(from, to);
      } catch { /* not a unit */ }
    }
    const cur = engine.value(target);
    let delta;
    let summary;
    if (parsed.op === 'param') {
      if (!node.dist) return { kind: 'invalid', label: 'no distribution', tokens: 0, detail: `${path} is a point value; set it directly`, target };
      const spec = { ...node.dist };
      let p = /** @type {string} */ (parsed.param);
      if (p === 'p50') p = 'median';
      let v = num.value * factor;
      if (num.percent && /^(1|prob|ratio)$/.test(unit)) v /= 100;
      if (spec.family === 'LogNormal' && (p === 'median' || p === 'p90')) spec[p] = v;
      else if (spec.family === 'Normal' && (p === 'mean' || p === 'sd' || p === 'median')) spec[p === 'median' ? 'mean' : p] = v;
      else if (spec.family === 'Beta' && (p === 'alpha' || p === 'beta')) spec[p] = v;
      else if ((spec.family === 'Uniform' || spec.family === 'Triangular') && (p === 'min' || p === 'max' || p === 'mode')) spec[p] = v;
      else return { kind: 'invalid', label: `no ${p} on ${spec.family}`, tokens: 0, detail: `${spec.family} has parameters ${Object.keys(spec).filter((k) => k !== 'family').join(', ')}`, target };
      try { makeDist(spec).quantile(0.5); } catch { return null; }
      delta = { op: 'set', target, dist: spec, prov: 'input', expect: g.versionLabel };
      summary = `${path} ~ ${describe(spec)}`;
    } else {
      let v = num.value * factor;
      if (parsed.op === 'add') {
        v = num.percent ? cur * (1 + num.value / 100) : cur + num.value * factor;
      } else if (num.percent && /^(1|prob|ratio|1\/year|share)$/.test(unit)) v = num.value / 100;
      else if (num.percent) v = cur * (num.value / 100);
      if (!Number.isFinite(v)) return null;
      if (node.dist && node.dist.family !== 'Point') {
        // shift the distribution's location, keep its spread
        const spec = shiftDist(node.dist, cur, v);
        delta = { op: 'set', target, dist: spec, prov: 'input', expect: g.versionLabel };
        summary = `${path} centered at ${unitValue(v, unit)} (${describe(spec)})`;
      } else {
        delta = { op: 'set', target, value: v, prov: 'input', expect: g.versionLabel };
        summary = `${path} = ${unitValue(v, unit)}`;
      }
    }
    if (ctx.scenarioId && ctx.scenarioId !== 'base') delta.scenario = ctx.scenarioId;
    return {
      kind: 'numeric',
      label: 'local · 0 tokens',
      tokens: 0,
      delta,
      target,
      summary,
      detail: `Numeric edit: set ${summary}${delta.scenario ? ' in the active scenario' : ''}. Recomputes in the browser engine, zero model tokens.${node.kind !== 'input' ? ` ${node.kind} → input.` : ''}`,
    };
  }

  /**
   * Resolve a free-text metric name to an editable node: "rent", "@Bakery.rent", "loan rate".
   * Prefers editable metrics, then the composer's context scopes, then the shallowest path.
   * @param {string} name @param {{scopes?: string[]}} ctx
   */
  resolveTarget(name, ctx = {}) {
    const engine = this.getEngine();
    const g = engine.graph;
    let q = name.trim().replace(/^the\s+/i, '').replace(/^@/, '').replace(/['"]/g, '');
    if (!q) return null;
    // explicit path
    const byPath = [...g.nodes.keys()].find((id) => g.path(id).toLowerCase() === q.toLowerCase());
    if (byPath) return byPath;
    if (q.includes('.')) {
      const r = g.resolveBindingPath(q);
      if (r) return r.nodeId;
    }
    q = q.replace(/\s+/g, '_').toLowerCase();
    const aliases = { loan_rate: 'rate', interest: 'rate', interest_rate: 'rate', bread_price: 'price', cost: 'unit_cost', traffic: 'foot_traffic', capture: 'capture_rate', ticket: 'avg_ticket', discount: 'max_discount' };
    q = aliases[q] || q;
    const cands = [...g.nodes.values()].filter((n) => n.name.toLowerCase() === q);
    const pool = cands.length ? cands : [...g.nodes.values()].filter((n) => n.name.toLowerCase().startsWith(q) || (n.label || '').toLowerCase().includes(q.replace(/_/g, ' ')));
    if (!pool.length) return null;
    const ctxScopes = new Set((ctx.scopes || []).map((id) => g.scopeIdOf(id)));
    const depth = (n) => g.path(n.id).split('.').length;
    pool.sort((a, b) => {
      const ea = g.isEditable(a.id) ? 0 : 1;
      const eb = g.isEditable(b.id) ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const ca = ctxScopes.has(a.scope) ? 0 : 1;
      const cb = ctxScopes.has(b.scope) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return depth(a) - depth(b);
    });
    return pool[0].id;
  }
}
