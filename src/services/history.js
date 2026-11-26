/**
 * History: the delta log (event-sourced), undo/redo, version list, diffs and restore.
 * Undo applies the inverse deltas as a NEW version; restore applies the inverse chain back to a
 * version as a new version. History is never rewritten. The log is persisted to localStorage
 * and replayed on reload. No DOM.
 * @module services/history
 */
import { log } from '../core/log.js';

/**
 * @typedef {Object} HistoryEntry
 * @property {number} seq
 * @property {string} version          version after this entry
 * @property {string} prevVersion
 * @property {any[]} deltas
 * @property {any[]} inverses
 * @property {string[]} summaries
 * @property {string} author           'user' | role name | 'model'
 * @property {number} tokens
 * @property {'edit'|'undo'|'redo'|'restore'|'model'|'swarm'|'local'} kind
 * @property {number} time
 * @property {string[]} changed
 * @property {Array<{id: string, before: string, after: string}>} changes
 * @property {number=} undoOf          seq of the entry this undoes
 */

export class HistoryService {
  /**
   * @param {{
   *   events: import('../core/events.js').EventBus,
   *   engine: import('../model/engine.js').JsEngine,
   *   persist?: { load: () => any, save: (log: any) => void, clear: () => void },
   * }} deps
   */
  constructor({ events, engine, persist }) {
    this.events = events;
    this.engine = engine;
    this.persist = persist;
    /** @type {HistoryEntry[]} */
    this.entries = [];
    /** @type {HistoryEntry[]} */
    this.undoStack = [];
    /** @type {HistoryEntry[]} */
    this.redoStack = [];
    this.seq = 0;
    this.baseVersion = engine.graph?.versionLabel || 'v41';
    /** content hash of the graph the log starts from (a log only replays onto the same model) */
    this.baseHash = engine.graph?.hash ?? null;
    this.replaying = false;
  }

  get version() { return this.engine.graph.versionLabel; }

  /**
   * Apply deltas through the engine and record them.
   * @param {any[]} deltas
   * @param {{author?: string, tokens?: number, kind?: HistoryEntry['kind'], record?: boolean, silent?: boolean, undoOf?: number}} [meta]
   */
  apply(deltas, meta = {}) {
    const g = this.engine.graph;
    const prevVersion = g.versionLabel;
    const stamped = deltas.map((d) => ({ ...d, expect: d.expect ?? prevVersion }));
    const before = new Map();
    for (const d of stamped) if (d.op === 'set' && d.target && !d.scenario) before.set(d.target, describeValue(g, d.target));
    const res = this.engine.apply(stamped, { author: meta.author || 'user', tokens: meta.tokens || 0, kind: meta.kind || 'edit', silent: meta.silent });
    // the engine reports rejections as delta:rejected (logged once, with the author, in main.js)
    if (!res.ok) return res;
    /** @type {HistoryEntry} */
    const entry = {
      seq: ++this.seq,
      version: g.versionLabel,
      prevVersion,
      deltas: stamped,
      inverses: res.inverses || [],
      summaries: res.summaries || [],
      author: meta.author || 'user',
      tokens: meta.tokens || 0,
      kind: meta.kind || 'edit',
      time: Date.now(),
      changed: res.changed || [],
      changes: [...before.entries()].map(([id, b]) => ({ id, before: b, after: describeValue(g, id) })),
      undoOf: meta.undoOf,
    };
    if (meta.record !== false) {
      this.entries.push(entry);
      if (meta.kind === 'undo') this.redoStack.push(entry);
      else {
        this.undoStack.push(entry);
        if (meta.kind !== 'redo') this.redoStack = [];
      }
    }
    for (const s of entry.summaries) log.info('delta', `${entry.version} ${entry.author}: ${s}`, { nodeId: stamped[0]?.target });
    if (!this.replaying) {
      this.events.emit('delta:applied', { deltas: stamped, version: entry.version, author: entry.author, tokens: entry.tokens, changed: entry.changed, summary: entry.summaries.join('; '), entry });
      this._changed();
      this._save();
    }
    return { ...res, entry };
  }

  /**
   * Transient change while dragging or typing: recomputes live, but creates no version and no
   * log entry. The first preview of a target snapshots it so commit() can record one clean
   * delta (with the right inverse).
   * @param {any[]} deltas
   */
  preview(deltas) {
    const g = this.engine.graph;
    if (!this._preview) this._preview = new Map();
    for (const d of deltas) {
      if (d.op !== 'set' || !d.target) continue;
      const key = `${d.scenario || 'base'}|${d.target}`;
      if (this._preview.has(key)) continue;
      if (d.scenario && d.scenario !== 'base') {
        const ov = this.engine.scenarios.get(d.scenario)?.overrides.get(d.target);
        this._preview.set(key, { scenario: d.scenario, target: d.target, override: ov ? { ...ov } : null });
      } else {
        const n = g.node(d.target);
        if (n) this._preview.set(key, { target: d.target, value: n.value, dist: n.dist ?? null, kind: n.kind, provDetail: n.prov ? structuredClone(n.prov) : undefined });
      }
    }
    return this.engine.apply(deltas.map((d) => ({ ...d, expect: undefined })), { transient: true, author: 'user', kind: 'preview' });
  }

  /** Restore preview snapshots (silently unless `emit`). @param {boolean} emit */
  _restorePreview(emit) {
    if (!this._preview || !this._preview.size) { this._preview = null; return; }
    const restores = [];
    for (const s of this._preview.values()) {
      if (s.scenario) restores.push(s.override ? { op: 'set', scenario: s.scenario, target: s.target, value: s.override.value, dist: s.override.dist, restore: true } : { op: 'set', scenario: s.scenario, target: s.target, clear: true, restore: true });
      else restores.push({ op: 'set', target: s.target, value: s.value, dist: s.dist, kind: s.kind, provDetail: s.provDetail, restore: true });
    }
    this._preview = null;
    this.engine.apply(restores, { transient: true, silent: !emit, author: 'user', kind: 'preview' });
  }

  /** Commit after previews: restore the snapshot, then apply as one recorded delta. @param {any[]} deltas @param {any} [meta] */
  commit(deltas, meta = {}) {
    this._restorePreview(false);
    return this.apply(deltas, { author: 'user', kind: 'local', ...meta });
  }

  /** Abandon previews (Esc while dragging). */
  cancelPreview() {
    this._restorePreview(true);
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    const res = this.apply(e.inverses.map((d) => ({ ...d, expect: undefined })), { author: 'user', kind: 'undo', undoOf: e.seq });
    if (!res.ok) {
      this.undoStack.push(e);
      return res;
    }
    return res;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    const orig = this.entries.find((x) => x.seq === e.undoOf);
    if (!orig) return null;
    return this.apply(orig.deltas.map((d) => ({ ...d, expect: undefined })), { author: 'user', kind: 'redo' });
  }

  /**
   * Restore the graph as of `version` by applying the inverse chain of all later entries as one
   * new version. @param {string} version
   */
  restore(version) {
    const idx = this.entries.findIndex((e) => e.version === version);
    const later = idx < 0 ? (version === this.baseVersion ? this.entries : null) : this.entries.slice(idx + 1);
    if (!later || !later.length) return null;
    const inverses = [];
    for (let i = later.length - 1; i >= 0; i--) inverses.push(...later[i].inverses);
    return this.apply(inverses.map((d) => ({ ...d, expect: undefined })), { author: 'user', kind: 'restore' });
  }

  /** Version list (oldest first) including the base. */
  versions() {
    return [
      { version: this.baseVersion, author: 'swarm', kind: 'model', summaries: ['initial build: Should our bakery open a second location?'], tokens: 41280, time: this.bootTime || Date.now(), seq: 0 },
      ...this.entries,
    ];
  }

  /**
   * Net changes between two versions (A exclusive, B inclusive).
   * @param {string} a @param {string} b
   */
  diff(a, b) {
    const va = this._index(a);
    const vb = this._index(b);
    const [lo, hi] = va <= vb ? [va, vb] : [vb, va];
    const slice = this.entries.filter((_, i) => i + 1 > lo && i + 1 <= hi);
    /** @type {Map<string, {id: string, before: string, after: string, kind: 'modified'}>} */
    const modified = new Map();
    const added = [];
    const removed = [];
    const other = [];
    for (const e of slice) {
      for (const c of e.changes) {
        const prev = modified.get(c.id);
        modified.set(c.id, { id: c.id, before: prev ? prev.before : c.before, after: c.after, kind: 'modified' });
      }
      e.deltas.forEach((d, i) => {
        const s = e.summaries[i] || d.op;
        if (d.op === 'add_scope' || d.op === 'add_metric' || d.op === 'restore_scope' || d.op === 'fork') added.push({ version: e.version, summary: s });
        else if (d.op === 'remove_scope' || d.op === 'remove_metric' || d.op === 'delete_scenario') removed.push({ version: e.version, summary: s });
        else if (d.op !== 'set') other.push({ version: e.version, summary: s });
      });
    }
    return { from: va <= vb ? a : b, to: va <= vb ? b : a, modified: [...modified.values()].filter((m) => m.before !== m.after), added, removed, other, entries: slice };
  }

  /** @param {string} v */
  _index(v) {
    if (v === this.baseVersion) return 0;
    const i = this.entries.findIndex((e) => e.version === v);
    return i < 0 ? 0 : i + 1;
  }

  _changed() {
    this.events.emit('history:changed', { canUndo: this.canUndo(), canRedo: this.canRedo(), version: this.version, size: this.entries.length });
  }

  _save() {
    if (!this.persist) return;
    this.persist.save({
      baseVersion: this.baseVersion,
      baseHash: this.baseHash,
      entries: this.entries.map((e) => ({ deltas: e.deltas, author: e.author, tokens: e.tokens, kind: e.kind, time: e.time, undoOf: e.undoOf })),
    });
  }

  /** Replay a persisted log onto the freshly loaded graph. Returns the number of entries replayed. */
  replay() {
    const saved = this.persist?.load();
    this.bootTime = Date.now();
    if (!saved || saved.baseVersion !== this.baseVersion || !saved.entries.length) return 0;
    if (saved.baseHash && this.baseHash && saved.baseHash !== this.baseHash) {
      log.info('history', `skipped the saved delta log: it was recorded against a different demo model (${String(saved.baseHash).slice(0, 8)}, now ${String(this.baseHash).slice(0, 8)})`);
      this.persist?.clear?.();
      return 0;
    }
    this.replaying = true;
    let n = 0;
    try {
      for (const e of saved.entries) {
        const res = this.apply(e.deltas, { author: e.author, tokens: e.tokens, kind: e.kind, silent: true, undoOf: e.undoOf });
        if (!res.ok) {
          log.warn('history', `stopped replaying the saved delta log at entry ${n + 1}: ${res.errors?.[0]?.message}`);
          break;
        }
        const last = this.entries[this.entries.length - 1];
        last.time = e.time;
        n++;
      }
    } finally {
      this.replaying = false;
    }
    // rebuild undo/redo stacks from kinds
    this.undoStack = [];
    this.redoStack = [];
    for (const e of this.entries) {
      if (e.kind === 'undo') {
        const i = this.undoStack.findIndex((x) => x.seq === e.undoOf);
        if (i >= 0) this.undoStack.splice(i, 1);
        this.redoStack.push(e);
      } else {
        this.undoStack.push(e);
        if (e.kind !== 'redo') this.redoStack = [];
      }
    }
    if (n) log.info('history', `replayed ${n} saved change(s) from the local delta log`);
    return n;
  }

  /** Forget the persisted log (used by "Reset demo graph"). */
  clearSaved() {
    this.persist?.clear();
  }

  /** Start a fresh log for a newly loaded graph. @param {{keepSaved?: boolean}} [opts] */
  reset(opts = {}) {
    this.entries = [];
    this.undoStack = [];
    this.redoStack = [];
    this._preview = null;
    this.baseVersion = this.engine.graph.versionLabel;
    this.baseHash = this.engine.graph.hash ?? null;
    this.bootTime = Date.now();
    if (!opts.keepSaved) this._save();
    this._changed();
  }
}

/** @param {import('../model/graph.js').ScopeGraph} g @param {string} id */
function describeValue(g, id) {
  const n = g.node(id);
  if (!n) return '—';
  if (n.dist && n.dist.family !== 'Point') {
    const d = n.dist;
    const p = Object.entries(d).filter(([k]) => k !== 'family' && k !== 'components').map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toPrecision(4)) : v}`).join(', ');
    return `${n.kind} ${d.family}(${p})`;
  }
  return `${n.kind} ${Number.isFinite(n.value) ? Number(Number(n.value).toPrecision(6)) : n.value} ${n.type.unit}`;
}
