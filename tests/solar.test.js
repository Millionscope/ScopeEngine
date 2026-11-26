import { suite, assert } from './harness.js';
import { PLANETS, keplerPeriodDays, orbitPosition, daysSinceJ2000, spinAngle } from '../src/editors/solar/orbits.js';

const test = suite('solar');
const P = Object.fromEntries(PLANETS.map((p) => [p.id, p]));

test('orbital periods follow Kepler’s third law', () => {
  assert.close(keplerPeriodDays(1), 365.2422, 1e-9);
  assert.close(P.jupiter.periodDays / P.earth.periodDays, 11.86, 0.01);
  assert.close(P.mercury.periodDays, 87.97, 0.1);
});

test('rotation ratios and directions are real', () => {
  assert.close(P.jupiter.rotationHours / P.earth.rotationHours, 0.4147, 0.001);
  assert.ok(P.venus.rotationHours < 0, 'Venus spins retrograde');
  assert.ok(P.uranus.tiltDeg > 90, 'Uranus retrograde through its tilt');
  assert.close(spinAngle(P.earth.rotationHours, P.earth.rotationHours / 4), Math.PI / 2, 1e-9);
});

test('size order matches the real radii', () => {
  const byScene = [...PLANETS].sort((a, b) => a.radius - b.radius).map((p) => p.id);
  const byReal = [...PLANETS].sort((a, b) => a.radiusKm - b.radiusKm).map((p) => p.id);
  assert.deepEqual(byScene, byReal);
});

test('positions: perihelion/aphelion bounds and real longitude', () => {
  for (let d = 0; d < 400; d += 7) {
    const { r } = orbitPosition(P.mercury, d);
    assert.ok(r >= P.mercury.sceneA * (1 - P.mercury.e) - 1e-9 && r <= P.mercury.sceneA * (1 + P.mercury.e) + 1e-9);
  }
  // Earth at the March 2024 equinox: heliocentric longitude ≈ 180°
  const { x, z } = orbitPosition(P.earth, daysSinceJ2000(Date.UTC(2024, 2, 20, 3)));
  const lon = (Math.atan2(-z, x) * 180 / Math.PI + 360) % 360;
  assert.close(lon, 180, 1.5);
  // one full period returns to the same place
  const a = orbitPosition(P.mars, 100), b = orbitPosition(P.mars, 100 + P.mars.periodDays);
  assert.close(a.x, b.x, 1e-6); assert.close(a.z, b.z, 1e-6);
});
