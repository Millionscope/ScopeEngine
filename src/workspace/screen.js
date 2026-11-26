/**
 * Renders one workspace's AreaTree into nested flex containers and owns its Area instances.
 * Rendering is keyed by area id: split containers are rebuilt on structural changes, but area
 * elements (and their mounted editors) are moved, never re-created, so split/join/swap keep
 * editor state. Areas that leave the tree are disposed.
 * @module workspace/screen
 */
import { DisposableStore } from '../core/disposable.js';
import { getEditor } from '../editors/registry.js';
import { attachSplitter } from './splitter.js';
import { Area } from './area.js';

export class Screen {
  /**
   * @param {{
   *   workspaceId: string,
   *   tree: import('./area-tree.js').AreaTree,
   *   container: HTMLElement,
   *   ws: import('./workspaces.js').WorkspaceManager,
   *   env: any,
   * }} opts
   */
  constructor({ workspaceId, tree, container, ws, env }) {
    this.workspaceId = workspaceId;
    this.tree = tree;
    this.container = container;
    this.ws = ws;
    this.env = env;
    /** @type {Map<string, Area>} */
    this.areas = new Map();
    this.splitD = new DisposableStore();
    this.visible = false;
  }

  /** Rebuild the split structure, reusing area instances. */
  render() {
    this.splitD.clear();
    const live = new Set(this.tree.leaves().map((l) => l.id));
    for (const [id, area] of this.areas) {
      if (!live.has(id)) {
        area.dispose();
        this.areas.delete(id);
      }
    }
    const rootEl = this._build(this.tree.root);
    this.container.replaceChildren(rootEl);
    this.applyMaximize();
    for (const area of this.areas.values()) area.setVisible(this.visible);
  }

  /** @param {import('./area-tree.js').TreeNode} node @returns {HTMLElement} */
  _build(node) {
    if (node.kind === 'area') {
      let area = this.areas.get(node.id);
      if (!area) {
        area = new Area({ leaf: node, ws: this.ws, workspaceId: this.workspaceId, env: this.env });
        this.areas.set(node.id, area);
        area.mount();
      } else {
        area.leaf = node;
        area.applyLeaf();
      }
      return area.el;
    }
    const el = document.createElement('div');
    el.className = `ms-split is-${node.dir}`;
    el.dataset.splitId = node.id;
    const paneA = document.createElement('div');
    paneA.className = 'ms-pane';
    const paneB = document.createElement('div');
    paneB.className = 'ms-pane';
    paneA.style.flexGrow = String(node.ratio);
    paneB.style.flexGrow = String(1 - node.ratio);
    const splitter = document.createElement('div');
    splitter.className = 'ms-splitter';
    paneA.appendChild(this._build(node.a));
    paneB.appendChild(this._build(node.b));
    el.append(paneA, splitter, paneB);
    const label = (n) => {
      if (n.kind === 'area') return getEditor(n.editorType)?.label || n.editorType;
      return 'group';
    };
    this.splitD.add(attachSplitter(splitter, {
      split: node,
      tree: this.tree,
      splitEl: el,
      paneA,
      paneB,
      labelA: () => label(node.a),
      labelB: () => label(node.b),
      scheduler: this.env.scheduler,
      onChange: (final) => {
        if (final) this.ws.persistSoon('resize');
      },
    }));
    return el;
  }

  applyMaximize() {
    const max = this.tree.maximizedId;
    this.container.classList.toggle('has-maximized', !!max);
    for (const [id, area] of this.areas) {
      area.el.classList.toggle('is-maximized', id === max);
      area.visibilityChanged();
    }
  }

  /** @param {boolean} v */
  setVisible(v) {
    this.visible = v;
    this.container.hidden = !v;
    for (const area of this.areas.values()) area.setVisible(v);
  }

  /** @param {string} id */
  getArea(id) {
    return this.areas.get(id) || null;
  }

  /** Area whose element contains the point. @param {number} x @param {number} y */
  areaAt(x, y) {
    if (!this.visible) return null;
    const max = this.tree.maximizedId;
    for (const area of this.areas.values()) {
      if (max && area.id !== max) continue;
      const r = area.el.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return area;
    }
    return null;
  }

  captureStates() {
    for (const a of this.areas.values()) a.captureState();
  }

  dispose() {
    this.splitD.dispose();
    for (const a of this.areas.values()) a.dispose();
    this.areas.clear();
    this.container.remove();
  }
}
