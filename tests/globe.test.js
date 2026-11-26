import { suite, assert } from './harness.js';
import { geoContains, geoDistance } from 'd3';
import { CITIES, COUNTRIES_URL, fmtLatLng } from '../src/editors/globe/cities.js';

const test = suite('globe');
const KM = 6371;

test('every tour city lies in (or on the coast of) the country it highlights', async () => {
  const geo = await (await fetch(COUNTRIES_URL)).json();
  for (const c of CITIES) {
    assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180, `${c.name} coordinates in range`);
    const f = geo.features.find((x) => x.properties.a3 === c.a3);
    assert.ok(f, `${c.name}: no ${c.a3} feature (Singapore needs the 50m set, France needs ADM0_A3)`);
    const p = [c.lng, c.lat];
    // 50m coastlines put waterfront centres (NYC, Istanbul, Lisbon) a few km offshore
    const near = geoContains(f, p) || JSON.stringify(f.geometry.coordinates).match(/\[-?[\d.]+,-?[\d.]+\]/g).some((s) => geoDistance(JSON.parse(s), p) * KM < 25);
    assert.ok(near, `${c.name} is not in ${c.a3}`);
    const other = geo.features.find((x) => x !== f && geoContains(x, p));
    assert.ok(!other, `${c.name} falls in ${other?.properties.a3}, not ${c.a3}`);
  }
});

test('coordinate format', () => {
  assert.equal(fmtLatLng(51.5074, -0.1278), '51.5074° N · 0.1278° W');
  assert.equal(fmtLatLng(-33.8688, 151.2093), '33.8688° S · 151.2093° E');
});
