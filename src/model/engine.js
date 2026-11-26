/**
 * The mock Scope Engine (JS), behind the EngineAdapter interface so the Rust->WASM build (or a
 * Web Worker) can replace it mechanically. No DOM.
 *
 * EngineAdapter:
 *   load(graph) · apply(deltas, meta) · run(targets, mode) · sample(id) · stats(id)
 *   · sensitivity(output) · goalSeek(spec)
 * plus value(id), prob(id, op, t), view(scenarioId), evaluate(overrides), constraintStatus(),
 * setSamples(n), watch(ids).
 *
 * Execution model (spec 5.1-5.4):
 *  - Point pass: dirty roots -> downstream cone (reverse-dependency index) -> recompute in
 *    topological order with EARLY CUTOFF (a node whose deps did not change is skipped).
 *  - Monte Carlo: n samples (default 1,000) per stochastic node as Float64Array. Leaves draw
 *    Latin-hypercube uniforms (or Gaussian-copula uniforms for correlated assumptions) from the
 *    counter-based RNG keyed by (graph lineage + seed, node id, sample index). Uniforms are
 *    cached per node, so editing a distribution only re-maps quantiles (common random numbers).
 *    Computed nodes run generated vector kernels; deterministic deps are scalars.
 *  - Statistic nodes (prob_lt, quantile, mean_of) reduce over their argument's samples.
 *  - Scenarios are copy-on-write overlays: only the cone of the overridden nodes is recomputed;
 *    everything else reads through to the base arrays.
 * @module model/engine
 */
import { compile } from './expr.js';
import { makeDist, nominal } from './distributions.js';
import { keyOf, lhsUniforms, copulaUniforms } from './rng.js';
import { applyDeltas } from './delta.js';
import { ScenarioStore } from './scenarios.js';
import { sensitivity as runSensitivity } from './sensitivity.js';
import { goalSeek as runGoalSeek } from './goalseek.js';

export const ENGINE_NAME = 'js-mock';
export const ENGINE_VERSION = '0.9.0 (mock of engine 1.4.2)';
/** Above this many nodes, Monte Carlo runs lazily for nodes nobody watches. */
const EAGER_MC_LIMIT = 20000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @param {Float64Array} arr
 * @returns {import('./types.js').Stats}
 */
export function computeStats(arr) {
  const n = arr.length;
  const s = Float64Array.from(arr).sort();
  const q = (p) => {
    const x = p * (n - 1);
    const lo = Math.floor(x);
    const hi = Math.min(n - 1, lo + 1);
    return s[lo] + (s[hi] - s[lo]) * (x - lo);
  };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (arr[i] - mean) ** 2;
  return {
    p05: q(0.05), p10: q(0.1), p50: q(0.5), p90: q(0.9), p95: q(0.95),
    mean, sd: Math.sqrt(ss / Math.max(1, n - 1)), min: s[0], max: s[n - 1], n, deterministic: false,
  };
}

/** @param {number} v @returns {import('./types.js').Stats} */
function pointStats(v) {
  return { p05: v, p10: v, p50: v, p90: v, p95: v, mean: v, sd: 0, min: v, max: v, n: 1, deterministic: true };
}

export class JsEngine {
  /**
   * @param {{ samples?: number, onRecomputed?: (payload: any) => void, onRejected?: (payload: any) => void, prototypes?: any }} [opts]
   */
  constructor(opts = {}) {
    this.name = ENGINE_NAME;
    this.engineVersion = ENGINE_VERSION;
    this.n = opts.samples || 1000;
    this.onRecomputed = opts.onRecomputed || (() => {});
    this.onRejected = opts.onRejected || (() => {});
    /** @type {import('./graph.js').ScopeGraph} */
    this.graph = /** @type {any} */ (null);
    this.scenarios = new ScenarioStore();
    /** increments on every recompute (cache key for views and stats) */
    this.computeVersion = 0;
    /** @type {Map<string, number>} */
    this.watched = new Map();
    this.lastRecompute = null;
    this.errors = [];
  }

  // ------------------------------------------------------------------ EngineAdapter

  /** @param {import('./graph.js').ScopeGraph} graph */
  load(graph) {
    const t0 = now();
    this.graph = graph;
    this.seedKey = keyOf(`${graph.graphId}:${graph.seed}`);
    this._rebuild();
    const r = this._recomputeAll();
    const ms = now() - t0;
    return { ...r, ms };
  }

  /**
   * Validate and apply ScopeDeltas, then recompute only what they affect.
   * @param {import('./types.js').ScopeDelta[]} deltas
   * @param {{author?: string, tokens?: number, kind?: string, silent?: boolean}} [meta]
   */
  apply(deltas, meta = {}) {
    const g = this.graph;
    const res = applyDeltas(g, this.scenarios, deltas);
    if (!res.ok) {
      const payload = { deltas, errors: res.errors, author: meta.author || 'user' };
      this.onRejected(payload);
      return { ok: false, errors: res.errors, version: g.versionLabel, changed: [], ms: 0, mcMs: 0, nodes: 0, structural: false };
    }
    // transient previews (slider drags) recompute without creating a version
    if (!meta.transient) g.version += 1;
    let out;
    if (res.structural) {
      g.reindex();
      this._rebuild();
      out = this._recomputeAll();
    } else {
      const roots = [];
      let stochChanged = false;
      for (const id of res.changedNodes) {
        const i = g.index.get(id);
        if (i === undefined) continue;
        const node = this.list[i];
        g.rehashNode(id);
        if (node.kind === 'computed') {
          // rewire: recompile this node
          this._compileNode(i);
        } else {
          this.point[i] = leafValue(node);
          const wasStoch = this.stoch[i] === 1;
          const isStoch = hasDist(node);
          if (wasStoch !== isStoch) stochChanged = true;
          this.stoch[i] = isStoch ? 1 : 0;
          this.statsCache[i] = null;
        }
        roots.push(i);
      }
      if (stochChanged) this._refreshStochastic(roots);
      out = this._recompute(roots, { regenerate: new Set(roots) });
    }
    if (res.scenarioChanged) this.scenarios.touch();
    const payload = {
      version: g.versionLabel, hash: g.shortHash, changed: out.changed, ms: out.ms, mcMs: out.mcMs, nodes: out.nodes,
      tokens: meta.tokens || 0, author: meta.author || 'user', kind: meta.kind || 'edit', structural: !!res.structural,
      scenarioChanged: !!res.scenarioChanged, full: !!res.structural, deltas, summaries: res.summaries, inverses: res.inverses,
      transient: !!meta.transient,
    };
    this.lastRecompute = payload;
    if (!meta.silent) this.onRecomputed(payload);
    return { ok: true, ...payload };
  }

  /**
   * @param {string[]} targets @param {'point'|'mc'|'sensitivity'} [mode]
   */
  run(targets, mode = 'point') {
    if (mode === 'sensitivity') return this.sensitivity(targets[0]);
    const out = {};
    for (const id of targets) out[id] = mode === 'mc' ? this.stats(id) : this.value(id);
    return out;
  }

  /** Point value (statistic nodes return their statistic). @param {string} id */
  value(id) {
    const i = this.graph.index.get(id);
    if (i === undefined) return NaN;
    if (this.statSpec[i] && this.mcDirty[i]) this._ensureMC(i);
    return this.point[i];
  }

  /** Samples (null if deterministic). @param {string} id */
  sample(id) {
    const i = this.graph.index.get(id);
    if (i === undefined || !this.stoch[i]) return null;
    if (this.mcDirty[i] || !this.samples[i]) this._ensureMC(i);
    return this.samples[i];
  }

  /** @param {string} id @returns {import('./types.js').Stats|null} */
  stats(id) {
    const i = this.graph.index.get(id);
    if (i === undefined) return null;
    if (!this.stoch[i]) return pointStats(this.value(id));
    if (this.mcDirty[i] || !this.samples[i]) this._ensureMC(i);
    let s = this.statsCache[i];
    if (!s) {
      s = computeStats(/** @type {Float64Array} */ (this.samples[i]));
      this.statsCache[i] = s;
    }
    return s;
  }

  /**
   * Threshold probability over the Monte Carlo samples.
   * @param {string} id @param {'<'|'<='|'>'|'>='} op @param {number} t
   */
  prob(id, op, t) {
    const arr = this.sample(id);
    if (!arr) {
      const v = this.value(id);
      return cmp(v, op, t) ? 1 : 0;
    }
    let c = 0;
    for (let k = 0; k < arr.length; k++) if (cmp(arr[k], op, t)) c++;
    return c / arr.length;
  }

  /** @param {string} output @param {any} [opts] */
  sensitivity(output, opts) {
    return runSensitivity(this, output, opts);
  }

  /** @param {any} spec */
  goalSeek(spec) {
    return runGoalSeek(this, spec);
  }

  /** Change the Monte Carlo sample count (full MC recompute). @param {number} n */
  setSamples(n) {
    if (n === this.n) return;
    this.n = n;
    this.uniCache.clear();
    this.samples = new Array(this.N).fill(null);
    const r = this._recomputeAll();
    const payload = { ...r, version: this.graph.versionLabel, hash: this.graph.shortHash, tokens: 0, author: 'user', kind: 'samples', structural: false, full: true };
    this.lastRecompute = payload;
    this.onRecomputed(payload);
  }

  /** Mark ids as visible (eager Monte Carlo on large graphs). @param {string[]} ids */
  watch(ids) {
    for (const id of ids) this.watched.set(id, (this.watched.get(id) || 0) + 1);
    return {
      dispose: () => {
        for (const id of ids) {
          const c = (this.watched.get(id) || 1) - 1;
          if (c <= 0) this.watched.delete(id);
          else this.watched.set(id, c);
        }
      },
    };
  }

  /** Full recompute (Graph menu). */
  recomputeAll() {
    const r = this._recomputeAll();
    const payload = { ...r, version: this.graph.versionLabel, hash: this.graph.shortHash, tokens: 0, author: 'user', kind: 'recompute', structural: false, full: true };
    this.lastRecompute = payload;
    this.onRecomputed(payload);
    return payload;
  }

  // ------------------------------------------------------------------ scenarios / overlays

  /**
   * View for a scenario id (null/'base' -> the engine itself). Views share the value/stats/
   * sample/prob interface and are cached until the base graph or the scenario changes.
   * @param {string|null|undefined} scenarioId
   */
  view(scenarioId) {
    if (!scenarioId || scenarioId === 'base') return this;
    const sc = this.scenarios.get(scenarioId);
    if (!sc) return this;
    const key = `${this.computeVersion}:${this.scenarios.rev}:${this.n}`;
    if (sc._view && sc._viewKey === key) return sc._view;
    const overrides = this.scenarios.resolvedOverrides(scenarioId);
    sc._view = this.evaluate(overrides);
    sc._viewKey = key;
    return sc._view;
  }

  /**
   * Evaluate an overlay of overrides without touching the base state.
   * @param {Map<string, {value?: number, dist?: any}>} overrides
   * @param {{mc?: boolean}} [opts]
   */
  evaluate(overrides, opts = {}) {
    return new OverlayView(this, overrides, opts);
  }

  /** Fast point-only evaluation of one target under overrides (tornado swings, goal seek brackets). */
  pointUnder(overrides, targetId) {
    const v = new OverlayView(this, overrides, { mc: false });
    return v.value(targetId);
  }

  // ------------------------------------------------------------------ constraints

  /**
   * @param {OverlayView|JsEngine} [view]
   * @returns {Array<{id: string, scope: string, label: string, severity: string, ok: boolean, share: number|null, deps: string[]}>}
   */
  constraintStatus(view) {
    const src = view || this;
    const key = src === this ? `${this.computeVersion}` : null;
    if (key && this._constraintKey === key) return this._constraintCache;
    const out = [];
    for (const [id, c] of this.graph.constraints) {
      const compiled = this.constraintFns.get(id);
      if (!compiled) { out.push({ id, scope: c.scope, label: c.label, severity: c.severity, ok: false, share: null, deps: c.deps }); continue; }
      const v = src === this ? this.point : /** @type {OverlayView} */ (src).pointArray();
      let ok;
      try { ok = compiled.point(v) === 1; } catch { ok = false; }
      let share = null;
      if (compiled.vector) {
        const S = src === this ? this._samplesFor(c.deps) : /** @type {OverlayView} */ (src).samplesArray(c.deps);
        const out2 = new Float64Array(this.n);
        try {
          compiled.vector(S, v, this.n, out2);
          let s = 0;
          for (let k = 0; k < this.n; k++) s += out2[k];
          share = s / this.n;
        } catch { share = null; }
      }
      out.push({ id, scope: c.scope, label: c.label, severity: c.severity, ok, share, deps: c.deps });
    }
    if (key) { this._constraintKey = key; this._constraintCache = out; }
    return out;
  }

  /** @param {string[]} deps */
  _samplesFor(deps) {
    for (const d of deps) {
      const i = this.graph.index.get(d);
      if (i !== undefined && this.stoch[i] && (this.mcDirty[i] || !this.samples[i])) this._ensureMC(i);
    }
    return this.samples;
  }

  // ------------------------------------------------------------------ internals: build

  _rebuild() {
    const g = this.graph;
    this.list = g.list;
    const N = (this.N = g.list.length);
    this.point = new Float64Array(N);
    this.stoch = new Uint8Array(N);
    this.samples = new Array(N).fill(null);
    this.statsCache = new Array(N).fill(null);
    this.mcDirty = new Uint8Array(N);
    this.pointFn = new Array(N).fill(null);
    this.vecFn = new Array(N).fill(null);
    this.statSpec = new Array(N).fill(null);
    this.nodeKeys = new Uint32Array(N);
    this.uniCache = new Map();
    this.coneCache = new Map();
    this.chgP = new Uint8Array(N);
    this.chgS = new Uint8Array(N);
    this.mark = new Uint8Array(N);
    this.errors = [...g.errors];
    for (let i = 0; i < N; i++) {
      const node = this.list[i];
      this.nodeKeys[i] = keyOf(node.id);
      if (node.kind !== 'computed') {
        if (node.kind === 'estimated' && node.dist && node.value === undefined) {
          node.value = nominal(node.dist);
          // the graph hashed this node before it had a nominal value
          g.rehashNode(node.id);
        }
        this.point[i] = leafValue(node);
        this.stoch[i] = hasDist(node) ? 1 : 0;
      }
    }
    // stochastic flags in topological order, then compile
    for (const i of g.topo) {
      const node = this.list[i];
      if (node.kind !== 'computed') continue;
      const r = g.resolved.get(node.id);
      const isStat = Array.isArray(r) && ['prob_lt', 'prob_gt', 'quantile', 'mean_of'].includes(r[0]);
      let s = 0;
      if (!isStat) for (const d of g.depIdx[i]) if (d >= 0 && this.stoch[d]) { s = 1; break; }
      this.stoch[i] = s;
    }
    for (const i of g.topo) if (this.list[i].kind === 'computed') this._compileNode(i);
    // constraints
    this.constraintFns = new Map();
    for (const [id, c] of g.constraints) {
      try {
        this.constraintFns.set(id, compile(c.expr, { idxOf: (x) => g.index.get(x) ?? -1, unitOf: (x) => g.unitOf(x), stochastic: (x) => this.stoch[g.index.get(x) ?? -1] === 1, where: id }));
      } catch (err) {
        this.errors.push({ code: 'type_error', message: `constraint ${c.label}: ${/** @type {Error} */ (err).message}`, nodeId: c.scope });
      }
    }
  }

  /** @param {number} i */
  _compileNode(i) {
    const g = this.graph;
    const node = this.list[i];
    const r = g.resolved.get(node.id);
    this.statSpec[i] = null;
    if (r === undefined || (typeof r === 'number' && Number.isNaN(r))) {
      this.pointFn[i] = () => NaN;
      this.vecFn[i] = null;
      return;
    }
    try {
      const c = compile(r, {
        idxOf: (x) => g.index.get(x) ?? -1,
        unitOf: (x) => g.unitOf(x),
        stochastic: (x) => this.stoch[g.index.get(x) ?? -1] === 1,
        where: g.path(node.id),
      });
      if (c.stat) {
        const argIdx = c.stat.arg && c.stat.arg.ref ? g.index.get(c.stat.arg.ref) ?? -1 : -1;
        this.statSpec[i] = { op: c.stat.op, argIdx, param: c.stat.param };
        this.pointFn[i] = null;
        this.vecFn[i] = null;
      } else {
        this.pointFn[i] = c.point;
        this.vecFn[i] = c.vector;
        if (this.stoch[i] && !c.vector) this.stoch[i] = 0;
      }
    } catch (err) {
      this.errors.push({ code: err.name === 'UnitError' ? 'unit_mismatch' : 'type_error', message: /** @type {Error} */ (err).message, hint: /** @type {any} */ (err).hint, nodeId: node.id });
      this.pointFn[i] = () => NaN;
      this.vecFn[i] = null;
    }
  }

  /** Stochasticity changed at some roots: recompute flags and kernels for their cones. @param {number[]} roots */
  _refreshStochastic(roots) {
    const g = this.graph;
    const cone = this._cone(roots);
    for (const i of cone) {
      const node = this.list[i];
      if (node.kind !== 'computed' || this.statSpec[i]) continue;
      let s = 0;
      for (const d of g.depIdx[i]) if (d >= 0 && this.stoch[d]) { s = 1; break; }
      this.stoch[i] = s;
      this._compileNode(i);
      if (!s) this.samples[i] = null;
      this.statsCache[i] = null;
    }
  }

  // ------------------------------------------------------------------ internals: recompute

  /** Downstream cone of roots (including roots), sorted topologically. @param {number[]} roots */
  _cone(roots) {
    if (roots.length === 1) {
      const hit = this.coneCache.get(roots[0]);
      if (hit) return hit;
    }
    const g = this.graph;
    const mark = this.mark;
    const out = [];
    const stack = [...roots];
    while (stack.length) {
      const i = /** @type {number} */ (stack.pop());
      if (mark[i]) continue;
      mark[i] = 1;
      out.push(i);
      for (const j of g.rev[i]) if (!mark[j]) stack.push(j);
    }
    for (const i of out) mark[i] = 0;
    const rank = g.rank;
    out.sort((a, b) => rank[a] - rank[b]);
    const arr = Int32Array.from(out);
    if (roots.length === 1) {
      if (this.coneCache.size > 512) this.coneCache.clear();
      this.coneCache.set(roots[0], arr);
    }
    return arr;
  }

  _recomputeAll() {
    const t0 = now();
    const g = this.graph;
    const topo = g.topo;
    for (let k = 0; k < topo.length; k++) {
      const i = topo[k];
      const fn = this.pointFn[i];
      if (fn) this.point[i] = fn(this.point);
    }
    const t1 = now();
    const lazy = this.N > EAGER_MC_LIMIT;
    for (let k = 0; k < topo.length; k++) {
      const i = topo[k];
      if (lazy && !this._isActive(i)) {
        this.mcDirty[i] = 1;
        this.statsCache[i] = null;
        continue;
      }
      this._mcNode(i, true);
    }
    // statistic dependents (rare): one more point pass
    for (let k = 0; k < topo.length; k++) {
      const i = topo[k];
      const fn = this.pointFn[i];
      if (fn && this._dependsOnStat(i)) this.point[i] = fn(this.point);
    }
    const t2 = now();
    this.computeVersion++;
    return { changed: this.list.map((n) => n.id), ms: t1 - t0, mcMs: t2 - t1, nodes: this.N };
  }

  /**
   * Incremental recompute from changed roots.
   * @param {number[]} roots @param {{regenerate?: Set<number>}} [opts]
   */
  _recompute(roots, opts = {}) {
    const t0 = now();
    const g = this.graph;
    const cone = this._cone(roots);
    const chgP = this.chgP;
    const chgS = this.chgS;
    const rootSet = new Set(roots);
    const changed = [];
    for (const r of roots) { chgP[r] = 1; chgS[r] = this.stoch[r]; changed.push(r); }

    // pass 1: point values with early cutoff
    for (let k = 0; k < cone.length; k++) {
      const i = cone[k];
      if (rootSet.has(i)) {
        const fn = this.pointFn[i];
        if (fn) { this.point[i] = fn(this.point); }
        continue;
      }
      const fn = this.pointFn[i];
      if (!fn) continue;
      let dirty = false;
      for (const d of g.depIdx[i]) if (d >= 0 && chgP[d]) { dirty = true; break; }
      if (!dirty) continue;
      const nv = fn(this.point);
      const ov = this.point[i];
      if (nv !== ov && !(Number.isNaN(nv) && Number.isNaN(ov))) {
        this.point[i] = nv;
        chgP[i] = 1;
        changed.push(i);
      }
    }
    const t1 = now();

    // pass 2: Monte Carlo for stochastic and statistic nodes whose inputs changed
    const lazy = this.N > EAGER_MC_LIMIT;
    let mcNodes = 0;
    for (let k = 0; k < cone.length; k++) {
      const i = cone[k];
      const isRoot = rootSet.has(i);
      if (!this.stoch[i] && !this.statSpec[i]) continue;
      let dirty = isRoot;
      if (!dirty) for (const d of g.depIdx[i]) if (d >= 0 && (chgS[d] || chgP[d])) { dirty = true; break; }
      if (!dirty) continue;
      if (lazy && !this._isActive(i)) { this.mcDirty[i] = 1; this.statsCache[i] = null; chgS[i] = 1; continue; }
      const before = this.statSpec[i] ? this.point[i] : 0;
      this._mcNode(i, opts.regenerate ? opts.regenerate.has(i) : isRoot);
      mcNodes++;
      if (this.stoch[i]) chgS[i] = 1;
      if (this.statSpec[i] && this.point[i] !== before) {
        chgP[i] = 1;
        if (!changed.includes(i)) changed.push(i);
      }
    }
    // pass 3: point dependents of statistic nodes
    for (let k = 0; k < cone.length; k++) {
      const i = cone[k];
      const fn = this.pointFn[i];
      if (!fn || !this._dependsOnStat(i)) continue;
      let dirty = false;
      for (const d of g.depIdx[i]) if (d >= 0 && chgP[d] && this.statSpec[d]) { dirty = true; break; }
      if (!dirty) continue;
      const nv = fn(this.point);
      if (nv !== this.point[i]) { this.point[i] = nv; chgP[i] = 1; if (!changed.includes(i)) changed.push(i); }
    }
    // stochastic nodes whose samples changed are "changed" for display too
    for (let k = 0; k < cone.length; k++) {
      const i = cone[k];
      if (chgS[i] && !chgP[i]) changed.push(i);
    }
    const t2 = now();
    for (let k = 0; k < cone.length; k++) { chgP[cone[k]] = 0; chgS[cone[k]] = 0; }
    this.computeVersion++;
    return { changed: [...new Set(changed)].map((i) => this.list[i].id), ms: t1 - t0, mcMs: t2 - t1, nodes: cone.length, mcNodes };
  }

  /** @param {number} i */
  _dependsOnStat(i) {
    for (const d of this.graph.depIdx[i]) if (d >= 0 && this.statSpec[d]) return true;
    return false;
  }

  /** Is node i in the eager Monte Carlo set (large graphs)? @param {number} i */
  _isActive(i) {
    if (this.N <= EAGER_MC_LIMIT) return true;
    if (this.statSpec[i]) return true;
    if (!this._activeSet || this._activeKey !== this.watched.size + ':' + this.graph.structureVersion) {
      const set = new Set();
      for (const id of this.watched.keys()) {
        const idx = this.graph.index.get(id);
        if (idx === undefined) continue;
        set.add(idx);
        for (const u of this.graph.upstream(id)) {
          const j = this.graph.index.get(u);
          if (j !== undefined) set.add(j);
        }
      }
      this._activeSet = set;
      this._activeKey = this.watched.size + ':' + this.graph.structureVersion;
    }
    return this._activeSet.has(i);
  }

  /** Compute samples (or the statistic) of one node from its deps. @param {number} i @param {boolean} regenerate */
  _mcNode(i, regenerate) {
    const node = this.list[i];
    const n = this.n;
    this.statsCache[i] = null;
    this.mcDirty[i] = 0;
    if (this.statSpec[i]) {
      this.point[i] = this._statValue(this.statSpec[i], this.samples, this.point);
      return;
    }
    if (!this.stoch[i]) return;
    let out = this.samples[i];
    if (!out || out.length !== n) out = this.samples[i] = new Float64Array(n);
    if (node.kind !== 'computed') {
      const u = this._uniforms(i);
      const dist = makeDist(/** @type {any} */ (node.dist));
      for (let k = 0; k < n; k++) out[k] = dist.quantile(u[k]);
      void regenerate;
      return;
    }
    const vf = this.vecFn[i];
    if (vf) {
      // make sure stochastic deps are materialized (lazy mode)
      for (const d of this.graph.depIdx[i]) if (d >= 0 && this.stoch[d] && (this.mcDirty[d] || !this.samples[d])) this._ensureMC(d);
      vf(this.samples, this.point, n, out);
    }
  }

  /** Lazily materialize Monte Carlo for node i and its upstream. @param {number} i */
  _ensureMC(i) {
    const g = this.graph;
    const order = [];
    const seen = new Set();
    const visit = (j) => {
      if (seen.has(j)) return;
      seen.add(j);
      for (const d of g.depIdx[j]) if (d >= 0 && (this.stoch[d] || this.statSpec[d]) && (this.mcDirty[d] || (this.stoch[d] && !this.samples[d]))) visit(d);
      order.push(j);
    };
    visit(i);
    for (const j of order) this._mcNode(j, true);
  }

  /** Cached uniforms for a leaf (LHS or copula). @param {number} i */
  _uniforms(i) {
    const hit = this.uniCache.get(i);
    if (hit && hit.length === this.n) return hit;
    const node = this.list[i];
    const u = node.corr
      ? copulaUniforms(this.seedKey, this.nodeKeys[i], keyOf(`factor:${node.corr.factor}`), node.corr.rho, this.n)
      : lhsUniforms(this.seedKey, this.nodeKeys[i], this.n);
    this.uniCache.set(i, u);
    return u;
  }

  /**
   * @param {{op: string, argIdx: number, param: number}} spec
   * @param {Array<Float64Array|null>} S @param {Float64Array} v
   */
  _statValue(spec, S, v) {
    const a = spec.argIdx;
    if (a < 0) return NaN;
    const arr = S[a];
    if (!arr || !this.stoch[a]) {
      const x = v[a];
      switch (spec.op) {
        case 'prob_lt': return x < spec.param ? 1 : 0;
        case 'prob_gt': return x > spec.param ? 1 : 0;
        default: return x;
      }
    }
    const n = arr.length;
    switch (spec.op) {
      case 'prob_lt': { let c = 0; for (let k = 0; k < n; k++) if (arr[k] < spec.param) c++; return c / n; }
      case 'prob_gt': { let c = 0; for (let k = 0; k < n; k++) if (arr[k] > spec.param) c++; return c / n; }
      case 'mean_of': { let s = 0; for (let k = 0; k < n; k++) s += arr[k]; return s / n; }
      case 'quantile': {
        const s = Float64Array.from(arr).sort();
        const x = spec.param * (n - 1);
        const lo = Math.floor(x);
        const hi = Math.min(n - 1, lo + 1);
        return s[lo] + (s[hi] - s[lo]) * (x - lo);
      }
      default: return NaN;
    }
  }
}

/**
 * Copy-on-write evaluation of overrides on top of the engine's base state.
 * Implements value / sample / stats / prob like the engine.
 */
export class OverlayView {
  /**
   * @param {JsEngine} engine
   * @param {Map<string, {value?: number, dist?: any}>} overrides
   * @param {{mc?: boolean}} opts
   */
  constructor(engine, overrides, opts = {}) {
    this.engine = engine;
    this.overrides = overrides;
    this.mc = opts.mc !== false;
    const g = engine.graph;
    const N = engine.N;
    const roots = [];
    for (const id of overrides.keys()) {
      const i = g.index.get(id);
      if (i !== undefined) roots.push(i);
    }
    this.roots = roots;
    this.cone = roots.length ? engine._cone(roots) : new Int32Array(0);
    this.inCone = new Set(this.cone);
    this.point = Float64Array.from(engine.point);
    /** @type {Array<Float64Array|null>} */
    this.S = engine.samples.slice();
    this.stoch = Uint8Array.from(engine.stoch);
    /** @type {Map<number, import('./types.js').Stats>} */
    this.statsCache = new Map();
    this._evaluate();
  }

  _evaluate() {
    const e = this.engine;
    const g = e.graph;
    const n = e.n;
    // leaves
    for (const i of this.roots) {
      const node = e.list[i];
      const o = this.overrides.get(node.id) || {};
      if (node.kind === 'computed') continue;
      if (o.dist) {
        this.stoch[i] = 1;
        this.point[i] = o.value ?? nominal(o.dist);
        if (this.mc) {
          const u = e._uniforms(i);
          const dist = makeDist(o.dist);
          const out = new Float64Array(n);
          for (let k = 0; k < n; k++) out[k] = dist.quantile(u[k]);
          this.S[i] = out;
        }
      } else if (o.value !== undefined) {
        this.stoch[i] = 0;
        this.point[i] = o.value;
        this.S[i] = null;
      }
    }
    // stochastic flags for the cone (may differ from base when overrides add/remove distributions)
    /** @type {Map<number, any>} */
    const recompiled = new Map();
    for (const i of this.cone) {
      if (this.roots.includes(i)) continue;
      if (e.list[i].kind !== 'computed' || e.statSpec[i]) continue;
      let s = 0;
      for (const d of g.depIdx[i]) if (d >= 0 && this.stoch[d]) { s = 1; break; }
      const wasDiff = s !== e.stoch[i] || g.depIdx[i].some((d) => d >= 0 && this.stoch[d] !== e.stoch[d]);
      this.stoch[i] = s;
      if (wasDiff) {
        try {
          recompiled.set(i, compile(g.resolved.get(e.list[i].id), {
            idxOf: (x) => g.index.get(x) ?? -1,
            unitOf: (x) => g.unitOf(x),
            stochastic: (x) => this.stoch[g.index.get(x) ?? -1] === 1,
          }));
        } catch { recompiled.set(i, null); }
      }
    }
    // point pass
    for (const i of this.cone) {
      if (this.roots.includes(i) && e.list[i].kind !== 'computed') continue;
      const fn = recompiled.get(i)?.point || e.pointFn[i];
      if (fn) this.point[i] = fn(this.point);
    }
    if (!this.mc) return;
    // Monte Carlo pass
    for (const i of this.cone) {
      if (this.roots.includes(i) && e.list[i].kind !== 'computed') continue;
      if (e.statSpec[i]) {
        const spec = e.statSpec[i];
        this.point[i] = e._statValue(spec, this._ensureDeps(spec.argIdx), this.point);
        continue;
      }
      if (!this.stoch[i]) { this.S[i] = null; continue; }
      const vf = recompiled.has(i) ? recompiled.get(i)?.vector : e.vecFn[i];
      if (!vf) continue;
      for (const d of g.depIdx[i]) if (d >= 0) this._ensureDeps(d);
      const out = new Float64Array(n);
      vf(this.S, this.point, n, out);
      this.S[i] = out;
    }
    // statistic dependents
    for (const i of this.cone) {
      const fn = e.pointFn[i];
      if (fn && e._dependsOnStat(i)) this.point[i] = fn(this.point);
    }
  }

  /** Materialize base samples for a dep outside the cone (lazy engines). @param {number} d */
  _ensureDeps(d) {
    const e = this.engine;
    if (d >= 0 && !this.inCone.has(d) && e.stoch[d] && (e.mcDirty[d] || !e.samples[d])) {
      e._ensureMC(d);
      this.S[d] = e.samples[d];
    }
    return this.S;
  }

  pointArray() { return this.point; }
  /** @param {string[]} deps */
  samplesArray(deps) {
    for (const id of deps) {
      const i = this.engine.graph.index.get(id);
      if (i !== undefined) this._ensureDeps(i);
    }
    return this.S;
  }

  /** @param {string} id */
  value(id) {
    const i = this.engine.graph.index.get(id);
    return i === undefined ? NaN : this.point[i];
  }

  /** @param {string} id */
  sample(id) {
    const e = this.engine;
    const i = e.graph.index.get(id);
    if (i === undefined || !this.stoch[i]) return null;
    if (!this.inCone.has(i)) return e.sample(id);
    return this.S[i];
  }

  /** @param {string} id */
  stats(id) {
    const e = this.engine;
    const i = e.graph.index.get(id);
    if (i === undefined) return null;
    if (!this.inCone.has(i)) return this.stoch[i] ? e.stats(id) : pointStats(this.point[i]);
    if (!this.stoch[i] || !this.S[i]) return pointStats(this.point[i]);
    let s = this.statsCache.get(i);
    if (!s) {
      s = computeStats(/** @type {Float64Array} */ (this.S[i]));
      this.statsCache.set(i, s);
    }
    return s;
  }

  /** @param {string} id @param {'<'|'<='|'>'|'>='} op @param {number} t */
  prob(id, op, t) {
    const arr = this.sample(id);
    if (!arr) return cmp(this.value(id), op, t) ? 1 : 0;
    let c = 0;
    for (let k = 0; k < arr.length; k++) if (cmp(arr[k], op, t)) c++;
    return c / arr.length;
  }
}

// ---------------------------------------------------------------- helpers

/** @param {any} node */
function hasDist(node) {
  return !!(node.dist && node.dist.family && node.dist.family !== 'Point');
}

/** @param {any} node */
function leafValue(node) {
  if (node.value !== undefined && node.value !== null && Number.isFinite(node.value)) return node.value;
  if (node.dist) return nominal(node.dist);
  return NaN;
}

/** @param {number} a @param {string} op @param {number} t */
function cmp(a, op, t) {
  switch (op) {
    case '<': return a < t;
    case '<=': return a <= t;
    case '>': return a > t;
    case '>=': return a >= t;
    default: return false;
  }
}
