/**
 * Visual encodings for the 3D Scope Space: per-node base colors and sizes for
 * "color by" (provenance, sensitivity, scope, value) and "size by" (uniform, sensitivity,
 * value). Pure: takes plain colors ([r, g, b] in 0..1) and returns typed arrays, so the same
 * code can run in a worker.
 * @module editors/space3d/encoding
 */

/** @typedef {[number, number, number]} RGB */

/**
 * @param {{
 *   kind: 'provenance'|'sensitivity'|'scope'|'value',
 *   graph: any,
 *   engine: any,
 *   clusterTop: Int32Array,            top-level group slot per node (-1 = other)
 *   colors: { prov: Record<string, RGB>, muted: RGB, seq: RGB[], series: RGB[] },
 *   sens: Map<string, number> | null, first-order index by node id
 * }} p
 * @returns {Float32Array}
 */
export function baseColors(p) {
  const g = p.graph;
  const n = g.list.length;
  const out = new Float32Array(n * 3);
  const put = (i, c) => { out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; };
  if (p.kind === 'provenance') {
    for (let i = 0; i < n; i++) put(i, p.colors.prov[g.displayProv(g.list[i].id)] || p.colors.prov.computed);
    return out;
  }
  if (p.kind === 'scope') {
    for (let i = 0; i < n; i++) {
      const t = p.clusterTop[i];
      put(i, t >= 0 && t < p.colors.series.length ? p.colors.series[t] : p.colors.muted);
    }
    return out;
  }
  if (p.kind === 'sensitivity') {
    const sens = p.sens || new Map();
    let max = 1e-9;
    for (const v of sens.values()) if (v > max) max = v;
    for (let i = 0; i < n; i++) {
      const s = sens.get(g.list[i].id);
      put(i, s == null ? dim(p.colors.muted) : rampAt(p.colors.seq, 0.2 + 0.8 * Math.sqrt(s / max)));
    }
    return out;
  }
  // value: log magnitude rank -> sequential ramp
  const mags = valueMagnitudes(g, p.engine);
  for (let i = 0; i < n; i++) put(i, Number.isFinite(mags[i]) ? rampAt(p.colors.seq, mags[i]) : dim(p.colors.muted));
  return out;
}

/**
 * @param {{kind: 'uniform'|'sensitivity'|'value', graph: any, engine: any, sens: Map<string, number>|null}} p
 * @returns {Float32Array}
 */
export function baseScales(p) {
  const g = p.graph;
  const n = g.list.length;
  const out = new Float32Array(n).fill(1);
  if (p.kind === 'sensitivity') {
    const sens = p.sens || new Map();
    let max = 1e-9;
    for (const v of sens.values()) if (v > max) max = v;
    for (let i = 0; i < n; i++) {
      const s = sens.get(g.list[i].id);
      out[i] = s == null ? 0.7 : 1 + 2.4 * Math.sqrt(s / max);
    }
  } else if (p.kind === 'value') {
    const mags = valueMagnitudes(g, p.engine);
    for (let i = 0; i < n; i++) out[i] = Number.isFinite(mags[i]) ? 0.55 + 1.6 * mags[i] : 0.6;
  }
  return out;
}

/**
 * Normalized log10 magnitude of each node's (median) value, 0..1 across the graph.
 * @param {any} g @param {any} engine
 */
export function valueMagnitudes(g, engine) {
  const n = g.list.length;
  const raw = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = engine.value(g.list[i].id);
    const m = Number.isFinite(v) ? Math.log10(Math.abs(v) + 1) : NaN;
    raw[i] = m;
    if (Number.isFinite(m)) { if (m < lo) lo = m; if (m > hi) hi = m; }
  }
  const span = hi - lo || 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(raw[i]) ? (raw[i] - lo) / span : NaN;
  return out;
}

/** Piecewise-linear sample of a ramp at t in [0, 1]. @param {RGB[]} ramp @param {number} t @returns {RGB} */
export function rampAt(ramp, t) {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** @param {RGB} c @returns {RGB} */
function dim(c) {
  return [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7];
}
