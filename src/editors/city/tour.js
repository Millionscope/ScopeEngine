/**
 * Pure geometry for the holographic city: the camera loop through the tallest towers and the
 * traffic-streak ribbons. Coordinates are metres (east, south) from the city centre.
 * @module editors/city/tour
 */

/**
 * Tour stops: the k tallest buildings at least `gap` metres apart, ordered around their centroid
 * so the loop does not cross itself. Null when fewer than 3 qualify (the camera orbits instead).
 * @param {Array<{x: number, y: number, h: number}>} bs @param {number} [k] @param {number} [gap]
 */
export function pickStops(bs, k = 6, gap = 260) {
  const out = [];
  for (const b of [...bs].sort((a, c) => c.h - a.h)) {
    if (out.every((o) => Math.hypot(o.x - b.x, o.y - b.y) >= gap)) out.push(b);
    if (out.length === k) break;
  }
  if (out.length < 3) return null;
  const cx = out.reduce((s, b) => s + b.x, 0) / out.length;
  const cy = out.reduce((s, b) => s + b.y, 0) / out.length;
  return out.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

/**
 * Closed Catmull-Rom loop through `pts` at t (wraps; one unit per lap, uniform per segment).
 * Returns the point, its tangent and the length of the segment it is on (to keep speed constant).
 * @param {Array<{x: number, y: number}>} pts @param {number} t
 */
export function loopAt(pts, t) {
  const n = pts.length;
  const u = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(u);
  const f = u - i;
  const P = (k) => pts[(i + k + n) % n];
  const [a, b, c, d] = [P(-1), P(0), P(1), P(2)];
  const cr = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);
  const dcr = (p0, p1, p2, p3) => 0.5 * ((p2 - p0) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (3 * p1 - p0 - 3 * p2 + p3) * f * f);
  return {
    x: cr(a.x, b.x, c.x, d.x),
    y: cr(a.y, b.y, c.y, d.y),
    dx: dcr(a.x, b.x, c.x, d.x),
    dy: dcr(a.y, b.y, c.y, d.y),
    len: Math.hypot(c.x - b.x, c.y - b.y),
  };
}

/** Floats per traffic vertex: x, y, across (-1..1), distance along the road, kind, seed. */
export const STRIDE = 6;

/**
 * Two triangles per road segment, `hw` metres either side of the centre line. `across` lets the
 * shader split a road into two opposing lanes; `dist` drives the moving streaks.
 * @param {Array<{pts: number[][], hw: number, kind: number, seed: number}>} roads
 */
export function ribbons(roads) {
  let segs = 0;
  for (const r of roads) segs += Math.max(0, r.pts.length - 1);
  const out = new Float32Array(segs * 6 * STRIDE);
  let o = 0;
  const put = (x, y, across, dist, r) => {
    out[o++] = x; out[o++] = y; out[o++] = across; out[o++] = dist; out[o++] = r.kind; out[o++] = r.seed;
  };
  for (const r of roads) {
    let d = 0;
    for (let i = 1; i < r.pts.length; i++) {
      const [x0, y0] = r.pts[i - 1];
      const [x1, y1] = r.pts[i];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1e-6;
      const nx = (-(y1 - y0) / len) * r.hw;
      const ny = ((x1 - x0) / len) * r.hw;
      put(x0 + nx, y0 + ny, 1, d, r); put(x0 - nx, y0 - ny, -1, d, r); put(x1 + nx, y1 + ny, 1, d + len, r);
      put(x1 + nx, y1 + ny, 1, d + len, r); put(x0 - nx, y0 - ny, -1, d, r); put(x1 - nx, y1 - ny, -1, d + len, r);
      d += len;
    }
  }
  return out;
}
