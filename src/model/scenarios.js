/**
 * Scenarios: forks of the graph plus overrides, stored copy-on-write. A scenario holds only its
 * own overrides; resolvedOverrides() merges the parent chain (base <- parent <- child), and the
 * engine evaluates the merged overlay on top of the shared base arrays, so 1,000 scenarios
 * share every unchanged node. No DOM.
 * @module model/scenarios
 */
import { uid } from '../core/ids.js';

/** @typedef {import('./types.js').Scenario} Scenario */

export class ScenarioStore {
  constructor() {
    /** @type {Map<string, Scenario & {_view?: any, _viewKey?: string, created: number}>} */
    this.map = new Map();
    this.rev = 0;
    this._order = 0;
    this.map.set('base', { id: 'base', name: 'base', parentId: null, baseVersion: '', overrides: new Map(), rev: 0, color: 0, createdBy: 'model', created: this._order++ });
  }

  list() {
    return [...this.map.values()].sort((a, b) => a.created - b.created);
  }

  /** @param {string} id */
  get(id) { return this.map.get(id) || null; }
  has(id) { return this.map.has(id); }

  /**
   * @param {{id?: string, name: string, parentId?: string, overrides?: Map<string, any>|Array<{target: string, value?: number, dist?: any}>, createdBy?: string, note?: string, baseVersion?: string}} spec
   */
  create(spec) {
    const id = spec.id || uid('scn');
    const overrides = new Map();
    if (spec.overrides instanceof Map) for (const [k, v] of spec.overrides) overrides.set(k, { ...v });
    else for (const o of spec.overrides || []) overrides.set(o.target, cleanOverride(o));
    const used = new Set([...this.map.values()].map((s) => s.color));
    let color = 1;
    while (used.has(color) && color < 7) color++;
    const sc = {
      id,
      name: spec.name,
      parentId: spec.parentId || 'base',
      baseVersion: spec.baseVersion || '',
      overrides,
      rev: 0,
      color,
      createdBy: spec.createdBy || 'user',
      note: spec.note,
      created: this._order++,
    };
    this.map.set(id, sc);
    this.touch();
    return sc;
  }

  /** @param {string} id @param {string} nodeId @param {{value?: number, dist?: any}|null} ov */
  setOverride(id, nodeId, ov) {
    const sc = this.map.get(id);
    if (!sc || id === 'base') return;
    if (ov) sc.overrides.set(nodeId, cleanOverride(ov));
    else sc.overrides.delete(nodeId);
    sc.rev++;
    this.touch();
  }

  /** @param {string} id @param {string} name */
  rename(id, name) {
    const sc = this.map.get(id);
    if (!sc || id === 'base') return;
    sc.name = name;
    this.touch();
  }

  /** Remove a scenario; its children are re-parented to its parent. @param {string} id */
  remove(id) {
    const sc = this.map.get(id);
    if (!sc || id === 'base') return null;
    for (const other of this.map.values()) if (other.parentId === id) other.parentId = sc.parentId;
    this.map.delete(id);
    this.touch();
    return sc;
  }

  /**
   * Overrides merged along the parent chain (child wins).
   * @param {string} id
   * @returns {Map<string, {value?: number, dist?: any}>}
   */
  resolvedOverrides(id) {
    const chain = [];
    let cur = this.map.get(id);
    let guard = 0;
    while (cur && guard++ < 64) {
      chain.unshift(cur);
      cur = cur.parentId ? this.map.get(cur.parentId) : undefined;
    }
    const out = new Map();
    for (const sc of chain) for (const [k, v] of sc.overrides) out.set(k, v);
    return out;
  }

  /** Children of a scenario (tree view). @param {string} id */
  children(id) {
    return this.list().filter((s) => s.parentId === id);
  }

  touch() {
    this.rev++;
    for (const s of this.map.values()) s._view = undefined;
  }
}

/** @param {any} o */
function cleanOverride(o) {
  const out = {};
  if (o.value !== undefined) out.value = o.value;
  if (o.dist) out.dist = o.dist;
  return out;
}

/**
 * Evaluate one sweep cell: base scenario overrides + x (+ y) values.
 * @param {import('./engine.js').JsEngine} engine
 * @param {Map<string, any>} baseOverrides
 * @param {{id: string, value: number}} x
 * @param {{id: string, value: number}|null} y
 * @param {(view: any) => number} measure
 */
export function sweepCell(engine, baseOverrides, x, y, measure) {
  const ov = new Map(baseOverrides);
  ov.set(x.id, { value: x.value });
  if (y) ov.set(y.id, { value: y.value });
  return measure(engine.evaluate(ov, { mc: true }));
}

/** Evenly spaced values lo..hi with a step (inclusive, capped). */
export function stepsFor(lo, hi, step, cap = 41) {
  const out = [];
  if (!(step > 0) || !(hi > lo)) return [lo];
  for (let v = lo; v <= hi + step * 1e-9 && out.length < cap; v += step) out.push(Math.round(v * 1e9) / 1e9);
  return out;
}
