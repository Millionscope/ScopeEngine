/**
 * Pure camera loop for the Building viewer, in units of the tower height (base at y = 0, spire
 * axis at x = z = 0): overview → fly down to the base → spiral up around the tower → top → back
 * to the overview. Also drives the hologram fill that climbs the tower with the camera.
 * @module editors/building/tour
 */

const TAU = Math.PI * 2;

/**
 * Keyframes: [time s, azimuth rad (cumulative), radius, camera y, target y, phase that starts here].
 * The last key closes the loop: same pose as the first, azimuth three full turns on.
 */
export const KEYS = [
  [0, 0, 1.9, 0.7, 0.48, 'Overview'],
  [6, 0.7, 1.9, 0.7, 0.48, 'Descending to the base'],
  [11, 2.2, 0.3, 0.03, 0.05, 'Ascending the tower'],
  [27, 2.2 + 2 * TAU, 0.11, 0.97, 1.0, 'Returning to the overview'],
  [33, 3 * TAU, 1.9, 0.7, 0.48, ''],
];
export const LOOP = KEYS[KEYS.length - 1][0];
const SPIRAL = 2; // index of the climb segment

const ease = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Tour state at time t (s, any value; loops every LOOP s).
 * sweep: normalized height the glow has filled up to; fill: its strength (0 hides it);
 * dim: how much the unlit part of the tower darkens.
 * @param {number} t
 */
export function tourAt(t) {
  const u = ((t % LOOP) + LOOP) % LOOP;
  let i = 0;
  while (KEYS[i + 1][0] <= u) i++;
  const [t0, a0, r0, y0, ty0, phase] = KEYS[i];
  const [t1, a1, r1, y1, ty1] = KEYS[i + 1];
  const s = ease((u - t0) / (t1 - t0));
  // while the camera dives the glow drains (fill → 0) and the tower fades to its dim state (dim → 1),
  // then it refills bottom to top at camera height
  const sweep = i === SPIRAL ? -0.02 + s * 1.1 : 1.03; // runs a little ahead of the camera
  const fill = i === SPIRAL - 1 ? 1 - s : 1;
  const dim = i === 0 ? 0 : i === SPIRAL - 1 ? s : 1;
  return {
    az: lerp(a0, a1, s),
    r: Math.exp(lerp(Math.log(r0), Math.log(r1), s)), // log space: the zoom feels even
    y: lerp(y0, y1, s),
    ty: lerp(ty0, ty1, s),
    sweep,
    fill,
    dim,
    phase,
  };
}
