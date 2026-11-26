/**
 * 3D layout for the Scope Space. Pure and worker-friendly: plain arrays in, typed arrays out,
 * no DOM and no three.js.
 *
 *  - X axis: dependency depth (longest path from a leaf assumption), so computation flows
 *    left to right.
 *  - Y/Z plane: scope clusters (the node's scope folded to depth <= CLUSTER_DEPTH below the
 *    root) laid out on a golden-angle spiral, biggest clusters in the middle.
 *  - Inside a cluster, the nodes sharing a depth form a small sunflower around the cluster
 *    center, so each cluster reads as a tube along X.
 *
 * Results are cached by (graph id, structure version) so switching editors does not recompute.
 * @module editors/space3d/layout
 */

export const CLUSTER_DEPTH = 2;
const DX = 3.2; // spacing between depth layers
const NODE_SPACING = 0.95; // sunflower spacing inside a cluster layer
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * @typedef {Object} LayoutInput
 * @property {number} n                     number of metric nodes
 * @property {Int32Array[]} depIdx          dependency indices per node (upstream)
 * @property {Int32Array} topo              topological order
 * @property {Int32Array} clusterOf         cluster index per node
 * @property {number} clusters              number of clusters
 */

/**
 * @typedef {Object} Layout
 * @property {Float32Array} positions       xyz per node
 * @property {Int32Array} depth             dependency depth per node
 * @property {Int32Array} order             node indices sorted by cluster (contiguous ranges)
 * @property {Int32Array} clusterStart      start offset into `order` per cluster
 * @property {Int32Array} clusterCount      node count per cluster
 * @property {Float32Array} clusterCenter   xyz per cluster
 * @property {Float32Array} clusterRadius   bounding radius per cluster
 * @property {number} maxDepth
 * @property {number} radius                bounding radius of the whole layout
 * @property {[number, number, number]} center
 */

/**
 * @param {LayoutInput} input
 * @returns {Layout}
 */
export function computeLayout(input) {
  const { n, depIdx, topo, clusterOf, clusters } = input;
  // 1. dependency depth (longest path from a source) in topological order
  const depth = new Int32Array(n);
  let maxDepth = 0;
  for (let k = 0; k < topo.length; k++) {
    const i = topo[k];
    let d = 0;
    const deps = depIdx[i];
    for (let j = 0; j < deps.length; j++) {
      const p = deps[j];
      if (p >= 0 && depth[p] + 1 > d) d = depth[p] + 1;
    }
    depth[i] = d;
    if (d > maxDepth) maxDepth = d;
  }
  // 2. order nodes by cluster (contiguous ranges), then by depth
  const clusterCount = new Int32Array(clusters);
  for (let i = 0; i < n; i++) clusterCount[clusterOf[i]]++;
  const clusterStart = new Int32Array(clusters);
  for (let c = 1; c < clusters; c++) clusterStart[c] = clusterStart[c - 1] + clusterCount[c - 1];
  const fill = Int32Array.from(clusterStart);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[clusterOf[i]]++] = i;
  for (let c = 0; c < clusters; c++) {
    const s = clusterStart[c];
    const sub = order.subarray(s, s + clusterCount[c]);
    sub.sort((a, b) => depth[a] - depth[b] || a - b);
  }
  // 3. per-cluster radius from the largest depth bucket
  const clusterRadius = new Float32Array(clusters);
  const bucketSize = new Map();
  for (let c = 0; c < clusters; c++) {
    bucketSize.clear();
    let maxBucket = 1;
    const s = clusterStart[c];
    for (let k = s; k < s + clusterCount[c]; k++) {
      const d = depth[order[k]];
      const b = (bucketSize.get(d) || 0) + 1;
      bucketSize.set(d, b);
      if (b > maxBucket) maxBucket = b;
    }
    clusterRadius[c] = NODE_SPACING * Math.sqrt(maxBucket) + 0.8;
  }
  // 4. cluster centers on a golden-angle spiral in Y/Z, largest first
  const byMass = Array.from({ length: clusters }, (_, c) => c).sort((a, b) => clusterCount[b] - clusterCount[a] || a - b);
  const maxR = Math.max(1, ...clusterRadius);
  const spacing = 2.15 * Math.max(maxR, 2.2);
  const clusterCenter = new Float32Array(clusters * 3);
  const clusterDepthMid = new Float32Array(clusters);
  for (let c = 0; c < clusters; c++) {
    const s = clusterStart[c];
    if (!clusterCount[c]) continue;
    const dMin = depth[order[s]];
    const dMax = depth[order[s + clusterCount[c] - 1]];
    clusterDepthMid[c] = (dMin + dMax) / 2;
  }
  byMass.forEach((c, k) => {
    const r = spacing * Math.sqrt(k) * 0.82;
    const a = k * GOLDEN;
    clusterCenter[c * 3] = clusterDepthMid[c] * DX;
    clusterCenter[c * 3 + 1] = Math.cos(a) * r;
    clusterCenter[c * 3 + 2] = Math.sin(a) * r;
  });
  // 5. node positions: sunflower per (cluster, depth) bucket around the cluster center
  const positions = new Float32Array(n * 3);
  const xOffset = (maxDepth * DX) / 2;
  for (let c = 0; c < clusters; c++) {
    const s = clusterStart[c];
    const cy = clusterCenter[c * 3 + 1];
    const cz = clusterCenter[c * 3 + 2];
    let k = s;
    while (k < s + clusterCount[c]) {
      const d = depth[order[k]];
      let e = k;
      while (e < s + clusterCount[c] && depth[order[e]] === d) e++;
      const m = e - k;
      for (let q = 0; q < m; q++) {
        const i = order[k + q];
        const rr = m === 1 ? 0 : NODE_SPACING * Math.sqrt(q + 0.5);
        const aa = q * GOLDEN + c * 0.7;
        positions[i * 3] = d * DX - xOffset;
        positions[i * 3 + 1] = cy + Math.cos(aa) * rr;
        positions[i * 3 + 2] = cz + Math.sin(aa) * rr;
      }
      k = e;
    }
    clusterCenter[c * 3] -= xOffset;
  }
  // 6. bounds
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]; const y = positions[i * 3 + 1]; const z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!n) { minX = minY = minZ = -1; maxX = maxY = maxZ = 1; }
  // cluster radius must also cover its depth extent along X
  for (let c = 0; c < clusters; c++) {
    const s = clusterStart[c];
    if (!clusterCount[c]) continue;
    const span = (depth[order[s + clusterCount[c] - 1]] - depth[order[s]]) * DX * 0.5;
    clusterRadius[c] = Math.sqrt(clusterRadius[c] ** 2 + span ** 2);
  }
  const center = /** @type {[number, number, number]} */ ([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]);
  const radius = Math.max(4, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
  return { positions, depth, order, clusterStart, clusterCount, clusterCenter, clusterRadius, maxDepth, radius, center };
}

/**
 * Build the layout input from a ScopeGraph (main thread; cheap) and cluster metadata.
 * @param {any} graph ScopeGraph
 */
export function layoutInputFromGraph(graph) {
  const n = graph.list.length;
  /** @type {Map<string, number>} */
  const clusterIndex = new Map();
  /** @type {Array<{scopeId: string, name: string, path: string, top: string}>} */
  const clusters = [];
  const depthOfScope = new Map();
  const scopeDepth = (sid) => {
    if (depthOfScope.has(sid)) return depthOfScope.get(sid);
    let d = 0;
    let cur = graph.scope(sid);
    while (cur && cur.parent) { d++; cur = graph.scope(cur.parent); }
    depthOfScope.set(sid, d);
    return d;
  };
  /** cluster scope: ancestor at depth <= CLUSTER_DEPTH */
  const clusterScopeOf = new Map();
  const clusterScope = (sid) => {
    if (clusterScopeOf.has(sid)) return clusterScopeOf.get(sid);
    let cur = sid;
    let d = scopeDepth(sid);
    while (d > CLUSTER_DEPTH) {
      cur = graph.scope(cur)?.parent || cur;
      d--;
    }
    clusterScopeOf.set(sid, cur);
    return cur;
  };
  const topOf = (sid) => {
    let cur = sid;
    let s = graph.scope(cur);
    while (s && s.parent && s.parent !== graph.rootId) { cur = s.parent; s = graph.scope(cur); }
    return cur;
  };
  const clusterOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const node = graph.list[i];
    const cs = clusterScope(node.scope);
    let idx = clusterIndex.get(cs);
    if (idx === undefined) {
      idx = clusters.length;
      clusterIndex.set(cs, idx);
      const s = graph.scope(cs);
      clusters.push({ scopeId: cs, name: s?.name || cs, path: graph.path(cs), top: topOf(cs) });
    }
    clusterOf[i] = idx;
  }
  return {
    input: { n, depIdx: graph.depIdx, topo: graph.topo, clusterOf, clusters: clusters.length },
    clusters,
    clusterOf,
  };
}

/** @type {Map<string, {layout: Layout, meta: ReturnType<typeof layoutInputFromGraph>}>} */
const cache = new Map();

/**
 * Cached layout for a graph (keyed by graph id + structure version).
 * @param {any} graph
 */
export function layoutFor(graph) {
  const key = `${graph.graphId}:${graph.structureVersion}:${graph.list.length}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const meta = layoutInputFromGraph(graph);
  const layout = computeLayout(meta.input);
  const out = { layout, meta };
  if (cache.size >= 4) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}
