/**
 * Scenarios: the global active scenario (areas may override it), forks, overrides, compare,
 * sweeps and goal seek. All changes go through ScopeDeltas (fork / set with scenario /
 * delete_scenario) so they are versioned, undoable and persisted. No DOM.
 * @module services/scenario-service
 */
import { uid } from '../core/ids.js';
import { sweepCell } from '../model/scenarios.js';

export class ScenarioService {
  /**
   * @param {{
   *   events: import('../core/events.js').EventBus,
   *   engine: import('../model/engine.js').JsEngine,
   *   history: import('./history.js').HistoryService,
   * }} deps
   */
  constructor({ events, engine, history }) {
    this.events = events;
    this.engine = engine;
    this.history = history;
    this.activeId = 'base';
    events.on('delta:applied', (p) => {
      if (p.deltas.some((d) => d.op === 'fork' || d.op === 'delete_scenario' || d.scenario)) {
        if (!this.engine.scenarios.has(this.activeId)) this.activeId = 'base';
        this.events.emit('scenario:changed', { activeId: this.activeId, reason: 'changed' });
      }
    });
  }

  get store() { return this.engine.scenarios; }

  list() { return this.store.list(); }
  /** @param {string|null} id */
  get(id) { return this.store.get(id || 'base'); }
  /** @param {string|null|undefined} id */
  label(id) { return this.store.get(id || 'base')?.name || 'base'; }

  /** @param {string} id */
  setActive(id) {
    if (!this.store.has(id) || id === this.activeId) return;
    this.activeId = id;
    this.events.emit('scenario:changed', { activeId: id, reason: 'active' });
  }

  /** @param {string|null|undefined} id */
  view(id) {
    return this.engine.view(id || 'base');
  }

  /**
   * Fork a scenario. Returns {ok, id, errors}.
   * @param {string} name
   * @param {Array<{target: string, value?: number, dist?: any}>} overrides
   * @param {{parent?: string, author?: string, note?: string, tokens?: number}} [opts]
   */
  fork(name, overrides = [], opts = {}) {
    const id = uid('scn');
    const res = this.history.apply([{ op: 'fork', id, name, parent: opts.parent || 'base', overrides, note: opts.note, author: opts.author }], { author: opts.author || 'user', tokens: opts.tokens || 0 });
    return { ok: res.ok, id: res.ok ? id : null, errors: res.errors };
  }

  /** @param {string} id @param {string} target @param {{value?: number, dist?: any}|null} ov */
  setOverride(id, target, ov) {
    if (!ov) return this.history.apply([{ op: 'set', scenario: id, target, clear: true }]);
    return this.history.apply([{ op: 'set', scenario: id, target, value: ov.value, dist: ov.dist }]);
  }

  /** @param {string} id */
  remove(id) {
    if (id === 'base') return null;
    return this.history.apply([{ op: 'delete_scenario', id }]);
  }

  /** @param {string} id @param {string} name */
  rename(id, name) {
    this.store.rename(id, name);
    this.events.emit('scenario:changed', { activeId: this.activeId, reason: 'rename', id });
  }

  /**
   * Compare key outputs across scenarios.
   * @param {string[]} ids @param {string[]} outputs
   */
  compare(ids, outputs) {
    const base = this.view('base');
    return outputs.map((out) => {
      const node = this.engine.graph.node(out);
      const baseStats = base.stats(out);
      return {
        id: out,
        unit: node?.type.unit || '',
        cells: ids.map((sid) => {
          const v = this.view(sid);
          const s = v.stats(out);
          return { scenarioId: sid, stats: s, value: v.value(out), delta: s && baseStats ? s.p50 - baseStats.p50 : 0 };
        }),
      };
    });
  }

  /**
   * Run a 1- or 2-input sweep in chunks so the UI stays responsive.
   * @param {{
   *   scenarioId?: string,
   *   x: {id: string, values: number[]},
   *   y?: {id: string, values: number[]} | null,
   *   output: {id: string, stat: 'p50'|'prob_lt'|'mean'|'p10'|'p90', threshold?: number},
   * }} spec
   * @param {(progress: {done: number, total: number, grid: number[][]}) => void} onProgress
   * @param {{signal?: {aborted: boolean}}} [opts]
   */
  async sweep(spec, onProgress, opts = {}) {
    const base = this.store.resolvedOverrides(spec.scenarioId || 'base');
    const ys = spec.y ? spec.y.values : [NaN];
    const grid = ys.map(() => spec.x.values.map(() => NaN));
    const total = spec.x.values.length * ys.length;
    let done = 0;
    const measure = (view) => {
      if (spec.output.stat === 'prob_lt') return view.prob(spec.output.id, '<', spec.output.threshold ?? 0);
      const s = view.stats(spec.output.id);
      return s ? /** @type {any} */ (s)[spec.output.stat] : NaN;
    };
    for (let yi = 0; yi < ys.length; yi++) {
      for (let xi = 0; xi < spec.x.values.length; xi++) {
        if (opts.signal?.aborted) return grid;
        grid[yi][xi] = sweepCell(this.engine, base, { id: spec.x.id, value: spec.x.values[xi] }, spec.y ? { id: spec.y.id, value: ys[yi] } : null, measure);
        done++;
        if (done % 4 === 0) {
          onProgress({ done, total, grid });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }
    onProgress({ done, total, grid });
    return grid;
  }

  /**
   * Goal seek and write the result as a NEW scenario (never over the user's inputs).
   * @param {import('../model/goalseek.js').GoalSeekSpec & {name?: string}} spec
   */
  goalSeek(spec) {
    const res = this.engine.goalSeek(spec);
    if (!res.ok || !Number.isFinite(res.value) || res.iterations === 0 && res.value === res.current) return { result: res, scenarioId: null };
    // the same answer twice reuses the scenario it already wrote instead of adding a duplicate
    const same = this.list().find((s) => s.id !== 'base' && s.parentId === 'base' && s.overrides.size === 1
      && Math.abs((s.overrides.get(spec.decision.id)?.value ?? NaN) - res.value) <= 1e-9 * Math.max(1, Math.abs(res.value)));
    if (same) return { result: res, scenarioId: same.id, reused: true };
    const dnode = this.engine.graph.node(spec.decision.id);
    const name = spec.name || `Goal seek: ${dnode?.name} = ${Math.abs(res.value) >= 100 ? Math.round(res.value) : res.value.toFixed(2)}`;
    const f = this.fork(name, [{ target: spec.decision.id, value: res.value }], { note: res.message });
    return { result: res, scenarioId: f.id, reused: false };
  }
}
