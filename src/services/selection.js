/**
 * Global selection: selected ids (scopes or metrics), hovered id, focus scope.
 * Emits selection:changed and hover:changed (hover is throttled). No DOM.
 * @module services/selection
 */

/** @typedef {import('../editors/base-editor.js').SelectionState} SelectionState */

export class SelectionService {
  /**
   * @param {import('../core/events.js').EventBus} events
   * @param {() => import('../model/graph.js').ScopeGraph|null} getGraph
   */
  constructor(events, getGraph) {
    this.events = events;
    this.getGraph = getGraph;
    /** @type {string[]} */
    this.selected = [];
    /** @type {string|null} */
    this.hovered = null;
    /** @type {string|null} */
    this.focusScope = null;
    /** anchor for shift-range selection in lists */
    this.anchor = null;
    this._hoverTimer = 0;
    this._pendingHover = undefined;
  }

  /** @returns {SelectionState} */
  get() {
    return {
      selected: [...this.selected],
      primary: this.selected[0] ?? null,
      focusScope: this.focusScope,
      hovered: this.hovered,
    };
  }

  /**
   * @param {string[]} ids
   * @param {{mode?: 'replace'|'add'|'toggle', source?: string|null}} [opts]
   */
  select(ids, opts = {}) {
    const mode = opts.mode || 'replace';
    let next;
    if (mode === 'add') next = [...this.selected, ...ids.filter((id) => !this.selected.includes(id))];
    else if (mode === 'toggle') {
      next = [...this.selected];
      for (const id of ids) {
        const i = next.indexOf(id);
        if (i >= 0) next.splice(i, 1);
        else next.push(id);
      }
    } else next = [...new Set(ids)];
    const same = next.length === this.selected.length && next.every((x, i) => x === this.selected[i]);
    if (same && mode === 'replace') return;
    this.selected = next;
    if (mode === 'replace') this.anchor = ids[0] ?? null;
    const g = this.getGraph();
    const primary = next[0] ?? null;
    if (primary && g) this.focusScope = g.scopeIdOf(primary) || this.focusScope;
    this.events.emit('selection:changed', { ...this.get(), source: opts.source ?? null });
  }

  clear() {
    if (!this.selected.length) return;
    this.selected = [];
    this.events.emit('selection:changed', { ...this.get(), source: 'clear' });
  }

  /** Set the focus scope without changing the selection. @param {string|null} scopeId */
  focus(scopeId) {
    this.focusScope = scopeId;
    this.events.emit('selection:changed', { ...this.get(), source: 'focus' });
  }

  /**
   * Hover highlights across synced editors (throttled to ~30 ms).
   * @param {string|null} id @param {string|null} [source]
   */
  hover(id, source = null) {
    this._pendingHover = { id, source };
    if (this._hoverTimer) return;
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = 0;
      const p = this._pendingHover;
      this._pendingHover = undefined;
      if (!p || p.id === this.hovered) return;
      this.hovered = p.id;
      this.events.emit('hover:changed', p);
    }, 30);
  }

  /** Human label for an id: graph path. @param {string|null} id */
  label(id) {
    if (!id) return '';
    const g = this.getGraph();
    return g ? g.path(id) : id;
  }

  /** Drop ids that no longer exist (after structural changes). */
  prune() {
    const g = this.getGraph();
    if (!g) return;
    const keep = this.selected.filter((id) => g.nodes.has(id) || g.scopes.has(id));
    if (this.focusScope && !g.scopes.has(this.focusScope)) this.focusScope = g.rootId;
    if (keep.length !== this.selected.length) {
      this.selected = keep;
      this.events.emit('selection:changed', { ...this.get(), source: 'prune' });
    }
  }
}
