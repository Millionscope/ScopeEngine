/**
 * Workspace tabs (Answer, Model, Scenarios, Minds, Verify, Space, plus user tabs), each owning
 * its own AreaTree and Screen. Switching tabs hides the previous screen (editors stay mounted,
 * keep their state and stop rendering) and lazily renders the next one on first show.
 * Also the single entry point for area operations, focus tracking and persistence.
 * @module workspace/workspaces
 */
import { DisposableStore, listen } from '../core/disposable.js';
import { uid } from '../core/ids.js';
import { log } from '../core/log.js';
import { debounce } from '../core/scheduler.js';
import { editorIds, getEditor } from '../editors/registry.js';
import { AreaTree } from './area-tree.js';
import { CornerGestures } from './corner-gestures.js';
import { PRESETS, getPreset } from './presets.js';
import { Screen } from './screen.js';
import { clearLayout, saveLayout } from './persistence.js';

/**
 * @typedef {Object} Workspace
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {string} preset
 * @property {AreaTree} tree
 * @property {Screen|null} screen
 * @property {HTMLElement} container
 * @property {string|null} activeAreaId
 */

export class WorkspaceManager {
  /**
   * @param {{ container: HTMLElement, env: any }} opts
   */
  constructor({ container, env }) {
    this.container = container;
    this.env = env;
    this.events = env.events;
    this.commands = env.commands;
    /** @type {Workspace[]} */
    this.workspaces = [];
    /** @type {string|null} */
    this.activeId = null;
    /** @type {string|null} */
    this.hoverAreaId = null;
    this.d = new DisposableStore();
    this.gestures = new CornerGestures({
      areaAt: (x, y) => this.activeWorkspace()?.screen?.areaAt(x, y) || null,
      canJoin: (keep, remove) => {
        const t = this.treeOf(keep);
        return t && t === this.treeOf(remove) ? t.canJoin(keep, remove) : { ok: false, reason: 'areas are in different workspaces' };
      },
      split: (areaId, dir, ratio, newFirst) => this.splitArea(areaId, dir, ratio, { newFirst }),
      join: (keep, remove) => this.joinAreas(keep, remove),
    });
    this._save = debounce(() => this.saveNow(), 300);
    this.d.add(listen(window, 'beforeunload', () => this.saveNow()));
  }

  // ------------------------------------------------------------------ setup

  /** @param {any|null} saved */
  init(saved) {
    const known = editorIds();
    let restored = false;
    if (saved && Array.isArray(saved.workspaces) && saved.workspaces.length) {
      try {
        for (const w of saved.workspaces) {
          const tree = AreaTree.deserialize(w.tree, { knownTypes: known });
          this._addWorkspace({ id: w.id || uid('ws'), name: w.name || 'Workspace', icon: w.icon || 'window', preset: w.preset || 'answer', tree, activeAreaId: w.activeAreaId || null });
        }
        restored = true;
      } catch (err) {
        log.warn('workspace', `saved layout was invalid and was reset: ${(/** @type {Error} */ (err)).message}`);
        this._disposeAll();
      }
    }
    if (!restored) for (const p of PRESETS) this._addWorkspace({ id: p.key, name: p.name, icon: p.icon, preset: p.key, tree: p.build() });
    const want = restored && saved.activeId && this.get(saved.activeId) ? saved.activeId : this.workspaces[0].id;
    this.switchTo(want, { initial: true });
    return restored;
  }

  /** @param {Omit<Workspace,'screen'|'container'|'activeAreaId'> & {activeAreaId?: string|null}} w */
  _addWorkspace(w, index = this.workspaces.length) {
    const container = document.createElement('div');
    container.className = 'ms-workspace';
    container.dataset.ws = w.id;
    container.hidden = true;
    this.container.appendChild(container);
    /** @type {Workspace} */
    const ws = { ...w, screen: null, container, activeAreaId: w.activeAreaId || null };
    this.workspaces.splice(index, 0, ws);
    return ws;
  }

  _disposeAll() {
    for (const w of this.workspaces) {
      w.screen?.dispose();
      w.container.remove();
    }
    this.workspaces = [];
    this.activeId = null;
  }

  // ------------------------------------------------------------------ queries

  /** @param {string} id */
  get(id) { return this.workspaces.find((w) => w.id === id) || null; }
  activeWorkspace() { return this.activeId ? this.get(this.activeId) : null; }
  activeTree() { return this.activeWorkspace()?.tree || null; }

  /** @param {string} areaId */
  workspaceOf(areaId) {
    return this.workspaces.find((w) => w.tree.area(areaId)) || null;
  }
  /** @param {string} areaId */
  treeOf(areaId) { return this.workspaceOf(areaId)?.tree || null; }

  /** @param {string} areaId @returns {import('./area.js').Area|null} */
  getArea(areaId) {
    const w = this.workspaceOf(areaId);
    return w?.screen?.getArea(areaId) || null;
  }

  /** Areas of the active workspace. */
  activeAreas() {
    const w = this.activeWorkspace();
    return w?.screen ? [...w.screen.areas.values()] : [];
  }

  /** Visible areas of a given editor type in the active workspace. @param {string} type */
  visibleAreasOfType(type) {
    return this.activeAreas().filter((a) => a.leaf.editorType === type && a.isVisible());
  }

  activeAreaId() { return this.activeWorkspace()?.activeAreaId || null; }
  activeArea() { const id = this.activeAreaId(); return id ? this.getArea(id) : null; }
  hoverArea() { return this.hoverAreaId ? this.getArea(this.hoverAreaId) : null; }
  /** Target for shortcuts: area under the pointer, else the active area (Blender rule). */
  targetArea() { return this.hoverArea() || this.activeArea(); }

  /** Human position of `toId` relative to `fromId`: left/right/above/below. */
  relativePosition(fromId, toId) {
    const a = this.getArea(fromId)?.el.getBoundingClientRect();
    const b = this.getArea(toId)?.el.getBoundingClientRect();
    if (!a || !b) return 'elsewhere';
    if (b.right <= a.left + 2) return 'left';
    if (b.left >= a.right - 2) return 'right';
    if (b.bottom <= a.top + 2) return 'above';
    if (b.top >= a.bottom - 2) return 'below';
    return 'overlapping';
  }

  // ------------------------------------------------------------------ workspace tabs

  /** @param {string} id @param {{initial?: boolean}} [opts] */
  switchTo(id, opts = {}) {
    const next = this.get(id);
    if (!next) return;
    const prevId = this.activeId;
    const prev = prevId ? this.get(prevId) : null;
    if (prev && prev !== next) {
      prev.screen?.captureStates();
      prev.screen?.setVisible(false);
      prev.container.hidden = true;
    }
    this.activeId = id;
    next.container.hidden = false;
    if (!next.screen) {
      next.screen = new Screen({ workspaceId: next.id, tree: next.tree, container: next.container, ws: this, env: this.env });
      next.screen.setVisible(true);
      next.screen.render();
    } else {
      next.screen.setVisible(true);
    }
    this._applyFullscreenClass();
    if (!next.activeAreaId || !next.tree.area(next.activeAreaId)) {
      const chat = next.tree.leaves().find((l) => l.editorType === 'chat');
      next.activeAreaId = (chat || next.tree.leaves()[0]).id;
    }
    this._applyActive();
    this.hoverAreaId = null;
    if (!opts.initial) this.persistSoon('switch');
    this.events.emit('workspace:changed', { activeId: id, previousId: prevId });
    this.events.emit('layout:changed', { workspaceId: id, reason: 'switch' });
    this._emitFocus();
  }

  /** @param {number} delta */
  cycle(delta) {
    const i = this.workspaces.findIndex((w) => w.id === this.activeId);
    const n = this.workspaces.length;
    this.switchTo(this.workspaces[(i + delta + n) % n].id);
  }

  /** @param {string} presetKey @param {string} [name] */
  addWorkspace(presetKey = 'answer', name) {
    const p = getPreset(presetKey) || PRESETS[0];
    const ws = this._addWorkspace({ id: uid('ws'), name: name || this._uniqueName(p.name), icon: p.icon, preset: p.key, tree: p.build() });
    this.switchTo(ws.id);
    this._layoutChanged('add-workspace');
    return ws.id;
  }

  /** @param {string} id */
  duplicateWorkspace(id) {
    const src = this.get(id);
    if (!src) return null;
    src.screen?.captureStates();
    const json = src.tree.serialize();
    // fresh ids so areas stay unique across workspaces
    const remap = (n) => {
      n.id = uid(n.kind === 'area' ? 'ar' : 'sp');
      if (n.kind === 'split') { remap(n.a); remap(n.b); }
    };
    remap(json.root);
    json.maximizedId = null;
    const tree = AreaTree.deserialize(json);
    const idx = this.workspaces.indexOf(src) + 1;
    const ws = this._addWorkspace({ id: uid('ws'), name: this._uniqueName(`${src.name} copy`), icon: src.icon, preset: src.preset, tree }, idx);
    this.switchTo(ws.id);
    this._layoutChanged('duplicate-workspace');
    return ws.id;
  }

  /** @param {string} id @param {string} name */
  renameWorkspace(id, name) {
    const w = this.get(id);
    const n = String(name || '').trim().slice(0, 40);
    if (!w || !n) return;
    w.name = n;
    this._layoutChanged('rename-workspace');
  }

  /** @param {string} id */
  removeWorkspace(id) {
    if (this.workspaces.length <= 1) return false;
    const w = this.get(id);
    if (!w) return false;
    const idx = this.workspaces.indexOf(w);
    if (this.activeId === id) this.switchTo(this.workspaces[idx === 0 ? 1 : idx - 1].id);
    w.screen?.dispose();
    w.container.remove();
    this.workspaces.splice(this.workspaces.indexOf(w), 1);
    this._layoutChanged('remove-workspace');
    return true;
  }

  /** @param {string} id @param {number} toIndex */
  moveWorkspace(id, toIndex) {
    const from = this.workspaces.findIndex((w) => w.id === id);
    if (from < 0) return;
    const [w] = this.workspaces.splice(from, 1);
    const idx = Math.max(0, Math.min(this.workspaces.length, toIndex > from ? toIndex - 1 : toIndex));
    this.workspaces.splice(idx, 0, w);
    this._layoutChanged('reorder');
  }

  /** @param {string} base */
  _uniqueName(base) {
    let n = base;
    let i = 2;
    while (this.workspaces.some((w) => w.name === n)) n = `${base} ${i++}`;
    return n;
  }

  // ------------------------------------------------------------------ area operations

  /** @param {string} areaId @param {string} type */
  setAreaType(areaId, type) {
    const w = this.workspaceOf(areaId);
    const area = this.getArea(areaId);
    if (!w || !getEditor(type)) return;
    const from = w.tree.area(areaId)?.editorType;
    if (from === type && area?.editor) return;
    w.tree.replaceEditor(areaId, type, {});
    area?.mount();
    this.setActiveArea(areaId);
    this.events.emit('area:typeChanged', { areaId, workspaceId: w.id, from, to: type });
    this._layoutChanged('type');
  }

  /**
   * @param {string} areaId @param {'row'|'col'} dir @param {number} [ratio]
   * @param {{newFirst?: boolean, type?: string|null, copyState?: boolean}} [opts]
   */
  splitArea(areaId, dir, ratio = 0.5, opts = {}) {
    const w = this.workspaceOf(areaId);
    if (!w) return null;
    const area = this.getArea(areaId);
    area?.captureState();
    const id = w.tree.split(areaId, dir, ratio, opts.type || null, { newFirst: opts.newFirst, copyState: opts.copyState });
    if (w.tree.maximizedId) w.tree.restore();
    w.screen?.render();
    this._layoutChanged('split');
    return id;
  }

  /** @param {string} areaId */
  duplicateArea(areaId) {
    const r = this.getArea(areaId)?.el.getBoundingClientRect();
    const dir = r && r.height > r.width ? 'col' : 'row';
    return this.splitArea(areaId, dir, 0.5, { copyState: true });
  }

  /** @param {string} keepId @param {string} removeId */
  joinAreas(keepId, removeId) {
    const w = this.workspaceOf(keepId);
    if (!w) return;
    const chk = w.tree.canJoin(keepId, removeId);
    if (!chk.ok) {
      this.env.services.notify?.warn(`Cannot join: ${chk.reason}`);
      return;
    }
    w.tree.join(keepId, removeId);
    w.screen?.render();
    this.setActiveArea(keepId);
    this._layoutChanged('join');
  }

  /** @param {string} aId @param {string} bId */
  swapAreas(aId, bId) {
    const w = this.workspaceOf(aId);
    if (!w || w !== this.workspaceOf(bId)) return;
    w.tree.swap(aId, bId);
    w.screen?.render();
    this._layoutChanged('swap');
  }

  /** @param {string} areaId */
  closeArea(areaId) {
    const w = this.workspaceOf(areaId);
    if (!w || w.tree.size <= 1) return;
    const next = w.tree.close(areaId);
    w.screen?.render();
    if (w.activeAreaId === areaId) w.activeAreaId = next;
    if (this.hoverAreaId === areaId) this.hoverAreaId = null;
    this._applyActive();
    this._applyFullscreenClass();
    this._layoutChanged('close');
    this._emitFocus();
  }

  /** @param {string} areaId @param {'tools'|'sidebar'} which */
  toggleRegion(areaId, which) {
    const area = this.getArea(areaId);
    if (!area) return;
    area.leaf.regions[which] = !area.leaf.regions[which];
    area.applyLeaf();
    this._layoutChanged('region');
  }

  /** @param {string} areaId @param {'top'|'bottom'} pos */
  setHeaderPos(areaId, pos) {
    const area = this.getArea(areaId);
    if (!area) return;
    area.leaf.headerPos = pos;
    area.applyLeaf();
    this._layoutChanged('header');
  }

  /** @param {string} areaId */
  toggleHeaderCollapsed(areaId) {
    const area = this.getArea(areaId);
    if (!area) return;
    area.leaf.headerCollapsed = !area.leaf.headerCollapsed;
    area.applyLeaf();
    this._layoutChanged('header');
  }

  /** @param {string} areaId */
  toggleMaximize(areaId) {
    const w = this.workspaceOf(areaId);
    if (!w) return;
    if (w.tree.maximizedId) w.tree.restore();
    else w.tree.maximize(areaId);
    w.screen?.applyMaximize();
    this._applyFullscreenClass();
    this.setActiveArea(areaId);
    this._layoutChanged('maximize');
  }

  /** @param {string} areaId */
  toggleFullscreen(areaId) {
    const w = this.workspaceOf(areaId);
    if (!w) return;
    if (w.tree.fullscreen && w.tree.maximizedId === areaId) w.tree.restore();
    else {
      w.tree.maximize(areaId);
      w.tree.fullscreen = true;
    }
    w.screen?.applyMaximize();
    this._applyFullscreenClass();
    this.setActiveArea(areaId);
    this._layoutChanged('fullscreen');
  }

  restoreMaximized() {
    const w = this.activeWorkspace();
    if (!w || !w.tree.maximizedId) return false;
    w.tree.restore();
    w.screen?.applyMaximize();
    this._applyFullscreenClass();
    this._layoutChanged('restore');
    return true;
  }

  _applyFullscreenClass() {
    const fs = !!this.activeWorkspace()?.tree.fullscreen;
    this.container.closest('.ms-app')?.classList.toggle('is-fullscreen-area', fs);
  }

  // ------------------------------------------------------------------ focus

  /** @param {string} areaId */
  setActiveArea(areaId) {
    const w = this.workspaceOf(areaId);
    if (!w) return;
    if (w.activeAreaId === areaId) return;
    w.activeAreaId = areaId;
    if (w.id === this.activeId) {
      this._applyActive();
      this._emitFocus();
    }
  }

  _applyActive() {
    const w = this.activeWorkspace();
    if (!w?.screen) return;
    for (const [id, area] of w.screen.areas) area.setActive(id === w.activeAreaId);
  }

  _emitFocus() {
    const area = this.activeArea();
    if (!area) return;
    this.events.emit('area:focused', { areaId: area.id, workspaceId: this.activeId, editorType: area.leaf.editorType });
  }

  /** @param {string} areaId */
  setHoverArea(areaId) { this.hoverAreaId = areaId; }
  /** @param {string} areaId */
  clearHoverArea(areaId) { if (this.hoverAreaId === areaId) this.hoverAreaId = null; }

  /**
   * Move focus to the neighboring area in a direction (Ctrl+Alt+Arrow).
   * @param {'left'|'right'|'up'|'down'} dir
   */
  moveFocus(dir) {
    const cur = this.activeArea();
    const areas = this.activeAreas().filter((a) => a.isVisible());
    if (!cur || areas.length < 2) return;
    const r = cur.el.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    for (const a of areas) {
      if (a === cur) continue;
      const o = a.el.getBoundingClientRect();
      let gap;
      let overlap;
      if (dir === 'left') { gap = r.left - o.right; overlap = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top); }
      else if (dir === 'right') { gap = o.left - r.right; overlap = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top); }
      else if (dir === 'up') { gap = r.top - o.bottom; overlap = Math.min(r.right, o.right) - Math.max(r.left, o.left); }
      else { gap = o.top - r.bottom; overlap = Math.min(r.right, o.right) - Math.max(r.left, o.left); }
      if (gap < -4) continue;
      const score = gap * 10 + (overlap > 0 ? -overlap / 1000 : 5000 - overlap);
      if (score < bestScore) { bestScore = score; best = a; }
    }
    if (best) {
      this.setActiveArea(best.id);
      best.el.tabIndex = -1;
      best.el.focus({ preventScroll: true });
      best.flash();
    }
  }

  // ------------------------------------------------------------------ persistence

  /** @param {string} [reason] */
  _layoutChanged(reason) {
    this.events.emit('layout:changed', { workspaceId: this.activeId, reason });
    this.persistSoon(reason);
  }

  /** @param {string} [reason] */
  persistSoon(reason) { // eslint-disable-line no-unused-vars
    this._save();
  }

  serialize() {
    for (const w of this.workspaces) w.screen?.captureStates();
    return {
      activeId: this.activeId,
      workspaces: this.workspaces.map((w) => ({
        id: w.id, name: w.name, icon: w.icon, preset: w.preset, activeAreaId: w.activeAreaId, tree: w.tree.serialize(),
      })),
    };
  }

  saveNow() {
    this._save.cancel();
    saveLayout(this.serialize());
  }

  /** Discard all layouts and rebuild the presets (no page reload). */
  resetLayout() {
    this._save.cancel();
    clearLayout();
    this._disposeAll();
    for (const p of PRESETS) this._addWorkspace({ id: p.key, name: p.name, icon: p.icon, preset: p.key, tree: p.build() });
    this.switchTo(this.workspaces[0].id);
    this.saveNow();
  }

  dispose() {
    this.d.dispose();
    this._disposeAll();
  }
}
