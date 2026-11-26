/**
 * BaseEditor: the lifecycle contract every editor implements.
 *
 * The Area owns the editor: it builds the EditorContext, calls mount(), forwards resize,
 * selection (respecting the area's pin and sync toggles), recompute, hover, scenario and theme
 * events, and calls dispose() when the area closes or switches type. Editors draw only inside
 * render(), which the shared scheduler calls once per frame when the editor is visible and
 * invalidated.
 * @module editors/base-editor
 */
import { DisposableStore, listen } from '../core/disposable.js';

/**
 * @typedef {Object} AreaFlags
 * @property {string|null} pinnedScopeId
 * @property {boolean} syncSelection
 * @property {string|null} scenarioId     area override; null = follow global
 */

/**
 * @typedef {Object} SelectionState
 * @property {string[]} selected          node or scope ids
 * @property {string|null} primary        first selected id
 * @property {string|null} focusScope     scope that editors should focus
 * @property {string|null} hovered
 * @property {string=} source
 */

/**
 * @typedef {Object} EditorContext
 * @property {HTMLElement} el                      editor host (area body)
 * @property {HTMLElement|null} toolsEl            left T region host
 * @property {HTMLElement|null} sidebarEl          right N region host
 * @property {string} areaId
 * @property {string} workspaceId
 * @property {import('../core/events.js').EventBus} events
 * @property {Record<string, any>} services        selection, chat, history, scenarios, sim, mind, swarm, notify, router, evidence, verify, compiler
 * @property {any} engine                          EngineAdapter (model/engine.js)
 * @property {import('../theme/theme-service.js').ThemeService} theme
 * @property {import('../core/scheduler.js').Scheduler} scheduler
 * @property {import('../core/commands.js').CommandRegistry} commands
 * @property {import('../core/store.js').Store} store
 * @property {Record<string, any>} libs            loaded libraries declared in `needs`
 * @property {{ showMenu: Function, toast?: Function }} ui   shell-provided UI helpers (injected)
 * @property {(state: object) => void} saveState  persist editor-local state into the area leaf
 * @property {() => AreaFlags} areaFlags
 * @property {() => boolean} isVisible
 * @property {() => void} refreshHeader           re-read getHeaderMenus()/getHeaderTools()
 * @property {() => void} [refreshRegions]        re-render the T / N regions
 * @property {(dispose: boolean) => void} [setBusy]  show/hide the area progress line
 */

export class BaseEditor {
  static id = '';
  static label = '';
  static icon = '';
  static group = '';
  /** @type {string[]} */
  static needs = [];
  static usesScenario = false;

  constructor() {
    /** @type {EditorContext|null} */
    this.ctx = null;
    this.disposables = new DisposableStore();
    this._dirty = false;
    this._disposed = false;
  }

  // ------------------------------------------------------------------ framework wiring

  /** @param {EditorContext} ctx (called by Area before mount) */
  _attach(ctx) {
    this.ctx = ctx;
  }

  /** Scheduler target: called once per frame while visible and dirty. @param {import('../core/scheduler.js').FrameInfo} info */
  renderFrame(info) {
    if (this._disposed) return;
    // still mounting (e.g. awaiting CSS or a library): the area invalidates again once mount() resolves
    if (!this._mounted) return;
    this._dirty = false;
    this.render(info);
  }

  isVisible() {
    return !this._disposed && !!this.ctx && this.ctx.isVisible();
  }

  /** Request a render on the next frame (no-op while hidden; re-requested when shown). */
  invalidate() {
    this._dirty = true;
    if (this.ctx && !this._disposed) this.ctx.scheduler.request(this);
  }

  get isDirty() { return this._dirty; }

  // ------------------------------------------------------------------ lifecycle (override)

  /** @param {EditorContext} ctx @param {object} state */
  async mount(ctx, state) {} // eslint-disable-line no-unused-vars

  /** @param {number} width @param {number} height */
  resize(width, height) {} // eslint-disable-line no-unused-vars

  /** @param {import('../core/scheduler.js').FrameInfo} frameInfo */
  render(frameInfo) {} // eslint-disable-line no-unused-vars

  /** Global selection changed (only called when sync is on and the area is not pinned). @param {SelectionState} sel */
  onSelection(sel) {} // eslint-disable-line no-unused-vars

  /** Hover changed elsewhere (sync on). @param {string|null} id */
  onHover(id) {} // eslint-disable-line no-unused-vars

  /** Engine recomputed. Diff `changedIds` against what is displayed; update only those. @param {string[]} changedIds @param {any} payload */
  onRecompute(changedIds, payload) {} // eslint-disable-line no-unused-vars

  /** Structural change (scopes or metrics added/removed): rebuild views. @param {any} payload */
  onStructure(payload) { this.invalidate(); } // eslint-disable-line no-unused-vars

  /** @param {{kind:'dark'|'light'}} theme */
  onTheme(theme) { this.invalidate(); } // eslint-disable-line no-unused-vars

  /** Active scenario for this area changed. @param {string|null} scenarioId */
  onScenario(scenarioId) { this.invalidate(); } // eslint-disable-line no-unused-vars

  /** Area pin/sync flags changed. @param {AreaFlags} flags */
  onFlags(flags) { this.invalidate(); } // eslint-disable-line no-unused-vars

  /** @returns {Array<{label: string, items: Array<any>}>} */
  getHeaderMenus() { return []; }

  /** @returns {Array<HTMLElement>} */
  getHeaderTools() { return []; }

  /** Serializable editor state (stored in the area leaf). */
  getState() { return {}; }

  focusSearch() {}

  /** Optional: Home / '.' (Graph, 3D). */
  frameAll() {}
  frameSelected() {}

  /** Optional: render the T (tools) region. @param {HTMLElement} el */
  renderTools(el) { el.innerHTML = '<div class="ms-region-empty">No tools for this editor.</div>'; }

  /** Optional: render the N (sidebar) region. @param {HTMLElement} el */
  renderSidebar(el) { el.innerHTML = '<div class="ms-region-empty">No properties for this editor.</div>'; }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.disposables.dispose();
    if (this.ctx) this.ctx.scheduler.cancel(this);
  }

  // ------------------------------------------------------------------ helpers

  /** addEventListener tracked for disposal. */
  listen(target, type, handler, options) {
    return this.disposables.add(listen(target, type, handler, options));
  }

  /** Event-bus subscription tracked for disposal. @param {string} type @param {Function} fn */
  on(type, fn) {
    return this.disposables.add(/** @type {any} */ (this.ctx).events.on(type, fn));
  }

  /** The scope this editor should show: the pinned scope, else the global focus. */
  focusScope() {
    const flags = this.ctx?.areaFlags();
    if (flags?.pinnedScopeId) return flags.pinnedScopeId;
    const sel = this.ctx?.services.selection;
    return sel ? sel.get().focusScope : null;
  }

  /** Current global selection state (or empty). @returns {SelectionState} */
  selection() {
    const sel = this.ctx?.services.selection;
    return sel ? sel.get() : { selected: [], primary: null, focusScope: null, hovered: null };
  }

  /** Scenario id this area shows (area override, else global active). */
  scenarioId() {
    const flags = this.ctx?.areaFlags();
    if (flags?.scenarioId) return flags.scenarioId;
    return this.ctx?.services.scenarios?.activeId ?? null;
  }

  /**
   * Select ids: global when sync is on, otherwise only inside this editor.
   * @param {string[]} ids @param {{mode?: 'replace'|'add'|'toggle'}} [opts]
   */
  select(ids, opts = {}) {
    const flags = this.ctx?.areaFlags();
    const svc = this.ctx?.services.selection;
    if (svc && (!flags || flags.syncSelection)) svc.select(ids, { ...opts, source: this.ctx?.areaId });
    else {
      const primary = ids[0] ?? null;
      this.onSelection({ selected: ids, primary, focusScope: null, hovered: null, source: 'local' });
    }
  }

  /** Hover an id (sync on only). @param {string|null} id */
  hover(id) {
    const flags = this.ctx?.areaFlags();
    if (flags && !flags.syncSelection) return;
    this.ctx?.services.selection?.hover(id, this.ctx?.areaId);
  }

  /** Persist editor state into the area leaf. */
  save() {
    this.ctx?.saveState(this.getState());
  }
}
