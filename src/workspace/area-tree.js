/**
 * Binary split tree for a workspace screen (pure data, no DOM, unit-tested).
 *
 * Leaf  = { kind:'area', id, editorType, editorState, regions:{tools, sidebar},
 *           pinnedScopeId, syncSelection, scenarioId, headerPos, headerCollapsed }
 * Split = { kind:'split', id, dir:'row'|'col', ratio, a, b }
 *   dir 'row': a is left, b is right.  dir 'col': a is top, b is bottom.  ratio = share of a.
 *
 * Joins follow Blender's rule: two areas may join only if they share a full edge. In a binary
 * split tree that is guaranteed for siblings (two leaves under the same split), which is the
 * case join() accepts.
 * @module workspace/area-tree
 */
import { uid } from '../core/ids.js';

export const MIN_AREA_W = 160;
export const MIN_AREA_H = 90;
export const SPLITTER = 1;
export const SCHEMA = 1;

/**
 * @typedef {Object} AreaLeaf
 * @property {'area'} kind
 * @property {string} id
 * @property {string} editorType
 * @property {Record<string, any>} editorState
 * @property {{tools: boolean, sidebar: boolean}} regions
 * @property {string|null} pinnedScopeId
 * @property {boolean} syncSelection
 * @property {string|null} scenarioId
 * @property {'top'|'bottom'} headerPos
 * @property {boolean} headerCollapsed
 */

/**
 * @typedef {Object} SplitNode
 * @property {'split'} kind
 * @property {string} id
 * @property {'row'|'col'} dir
 * @property {number} ratio
 * @property {TreeNode} a
 * @property {TreeNode} b
 */

/** @typedef {AreaLeaf|SplitNode} TreeNode */

/**
 * @param {string} editorType
 * @param {Partial<AreaLeaf>} [opts]
 * @returns {AreaLeaf}
 */
export function makeArea(editorType, opts = {}) {
  return {
    kind: 'area',
    id: opts.id || uid('ar'),
    editorType,
    editorState: opts.editorState ? structuredClone(opts.editorState) : {},
    regions: { tools: false, sidebar: false, ...(opts.regions || {}) },
    pinnedScopeId: opts.pinnedScopeId ?? null,
    syncSelection: opts.syncSelection ?? true,
    scenarioId: opts.scenarioId ?? null,
    headerPos: opts.headerPos || 'top',
    headerCollapsed: !!opts.headerCollapsed,
    ...(opts.cycle ? { cycle: [...opts.cycle] } : {}),
  };
}

/**
 * @param {'row'|'col'} dir @param {number} ratio @param {TreeNode} a @param {TreeNode} b
 * @returns {SplitNode}
 */
export function makeSplit(dir, ratio, a, b, id) {
  return { kind: 'split', id: id || uid('sp'), dir, ratio: clamp01(ratio), a, b };
}

/** @param {number} r */
function clamp01(r) {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(0.98, Math.max(0.02, r));
}

/** @param {TreeNode} n @returns {TreeNode} */
function cloneNode(n) {
  return structuredClone(n);
}

export class AreaTree {
  /** @param {TreeNode} root */
  constructor(root) {
    this.root = root;
    /** @type {string|null} */
    this.maximizedId = null;
    this.fullscreen = false;
  }

  // ---------------------------------------------------------------- queries

  /**
   * @param {string} id
   * @returns {{node: TreeNode, parent: SplitNode|null, side: 'a'|'b'|null}|null}
   */
  find(id) {
    /** @type {Array<{node: TreeNode, parent: SplitNode|null, side: 'a'|'b'|null}>} */
    const stack = [{ node: this.root, parent: null, side: null }];
    while (stack.length) {
      const cur = /** @type {any} */ (stack.pop());
      if (cur.node.id === id) return cur;
      if (cur.node.kind === 'split') {
        stack.push({ node: cur.node.b, parent: cur.node, side: 'b' });
        stack.push({ node: cur.node.a, parent: cur.node, side: 'a' });
      }
    }
    return null;
  }

  /** @param {string} id @returns {AreaLeaf|null} */
  area(id) {
    const f = this.find(id);
    return f && f.node.kind === 'area' ? f.node : null;
  }

  /** In-order list of leaves (left-to-right, top-to-bottom). @returns {AreaLeaf[]} */
  leaves() {
    /** @type {AreaLeaf[]} */
    const out = [];
    const walk = (/** @type {TreeNode} */ n) => {
      if (n.kind === 'area') out.push(n);
      else { walk(n.a); walk(n.b); }
    };
    walk(this.root);
    return out;
  }

  /** @returns {SplitNode[]} */
  splits() {
    /** @type {SplitNode[]} */
    const out = [];
    const walk = (/** @type {TreeNode} */ n) => {
      if (n.kind === 'split') { out.push(n); walk(n.a); walk(n.b); }
    };
    walk(this.root);
    return out;
  }

  get size() { return this.leaves().length; }

  /**
   * Minimum pixel size of a subtree.
   * @param {TreeNode} node @returns {{w:number,h:number}}
   */
  minSize(node) {
    if (node.kind === 'area') return { w: MIN_AREA_W, h: MIN_AREA_H };
    const a = this.minSize(node.a);
    const b = this.minSize(node.b);
    return node.dir === 'row'
      ? { w: a.w + b.w + SPLITTER, h: Math.max(a.h, b.h) }
      : { w: Math.max(a.w, b.w), h: a.h + b.h + SPLITTER };
  }

  /**
   * Clamp a ratio so both sides keep their minimum size inside `extentPx`.
   * @param {SplitNode} split @param {number} ratio @param {number} extentPx
   */
  clampRatio(split, ratio, extentPx) {
    const axis = split.dir === 'row' ? 'w' : 'h';
    const minA = this.minSize(split.a)[axis];
    const minB = this.minSize(split.b)[axis];
    const avail = Math.max(1, extentPx - SPLITTER);
    if (minA + minB >= avail) return clamp01(minA / (minA + minB));
    return clamp01(Math.min(Math.max(ratio, minA / avail), 1 - minB / avail));
  }

  /** The sibling leaf of an area, if the sibling is itself a leaf. @param {string} areaId */
  siblingLeaf(areaId) {
    const f = this.find(areaId);
    if (!f || !f.parent) return null;
    const sib = f.side === 'a' ? f.parent.b : f.parent.a;
    return sib.kind === 'area' ? sib : null;
  }

  /**
   * Can `removeId` be joined into `keepId`? Both must be leaves sharing a full edge (siblings).
   * @param {string} keepId @param {string} removeId
   * @returns {{ok: boolean, reason?: string}}
   */
  canJoin(keepId, removeId) {
    if (keepId === removeId) return { ok: false, reason: 'an area cannot join itself' };
    const k = this.find(keepId);
    const r = this.find(removeId);
    if (!k || !r || k.node.kind !== 'area' || r.node.kind !== 'area') return { ok: false, reason: 'both targets must be areas' };
    if (!k.parent || k.parent !== r.parent) {
      return { ok: false, reason: 'areas must share a full edge; split siblings can be joined' };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- operations

  /**
   * Split an area. The new area copies the editor type (unless newEditorType is given) and
   * the flags of the original. Returns the new area id.
   * @param {string} areaId
   * @param {'row'|'col'} dir
   * @param {number} [ratio] share of the first child
   * @param {string|null} [newEditorType]
   * @param {{newFirst?: boolean, copyState?: boolean}} [opts]
   */
  split(areaId, dir, ratio = 0.5, newEditorType = null, opts = {}) {
    const f = this.find(areaId);
    if (!f || f.node.kind !== 'area') throw new Error(`split: no area ${areaId}`);
    const leaf = f.node;
    const fresh = makeArea(newEditorType || leaf.editorType, {
      editorState: opts.copyState && !newEditorType ? leaf.editorState : {},
      regions: { ...leaf.regions },
      syncSelection: leaf.syncSelection,
      scenarioId: leaf.scenarioId,
      headerPos: leaf.headerPos,
    });
    const split = opts.newFirst ? makeSplit(dir, ratio, fresh, leaf) : makeSplit(dir, ratio, leaf, fresh);
    this._replace(f, split);
    return fresh.id;
  }

  /**
   * Join two sibling areas: `keepId` grows into the space of `removeId`.
   * @param {string} keepId @param {string} removeId
   */
  join(keepId, removeId) {
    const chk = this.canJoin(keepId, removeId);
    if (!chk.ok) throw new Error(`join: ${chk.reason}`);
    const k = /** @type {NonNullable<ReturnType<AreaTree['find']>>} */ (this.find(keepId));
    const parent = /** @type {SplitNode} */ (k.parent);
    const pf = /** @type {NonNullable<ReturnType<AreaTree['find']>>} */ (this.find(parent.id));
    this._replace(pf, k.node);
    if (this.maximizedId === removeId) this.maximizedId = null;
    return keepId;
  }

  /** Close an area; its sibling takes the parent's space. Never allows zero areas. @param {string} areaId */
  close(areaId) {
    if (this.size <= 1) throw new Error('close: a screen must keep at least one area');
    const f = this.find(areaId);
    if (!f || f.node.kind !== 'area' || !f.parent) throw new Error(`close: no area ${areaId}`);
    const sib = f.side === 'a' ? f.parent.b : f.parent.a;
    const pf = /** @type {NonNullable<ReturnType<AreaTree['find']>>} */ (this.find(f.parent.id));
    this._replace(pf, sib);
    if (this.maximizedId === areaId) { this.maximizedId = null; this.fullscreen = false; }
    return sib.kind === 'area' ? sib.id : this._firstLeaf(sib).id;
  }

  /** Swap the positions of two areas. @param {string} aId @param {string} bId */
  swap(aId, bId) {
    if (aId === bId) return;
    const fa = this.find(aId);
    const fb = this.find(bId);
    if (!fa || !fb || fa.node.kind !== 'area' || fb.node.kind !== 'area') throw new Error('swap: both targets must be areas');
    const na = fa.node;
    const nb = fb.node;
    this._setChild(fa, nb);
    this._setChild(fb, na);
  }

  /** @param {string} splitId @param {number} ratio */
  resize(splitId, ratio) {
    const f = this.find(splitId);
    if (!f || f.node.kind !== 'split') throw new Error(`resize: no split ${splitId}`);
    f.node.ratio = clamp01(ratio);
  }

  /** @param {string} areaId @param {string} type @param {Record<string,any>} [state] */
  replaceEditor(areaId, type, state = {}) {
    const leaf = this.area(areaId);
    if (!leaf) throw new Error(`replaceEditor: no area ${areaId}`);
    leaf.editorType = type;
    leaf.editorState = structuredClone(state);
    leaf.pinnedScopeId = null;
  }

  /** @param {string} areaId */
  maximize(areaId) {
    if (!this.area(areaId)) throw new Error(`maximize: no area ${areaId}`);
    this.maximizedId = areaId;
  }

  restore() {
    this.maximizedId = null;
    this.fullscreen = false;
  }

  // ---------------------------------------------------------------- (de)serialization

  serialize() {
    return {
      schema: SCHEMA,
      root: cloneNode(this.root),
      maximizedId: this.maximizedId,
      fullscreen: this.fullscreen,
    };
  }

  /**
   * @param {any} json
   * @param {{knownTypes?: Set<string>|null}} [opts]
   */
  static deserialize(json, opts = {}) {
    if (!json || typeof json !== 'object' || !json.root) throw new Error('deserialize: missing root');
    const tree = new AreaTree(cloneNode(json.root));
    const v = tree.validate(opts);
    if (!v.ok) throw new Error('deserialize: ' + v.errors.join('; '));
    tree.maximizedId = json.maximizedId && tree.area(json.maximizedId) ? json.maximizedId : null;
    tree.fullscreen = !!(tree.maximizedId && json.fullscreen);
    return tree;
  }

  /**
   * Structural invariants: unique ids, valid ratios, leaf fields present, at least one area.
   * @param {{knownTypes?: Set<string>|null}} [opts]
   */
  validate(opts = {}) {
    const errors = [];
    const ids = new Set();
    let leaves = 0;
    const walk = (/** @type {any} */ n, depth) => {
      if (!n || typeof n !== 'object') { errors.push('null node'); return; }
      if (depth > 64) { errors.push('tree too deep'); return; }
      if (typeof n.id !== 'string' || !n.id) errors.push('node without id');
      else if (ids.has(n.id)) errors.push(`duplicate id ${n.id}`);
      else ids.add(n.id);
      if (n.kind === 'area') {
        leaves++;
        if (typeof n.editorType !== 'string' || !n.editorType) errors.push(`area ${n.id} has no editorType`);
        else if (opts.knownTypes && !opts.knownTypes.has(n.editorType)) errors.push(`area ${n.id} has unknown editor type ${n.editorType}`);
        if (!n.regions || typeof n.regions !== 'object') n.regions = { tools: false, sidebar: false };
        if (!n.editorState || typeof n.editorState !== 'object') n.editorState = {};
        if (typeof n.syncSelection !== 'boolean') n.syncSelection = true;
        if (n.headerPos !== 'bottom') n.headerPos = 'top';
        n.headerCollapsed = !!n.headerCollapsed;
        n.pinnedScopeId = n.pinnedScopeId ?? null;
        n.scenarioId = n.scenarioId ?? null;
      } else if (n.kind === 'split') {
        if (n.dir !== 'row' && n.dir !== 'col') errors.push(`split ${n.id} has bad dir`);
        if (!(n.ratio > 0 && n.ratio < 1)) errors.push(`split ${n.id} has bad ratio ${n.ratio}`);
        walk(n.a, depth + 1);
        walk(n.b, depth + 1);
      } else {
        errors.push(`unknown node kind ${n.kind}`);
      }
    };
    walk(this.root, 0);
    if (leaves === 0) errors.push('no areas');
    return { ok: errors.length === 0, errors };
  }

  // ---------------------------------------------------------------- internals

  /** @param {TreeNode} n @returns {AreaLeaf} */
  _firstLeaf(n) {
    return n.kind === 'area' ? n : this._firstLeaf(n.a);
  }

  /**
   * Replace the node at a found position with another node.
   * @param {{node: TreeNode, parent: SplitNode|null, side: 'a'|'b'|null}} at @param {TreeNode} node
   */
  _replace(at, node) {
    if (!at.parent) this.root = node;
    else at.parent[/** @type {'a'|'b'} */ (at.side)] = node;
  }

  /** @param {{node: TreeNode, parent: SplitNode|null, side: 'a'|'b'|null}} at @param {TreeNode} node */
  _setChild(at, node) {
    this._replace(at, node);
  }
}
