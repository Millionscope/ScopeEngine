import { suite, assert } from './harness.js';
import { tourAt, KEYS, LOOP } from '../src/editors/building/tour.js';

const test = suite('building');
const TAU = Math.PI * 2;

test('loop wraps without a jump (azimuth a whole number of turns on)', () => {
  const a = tourAt(0);
  const b = tourAt(LOOP - 1e-6);
  assert.close(Math.sin(a.az), Math.sin(b.az), 1e-5);
  assert.close(Math.cos(a.az), Math.cos(b.az), 1e-5);
  for (const k of ['r', 'y', 'ty', 'sweep', 'fill']) assert.close(a[k], b[k], 1e-5, k);
  assert.close((KEYS[KEYS.length - 1][1] - KEYS[0][1]) / TAU % 1, 0, 1e-9);
});

test('glow state is continuous at every keyframe', () => {
  for (const [t] of KEYS.slice(1, -1)) {
    const a = tourAt(t - 1e-6);
    const b = tourAt(t);
    // brightness proxy of the shader at a few heights: filled boost, dimming of the unfilled rest
    const shade = (p, h) => { const f = p.sweep >= h ? p.fill : 0; return (1 + f) * (1 - 0.6 * p.dim * (1 - f)); };
    for (const h of [0.1, 0.5, 0.9]) assert.close(shade(a, h), shade(b, h), 1e-4, `glow at ${t}, h ${h}`);
    assert.close(a.y, b.y, 1e-4, `y at ${t}`);
  }
});

test('climb: from the base to the top, the glow tracking the camera', () => {
  const [t0] = KEYS[2];
  const [t1] = KEYS[3];
  assert.ok(tourAt(t0).y < 0.05 && tourAt(t0).sweep <= 0, 'starts at the base, nothing lit');
  let prev = -Infinity;
  for (let t = t0; t < t1; t += 0.25) {
    const p = tourAt(t);
    assert.ok(p.y >= prev - 1e-9, `rises at ${t}`);
    assert.ok(Math.abs(p.sweep - p.y) < 0.12, `glow near camera height at ${t}`);
    prev = p.y;
  }
  assert.ok(tourAt(t1 - 1e-6).sweep >= 1, 'whole tower lit at the top');
  assert.equal(tourAt(1).phase, 'Overview');
});
