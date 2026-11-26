import { suite, assert } from './harness.js';
import { parseTemplate, resolveSegments, renderTemplateText, stripBindings, findFreeNumerals } from '../src/model/binding.js';
import { loadDemoGraph } from '../src/model/loader.js';
import { JsEngine } from '../src/model/engine.js';

const test = suite('binding');

let shared = null;
function engine() {
  if (!shared) {
    shared = new JsEngine({ samples: 400 });
    shared.load(loadDemoGraph());
  }
  return shared;
}

test('parses bindings with format and scenario prefix; the statistic resolves against the graph', () => {
  const segs = parseTemplate('Cash {{bakery.monthly_cash.p50 | usd}} vs {{scn_a::bakery.rent}}.');
  const binds = segs.filter((s) => s.type === 'bind');
  assert.equal(binds.length, 2);
  assert.equal(binds[0].path, 'bakery.monthly_cash.p50');
  assert.equal(binds[0].fmt, 'usd');
  assert.equal(binds[1].scenario, 'scn_a');
  assert.equal(binds[1].path, 'bakery.rent');
  resolveSegments(segs, engine().graph);
  assert.equal(binds[0].nodeId, 'sc_bakery.monthly_cash');
  assert.equal(binds[0].stat, 'p50', '".p50" is a statistic, not a child scope');
  assert.equal(binds[1].stat, 'value');
});

test('resolves paths lexically against the graph', () => {
  const g = engine().graph;
  const segs = resolveSegments(parseTemplate('{{bakery.rent}} {{locationB.net_cash.p50}} {{nope.nothing}}'), g);
  const binds = segs.filter((s) => s.type === 'bind');
  assert.equal(binds[0].nodeId, 'sc_bakery.rent');
  assert.equal(binds[1].nodeId, 'sc_7Q2f.net_cash');
  assert.equal(binds[2].nodeId, null, 'unknown paths stay unbound (rendered as [path?])');
});

test('renders current values with the unit-aware formatter', () => {
  const e = engine();
  const text = renderTemplateText('Rent is {{bakery.rent}}.', { graph: e.graph, viewFor: (s) => e.view(s || 'base') });
  assert.match(text, /^Rent is \$6,500/);
});

test('flags unbound numerals and ignores bound ones, dates, identifiers and list markers', () => {
  const ok = '1. Median cash is {{bakery.monthly_cash.p50 | usd}} at p90 in v41 on 2026-11-26 ("about 4,000").';
  assert.deepEqual(findFreeNumerals(ok), []);
  const bad = 'Median cash is $3,671 and rent rose 8%.';
  assert.deepEqual(findFreeNumerals(bad).map((f) => f.text), ['$3,671', '8%']);
  assert.equal(stripBindings('{{a.b}}').trim(), '');
});
