/**
 * Scope Graph view model: which scopes are drawn as frames (expanded) or as one summary proxy
 * (collapsed), which metric nodes are visible, and the item-level edges after collapsing
 * (a dependency into a collapsed subtree attaches to its proxy). Pure apart from reading the
 * ScopeGraph; the output feeds layoutCompound() unchanged.
 * @module editors/graph/model
 */

/** Scope kinds collapsed in the default view (large or secondary subtrees). */
const COLLAPSE_KINDS = new Set(['group', 'projection', 'month', 'mind', 'person', 'equipment']);

/**
 * The readable default: the business, the new location, the loan and the market expanded;
 * projection months, staff, equipment, minds and everything at depth 2 or more collapsed.
 * Descends the whole tree, so expanding Projection shows 24 month proxies, not 168 metrics.
 * @param {import('../../model/graph.js').ScopeGraph} graph
 * @param {string} [rootId]
 * @returns {Set<string>}
 */
export function defaultCollapsed(graph, rootId = graph.rootId || '') {
  const out = new Set();
  if (!rootId) return out;
  /** @type {Array<[string, number]>} */
  const stack = [[rootId, 0]];
  while (stack.length) {
    const [id, depth] = /** @type {[string, number]} */ (stack.pop());
    const s = graph.scope(id);
    if (!s) continue;
    if (isDefaultCollapsed(s, depth)) out.add(id);
    for (const c of s.children) stack.push([c, depth + 1]);
  }
  return out;
}

/**
 * @param {import('../../model/types.js').Scope} s @param {number} depth (root = 0)
 */
export function isDefaultCollapsed(s, depth) {
  return depth > 0 && (depth >= 2 || COLLAPSE_KINDS.has(s.kind || '')) && (s.children.length > 0 || s.metrics.length > 0);
}


/**
 * Collapse everything below `depth` (root = 0) that has content.
 * @param {import('../../model/graph.js').ScopeGraph} graph @param {number} depth
 */
export function collapsedBelow(graph, depth, rootId = graph.rootId || '') {
  const out = new Set();
  if (!rootId) return out;
  /** @type {Array<[string, number]>} */
  const stack = [[rootId, 0]];
  while (stack.length) {
    const [id, d] = /** @type {[string, number]} */ (stack.pop());
    const s = graph.scope(id);
    if (!s) continue;
    if (d >= depth && d > 0 && (s.children.length || s.metrics.length)) out.add(id);
    for (const c of s.children) stack.push([c, d + 1]);
  }
  return out;
}

/**
 * @typedef {Object} ViewItem
 * @property {string} id               metric node id or (proxy) scope id
 * @property {'metric'|'proxy'} kind
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} ViewModel
 * @property {string} root
 * @property {Map<string, import('./layout.js').LayoutFrame>} frames
 * @property {Map<string, ViewItem>} items
 * @property {Map<string, string>} itemFrame
 * @property {Array<[string, string]>} edges              unique item edges (a -> b)
 * @property {Map<string, number>} edgeCount              'a\u0000b' -> underlying dependency count
 * @property {Map<string, string>} rep                    node or scope id -> visible item or frame id
 * @property {string[]} metricIds
 * @property {string[]} proxyIds
 * @property {number} hiddenNodes
 */

/**
 * @param {import('../../model/graph.js').ScopeGraph} graph
 * @param {{collapsed: Set<string>, nodeW: number, nodeH: number, proxyW: number, proxyH: number, root?: string}} opts
 * @returns {ViewModel}
 */
export function buildViewModel(graph, opts) {
  const { collapsed, nodeW, nodeH, proxyW, proxyH } = opts;
  const root = /** @type {string} */ (opts.root && graph.scope(opts.root) ? opts.root : graph.rootId);
  /** @type {Map<string, import('./layout.js').LayoutFrame>} */
  const frames = new Map();
  /** @type {Map<string, ViewItem>} */
  const items = new Map();
  /** @type {Map<string, string>} */
  const itemFrame = new Map();
  /** @type {Map<string, string>} */
  const rep = new Map();
  const metricIds = [];
  const proxyIds = [];
  let hiddenNodes = 0;

  /** Walk: expanded scopes become frames; collapsed ones become proxies representing their subtree. */
  const stack = [{ id: root, parent: /** @type {string|null} */ (null) }];
  while (stack.length) {
    const { id, parent } = /** @type {{id: string, parent: string|null}} */ (stack.pop());
    const s = graph.scope(id);
    if (!s) continue;
    if (parent && collapsed.has(id)) {
      items.set(id, { id, kind: 'proxy', w: proxyW, h: proxyH });
      itemFrame.set(id, parent);
      /** @type {import('./layout.js').LayoutFrame} */ (frames.get(parent)).items.push(id);
      proxyIds.push(id);
      for (const sid of graph.descendants(id, true)) {
        rep.set(sid, id);
        const sc = graph.scope(sid);
        if (!sc) continue;
        for (const m of sc.metrics) { rep.set(m, id); hiddenNodes++; }
      }
      continue;
    }
    frames.set(id, { id, parent, items: [], frames: [] });
    rep.set(id, id);
    if (parent) /** @type {import('./layout.js').LayoutFrame} */ (frames.get(parent)).frames.push(id);
    const F = /** @type {import('./layout.js').LayoutFrame} */ (frames.get(id));
    for (const m of s.metrics) {
      if (!graph.node(m)) continue;
      items.set(m, { id: m, kind: 'metric', w: nodeW, h: nodeH });
      itemFrame.set(m, id);
      rep.set(m, m);
      F.items.push(m);
      metricIds.push(m);
    }
    // push children in reverse so they pop (and register with their parent) in declaration order
    for (let k = s.children.length - 1; k >= 0; k--) stack.push({ id: s.children[k], parent: id });
  }

  /** @type {Map<string, number>} */
  const edgeCount = new Map();
  /** @type {Array<[string, string]>} */
  const edges = [];
  for (const n of graph.nodes.values()) {
    const b = rep.get(n.id);
    if (!b || !n.deps || !n.deps.length) continue;
    for (const d of n.deps) {
      const a = rep.get(d);
      if (!a || a === b) continue;
      const key = `${a}\u0000${b}`;
      const c = edgeCount.get(key);
      if (c === undefined) {
        edgeCount.set(key, 1);
        edges.push([a, b]);
      } else edgeCount.set(key, c + 1);
    }
  }
  return { root, frames, items, itemFrame, edges, edgeCount, rep, metricIds, proxyIds, hiddenNodes };
}

/**
 * Ancestors of a node or scope that must be expanded to show it.
 * @param {import('../../model/graph.js').ScopeGraph} graph @param {string} id
 */
export function revealPath(graph, id) {
  const sid = graph.scopeIdOf(id);
  if (!sid) return [];
  const out = graph.isScope(id) ? graph.ancestors(sid) : [sid, ...graph.ancestors(sid)];
  return out;
}
