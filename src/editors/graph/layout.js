/**
 * Compound layered layout for the Scope Graph (Sugiyama-style, nested scope frames).
 *
 * Pure: plain data in, positions out. No DOM, no graph object, no globals, so it can move
 * into a Web Worker unchanged.
 *
 * Inside every expanded frame, the "units" are its direct items (metric nodes, collapsed-scope
 * proxies) and its child frames (laid out first, bottom-up, as blocks). Each dependency edge is
 * attributed to the lowest common frame of its endpoints and becomes a unit edge there. Units
 * are ranked by longest path (back edges removed by DFS, so cycles never break the layout;
 * sources are pulled next to their first consumer), ordered inside each rank by barycenter
 * sweeps, then packed into lanes: columns (LR) or rows (TB) that wrap after `wrap` px and are
 * centered across the frame. The editor caches results by structureVersion + collapse state.
 * @module editors/graph/layout
 */

export const LAYOUT_DEFAULTS = Object.freeze({
  dir: /** @type {'LR'|'TB'} */ ('LR'),
  gapRank: 34,
  gapLane: 10,
  gapOrder: 6,
  pad: 10,
  headerH: 24,
  sweeps: 4,
  minFrameW: 160,
  /** max lane length in px before a rank wraps into another lane */
  wrap: 300,
});

/**
 * @typedef {Object} LayoutFrame
 * @property {string} id
 * @property {string|null} parent
 * @property {string[]} items    direct items, in display order
 * @property {string[]} frames   child frames, in display order
 */

/**
 * @typedef {Object} LayoutInput
 * @property {string} root
 * @property {Map<string, LayoutFrame>} frames
 * @property {Map<string, {id: string, w: number, h: number}>} items
 * @property {Map<string, string>} itemFrame          item id -> containing frame id
 * @property {Array<[string, string]>} edges          item-level edges (source -> target)
 */

/**
 * @typedef {Object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} LayoutResult
 * @property {Map<string, Rect>} itemPos
 * @property {Map<string, Rect & {depth: number}>} framePos
 * @property {Map<string, number>} itemRank        rank of each item inside its own frame
 * @property {number} width
 * @property {number} height
 * @property {number} ms
 */

/**
 * @param {LayoutInput} input
 * @param {Partial<typeof LAYOUT_DEFAULTS>} [opts]
 * @returns {LayoutResult}
 */
export function layoutCompound(input, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const o = { ...LAYOUT_DEFAULTS, ...opts };
  const { frames, items, itemFrame, edges, root } = input;
  const lr = o.dir !== 'TB';

  // ---------------------------------------------------------------- frame chains
  /** @type {Map<string, number>} */
  const fDepth = new Map();
  /** @type {Map<string, string[]>} root..frame */
  const fChain = new Map();
  const stack = [[root, 0, /** @type {string[]} */ ([])]];
  while (stack.length) {
    const [fid, depth, chain] = /** @type {[string, number, string[]]} */ (stack.pop());
    const f = frames.get(fid);
    if (!f) continue;
    const c = [...chain, fid];
    fDepth.set(fid, depth);
    fChain.set(fid, c);
    for (const ch of f.frames) stack.push([ch, depth + 1, c]);
  }

  // ---------------------------------------------------------------- unit edges per frame
  /** @type {Map<string, Array<[string, string]>>} */
  const unitEdges = new Map();
  for (const fid of fChain.keys()) unitEdges.set(fid, []);
  const unitOf = (fid, itemId) => {
    const chain = fChain.get(/** @type {string} */ (itemFrame.get(itemId)));
    const d = /** @type {number} */ (fDepth.get(fid));
    if (!chain || chain[d] !== fid) return null;
    return d === chain.length - 1 ? itemId : chain[d + 1];
  };
  for (const [a, b] of edges) {
    const ca = fChain.get(/** @type {string} */ (itemFrame.get(a)));
    const cb = fChain.get(/** @type {string} */ (itemFrame.get(b)));
    if (!ca || !cb) continue;
    let d = 0;
    while (d < ca.length && d < cb.length && ca[d] === cb[d]) d++;
    const lcf = ca[d - 1];
    if (!lcf) continue;
    const ua = unitOf(lcf, a);
    const ub = unitOf(lcf, b);
    if (ua && ub && ua !== ub) /** @type {Array<[string, string]>} */ (unitEdges.get(lcf)).push([ua, ub]);
  }

  // ---------------------------------------------------------------- per-frame layout (bottom-up)
  /** @type {Map<string, {w: number, h: number}>} */
  const fSize = new Map();
  /** @type {Map<string, {x: number, y: number}>} unit -> position relative to its frame */
  const rel = new Map();
  /** @type {Map<string, number>} */
  const itemRank = new Map();

  /** Post-order traversal without recursion (deep stress graphs). */
  const order = [];
  const st2 = [root];
  while (st2.length) {
    const fid = /** @type {string} */ (st2.pop());
    order.push(fid);
    for (const ch of frames.get(fid)?.frames || []) st2.push(ch);
  }
  for (let k = order.length - 1; k >= 0; k--) layoutFrame(order[k]);

  /** @param {string} fid */
  function layoutFrame(fid) {
    const F = /** @type {LayoutFrame} */ (frames.get(fid));
    const units = [...F.items, ...F.frames];
    const n = units.length;
    const size = (u) => items.get(u) || fSize.get(u) || { w: 0, h: 0 };
    if (!n) {
      fSize.set(fid, { w: o.minFrameW, h: o.headerH + o.pad * 2 });
      return;
    }
    /** @type {Map<string, number>} */
    const idx = new Map(units.map((u, i) => [u, i]));
    /** @type {number[][]} */
    const out = Array.from({ length: n }, () => []);
    /** @type {number[][]} */
    const inn = Array.from({ length: n }, () => []);
    const seen = new Set();
    for (const [a, b] of /** @type {Array<[string, string]>} */ (unitEdges.get(fid))) {
      const ia = idx.get(a);
      const ib = idx.get(b);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      const key = ia * n + ib;
      if (seen.has(key)) continue;
      seen.add(key);
      out[ia].push(ib);
      inn[ib].push(ia);
    }
    // back edges by iterative DFS (cycle breaking)
    const state = new Uint8Array(n);
    const back = new Set();
    for (let s = 0; s < n; s++) {
      if (state[s]) continue;
      /** @type {Array<[number, number]>} */
      const dfs = [[s, 0]];
      state[s] = 1;
      while (dfs.length) {
        const top = dfs[dfs.length - 1];
        const [i, k] = top;
        if (k < out[i].length) {
          top[1]++;
          const j = out[i][k];
          if (state[j] === 1) back.add(i * n + j);
          else if (state[j] === 0) {
            state[j] = 1;
            dfs.push([j, 0]);
          }
        } else {
          state[i] = 2;
          dfs.pop();
        }
      }
    }
    // longest-path ranks over the DAG (Kahn)
    const indeg = new Int32Array(n);
    for (let i = 0; i < n; i++) for (const j of out[i]) if (!back.has(i * n + j)) indeg[j]++;
    const rank = new Int32Array(n);
    const q = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) q.push(i);
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (const j of out[i]) {
        if (back.has(i * n + j)) continue;
        if (rank[i] + 1 > rank[j]) rank[j] = rank[i] + 1;
        if (--indeg[j] === 0) q.push(j);
      }
    }
    // tighten sources: an assumption sits one rank before its first consumer, not always at 0
    for (let i = 0; i < n; i++) {
      if (inn[i].some((p) => !back.has(p * n + i))) continue;
      let m = Infinity;
      for (const j of out[i]) if (!back.has(i * n + j) && rank[j] < m) m = rank[j];
      if (m !== Infinity && m - 1 > rank[i]) rank[i] = m - 1;
    }
    let R = 0;
    for (let i = 0; i < n; i++) if (rank[i] + 1 > R) R = rank[i] + 1;
    /** @type {number[][]} */
    const layers = Array.from({ length: R }, () => []);
    for (let i = 0; i < n; i++) layers[rank[i]].push(i);
    const pos = new Float64Array(n);
    const setPos = (r) => layers[r].forEach((i, p) => { pos[i] = p / Math.max(1, layers[r].length - 1 || 1); });
    for (let r = 0; r < R; r++) setPos(r);
    // barycenter sweeps
    for (let sweep = 0; sweep < o.sweeps; sweep++) {
      for (let r = 1; r < R; r++) {
        const bary = new Map();
        for (const i of layers[r]) {
          let s = 0;
          let c = 0;
          for (const p of inn[i]) if (rank[p] < r && !back.has(p * n + i)) { s += pos[p]; c++; }
          bary.set(i, c ? s / c : pos[i]);
        }
        layers[r].sort((a, b) => bary.get(a) - bary.get(b) || a - b);
        setPos(r);
      }
      for (let r = R - 2; r >= 0; r--) {
        const bary = new Map();
        for (const i of layers[r]) {
          let s = 0;
          let c = 0;
          for (const j of out[i]) if (rank[j] > r && !back.has(i * n + j)) { s += pos[j]; c++; }
          bary.set(i, c ? s / c : pos[i]);
        }
        layers[r].sort((a, b) => bary.get(a) - bary.get(b) || a - b);
        setPos(r);
      }
    }
    // pack: each rank becomes one or more lanes (columns for LR, rows for TB); a lane wraps
    // when it would exceed `wrap` px, so long ranks of assumptions do not make frames very tall.
    // Lanes are centered across the frame so edges stay short.
    /** @type {Array<{units: number[], main: number, cross: number, rank: number}>} */
    const lanes = [];
    const along = (s) => (lr ? s.h : s.w); // size along the lane
    const across = (s) => (lr ? s.w : s.h); // lane thickness
    for (let r = 0; r < R; r++) {
      let lane = { units: /** @type {number[]} */ ([]), main: 0, cross: 0, rank: r };
      for (const i of layers[r]) {
        const s = size(units[i]);
        const add = along(s) + (lane.units.length ? o.gapOrder : 0);
        if (lane.units.length && lane.main + add > o.wrap) {
          lanes.push(lane);
          lane = { units: [], main: 0, cross: 0, rank: r };
        }
        lane.main += along(s) + (lane.units.length ? o.gapOrder : 0);
        lane.cross = Math.max(lane.cross, across(s));
        lane.units.push(i);
      }
      if (lane.units.length) lanes.push(lane);
    }
    let inner = 0;
    for (const L of lanes) inner = Math.max(inner, L.main);
    let c = o.pad; // running offset across lanes
    for (let k = 0; k < lanes.length; k++) {
      const L = lanes[k];
      const start = (lr ? o.headerH + o.pad : o.pad) + (inner - L.main) / 2;
      let m = start;
      for (const i of L.units) {
        const u = units[i];
        const s = size(u);
        // center thinner units inside the lane
        const off = (L.cross - across(s)) / 2;
        rel.set(u, lr ? { x: c + off, y: m } : { x: m, y: c + off });
        if (items.has(u)) itemRank.set(u, L.rank);
        m += along(s) + o.gapOrder;
      }
      const next = lanes[k + 1];
      c += L.cross + (next ? (next.rank === L.rank ? o.gapLane : o.gapRank) : 0);
    }
    const thick = c + o.pad; // extent across lanes incl. both paddings
    if (lr) fSize.set(fid, { w: Math.max(o.minFrameW, thick), h: o.headerH + o.pad + inner + o.pad });
    else fSize.set(fid, { w: Math.max(o.minFrameW, o.pad + inner + o.pad), h: o.headerH + thick });
    // TB: lanes start below the header
    if (!lr) for (const L of lanes) for (const i of L.units) { const p = /** @type {{x: number, y: number}} */ (rel.get(units[i])); p.y += o.headerH; }
  }

  // ---------------------------------------------------------------- absolute positions
  /** @type {Map<string, Rect>} */
  const itemPos = new Map();
  /** @type {Map<string, Rect & {depth: number}>} */
  const framePos = new Map();
  /** @type {Array<[string, number, number]>} */
  const place = [[root, 0, 0]];
  while (place.length) {
    const [fid, x, y] = /** @type {[string, number, number]} */ (place.pop());
    const s = /** @type {{w: number, h: number}} */ (fSize.get(fid));
    framePos.set(fid, { x, y, w: s.w, h: s.h, depth: /** @type {number} */ (fDepth.get(fid)) });
    const F = /** @type {LayoutFrame} */ (frames.get(fid));
    for (const u of F.items) {
      const r = rel.get(u);
      const it = items.get(u);
      if (r && it) itemPos.set(u, { x: x + r.x, y: y + r.y, w: it.w, h: it.h });
    }
    for (const ch of F.frames) {
      const r = rel.get(ch);
      if (r) place.push([ch, x + r.x, y + r.y]);
    }
  }
  const rs = /** @type {{w: number, h: number}} */ (fSize.get(root));
  return {
    itemPos,
    framePos,
    itemRank,
    width: rs.w,
    height: rs.h,
    ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
}

/**
 * Edge geometry between two rects: a cubic Bezier from the source's outgoing side to the
 * target's incoming side (LR: right -> left, TB: bottom -> top). Backward or overlapping pairs
 * (same rank lanes, cycles) leave and enter on the cross sides so the curve never folds over
 * the boxes. Returns the control polygon (for canvas) and the SVG path string.
 * @param {Rect} a @param {Rect} b @param {'LR'|'TB'} dir
 */
export function edgeGeom(a, b, dir) {
  let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
  if (dir === 'TB') {
    if (b.y >= a.y + a.h + 6) {
      x1 = a.x + a.w / 2; y1 = a.y + a.h; x2 = b.x + b.w / 2; y2 = b.y;
      const d = Math.max(18, (y2 - y1) / 2);
      c1x = x1; c1y = y1 + d; c2x = x2; c2y = y2 - d;
    } else {
      const right = b.x + b.w / 2 >= a.x + a.w / 2;
      x1 = right ? a.x + a.w : a.x; y1 = a.y + a.h / 2;
      x2 = right ? b.x : b.x + b.w; y2 = b.y + b.h / 2;
      if (Math.abs(x2 - x1) < 12) { x2 = right ? b.x + b.w : b.x; }
      const d = Math.max(24, Math.abs(x2 - x1) / 2);
      c1x = x1 + (right ? d : -d); c1y = y1; c2x = x2 + (right ? -d : d); c2y = y2;
    }
  } else if (b.x >= a.x + a.w + 6) {
    x1 = a.x + a.w; y1 = a.y + a.h / 2; x2 = b.x; y2 = b.y + b.h / 2;
    const d = Math.max(18, (x2 - x1) / 2);
    c1x = x1 + d; c1y = y1; c2x = x2 - d; c2y = y2;
  } else {
    const down = b.y + b.h / 2 >= a.y + a.h / 2;
    x1 = a.x + a.w / 2; y1 = down ? a.y + a.h : a.y;
    x2 = b.x + b.w / 2; y2 = down ? b.y : b.y + b.h;
    if (Math.abs(y2 - y1) < 12) { y2 = down ? b.y + b.h : b.y; }
    const d = Math.max(24, Math.abs(y2 - y1) / 2);
    c1x = x1; c1y = y1 + (down ? d : -d); c2x = x2; c2y = y2 + (down ? -d : d);
  }
  const f = (v) => Math.round(v * 10) / 10;
  return {
    x1, y1, c1x, c1y, c2x, c2y, x2, y2,
    d: `M${f(x1)},${f(y1)}C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(x2)},${f(y2)}`,
  };
}
