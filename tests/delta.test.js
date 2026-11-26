import { suite, assert } from './harness.js';
import { loadDemoGraph } from '../src/model/loader.js';
import { JsEngine } from '../src/model/engine.js';

const test = suite('delta');

function fresh() {
  const rejected = [];
  const e = new JsEngine({ samples: 200, onRejected: (p) => rejected.push(p) });
  e.load(loadDemoGraph());
  return { e, rejected };
}

test('a valid set lands as a new version and reports its inverse', () => {
  const { e } = fresh();
  const v0 = e.graph.versionLabel;
  const r = e.apply([{ op: 'set', target: 'sc_bakery.rent', value: 7000, expect: v0 }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.notEqual(e.graph.versionLabel, v0);
  assert.equal(e.value('sc_bakery.rent'), 7000);
  assert.equal(r.inverses[0].op, 'set');
  assert.equal(r.inverses[0].value, 6500);
});

test('stale version fails closed with a rebase hint', () => {
  const { e, rejected } = fresh();
  const r = e.apply([{ op: 'set', target: 'sc_bakery.rent', value: 7000, expect: 'v1' }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'stale_version');
  assert.match(r.errors[0].message, /expects v1 but the graph is at v\d+/);
  assert.match(r.errors[0].hint, /rebase/);
  assert.equal(e.value('sc_bakery.rent'), 6500, 'nothing applied');
  assert.equal(rejected.length, 1, 'delta:rejected is reported once');
});

test('unit mismatch fails closed with the actionable convert() message', () => {
  const { e } = fresh();
  const r = e.apply([{ op: 'rewire', target: 'sc_7Q2f.net_cash', expr: ['sub', '@contribution_b', '@rent'] }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /unit mismatch in Bakery\.LocationB\.net_cash: USD\/day - USD\/month/);
  assert.match(r.errors[0].hint, /wrap the first term in convert\(\.\.\., USD\/month\)/);
});

test('a rewire that would create a cycle is rejected with the cycle path', () => {
  const { e } = fresh();
  // gross_margin feeds contribution; making gross_margin depend on contribution closes a loop
  const r = e.apply([{ op: 'rewire', target: 'sc_bakery.gross_margin', expr: ['mul', '@contribution', 1] }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'cycle');
  assert.match(r.errors[0].message, /cycle .*gross_margin.*contribution|cycle .*contribution.*gross_margin/);
});

test('batches are all-or-nothing', () => {
  const { e } = fresh();
  const v0 = e.graph.versionLabel;
  const r = e.apply([
    { op: 'set', target: 'sc_bakery.rent', value: 7000 },
    { op: 'set', target: 'sc_bakery.does_not_exist', value: 1 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(e.value('sc_bakery.rent'), 6500, 'first delta rolled back');
  assert.equal(e.graph.versionLabel, v0, 'no version created');
});

test('applying the inverse restores the previous values exactly', () => {
  const { e } = fresh();
  const before = e.value('sc_bakery.monthly_cash');
  const r = e.apply([{ op: 'set', target: 'sc_bakery.price', value: 4.5 }]);
  assert.ok(r.ok);
  assert.notEqual(e.value('sc_bakery.monthly_cash'), before);
  const u = e.apply(r.inverses.map((d) => ({ ...d, expect: undefined })));
  assert.ok(u.ok, JSON.stringify(u.errors));
  assert.equal(e.value('sc_bakery.monthly_cash'), before);
});
