import { suite, assert } from './harness.js';
import { pickStops, loopAt, ribbons, STRIDE } from '../src/editors/city/tour.js';

const test = suite('city');

test('tour stops: tallest first, spaced apart, ordered around the ring', () => {
  const bs = [
    { x: 0, y: 0, h: 300 }, { x: 10, y: 0, h: 290 }, // too close to the tallest: skipped
    { x: 1000, y: 0, h: 200 }, { x: 0, y: 1000, h: 150 }, { x: 1000, y: 1000, h: 120 }, { x: 500, y: 500, h: 5 },
  ];
  const stops = pickStops(bs, 4, 260);
  assert.equal(stops.length, 4);
  assert.ok(!stops.some((s) => s.h === 290 || s.h === 5));
  const ang = stops.map((s) => Math.atan2(s.y - 500, s.x - 500));
  assert.deepEqual(ang, [...ang].sort((a, b) => a - b));
  assert.equal(pickStops(bs.slice(0, 2)), null);
});

test('loop passes through every stop and wraps', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  pts.forEach((p, i) => {
    const q = loopAt(pts, i / pts.length);
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y) < 1e-9, `stop ${i}`);
  });
  const a = loopAt(pts, 0.1);
  const b = loopAt(pts, 1.1);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
  assert.ok(loopAt(pts, 0).dx > 0, 'heads towards the next stop');
});

test('ribbons: 6 vertices per segment, width and running distance', () => {
  const v = ribbons([{ pts: [[0, 0], [10, 0], [10, 20]], hw: 3, kind: 2, seed: 0.5 }]);
  assert.equal(v.length, 2 * 6 * STRIDE);
  assert.deepEqual([...v.slice(0, STRIDE)], [0, 3, 1, 0, 2, 0.5]);
  assert.equal(v[11 * STRIDE + 3], 30); // last vertex: 10 + 20 m along
});
