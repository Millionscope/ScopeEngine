/**
 * Scope Graph (spec 12.3): metric nodes as a DAG, grouped into scope frames.
 *
 *  - Compound layered layout (layout.js: longest-path ranks + barycenter ordering per frame),
 *    computed from a view model (model.js) and cached by structureVersion + collapse state.
 *  - Nodes: rounded box with provenance stroke + glyph, name and value (p50 for stochastic
 *    nodes, from engine.view(scenario)). Node groups are bound values (.ms-bv, data-node,
 *    data-stat), so the shell preview card works on hover.
 *  - Hover: downstream cone (--ms-cone) and upstream (--ms-upstream). Recompute: only changed
 *    labels update; the changed cone pulses (skipped under reduced motion).
 *  - Double-click a frame to collapse it into a summary proxy (graph.summary); double-click a
 *    proxy to expand. Header menus: View, Select, Graph.
 *  - d3-zoom (no d3 transitions: programmatic moves run on scheduler.animate), minimap in the
 *    N sidebar, "View as table", roving keyboard focus with arrow-key navigation.
 *  - Above ~2,000 visible items the canvas renderer takes over with the same interactions and
 *    suggests the 3D Scope Space.
 * @module editors/graph
 */
import { BaseEditor } from '../base-editor.js';
import { loadCss } from '../../core/lazy.js';
import { tableView, tableToggle } from '../shared/chart-table.js';
import { provMark, provLegend } from '../shared/prov-mark.js';
import { unitValue } from '../../model/format.js';
import { PROVENANCE } from '../../theme/tokens.js';
import { layoutCompound, edgeGeom } from './layout.js';
import { buildViewModel, defaultCollapsed, collapsedBelow, isDefaultCollapsed, revealPath } from './model.js';
import { SvgScene, wrapText } from './svg.js';
import { CanvasScene } from './canvas.js';
import { Minimap } from './minimap.js';

/** Above this many visible items the canvas renderer is used. */
export const CANVAS_THRESHOLD = 2000;
const NODE_W = 136;
const NODE_H = 32;
const NODE_H_COMPACT = 22;
const PROXY_W = 184;
const PROXY_H = 46;
/** The default view fits everything only if text stays readable at this zoom. */
const MIN_READABLE = 0.75;
const TABLE_CAP = 2000;

/** @typedef {import('./svg.js').Scene} Scene */

export default class GraphEditor extends BaseEditor {
  static id = 'graph';
  static label = 'Scope Graph';
  static icon = 'type-hierarchy-sub';
  static group = 'Scope';
  static needs = ['d3'];
  static usesScenario = false;

  /** @param {import('../base-editor.js').EditorContext} ctx @param {any} state */
  async mount(ctx, state) {
    await loadCss(new URL('./graph.css', import.meta.url));
    this.d3 = ctx.libs.d3;
    this.st = {
      dir: /** @type {'LR'|'TB'} */ (state.dir === 'TB' ? 'TB' : 'LR'),
      showValues: state.showValues !== false,
      showUnits: state.showUnits !== false,
      table: !!state.table,
    };
    /** explicit user choices relative to the default collapse rule */
    this.userCollapsed = new Set(Array.isArray(state.userCollapsed) ? state.userCollapsed : []);
    this.userExpanded = new Set(Array.isArray(state.userExpanded) ? state.userExpanded : []);
    this.t = { x: 0, y: 0, k: 1 };
    this.w = ctx.el.clientWidth || 600;
    this.h = ctx.el.clientHeight || 400;
    /** @type {Scene|null} */
    this.scene = null;
    /** @type {any} */
    this.vm = null;
    this.mode = /** @type {'svg'|'canvas'} */ ('svg');
    this.layoutCache = { key: '', L: /** @type {any} */ (null), wrap: 0 };
    this.localHover = null;
    this.extHover = null;
    this.userMoved = false;
    this.needsBuild = false;
    this.pendingView = /** @type {null|'initial'|'keep'|'fit'} */ ('initial');
    /** @type {null|{id: string, sx: number, sy: number}} */
    this.anchor = null;
    this.knownScopes = new Set(this.graph().scopes.keys());
    this.searchQ = '';
    this.searchIdx = 0;
    /** @type {Map<string, HTMLElement>} */
    this.tableVals = new Map();
    this.viewAnim = null;

    // ---------------------------------------------------------------- DOM
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-graph';
    this.banner = document.createElement('div');
    this.banner.className = 'ms-graph-banner';
    this.banner.hidden = true;
    this.banner.setAttribute('role', 'status');
    this.stage = document.createElement('div');
    this.stage.className = 'ms-graph-stage';
    this.hint = document.createElement('div');
    this.hint.className = 'ms-graph-hint';
    this.hint.hidden = true;
    this.hint.setAttribute('role', 'status');
    this.tableHost = document.createElement('div');
    this.tableHost.className = 'ms-ed-scroll ms-graph-table';
    this.tableHost.hidden = true;
    this.status = document.createElement('div');
    this.status.className = 'ms-sr-only';
    this.status.setAttribute('aria-live', 'polite');
    this.root.append(this.banner, this.stage, this.tableHost, this.hint, this.status);
    ctx.el.appendChild(this.root);

    this.svgScene = new SvgScene({ host: this.stage, areaId: ctx.areaId });
    this.canvasScene = new CanvasScene({ host: this.stage, scheduler: ctx.scheduler, owner: this });
    this.canvasScene.setVisible(false);
    this.canvasScene.resize(1, 1);
    this.w = this.stage.clientWidth || this.w;
    this.h = this.stage.clientHeight || this.h;

    // ---------------------------------------------------------------- zoom (no transitions)
    const d3 = this.d3;
    this.zoom = d3.zoom()
      .scaleExtent([0.01, 4])
      .filter((e) => (!e.ctrlKey || e.type === 'wheel') && !e.button && !(e.target instanceof Element && e.target.closest('.ms-graph-banner, .ms-graph-hint')))
      .on('zoom', (e) => {
        this.t = { x: e.transform.x, y: e.transform.y, k: e.transform.k };
        if (e.sourceEvent) {
          this.userMoved = true;
          this.viewAnim?.dispose();
          this.viewAnim = null;
          if (!this.hint.hidden) this.hint.hidden = true;
        }
        this.invalidate();
      });
    this.zoomSel = d3.select(this.stage).call(this.zoom).on('dblclick.zoom', null);

    this.wireEvents();

    this.rebuild();
    this.applyMode();
  }

  // ------------------------------------------------------------------ model access

  graph() { return /** @type {any} */ (this.ctx).engine.graph; }

  view() { return /** @type {any} */ (this.ctx).engine.view(this.scenarioId()); }

  viewRoot() {
    const g = this.graph();
    const pin = this.ctx?.areaFlags().pinnedScopeId;
    return pin && g.scope(pin) ? pin : g.rootId;
  }

  /** Displayed number: median for stochastic nodes, point value otherwise. @param {string} id @param {any} [view] */
  valueOf(id, view = this.view()) {
    const st = view.stats(id);
    if (st && !st.deterministic) return st.p50;
    return view.value(id);
  }

  /** Current collapsed set for the view root. */
  collapsedSet() {
    const g = this.graph();
    const root = this.viewRoot();
    const out = new Set();
    for (const id of defaultCollapsed(g, root)) if (!this.userExpanded.has(id)) out.add(id);
    for (const id of this.userCollapsed) if (g.scope(id) && id !== root) out.add(id);
    return out;
  }

  /** Make `target` the collapsed set (records the difference from the default rule). @param {Set<string>} target */
  setCollapsed(target) {
    const D = defaultCollapsed(this.graph(), this.viewRoot());
    this.userCollapsed = new Set([...target].filter((id) => !D.has(id)));
    this.userExpanded = new Set([...D].filter((id) => !target.has(id)));
  }

  // ------------------------------------------------------------------ build

  /** Rebuild view model, layout and renderer (structure, collapse, direction or size changes). */
  rebuild() {
    const g = this.graph();
    const root = this.viewRoot();
    if (!root || !g.scope(root)) return;
    const prevScene = this.scene;
    const collapsed = this.collapsedSet();
    const nodeH = this.st.showValues ? NODE_H : NODE_H_COMPACT;
    const vm = buildViewModel(g, { collapsed, nodeW: NODE_W, nodeH, proxyW: PROXY_W, proxyH: PROXY_H, root });
    const key = `${g.structureVersion}|${root}|${this.st.dir}|${nodeH}|${[...collapsed].sort().join(',')}`;
    let L;
    if (this.layoutCache.key === key) L = this.layoutCache.L;
    else {
      L = this.layoutBest(vm);
      this.layoutCache = { key, L, wrap: L.wrap };
    }
    this.vm = vm;
    /** @type {Map<string, import('./svg.js').SceneItem>} */
    const items = new Map();
    for (const [id, r] of L.itemPos) items.set(id, { id, kind: vm.items.get(id).kind, x: r.x, y: r.y, w: r.w, h: r.h, frame: vm.itemFrame.get(id) });
    const frames = [...L.framePos.entries()].map(([id, r]) => {
      const s = g.scope(id);
      return { id, x: r.x, y: r.y, w: r.w, h: r.h, depth: r.depth, name: s?.name || id, proto: s ? g.protoName(s.proto) : '' };
    }).sort((a, b) => a.depth - b.depth);
    /** @type {Map<string, number[]>} */
    const outE = new Map();
    /** @type {Map<string, number[]>} */
    const inE = new Map();
    const edges = [];
    for (const [a, b] of vm.edges) {
      const ra = items.get(a);
      const rb = items.get(b);
      if (!ra || !rb) continue;
      const i = edges.length;
      edges.push({ a, b, count: vm.edgeCount.get(`${a}\u0000${b}`) || 1, g: edgeGeom(ra, rb, this.st.dir) });
      (outE.get(a) || outE.set(a, []).get(a)).push(i);
      (inE.get(b) || inE.set(b, []).get(b)).push(i);
    }
    /** @type {Scene} */
    const scene = { dir: this.st.dir, width: L.width, height: L.height, items, frames, edges, outE, inE };
    this.scene = scene;
    this.layoutMs = L.ms;
    this.mode = items.size > CANVAS_THRESHOLD ? 'canvas' : 'svg';
    const labelOf = (id) => this.labelOf(id);
    if (this.mode === 'svg') {
      this.svgScene.build(scene, labelOf);
      this.svgScene.setScenario(this.scenarioId());
      this.canvasScene.build({ ...scene, items: new Map(), frames: [], edges: [] }, labelOf);
    } else {
      this.svgScene.build({ ...scene, items: new Map(), frames: [], edges: [], outE: new Map(), inE: new Map() }, labelOf);
      this.canvasScene.build(scene, labelOf);
    }
    this.minimap?.setScene(scene, (id) => this.provOfItem(id));
    this.applyMode();
    this.updateBanner(); // before measuring: the banner takes height from the stage
    this.syncSize();
    this.applySelection();
    this.localHover = null;
    this.applyHover();

    // view placement
    const pv = this.pendingView;
    this.pendingView = null;
    if (pv === 'initial') this.initialView();
    else if (pv === 'fit') this.frameAll(false);
    else if (this.anchor && prevScene) {
      // keep the toggled scope where it was on screen
      const a = this.anchor;
      const r = items.get(a.id) || frames.find((f) => f.id === a.id);
      if (r) this.setTransform({ k: this.t.k, x: a.sx - r.x * this.t.k, y: a.sy - r.y * this.t.k }, false);
    }
    this.anchor = null;
    this.updateSidebar();
    this.updateAria();
    if (this.st.table) this.buildTable();
    this.invalidate();
  }

  /**
   * Layout with the lane wrap that best fits the viewport (small graphs only; cheap).
   * @param {any} vm
   */
  layoutBest(vm) {
    const dir = this.st.dir;
    const n = vm.items.size;
    const cands = n > 600 ? [dir === 'LR' ? 600 : 1800] : dir === 'LR' ? [320, 460, 640, 900, 1e9] : [700, 1000, 1400, 2000, 2800, 1e9];
    let best = null;
    let bestScore = -1;
    for (const wrap of cands) {
      const L = layoutCompound(vm, { dir, wrap });
      const score = Math.min((this.w - 32) / L.width, (this.h - 32) / L.height);
      if (score > bestScore + 1e-3) { best = { ...L, wrap }; bestScore = score; }
    }
    return /** @type {any} */ (best);
  }

  /**
   * Label for an item (metric node or collapsed scope proxy).
   * @param {string} id
   * @returns {import('./svg.js').ItemLabel}
   */
  labelOf(id) {
    const g = this.graph();
    const view = this.view();
    if (g.isScope(id)) {
      const s = g.scope(id);
      const proto = g.protoName(s.proto);
      const sum = g.summary(id, (nid) => this.valueOf(nid, view));
      // graph.summary() text, minus the name (already the title), an empty "0 scopes" and a
      // dimensionless unit suffix ("pressure 0.09 1")
      const inner = sum.replace(/^\[/, '').replace(/\]$/, '').replace(`${s.name}: `, '').replace(/^0 scopes, /, '').replace(/ 1$/, '');
      return {
        name: s.name, proto, value: '', prov: 'computed', stat: 'value',
        lines: wrapText(inner.replace(/, /g, ' · '), 30, 2),
        title: `${sum}\nDouble-click to expand`,
        aria: `${g.path(id)}, collapsed ${proto} scope: ${inner}. Press Enter to expand.`,
      };
    }
    const n = g.node(id);
    const prov = g.displayProv(id);
    if (!n) return { name: id, value: '', prov, stat: 'value', aria: id };
    const st = view.stats(id);
    const stoch = !!st && !st.deterministic;
    const v = stoch ? st.p50 : view.value(id);
    const unit = n.type?.unit || '';
    const text = n.type?.dtype === 'text' || !Number.isFinite(v) ? '—' : unitValue(v, unit, { compact: true, bare: !this.st.showUnits });
    const full = n.type?.dtype === 'text' || !Number.isFinite(v) ? 'no value' : unitValue(v, unit);
    return {
      name: n.name,
      value: this.st.showValues ? text : '',
      prov,
      stat: stoch ? 'p50' : 'value',
      aria: `${g.path(id)}, ${PROVENANCE[prov]?.label || prov}, ${stoch ? 'median ' : ''}${full}. Enter selects.`,
    };
  }

  /** @param {string} id */
  provOfItem(id) {
    return this.graph().isScope(id) ? 'computed' : this.graph().displayProv(id);
  }

  /**
   * The viewport is the stage (the area body minus the canvas-mode banner). Read its size and
   * size the canvas backing store only while the canvas renderer is in use.
   */
  syncSize() {
    if (!this.st.table) {
      const w = this.stage.clientWidth;
      const h = this.stage.clientHeight;
      if (w > 0 && h > 0) {
        this.w = w;
        this.h = h;
      }
    }
    if (this.mode === 'canvas') this.canvasScene.resize(this.w, this.h);
    else if (this.canvasScene.canvas.width > 1) this.canvasScene.resize(1, 1);
  }

  applyMode() {
    const table = this.st.table;
    this.stage.hidden = table;
    this.tableHost.hidden = !table;
    this.svgScene.setVisible(!table && this.mode === 'svg');
    this.canvasScene.setVisible(!table && this.mode === 'canvas');
    this.root.classList.toggle('is-canvas', this.mode === 'canvas');
  }

  updateBanner() {
    const n = this.scene ? this.scene.items.size : 0;
    if (this.mode !== 'canvas' || this.bannerDismissed) {
      this.banner.hidden = true;
      return;
    }
    this.banner.hidden = false;
    this.banner.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'codicon codicon-info';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = `${n.toLocaleString('en-US')} visible items: drawn on canvas for speed. The 3D Scope Space is built for graphs this size.`;
    const open = document.createElement('button');
    open.className = 'ms-btn is-small';
    open.textContent = 'Open 3D Scope Space';
    open.addEventListener('click', () => /** @type {any} */ (this.ctx).commands.execute('view.reveal', 'space3d', this.selection().primary));
    const back = document.createElement('button');
    back.className = 'ms-btn is-secondary is-small';
    back.textContent = 'Back to default view';
    back.addEventListener('click', () => this.resetCollapse());
    const close = document.createElement('button');
    close.className = 'ms-icon-btn';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
    close.addEventListener('click', () => { this.bannerDismissed = true; this.banner.hidden = true; this.syncSize(); this.invalidate(); });
    this.banner.append(icon, text, open, back, close);
  }

  updateAria() {
    const g = this.graph();
    const sc = this.scene;
    if (!sc) return;
    const metrics = this.vm.metricIds.length;
    const label = `Scope graph of ${g.path(this.viewRoot())}: ${metrics} of ${g.nodes.size} metrics visible, ${this.vm.proxyIds.length} collapsed scopes, ${sc.edges.length} edges. Arrow keys move between nodes, Enter selects or expands, double-click a frame to collapse it.`;
    this.svgScene.svg.setAttribute('aria-label', label);
  }

  // ------------------------------------------------------------------ view transform

  /** @param {{x: number, y: number, k: number}} t @param {boolean} [animate] */
  setTransform(t, animate = false) {
    const d3 = this.d3;
    const to = d3.zoomIdentity.translate(t.x, t.y).scale(t.k);
    this.viewAnim?.dispose();
    this.viewAnim = null;
    const sched = /** @type {any} */ (this.ctx).scheduler;
    if (!animate || sched.reducedMotion || !this.isVisible()) {
      this.zoom.transform(this.zoomSel, to);
      return;
    }
    const from = { ...this.t };
    const t0 = performance.now();
    const dur = 260;
    this.viewAnim = sched.animate(this, () => {
      const u = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - (1 - u) ** 3;
      const k = from.k * (t.k / from.k) ** e;
      // interpolate the world point at the viewport center so zooming feels anchored
      const cx = this.w / 2;
      const cy = this.h / 2;
      const wx0 = (cx - from.x) / from.k;
      const wy0 = (cy - from.y) / from.k;
      const wx1 = (cx - t.x) / t.k;
      const wy1 = (cy - t.y) / t.k;
      const wx = wx0 + (wx1 - wx0) * e;
      const wy = wy0 + (wy1 - wy0) * e;
      this.zoom.transform(this.zoomSel, d3.zoomIdentity.translate(cx - wx * k, cy - wy * k).scale(k));
      if (u >= 1) {
        this.viewAnim?.dispose();
        this.viewAnim = null;
      }
    });
  }

  /**
   * @param {{x: number, y: number, w: number, h: number}} b
   * @param {{pad?: number, maxK?: number, minK?: number}} [o]
   */
  fitTransform(b, o = {}) {
    const pad = o.pad ?? 24;
    const k = Math.max(o.minK ?? 0.01, Math.min(o.maxK ?? 1.25, (this.w - pad * 2) / Math.max(1, b.w), (this.h - pad * 2) / Math.max(1, b.h)));
    return { k, x: this.w / 2 - (b.x + b.w / 2) * k, y: this.h / 2 - (b.y + b.h / 2) * k };
  }

  /** Home: everything in view. @param {boolean} [animate] */
  frameAll(animate = true) {
    if (!this.scene) return;
    this.hint.hidden = true;
    this.setTransform(this.fitTransform({ x: 0, y: 0, w: this.scene.width, h: this.scene.height }), animate);
  }

  /** '.': reveal (expand ancestors of) the selection and fit it. */
  frameSelected() {
    const sel = this.currentSel().selected;
    if (!sel.length) { this.frameAll(); return; }
    const g = this.graph();
    // reveal hidden selections by expanding their ancestors
    const root = this.viewRoot();
    const collapsed = this.collapsedSet();
    let changed = false;
    for (const id of sel.slice(0, 50)) {
      for (const sid of revealPath(g, id)) {
        if (sid === root) break;
        if (collapsed.has(sid)) {
          collapsed.delete(sid);
          this.userCollapsed.delete(sid);
          this.userExpanded.add(sid);
          changed = true;
        }
      }
    }
    if (changed) {
      this.save();
      this.rebuild();
    }
    const b = this.bboxOf(sel);
    if (!b) return;
    this.hint.hidden = true;
    this.setTransform(this.fitTransform(b, { pad: 48, maxK: 1.2 }), true);
  }

  /** Bounding box of the items/frames showing these ids. @param {string[]} ids */
  bboxOf(ids) {
    const sc = this.scene;
    if (!sc) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
      const r = this.vm.rep.get(id);
      const it = r ? sc.items.get(r) || sc.frames.find((f) => f.id === r) : null;
      if (!it) continue;
      x0 = Math.min(x0, it.x);
      y0 = Math.min(y0, it.y);
      x1 = Math.max(x1, it.x + it.w);
      y1 = Math.max(y1, it.y + it.h);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** The answer: the primary selection, else the root's headline output. */
  answerId() {
    const g = this.graph();
    const prim = this.currentSel().primary;
    if (prim && this.vm.rep.get(prim) && this.scene?.items.has(this.vm.rep.get(prim))) return this.vm.rep.get(prim);
    const root = g.scope(this.viewRoot());
    const metrics = (root?.metrics || []).map((m) => g.node(m)).filter(Boolean);
    const pick = metrics.find((n) => n.output && n.headline) || metrics.find((n) => n.output) || metrics.find((n) => n.headline) || metrics[0];
    return pick ? pick.id : null;
  }

  /** Readable default: fit everything if readable, else the answer and its inputs. */
  initialView() {
    const sc = this.scene;
    if (!sc) return;
    const fit = this.fitTransform({ x: 0, y: 0, w: sc.width, h: sc.height });
    if (fit.k >= MIN_READABLE || this.mode === 'canvas') {
      this.setTransform(fit, false);
      this.hint.hidden = true;
      return;
    }
    const id = this.answerId();
    const it = id ? sc.items.get(id) : null;
    if (!it) {
      this.setTransform(fit, false);
      return;
    }
    const ids = [id, ...(this.graph().node(id)?.deps || [])];
    const b = this.bboxOf(ids) || it;
    const k = Math.max(MIN_READABLE, Math.min(1, this.fitTransform(b, { pad: 32 }).k));
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const t = this.st.dir === 'LR'
      ? { k, x: this.w * 0.7 - cx * k, y: this.h * 0.5 - cy * k }
      : { k, x: this.w * 0.5 - cx * k, y: this.h * 0.68 - cy * k };
    this.setTransform(t, false);
    this.hint.hidden = false;
    this.hint.replaceChildren();
    const s = document.createElement('span');
    s.textContent = `Showing ${this.graph().node(id)?.name || 'the answer'} and its inputs at a readable zoom (${sc.items.size} items in this view).`;
    const b2 = document.createElement('button');
    b2.className = 'ms-btn is-secondary is-small';
    b2.textContent = 'Fit all (Home)';
    b2.addEventListener('click', () => this.frameAll());
    this.hint.append(s, b2);
  }

  /** Pan so the world point is centered (minimap). @param {number} wx @param {number} wy */
  centerOn(wx, wy) {
    this.userMoved = true;
    this.hint.hidden = true;
    this.setTransform({ k: this.t.k, x: this.w / 2 - wx * this.t.k, y: this.h / 2 - wy * this.t.k }, false);
  }

  /** Keep an item on screen (keyboard navigation). @param {string} id */
  ensureVisible(id) {
    const it = this.scene?.items.get(id) || this.scene?.frames.find((f) => f.id === id);
    if (!it) return;
    const { x, y, k } = this.t;
    const sx0 = it.x * k + x;
    const sy0 = it.y * k + y;
    const sx1 = sx0 + Math.min(it.w, 400) * k;
    const sy1 = sy0 + Math.min(it.h, 200) * k;
    const m = 24;
    let dx = 0;
    let dy = 0;
    if (sx0 < m) dx = m - sx0;
    else if (sx1 > this.w - m) dx = this.w - m - sx1;
    if (sy0 < m) dy = m - sy0;
    else if (sy1 > this.h - m) dy = this.h - m - sy1;
    if (dx || dy) this.setTransform({ k, x: x + dx, y: y + dy }, true);
  }

  // ------------------------------------------------------------------ collapse

  /** @param {string} scopeId */
  toggleCollapse(scopeId) {
    const g = this.graph();
    if (!g.scope(scopeId) || scopeId === this.viewRoot()) return;
    this.lastToggleAt = performance.now();
    const collapsed = this.collapsedSet();
    // anchor: keep this scope where it is on screen
    const sc = this.scene;
    const r = sc?.items.get(scopeId) || sc?.frames.find((f) => f.id === scopeId);
    if (r) this.anchor = { id: scopeId, sx: r.x * this.t.k + this.t.x, sy: r.y * this.t.k + this.t.y };
    if (collapsed.has(scopeId)) {
      this.userCollapsed.delete(scopeId);
      this.userExpanded.add(scopeId);
    } else {
      this.userExpanded.delete(scopeId);
      this.userCollapsed.add(scopeId);
    }
    this.save();
    this.rebuild();
    const now = this.collapsedSet().has(scopeId);
    this.announce(`${g.scope(scopeId).name} ${now ? 'collapsed' : 'expanded'}; ${this.scene?.items.size || 0} items visible.`);
    // keep keyboard focus on the toggled scope (proxy or frame header)
    if (this.mode === 'svg' && this.stage.contains(document.activeElement)) this.svgScene.setFocusItem(scopeId, true);
  }

  /** @param {Set<string>} target */
  applyCollapse(target) {
    this.setCollapsed(target);
    this.save();
    this.pendingView = 'fit';
    this.rebuild();
  }

  resetCollapse() {
    this.userCollapsed.clear();
    this.userExpanded.clear();
    this.save();
    this.pendingView = 'initial';
    this.bannerDismissed = false;
    this.rebuild();
  }

  expandAll() { this.applyCollapse(new Set()); }

  collapseAll() { this.applyCollapse(collapsedBelow(this.graph(), 1, this.viewRoot())); }

  /** @param {number} depth */
  expandToDepth(depth) { this.applyCollapse(collapsedBelow(this.graph(), depth, this.viewRoot())); }

  // ------------------------------------------------------------------ hover / selection

  /** @param {string|null} id */
  setLocalHover(id) {
    if (id === this.localHover) return;
    this.localHover = id;
    this.applyHover();
  }

  applyHover() {
    if (!this.scene || !this.vm) return;
    let id = this.localHover;
    if (!id && this.extHover) id = this.vm.rep.get(this.extHover) || null;
    if (!id || !this.scene.items.has(id)) {
      this.svgScene.setHover(null);
      this.canvasScene.setHover(null);
      if (this.mode === 'canvas') this.invalidate();
      return;
    }
    const g = this.graph();
    const sources = g.isScope(id) ? g.subtreeNodes(id) : [id];
    const down = coneDown(g, sources);
    const up = coneUp(g, sources);
    const cone = new Set();
    const ups = new Set();
    for (const n of down) { const r = this.vm.rep.get(n); if (r && r !== id && this.scene.items.has(r)) cone.add(r); }
    for (const n of up) { const r = this.vm.rep.get(n); if (r && r !== id && this.scene.items.has(r) && !cone.has(r)) ups.add(r); }
    const h = { id, cone, up: ups };
    if (this.mode === 'svg') this.svgScene.setHover(h);
    else { this.canvasScene.setHover(h); this.invalidate(); }
  }

  applySelection() {
    if (!this.scene) return;
    const sel = this.currentSel();
    const vis = new Set();
    for (const id of sel.selected || []) {
      const r = this.vm.rep.get(id);
      if (r && this.scene.items.has(r)) vis.add(r);
    }
    const prim = sel.primary ? this.vm.rep.get(sel.primary) || null : null;
    this.svgScene.setSelection(vis, prim);
    this.canvasScene.setSelection(vis, prim);
    // selected expanded scopes: highlight their frame
    for (const el of this.svgScene.gFrames.querySelectorAll('.frame.is-sel')) el.classList.remove('is-sel');
    for (const id of sel.selected || []) {
      if (this.graph().isScope(id) && !this.scene.items.has(id)) {
        this.svgScene.gFrames.querySelector(`[data-frame="${CSS.escape(id)}"]`)?.classList.add('is-sel');
      }
    }
    if (this.mode === 'canvas') this.invalidate();
    this.updateSidebar();
  }

  /** @param {import('../base-editor.js').SelectionState} sel */
  onSelection(sel) {
    this.localSel = sel.source === 'local' ? sel : null;
    if (this.viewRoot() !== this.vm?.root) { this.pendingView = 'initial'; this.rebuild(); return; }
    this.applySelection();
  }

  /** @param {string|null} id */
  onHover(id) {
    if (id === this.extHover) return;
    this.extHover = id;
    if (!this.localHover) this.applyHover();
  }

  /** Selection this area shows: local while sync is off, else global. */
  currentSel() {
    return this.localSel || this.selection();
  }

  /** @param {'up'|'down'|'proto'} what */
  selectRelated(what) {
    const g = this.graph();
    const sel = this.currentSel();
    const prim = sel.primary;
    if (!prim) return;
    if (what === 'proto') {
      const sid = g.scopeIdOf(prim);
      const proto = g.scope(sid)?.proto;
      if (!proto) return;
      const scopes = [...g.scopes.values()].filter((s) => s.proto === proto);
      if (g.isScope(prim)) this.select(scopes.map((s) => s.id));
      else {
        const name = g.node(prim)?.name;
        this.select([prim, ...scopes.flatMap((s) => s.metrics.filter((m) => g.node(m)?.name === name && m !== prim))]);
      }
      this.announce(`Selected ${this.currentSel().selected.length} items with prototype ${g.protoName(proto)}.`);
      return;
    }
    const sources = sel.selected.flatMap((id) => (g.isScope(id) ? g.subtreeNodes(id) : [id]));
    const set = what === 'up' ? coneUp(g, sources) : coneDown(g, sources);
    this.select([prim, ...[...set].filter((id) => id !== prim)]);
    this.announce(`Selected ${set.size} ${what === 'up' ? 'upstream' : 'downstream'} metrics.`);
  }

  /** @param {string} text */
  announce(text) {
    this.status.textContent = text;
  }

  // ------------------------------------------------------------------ events

  wireEvents() {
    const stage = this.stage;
    const itemOf = (t) => (t instanceof Element ? t.closest('[data-item]') : null);

    this.listen(stage, 'pointerover', (e) => {
      if (this.mode !== 'svg') return;
      const el = itemOf(e.target);
      const id = el ? el.getAttribute('data-item') : null;
      if (id && id !== this.localHover) {
        this.setLocalHover(id);
        this.hover(id);
      }
    });
    this.listen(stage, 'pointerout', (e) => {
      if (this.mode !== 'svg') return;
      const el = itemOf(e.target);
      const rel = /** @type {PointerEvent} */ (e).relatedTarget;
      if (el && !(rel instanceof Node && el.contains(rel))) {
        const next = itemOf(rel);
        if (!next) {
          this.setLocalHover(null);
          this.hover(null);
        }
      }
    });
    const hoverCanvas = /** @type {any} */ (this.ctx).scheduler.rafThrottle((x, y) => {
      if (this.mode !== 'canvas') return;
      const id = this.canvasScene.hitItem(x, y);
      if (id !== this.localHover) {
        this.setLocalHover(id);
        this.hover(id);
      }
      this.canvasScene.canvas.style.cursor = id ? 'pointer' : '';
    });
    this.disposables.add({ dispose: () => hoverCanvas.cancel() });
    this.listen(stage, 'pointermove', (e) => {
      if (this.mode !== 'canvas') return;
      const r = stage.getBoundingClientRect();
      const pe = /** @type {PointerEvent} */ (e);
      hoverCanvas(pe.clientX - r.left, pe.clientY - r.top);
    });
    this.listen(stage, 'pointerleave', () => {
      if (this.localHover) {
        this.setLocalHover(null);
        this.hover(null);
      }
    });

    this.listen(stage, 'click', (e) => {
      const me = /** @type {MouseEvent} */ (e);
      const mode = me.shiftKey ? 'add' : me.ctrlKey || me.metaKey ? 'toggle' : 'replace';
      const hit = this.hitAt(me);
      if (hit.toggle) { this.toggleCollapse(hit.toggle); return; }
      if (hit.item) {
        this.select([hit.item], { mode });
        if (this.mode === 'svg') this.svgScene.setFocusItem(hit.item);
        return;
      }
      if (hit.head) { this.select([hit.head], { mode }); return; }
      if (mode === 'replace' && this.currentSel().selected.length) this.select([]);
    });
    this.listen(stage, 'dblclick', (e) => {
      const me = /** @type {MouseEvent} */ (e);
      if (performance.now() - (this.lastToggleAt || 0) < 450) return; // second half of a toggle click
      const hit = this.hitAt(me);
      if (hit.item && this.graph().isScope(hit.item)) { me.preventDefault(); this.toggleCollapse(hit.item); return; }
      if (hit.item) return;
      if (hit.frame && hit.frame !== this.viewRoot()) { me.preventDefault(); this.toggleCollapse(hit.frame); }
    });
    this.listen(stage, 'contextmenu', (e) => {
      const me = /** @type {MouseEvent} */ (e);
      const hit = this.hitAt(me);
      const id = hit.item || hit.head || hit.frame;
      if (!id) return;
      me.preventDefault();
      if (!this.currentSel().selected.includes(id)) this.select([id]);
      this.showContextMenu(id, { x: me.clientX, y: me.clientY });
    });
    this.listen(stage, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(stage, 'focusin', (e) => {
      const t = /** @type {Element} */ (e.target);
      const id = t.getAttribute?.('data-item') || t.getAttribute?.('data-frame-head');
      if (id && this.mode === 'svg') {
        this.svgScene.setFocusItem(id);
        this.ensureVisible(id);
      }
    });
  }

  /**
   * What is under the pointer: item, frame header, frame, or the collapse toggle.
   * @param {MouseEvent} e
   * @returns {{item?: string|null, head?: string|null, frame?: string|null, toggle?: string|null}}
   */
  hitAt(e) {
    if (this.mode === 'svg') {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return {};
      const tog = t.closest('.frame-toggle');
      const head = t.closest('[data-frame-head]');
      if (tog && head) return { toggle: head.getAttribute('data-frame-head') };
      const item = t.closest('[data-item]');
      if (item) return { item: item.getAttribute('data-item') };
      if (head) return { head: head.getAttribute('data-frame-head'), frame: head.getAttribute('data-frame-head') };
      const frame = t.closest('[data-frame]');
      return { frame: frame ? frame.getAttribute('data-frame') : null };
    }
    const r = this.stage.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const item = this.canvasScene.hitItem(x, y);
    if (item) return { item };
    const frame = this.canvasScene.hitFrame(x, y);
    if (!frame) return {};
    const f = this.scene?.frames.find((ff) => ff.id === frame);
    const wy = this.canvasScene.toWorld(x, y).y;
    if (f && f.depth > 0 && wy - f.y < 24 / Math.min(1, this.t.k)) return { head: frame, frame };
    return { frame };
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const t = /** @type {Element} */ (e.target);
    const id = t.getAttribute?.('data-item') || null;
    const head = t.getAttribute?.('data-frame-head') || null;
    const cur = id || head;
    const k = e.key;
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      e.preventDefault();
      const f = k === '+' || k === '=' ? 1.25 : 0.8;
      const nk = Math.max(0.01, Math.min(4, this.t.k * f));
      const cx = this.w / 2;
      const cy = this.h / 2;
      this.userMoved = true;
      this.setTransform({ k: nk, x: cx - ((cx - this.t.x) / this.t.k) * nk, y: cy - ((cy - this.t.y) / this.t.k) * nk }, true);
      return;
    }
    if (!cur) return;
    if (k === 'Enter') {
      e.preventDefault();
      if (head) this.toggleCollapse(head);
      else if (this.graph().isScope(cur)) this.toggleCollapse(cur);
      else this.select([cur], { mode: e.shiftKey ? 'add' : 'replace' });
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      this.select([cur], { mode: e.shiftKey ? 'add' : e.ctrlKey ? 'toggle' : 'replace' });
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const next = this.spatialNext(cur, k);
      if (next) this.svgScene.setFocusItem(next, true);
    }
  }

  /**
   * Nearest focusable (item or frame header) in an arrow direction.
   * @param {string} from @param {string} key
   */
  spatialNext(from, key) {
    const sc = this.scene;
    if (!sc) return null;
    /** @type {Array<{id: string, cx: number, cy: number}>} */
    const cands = [];
    for (const it of sc.items.values()) cands.push({ id: it.id, cx: it.x + it.w / 2, cy: it.y + it.h / 2 });
    for (const f of sc.frames) if (f.depth > 0) cands.push({ id: f.id, cx: f.x + 60, cy: f.y + 12 });
    const src = cands.find((c) => c.id === from);
    if (!src) return null;
    const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
    const dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
    let best = null;
    let bestS = Infinity;
    for (const c of cands) {
      if (c.id === from) continue;
      const vx = c.cx - src.cx;
      const vy = c.cy - src.cy;
      const along = vx * dx + vy * dy;
      if (along <= 4) continue;
      const across = Math.abs(vx * dy) + Math.abs(vy * dx);
      const s = along + across * 2.5;
      if (s < bestS) { bestS = s; best = c.id; }
    }
    return best;
  }

  /** @param {string} id @param {{x: number, y: number}} at */
  showContextMenu(id, at) {
    const g = this.graph();
    const isScope = g.isScope(id);
    const collapsed = this.collapsedSet();
    const items = [
      { label: 'Select Upstream', run: () => this.selectRelated('up') },
      { label: 'Select Downstream', run: () => this.selectRelated('down') },
      { label: 'Select Same Prototype', run: () => this.selectRelated('proto') },
      { separator: true },
    ];
    if (isScope && id !== this.viewRoot()) items.push({ label: collapsed.has(id) ? 'Expand Scope' : 'Collapse Scope', run: () => this.toggleCollapse(id) });
    else if (!isScope) {
      const sid = g.scopeIdOf(id);
      if (sid && sid !== this.viewRoot()) items.push({ label: `Collapse ${g.scope(sid)?.name || 'Scope'}`, run: () => this.toggleCollapse(sid) });
    }
    items.push({ label: 'Frame Selected', key: '.', run: () => this.frameSelected() });
    /** @type {any} */ (this.ctx).ui.showMenu(items, at, { label: `${g.path(id)} actions` });
  }

  // ------------------------------------------------------------------ editor hooks

  /** @param {number} w @param {number} h */
  resize(w, h) {
    const first = !this.sized;
    this.sized = true;
    const pw = this.w;
    const ph = this.h;
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.syncSize();
    const changed = Math.abs(this.w - pw) > 1 || Math.abs(this.h - ph) > 1;
    if (changed && !this.userMoved && first) {
      // the first real size arrives after mount: redo the default view for it
      this.layoutCache.key = '';
      this.pendingView = 'initial';
      this.needsBuild = true;
    }
    this.invalidate();
  }

  render() {
    if (this.needsBuild) {
      this.needsBuild = false;
      this.rebuild();
    }
    if (this.mode === 'svg') this.svgScene.setTransform(this.t);
    else {
      this.canvasScene.setTransform(this.t);
      this.canvasScene.draw();
    }
    if (this.minimap && this.minimap.connected) {
      this.minimap.setView(this.t, this.w, this.h);
      this.minimap.draw();
    }
  }

  /** @param {string[]} changed @param {any} payload */
  onRecompute(changed, payload) {
    if (!this.scene || payload?.structural) return;
    const ids = new Set();
    if (payload?.full || changed.length > 4000) for (const id of this.scene.items.keys()) ids.add(id);
    else {
      for (const c of changed) {
        const r = this.vm.rep.get(c);
        if (r && this.scene.items.has(r)) ids.add(r);
      }
    }
    if (!ids.size) return;
    this.refreshLabels(ids);
    if (!payload?.transient && !payload?.full && !(/** @type {any} */ (this.ctx).scheduler.reducedMotion)) this.pulse([...ids]);
  }

  /** @param {Iterable<string>} ids */
  refreshLabels(ids) {
    const list = [...ids];
    if (this.mode === 'svg') this.svgScene.updateLabels(list, (id) => this.labelOf(id));
    else {
      this.canvasScene.updateLabels(list);
      this.invalidate();
    }
    if (this.st.table) {
      const view = this.view();
      for (const id of list) {
        const cell = this.tableVals.get(id);
        if (cell) cell.textContent = this.tableValue(id, view);
      }
    }
  }

  /** @param {string[]} ids */
  pulse(ids) {
    if (this.mode === 'svg') this.svgScene.pulse(ids);
    else this.canvasScene.pulse(ids);
  }

  /** @param {any} payload */
  onStructure(payload) {
    const g = this.graph();
    if (payload?.kind === 'load') {
      // a different graph (reset / stress): back to the default view for it
      this.userCollapsed.clear();
      this.userExpanded.clear();
      this.knownScopes = new Set(g.scopes.keys());
      this.layoutCache.key = '';
      this.pendingView = 'initial';
      this.bannerDismissed = false;
      this.userMoved = false;
      this.save();
      this.rebuild();
      return;
    }
    // new scopes: small leaves under a visible frame open expanded so the change is visible
    const fresh = [];
    for (const id of g.scopes.keys()) if (!this.knownScopes.has(id)) fresh.push(id);
    this.knownScopes = new Set(g.scopes.keys());
    const root = this.viewRoot();
    for (const id of fresh) {
      const s = g.scope(id);
      if (!s || s.children.length || s.metrics.length > 12) continue;
      const depth = g.ancestors(id).length - g.ancestors(root).length;
      if (isDefaultCollapsed(s, depth)) this.userExpanded.add(id);
    }
    const keepT = { ...this.t };
    this.pendingView = 'keep';
    this.rebuild();
    this.setTransform(keepT, false);
    const show = new Set();
    for (const id of fresh) { const r = this.vm.rep.get(id); if (r && this.scene?.items.has(r)) show.add(r); for (const m of g.scope(id)?.metrics || []) if (this.scene?.items.has(m)) show.add(m); }
    for (const c of payload?.changed || []) { const r = this.vm.rep.get(c); if (r && this.scene?.items.has(r)) show.add(r); }
    if (show.size && !(/** @type {any} */ (this.ctx).scheduler.reducedMotion)) this.pulse([...show]);
    if (fresh.length) this.announce(`${fresh.length} new scope${fresh.length === 1 ? '' : 's'}: ${fresh.map((f) => g.scope(f)?.name).join(', ')}.`);
  }

  onScenario() {
    if (!this.scene) return;
    this.svgScene.setScenario(this.scenarioId());
    this.refreshLabels(this.scene.items.keys());
  }

  onTheme() {
    this.canvasScene.refreshPalette();
    this.invalidate();
  }

  onFlags() {
    if (this.vm && this.viewRoot() !== this.vm.root) {
      this.layoutCache.key = '';
      this.pendingView = 'initial';
      this.rebuild();
    }
    this.applySelection();
  }

  focusSearch() {
    if (this.searchInput && this.searchInput.isConnected) {
      this.searchInput.focus();
      this.searchInput.select();
    }
  }

  getState() {
    return {
      ...this.st,
      userCollapsed: this.userCollapsed.size <= 500 ? [...this.userCollapsed] : [],
      userExpanded: this.userExpanded.size <= 500 ? [...this.userExpanded] : [],
    };
  }

  // ------------------------------------------------------------------ header

  getHeaderMenus() {
    const g = this.graph();
    const hasSel = () => !!this.currentSel().primary;
    return [
      {
        label: 'View',
        items: () => [
          { label: 'Frame All', key: 'Home', run: () => this.frameAll() },
          { label: 'Frame Selected', key: '.', disabled: !hasSel(), run: () => this.frameSelected() },
          { separator: true },
          { label: 'Left to Right', checked: this.st.dir === 'LR', run: () => this.setOpt('dir', 'LR') },
          { label: 'Top to Bottom', checked: this.st.dir === 'TB', run: () => this.setOpt('dir', 'TB') },
          { separator: true },
          { label: 'Show Values', checked: this.st.showValues, run: () => this.setOpt('showValues', !this.st.showValues) },
          { label: 'Show Units', checked: this.st.showUnits, disabled: !this.st.showValues, run: () => this.setOpt('showUnits', !this.st.showUnits) },
          { separator: true },
          { label: 'View as Table', checked: this.st.table, run: () => this.setTable(!this.st.table) },
        ],
      },
      {
        label: 'Select',
        items: () => [
          { label: 'Upstream', disabled: !hasSel(), run: () => this.selectRelated('up') },
          { label: 'Downstream', disabled: !hasSel(), run: () => this.selectRelated('down') },
          { label: 'Same Prototype', disabled: !hasSel(), run: () => this.selectRelated('proto') },
          { separator: true },
          { label: 'Clear Selection', disabled: !hasSel(), run: () => this.select([]) },
        ],
      },
      {
        label: 'Graph',
        items: () => [
          { label: 'Collapse All', run: () => this.collapseAll() },
          { label: 'Expand to Depth', submenu: () => [1, 2, 3, 4, 5].map((d) => ({ label: `Depth ${d}`, run: () => this.expandToDepth(d) })) },
          { label: `Expand All (${g.nodes.size.toLocaleString('en-US')} metrics)`, run: () => this.expandAll() },
          { separator: true },
          { label: 'Default View', run: () => this.resetCollapse() },
        ],
      },
    ];
  }

  getHeaderTools() {
    const wrap = document.createElement('div');
    wrap.className = 'ms-row ms-graph-tools';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'ms-input ms-graph-search';
    search.placeholder = 'Find node…';
    search.value = this.searchQ;
    search.setAttribute('aria-label', 'Find a metric or scope in the graph (Enter: next match)');
    search.addEventListener('input', () => { this.searchQ = search.value; this.searchIdx = 0; });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.findNext(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        search.value = '';
        this.searchQ = '';
        search.blur();
      }
    });
    this.searchInput = search;
    const tt = tableToggle(this.st.table, (v) => this.setTable(v));
    tt.setAttribute('aria-label', 'Graph or table view');
    const [b1] = tt.querySelectorAll('button');
    if (b1) b1.textContent = 'Graph';
    wrap.append(search, tt);
    return [wrap];
  }

  /** @param {number} dir */
  findNext(dir) {
    const q = this.searchQ.trim();
    if (!q) return;
    const res = this.graph().search(q, { limit: 12 });
    if (!res.length) { this.announce(`No match for ${q}.`); return; }
    this.searchIdx = (this.searchIdx + (dir > 0 ? 0 : -2) + res.length) % res.length;
    const hit = res[this.searchIdx];
    this.searchIdx = (this.searchIdx + 1) % res.length;
    this.select([hit.id]);
    this.frameSelected();
    this.announce(`${hit.path} (${res.indexOf(hit) + 1} of ${res.length}).`);
  }

  /** @param {'dir'|'showValues'|'showUnits'} key @param {any} value */
  setOpt(key, value) {
    if (this.st[key] === value) return;
    this.st[key] = value;
    this.save();
    this.pendingView = key === 'dir' ? 'fit' : 'keep';
    if (key === 'showUnits') {
      // labels only; no relayout
      this.pendingView = null;
      if (this.scene) this.refreshLabels(this.scene.items.keys());
      return;
    }
    this.rebuild();
  }

  /** @param {boolean} on */
  setTable(on) {
    this.st.table = on;
    this.save();
    this.applyMode();
    this.syncSize();
    if (on) this.buildTable();
    else this.tableHost.replaceChildren();
    /** @type {any} */ (this.ctx).refreshHeader();
    this.invalidate();
  }

  /** @param {string} id @param {any} view */
  tableValue(id, view) {
    const g = this.graph();
    if (g.isScope(id)) return this.labelOf(id).lines?.join(' ') || '';
    const n = g.node(id);
    const v = this.valueOf(id, view);
    return n?.type?.dtype === 'text' || !Number.isFinite(v) ? '—' : unitValue(v, n?.type?.unit || '');
  }

  buildTable() {
    const sc = this.scene;
    if (!sc) return;
    const g = this.graph();
    const view = this.view();
    this.tableVals.clear();
    const ids = [...sc.items.keys()].sort((a, b) => g.path(a).localeCompare(g.path(b)));
    const rows = ids.slice(0, TABLE_CAP).map((id) => {
      const isScope = g.isScope(id);
      const btn = document.createElement('button');
      btn.className = 'ms-graph-link';
      btn.textContent = g.path(id);
      btn.addEventListener('click', () => this.select([id]));
      const prov = document.createElement('span');
      prov.className = 'ms-row';
      if (isScope) prov.textContent = `collapsed ${g.protoName(g.scope(id).proto)}`;
      else {
        const p = g.displayProv(id);
        prov.append(provMark(p), document.createTextNode(` ${PROVENANCE[p]?.label || p}`));
      }
      const val = document.createElement('span');
      val.textContent = this.tableValue(id, view);
      this.tableVals.set(id, val);
      return [btn, prov, val, String((sc.inE.get(id) || []).length), String((sc.outE.get(id) || []).length)];
    });
    const table = tableView({
      caption: `Scope graph of ${g.path(this.viewRoot())}: ${ids.length} visible items`,
      columns: [{ label: 'Metric or scope' }, { label: 'Provenance' }, { label: 'Value', align: 'right' }, { label: 'Inputs shown', align: 'right' }, { label: 'Used by shown', align: 'right' }],
      rows,
    });
    this.tableHost.replaceChildren(table);
    if (ids.length > TABLE_CAP) {
      const note = document.createElement('div');
      note.className = 'ms-muted ms-small ms-graph-table-note';
      note.textContent = `First ${TABLE_CAP.toLocaleString('en-US')} of ${ids.length.toLocaleString('en-US')} items. Collapse scopes or use Find to narrow down.`;
      this.tableHost.appendChild(note);
    }
  }

  // ------------------------------------------------------------------ sidebar (N)

  /** @param {HTMLElement} el */
  renderSidebar(el) {
    this.minimap?.dispose();
    const wrap = document.createElement('div');
    wrap.className = 'ms-graph-side';
    const head = (t) => {
      const d = document.createElement('div');
      d.className = 'ms-graph-side-h';
      d.textContent = t;
      return d;
    };
    const mm = document.createElement('div');
    wrap.append(head('Minimap'), mm);
    this.minimap = new Minimap(mm, { onPan: (wx, wy) => this.centerOn(wx, wy) });
    if (this.scene) this.minimap.setScene(this.scene, (id) => this.provOfItem(id));
    this.sideStats = document.createElement('div');
    this.sideStats.className = 'ms-graph-side-stats ms-small';
    this.sideSel = document.createElement('div');
    this.sideSel.className = 'ms-graph-side-sel ms-small';
    wrap.append(head('Provenance'), provLegend(), head('View'), this.sideStats, head('Selection'), this.sideSel);
    el.appendChild(wrap);
    this.updateSidebar();
    this.invalidate();
  }

  updateSidebar() {
    if (!this.sideStats || !this.sideStats.isConnected || !this.scene) return;
    const g = this.graph();
    const sc = this.scene;
    this.sideStats.replaceChildren();
    const line = (text) => {
      const d = document.createElement('div');
      d.textContent = text;
      this.sideStats.appendChild(d);
    };
    line(`${this.vm.metricIds.length.toLocaleString('en-US')} of ${g.nodes.size.toLocaleString('en-US')} metrics visible`);
    line(`${this.vm.proxyIds.length} collapsed scope${this.vm.proxyIds.length === 1 ? '' : 's'} · ${sc.frames.length} frame${sc.frames.length === 1 ? '' : 's'}`);
    line(`${sc.edges.length.toLocaleString('en-US')} edges · layout ${Math.max(1, Math.round(this.layoutMs || 0))} ms`);
    line(`${this.mode === 'svg' ? 'SVG' : 'Canvas'} renderer · ${this.st.dir === 'LR' ? 'left to right' : 'top to bottom'}`);
    this.sideSel.replaceChildren();
    const sel = this.currentSel();
    if (!sel.primary) {
      this.sideSel.textContent = 'Nothing selected. Click a node; Shift adds, Ctrl toggles.';
      return;
    }
    const p = document.createElement('div');
    p.className = 'ms-ellipsis';
    p.textContent = g.path(sel.primary);
    p.title = g.path(sel.primary);
    this.sideSel.appendChild(p);
    if (sel.selected.length > 1) {
      const more = document.createElement('div');
      more.className = 'ms-muted';
      more.textContent = `+ ${sel.selected.length - 1} more`;
      this.sideSel.appendChild(more);
    }
    const row = document.createElement('div');
    row.className = 'ms-row ms-graph-side-actions';
    for (const [label, what] of [['Upstream', 'up'], ['Downstream', 'down'], ['Same prototype', 'proto']]) {
      const b = document.createElement('button');
      b.className = 'ms-btn is-secondary is-small';
      b.textContent = label;
      b.addEventListener('click', () => this.selectRelated(/** @type {any} */ (what)));
      row.appendChild(b);
    }
    this.sideSel.appendChild(row);
  }

  dispose() {
    this.viewAnim?.dispose();
    this.viewAnim = null;
    this.zoomSel?.on('.zoom', null);
    this.svgScene?.dispose();
    this.canvasScene?.dispose();
    this.minimap?.dispose();
    this.minimap = null;
    this.root?.remove();
    super.dispose();
  }
}

/**
 * Downstream cone of several sources in one traversal (sources themselves excluded unless
 * reached from another source).
 * @param {any} g ScopeGraph @param {string[]} sources
 */
function coneDown(g, sources) {
  const out = new Set();
  const seen = new Uint8Array(g.list.length);
  const stack = [];
  for (const s of sources) {
    const i = g.index.get(s);
    if (i !== undefined && !seen[i]) { seen[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    for (const j of g.rev[i]) {
      if (seen[j]) continue;
      seen[j] = 1;
      out.add(g.list[j].id);
      stack.push(j);
    }
  }
  return out;
}

/** @param {any} g ScopeGraph @param {string[]} sources */
function coneUp(g, sources) {
  const out = new Set();
  const seen = new Uint8Array(g.list.length);
  const stack = [];
  for (const s of sources) {
    const i = g.index.get(s);
    if (i !== undefined && !seen[i]) { seen[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const deps = g.depIdx[i];
    for (let k = 0; k < deps.length; k++) {
      const j = deps[k];
      if (j < 0 || seen[j]) continue;
      seen[j] = 1;
      out.add(g.list[j].id);
      stack.push(j);
    }
  }
  return out;
}
