import { suite, assert } from './harness.js';
import { parseUnit, convert, convertFactor, mulUnit, divUnit, sameDims, unitText, isDimensionless, TIME } from '../src/model/units.js';

const test = suite('units');

test('parses compound units', () => {
  const u = parseUnit('USD/month');
  assert.deepEqual(u.d, { USD: 1, s: -1 });
  assert.ok(sameDims(parseUnit('USD/day'), u), 'USD/day and USD/month share dimensions');
  assert.ok(isDimensionless(parseUnit('')), 'empty is dimensionless');
  assert.ok(isDimensionless(parseUnit('prob')));
  assert.ok(!sameDims(parseUnit('loaf/day'), parseUnit('person/day')), 'loaves never add to people');
});

test('converts between time bases exactly', () => {
  assert.close(convert(100, 'USD/day', 'USD/month'), 100 * (TIME.MONTH / TIME.DAY), 1e-9);
  assert.close(convert(12, 'USD/month', 'USD/year'), 144, 1e-9);
  assert.close(convert(1, 'kUSD', 'USD'), 1000, 1e-12);
  assert.close(convertFactor('km', 'm'), 1000, 1e-12);
});

test('refuses to convert across dimensions, with an actionable hint', () => {
  assert.throws(() => convert(1, 'USD/month', 'loaf/day'), /dimensions differ/);
});

test('multiplication and division compose dimensions', () => {
  const rev = mulUnit(parseUnit('loaf/day'), parseUnit('USD/loaf'));
  assert.ok(sameDims(rev, parseUnit('USD/day')), unitText(rev));
  const per = divUnit(parseUnit('USD/month'), parseUnit('USD'));
  assert.ok(sameDims(per, parseUnit('1/month')), unitText(per));
  assert.ok(isDimensionless(divUnit(parseUnit('USD/loaf'), parseUnit('USD/loaf'))));
});
