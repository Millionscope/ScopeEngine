/**
 * A small reactive store for UI state (theme mode, MC sample count, status-bar readouts,
 * composer mode...). Paths are dot strings: 'status.lastRecompute'.
 *
 * select(path, cb) fires when the value at `path` (or any path under/above it) changes by
 * identity. batch(fn) coalesces notifications until fn returns.
 * @module core/store
 */
import { toDisposable, leakCounters } from './disposable.js';

/**
 * @param {any} obj @param {string[]} parts
 */
function getIn(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export class Store {
  /** @param {object} [initial] */
  constructor(initial = {}) {
    this._state = structuredClone(initial);
    /** @type {Map<string, Set<(value:any, path:string) => void>>} */
    this._subs = new Map();
    this._batchDepth = 0;
    /** @type {Set<string>} */
    this._pending = new Set();
  }

  /** @param {string} [path] */
  get(path) {
    if (!path) return this._state;
    return getIn(this._state, path.split('.'));
  }

  /**
   * Set a value (immutably copies the containers on the path).
   * @param {string} path @param {any} value
   */
  set(path, value) {
    const parts = path.split('.');
    const old = getIn(this._state, parts);
    if (Object.is(old, value)) return;
    const root = { ...this._state };
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      cur[k] = cur[k] && typeof cur[k] === 'object' ? (Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] }) : {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
    this._state = root;
    this._pending.add(path);
    if (this._batchDepth === 0) this._flush();
  }

  /** @param {string} path @param {(old:any) => any} fn */
  update(path, fn) {
    this.set(path, fn(this.get(path)));
  }

  /** @param {() => void} fn */
  batch(fn) {
    this._batchDepth++;
    try { fn(); } finally {
      this._batchDepth--;
      if (this._batchDepth === 0) this._flush();
    }
  }

  /**
   * Subscribe to a path. Fires on changes at the path, its descendants or its ancestors.
   * @param {string} path
   * @param {(value:any, path:string) => void} cb
   * @param {{immediate?: boolean}} [opts]
   */
  select(path, cb, opts = {}) {
    let set = this._subs.get(path);
    if (!set) this._subs.set(path, (set = new Set()));
    set.add(cb);
    leakCounters.listeners++;
    if (opts.immediate) cb(this.get(path), path);
    return toDisposable(() => {
      if (set.delete(cb)) leakCounters.listeners--;
    });
  }

  _flush() {
    if (!this._pending.size) return;
    const changed = [...this._pending];
    this._pending.clear();
    const fired = new Set();
    for (const [subPath, cbs] of this._subs) {
      const hit = changed.some((p) => p === subPath || p.startsWith(subPath + '.') || subPath.startsWith(p + '.'));
      if (!hit) continue;
      const value = this.get(subPath);
      for (const cb of [...cbs]) {
        if (fired.has(cb)) continue;
        fired.add(cb);
        try { cb(value, subPath); } catch (err) { console.error('[store] subscriber failed', err); }
      }
    }
  }
}
