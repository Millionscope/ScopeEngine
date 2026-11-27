import { suite, assert } from './harness.js';
import { CITIES } from '../src/editors/shared/cities.js';
import { VIEWS } from '../src/editors/terrain/views.js';

const test = suite('terrain');
const POPULAR = ['London', 'New York City', 'Paris', 'Tokyo', 'Madrid', 'Singapore', 'Rome', 'Dubai', 'Berlin', 'Barcelona', 'Sydney', 'Los Angeles', 'Seoul', 'Amsterdam', 'Melbourne', 'Bangkok', 'Shanghai', 'Istanbul', 'Mexico City', 'Lisbon'];

test('one terrain view per popular city, in order, matching the globe', () => {
  assert.deepEqual(Object.keys(VIEWS), POPULAR);
  assert.deepEqual(CITIES.map((c) => c.name), POPULAR);
  for (const [name, v] of Object.entries(VIEWS)) {
    assert.ok(v.zoom >= 6 && v.zoom <= 14, `${name} zoom ${v.zoom}`);
    assert.ok(v.exag > 0 && v.exag <= 20, `${name} exaggeration ${v.exag}`);
  }
});
