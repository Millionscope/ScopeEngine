/**
 * One area: header + optional tool (T) and sidebar (N) regions + editor host.
 * Owns the editor lifecycle: lazy-loads the editor module and its `needs` libraries (skeleton
 * and progress line while loading, inline error with Retry on failure), builds the
 * EditorContext, forwards events honoring pin/sync, coalesces resizes per frame, and disposes
 * everything on close or type switch.
 * @module workspace/area
 */
import { DisposableStore, listen, observeResize, toDisposable } from '../core/disposable.js';
import { loadLibs, LIBS } from '../core/lazy.js';
import { log } from '../core/log.js';
import { getEditor } from '../editors/registry.js';
import { AreaHeader } from './area-header.js';

/** Count of live editor instances (debug overlay / leak checks). */
export const editorCounters = { live: 0, mounted: 0, disposed: 0 };

export class Area {
  /**
   * @param {{
   *   leaf: import('./area-tree.js').AreaLeaf,
   *   ws: import('./workspaces.js').WorkspaceManager,
   *   workspaceId: string,
   *   env: any,
   * }} opts
   */
  constructor({ leaf, ws, workspaceId, env }) {
    this.leaf = leaf;
    this.id = leaf.id;
    this.ws = ws;
    this.workspaceId = workspaceId;
    this.env = env;
    this.ui = env.ui;
    /** @type {any} */
    this.editor = null;
    this._visible = false;
    this._active = false;
    this._mountToken = 0;
    this._disposed = false;
    this._loadedType = null;
    this.d = new DisposableStore();
    this.ed = new DisposableStore();
    this._build();
  }

  _build() {
    const el = document.createElement('section');
    el.className = 'ms-area';
    el.dataset.areaId = this.id;
    el.setAttribute('role', 'region');
    this.el = el;

    this.header = new AreaHeader(this);
    this.d.add({ dispose: () => this.header.dispose() });

    const body = document.createElement('div');
    body.className = 'ms-area-body';
    this.body = body;

    this.toolsEl = document.createElement('aside');
    this.toolsEl.className = 'ms-region ms-region-tools';
    this.toolsEl.setAttribute('aria-label', 'Tool region');
    this.toolsEl.hidden = true;

    this.host = document.createElement('div');
    this.host.className = 'ms-editor-host';

    this.sidebarEl = document.createElement('aside');
    this.sidebarEl.className = 'ms-region ms-region-sidebar';
    this.sidebarEl.setAttribute('aria-label', 'Sidebar region');
    this.sidebarEl.hidden = true;

    this.progress = document.createElement('div');
    this.progress.className = 'ms-progress';
    this.progress.hidden = true;

    body.append(this.toolsEl, this.host, this.sidebarEl);
    el.append(this.header.el, body, this.progress);

    this.d.add(this.ws.gestures.attach(this));

    // focus tracking: last clicked/focused area is active; pointer area receives shortcuts
    this.d.add(listen(el, 'pointerdown', () => this.ws.setActiveArea(this.id), true));
    this.d.add(listen(el, 'focusin', () => this.ws.setActiveArea(this.id)));
    this.d.add(listen(el, 'pointerenter', () => this.ws.setHoverArea(this.id)));
    this.d.add(listen(el, 'pointerleave', () => this.ws.clearHoverArea(this.id)));

    // resize coalesced per frame
    const scheduler = this.env.scheduler;
    const pushSize = scheduler.rafThrottle(() => {
      if (!this.editor || this._disposed) return;
      const w = this.host.clientWidth;
      const h = this.host.clientHeight;
      if (w === this._w && h === this._h) return;
      this._w = w;
      this._h = h;
      try { this.editor.resize(w, h); } catch (err) { console.error('[area] resize failed', err); }
    });
    this._pushSize = pushSize;
    this.d.add(observeResize(this.host, () => pushSize()));
    this.d.add(toDisposable(() => pushSize.cancel()));

    this.applyLeaf();
  }

  /** Re-apply leaf flags to the DOM (after tree operations or flag changes). */
  applyLeaf() {
    const leaf = this.leaf;
    const entry = getEditor(leaf.editorType);
    this.el.classList.toggle('is-header-bottom', leaf.headerPos === 'bottom');
    this.el.classList.toggle('is-header-collapsed', !!leaf.headerCollapsed);
    this.el.setAttribute('aria-label', `${entry ? entry.label : leaf.editorType} area`);
    this.body.classList.toggle('is-editor-like', (entry?.kind || 'editor') === 'editor');
    this.body.classList.toggle('is-panel-like', entry?.kind === 'panel');
    this._applyRegions();
    this.header.refresh();
  }

  _applyRegions() {
    const { tools, sidebar } = this.leaf.regions;
    const wasTools = !this.toolsEl.hidden;
    const wasSide = !this.sidebarEl.hidden;
    this.toolsEl.hidden = !tools;
    this.sidebarEl.hidden = !sidebar;
    if (this.editor) {
      if (tools && !wasTools) this._renderRegion('tools');
      if (sidebar && !wasSide) this._renderRegion('sidebar');
    }
  }

  /** @param {'tools'|'sidebar'} which */
  _renderRegion(which) {
    const el = which === 'tools' ? this.toolsEl : this.sidebarEl;
    el.replaceChildren();
    const title = document.createElement('div');
    title.className = 'ms-region-title';
    title.textContent = which === 'tools' ? 'Tools' : 'Sidebar';
    const body = document.createElement('div');
    body.className = 'ms-region-body-host';
    el.append(title, body);
    try {
      if (which === 'tools') this.editor.renderTools(body);
      else this.editor.renderSidebar(body);
    } catch (err) {
      console.error(`[area] ${which} region failed`, err);
    }
  }

  /** Re-render open regions (editors call this after their content changes). */
  refreshRegions() {
    if (!this.editor) return;
    if (!this.toolsEl.hidden) this._renderRegion('tools');
    if (!this.sidebarEl.hidden) this._renderRegion('sidebar');
  }

  // ------------------------------------------------------------------ editor lifecycle

  /** Mount the leaf's editor (first time or after a type switch). */
  mount() {
    return this._mountEditor(this.leaf.editorType, this.leaf.editorState || {});
  }

  /**
   * @param {string} type
   * @param {object} state
   */
  async _mountEditor(type, state) {
    const token = ++this._mountToken;
    this._disposeEditor();
    this.applyLeaf();
    const entry = getEditor(type);
    if (!entry) {
      this._showError(new Error(`Unknown editor type "${type}"`), type, false);
      return;
    }
    this._showLoading(entry);
    const t0 = performance.now();
    try {
      const [mod, libs] = await Promise.all([entry.loader(), loadLibs(entry.needs || [])]);
      const EditorClass = mod.default;
      const extra = (EditorClass.needs || []).filter((n) => !(n in libs));
      if (extra.length) Object.assign(libs, await loadLibs(extra));
      if (token !== this._mountToken || this._disposed) return;
      const editor = new EditorClass();
      const ctx = this._makeContext(libs);
      editor._attach(ctx);
      this.editor = editor;
      editorCounters.live++;
      editorCounters.mounted++;
      this._hideLoading();
      await editor.mount(ctx, state || {});
      if (token !== this._mountToken || this._disposed) {
        // superseded while mounting
        return;
      }
      this._loadedType = type;
      editor._mounted = true;
      this._wireEvents(editor);
      this.header.refresh();
      this._applyRegions();
      this.refreshRegions();
      this._w = -1;
      this._h = -1;
      this._pushSize();
      if (this._visible) editor.invalidate();
      log.debug('workspace', `mounted ${type} in ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      if (token !== this._mountToken || this._disposed) return;
      this._disposeEditor();
      this._showError(/** @type {Error} */ (err), type, true);
      log.error('workspace', `could not open ${entry.label}: ${(/** @type {Error} */ (err)).message}`, {
        hint: entry.needs?.length ? `needs ${entry.needs.map((n) => LIBS[n]?.version || n).join(', ')} from the CDN` : undefined,
      });
    }
  }

  /** @param {Record<string, any>} libs */
  _makeContext(libs) {
    const env = this.env;
    const leaf = this.leaf;
    return {
      el: this.host,
      toolsEl: this.toolsEl,
      sidebarEl: this.sidebarEl,
      areaId: this.id,
      workspaceId: this.workspaceId,
      events: env.events,
      services: env.services,
      engine: env.engine,
      theme: env.theme,
      scheduler: env.scheduler,
      commands: env.commands,
      store: env.store,
      ui: env.ui,
      libs,
      saveState: (s) => {
        this.leaf.editorState = s && typeof s === 'object' ? s : {};
        this.ws.persistSoon();
      },
      areaFlags: () => ({ pinnedScopeId: leaf.pinnedScopeId, syncSelection: leaf.syncSelection, scenarioId: leaf.scenarioId }),
      isVisible: () => this.isVisible(),
      refreshHeader: () => this.header.refresh(),
      refreshRegions: () => this.refreshRegions(),
      setBusy: (b) => this.setBusy(b),
    };
  }

  /** @param {any} editor */
  _wireEvents(editor) {
    const ev = this.env.events;
    const leaf = this.leaf;
    const safe = (fn) => (...a) => {
      if (this.editor !== editor) return;
      try { fn(...a); } catch (err) { console.error(`[area ${leaf.editorType}]`, err); }
    };
    this.ed.add(ev.on('selection:changed', safe((sel) => {
      if (leaf.syncSelection && !leaf.pinnedScopeId) editor.onSelection(sel);
    })));
    this.ed.add(ev.on('hover:changed', safe((p) => {
      if (leaf.syncSelection) editor.onHover(p ? p.id : null);
    })));
    this.ed.add(ev.on('graph:recomputed', safe((p) => {
      if (p.structural) editor.onStructure(p);
      editor.onRecompute(p.changed || [], p);
    })));
    this.ed.add(ev.on('theme:changed', safe((t) => editor.onTheme(t))));
    this.ed.add(ev.on('scenario:changed', safe(() => {
      this.header.refresh();
      editor.onScenario(this.scenarioId());
    })));
  }

  _disposeEditor() {
    this.ed.clear();
    if (this.editor) {
      try { this.editor.dispose(); } catch (err) { console.error('[area] editor dispose failed', err); }
      editorCounters.live--;
      editorCounters.disposed++;
      this.editor = null;
    }
    this._loadedType = null;
    this.host.replaceChildren();
    this.toolsEl.replaceChildren();
    this.sidebarEl.replaceChildren();
  }

  /** @param {import('../editors/registry.js').EditorEntry} entry */
  _showLoading(entry) {
    this.setBusy(true);
    const box = document.createElement('div');
    box.className = 'ms-editor-loading';
    box.setAttribute('role', 'status');
    for (let i = 0; i < 5; i++) {
      const s = document.createElement('div');
      s.className = 'ms-skel';
      box.appendChild(s);
    }
    const label = document.createElement('div');
    label.className = 'ms-editor-loading-label';
    const libs = (entry.needs || []).map((n) => LIBS[n]?.version || n);
    label.textContent = `Loading ${entry.label}${libs.length ? ` (${libs.join(', ')})` : ''}…`;
    box.appendChild(label);
    this.host.replaceChildren(box);
  }

  _hideLoading() {
    this.setBusy(false);
    this.host.querySelector('.ms-editor-loading')?.remove();
  }

  /** @param {Error} err @param {string} type @param {boolean} retryable */
  _showError(err, type, retryable) {
    this.setBusy(false);
    const entry = getEditor(type);
    const box = document.createElement('div');
    box.className = 'ms-editor-error';
    box.setAttribute('role', 'alert');
    const title = document.createElement('strong');
    title.textContent = `Could not open ${entry ? entry.label : type}`;
    const pre = document.createElement('pre');
    const needs = (entry?.needs || []).map((n) => LIBS[n]?.version || n);
    pre.textContent = `${err && err.message ? err.message : String(err)}${needs.length ? `\nRequires ${needs.join(', ')}.` : ''}`;
    box.append(title, pre);
    const row = document.createElement('div');
    row.className = 'ms-row';
    if (retryable) {
      const retry = document.createElement('button');
      retry.className = 'ms-btn is-small';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => this._mountEditor(type, this.leaf.editorState || {}));
      row.appendChild(retry);
    }
    if (type === 'space3d' || type === 'simulation') {
      const alt = document.createElement('button');
      alt.className = 'ms-btn is-secondary is-small';
      alt.textContent = 'Open 2D Scope Graph instead';
      alt.addEventListener('click', () => this.ws.setAreaType(this.id, 'graph'));
      row.appendChild(alt);
    }
    box.appendChild(row);
    this.host.replaceChildren(box);
  }

  // ------------------------------------------------------------------ state & flags

  isVisible() {
    if (this._disposed || !this._visible) return false;
    const tree = this.ws.treeOf(this.id);
    if (tree && tree.maximizedId && tree.maximizedId !== this.id) return false;
    return true;
  }

  /** @param {boolean} v */
  setVisible(v) {
    if (this._visible === v) return;
    this._visible = v;
    const ed = this.editor;
    if (!ed) return;
    try { ed.onVisibility?.(this.isVisible()); } catch (err) { console.error(err); }
    if (this.isVisible()) {
      this._pushSize();
      if (ed.isDirty) this.env.scheduler.request(ed);
      else ed.invalidate();
    }
  }

  /** Visibility may change without _visible changing (maximize/restore). */
  visibilityChanged() {
    const ed = this.editor;
    if (!ed) return;
    try { ed.onVisibility?.(this.isVisible()); } catch (err) { console.error(err); }
    if (this.isVisible()) {
      this._pushSize();
      ed.invalidate();
    }
  }

  /** @param {boolean} a */
  setActive(a) {
    this._active = a;
    this.el.classList.toggle('is-active', a);
  }

  /** @param {boolean} busy */
  setBusy(busy) {
    this.progress.hidden = !busy;
  }

  flash() {
    this.el.classList.remove('is-flash');
    void this.el.offsetWidth;
    this.el.classList.add('is-flash');
    setTimeout(() => this.el.classList.remove('is-flash'), 1000);
  }

  scenarioId() {
    return this.leaf.scenarioId || this.env.services.scenarios?.activeId || null;
  }

  /** @param {boolean} pinned */
  setPinned(pinned) {
    const sel = this.env.services.selection;
    if (pinned) {
      const fromEditor = this.editor?.focusScope?.();
      this.leaf.pinnedScopeId = fromEditor || sel?.get().focusScope || sel?.get().primary || 'sc_bakery';
    } else {
      this.leaf.pinnedScopeId = null;
    }
    this._afterFlags();
    if (!pinned && this.editor && sel && this.leaf.syncSelection) this.editor.onSelection(sel.get());
  }

  /** @param {boolean} sync */
  setSync(sync) {
    this.leaf.syncSelection = sync;
    this._afterFlags();
    const sel = this.env.services.selection;
    if (sync && this.editor && sel && !this.leaf.pinnedScopeId) this.editor.onSelection(sel.get());
  }

  /** @param {string|null} id */
  setScenario(id) {
    this.leaf.scenarioId = id;
    this._afterFlags();
    this.editor?.onScenario(this.scenarioId());
  }

  _afterFlags() {
    this.header.refresh();
    try { this.editor?.onFlags({ pinnedScopeId: this.leaf.pinnedScopeId, syncSelection: this.leaf.syncSelection, scenarioId: this.leaf.scenarioId }); } catch (err) { console.error(err); }
    this.ws.persistSoon();
  }

  /** Persist current editor state into the leaf (before serialize). */
  captureState() {
    // only a fully mounted editor owns its state; while mount() is pending, keep the leaf's
    if (!this.editor || !this._loadedType) return;
    try {
      const s = this.editor.getState();
      if (s && typeof s === 'object') this.leaf.editorState = s;
    } catch (err) { console.error(err); }
  }

  dispose() {
    if (this._disposed) return;
    this.captureState();
    this._disposed = true;
    this._mountToken++;
    this._disposeEditor();
    this.d.dispose();
    this.el.remove();
  }
}
