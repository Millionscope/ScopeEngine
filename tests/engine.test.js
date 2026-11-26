import { suite, assert } from './harness.js';
import { loadDemoGraph } from '../src/model/loader.js';
import { JsEngine } from '../src/model/engine.js';

const test = suite('engine');
const OUT = 'sc_bakery.monthly_cash';

function engineWith(edits = [], samples = 500) {
  const g = loadDemoGraph();
  for (const [id, v] of edits) g.node(id).value = v;
  const e = new JsEngine({ samples });
  e.load(g);
  return e;
}

test('incremental recompute equals a full recompute (point values and Monte Carlo)', () => {
  const inc = engineWith();
  for (const [id, v] of [['sc_bakery.rent', 7200], ['sc_bakery.price', 4.25], ['sc_bakery.marketing', 900]]) {
    const r = inc.apply([{ op: 'set', target: id, value: v }]);
    assert.ok(r.ok, JSON.stringify(r.errors));
  }
  const full = engineWith([['sc_bakery.rent', 7200], ['sc_bakery.price', 4.25], ['sc_bakery.marketing', 900]]);
  let compared = 0;
  for (const id of inc.graph.nodes.keys()) {
    const a = inc.value(id);
    const b = full.value(id);
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    assert.close(a, b, Math.abs(b) * 1e-12 + 1e-12, `point value of ${id}`);
    compared++;
  }
  assert.ok(compared > 250, `compared ${compared} metrics`);
  for (const id of [OUT, 'sc_7Q2f.net_cash', 'sc_bakery.p_cash_negative']) {
    const sa = inc.stats(id);
    const sb = full.stats(id);
    assert.close(sa.p50, sb.p50, Math.abs(sb.p50) * 1e-9 + 1e-9, `p50 of ${id}`);
    assert.close(sa.mean, sb.mean, Math.abs(sb.mean) * 1e-9 + 1e-9, `mean of ${id}`);
  }
});

test('only the downstream cone is recomputed', () => {
  const e = engineWith();
  const r = e.apply([{ op: 'set', target: 'sc_bakery.insurance', value: 400 }]);
  assert.ok(r.ok);
  assert.ok(r.changed.includes('sc_bakery.fixed_costs'), 'direct dependant recomputed');
  assert.ok(r.changed.includes(OUT), 'output recomputed');
  assert.ok(!r.changed.includes('sc_7Q2f.customers'), 'unrelated branch untouched');
  assert.ok(r.changed.length < e.graph.nodes.size / 3, `${r.changed.length} of ${e.graph.nodes.size} changed`);
});

test('early cutoff stops propagation when a value does not change', () => {
  const e = engineWith();
  const add = e.apply([
    { op: 'add_metric', scope: 'sc_bakery', name: 'floor_test', unit: 'USD/month', expr: ['max', '@insurance', 10000] },
    { op: 'add_metric', scope: 'sc_bakery', name: 'floor_child', unit: 'USD/month', expr: ['mul', '@floor_test', 2] },
  ]);
  assert.ok(add.ok, JSON.stringify(add.errors));
  assert.equal(e.value('sc_bakery.floor_child'), 20000);
  const r = e.apply([{ op: 'set', target: 'sc_bakery.insurance', value: 420 }]);
  assert.ok(r.ok);
  assert.ok(r.changed.includes('sc_bakery.fixed_costs'), 'the other branch still updates');
  assert.ok(!r.changed.includes('sc_bakery.floor_test'), 'max(…, 10000) did not change');
  assert.ok(!r.changed.includes('sc_bakery.floor_child'), 'its dependants were cut off');
});

test('seeded Monte Carlo is reproducible, and the seed matters', () => {
  const a = engineWith();
  const b = engineWith();
  const sa = a.sample(OUT);
  const sb = b.sample(OUT);
  assert.ok(sa && sb && sa.length === 500);
  let same = true;
  for (let k = 0; k < sa.length; k++) if (sa[k] !== sb[k]) { same = false; break; }
  assert.ok(same, 'same graph hash + seed → identical samples');
  const g = loadDemoGraph();
  g.seed = 99;
  const c = new JsEngine({ samples: 500 });
  c.load(g);
  const sc = c.sample(OUT);
  let diff = 0;
  for (let k = 0; k < sa.length; k++) if (sa[k] !== sc[k]) diff++;
  assert.ok(diff > 400, `a different seed changes the draws (${diff} of 500 differ)`);
});

test('common random numbers: an edit moves outputs without re-drawing the noise', () => {
  const e = engineWith();
  const before = Float64Array.from(e.sample('sc_bakery.demand'));
  e.apply([{ op: 'set', target: 'sc_bakery.rent', value: 7000 }]);
  const after = e.sample('sc_bakery.demand');
  for (let k = 0; k < before.length; k++) assert.equal(after[k], before[k], `demand draw ${k}`);
});

test('the demo answer matches the documented headline numbers', () => {
  const e = engineWith([], 1000);
  const s = e.stats(OUT);
  assert.close(s.p50, 3671, 1, 'median monthly cash');
  assert.close(e.value('sc_bakery.p_cash_negative'), 0.25, 0.005, 'P(monthly cash < 0)');
});
