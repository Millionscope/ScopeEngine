import { suite, assert } from './harness.js';
import { AreaTree, makeArea, makeSplit } from '../src/workspace/area-tree.js';

const test = suite('area-tree');

/** A three-area layout: chat | (outliner / sheet). */
function sample() {
  return new AreaTree(makeSplit('row', 0.55, makeArea('chat'), makeSplit('col', 0.5, makeArea('outliner'), makeArea('sheet'))));
}

test('split creates a sibling with the requested ratio and editor type', () => {
  const t = new AreaTree(makeArea('chat'));
  const first = t.root.id;
  const second = t.split(first, 'row', 0.3, 'outliner');
  assert.equal(t.leaves().length, 2);
  assert.equal(t.root.kind, 'split');
  assert.equal(/** @type {any} */ (t.root).dir, 'row');
  assert.close(/** @type {any} */ (t.root).ratio, 0.3, 1e-12);
  assert.equal(t.area(second)?.editorType, 'outliner');
  assert.equal(t.area(first)?.editorType, 'chat');
  assert.ok(t.validate().ok, 'tree stays valid');
});

test('split without a type copies the type, flags and (optionally) state', () => {
  const t = new AreaTree(makeArea('graph', { syncSelection: false, scenarioId: 'scn_1', editorState: { zoom: 2 } }));
  const id = t.split(t.root.id, 'col', 0.5, null, { copyState: true });
  const leaf = t.area(id);
  assert.equal(leaf?.editorType, 'graph');
  assert.equal(leaf?.syncSelection, false);
  assert.equal(leaf?.scenarioId, 'scn_1');
  assert.deepEqual(leaf?.editorState, { zoom: 2 });
});

test('join merges siblings back into one area', () => {
  const t = new AreaTree(makeArea('chat'));
  const a = t.root.id;
  const b = t.split(a, 'row');
  t.join(a, b);
  assert.equal(t.leaves().length, 1);
  assert.equal(t.root.id, a);
  assert.ok(t.validate().ok);
});

test('join refuses areas that do not share a full edge', () => {
  const t = sample();
  const [chat, outliner] = t.leaves().map((l) => l.id);
  assert.equal(t.canJoin(chat, outliner).ok, false);
  assert.equal(t.canJoin(chat, chat).ok, false);
  assert.throws(() => t.join(chat, outliner), /full edge/);
});

test('close keeps the sibling and never leaves zero areas', () => {
  const t = sample();
  const [, outliner, sheet] = t.leaves().map((l) => l.id);
  t.close(sheet);
  assert.equal(t.leaves().length, 2);
  assert.ok(t.area(outliner));
  const single = new AreaTree(makeArea('chat'));
  assert.throws(() => single.close(single.root.id), /at least one area/);
});

test('swap exchanges two areas and keeps every id unique', () => {
  const t = sample();
  const before = t.leaves().map((l) => l.editorType);
  const [a, , c] = t.leaves().map((l) => l.id);
  t.swap(a, c);
  const after = t.leaves().map((l) => l.editorType);
  assert.deepEqual(after, [before[2], before[1], before[0]]);
  assert.ok(t.validate().ok);
});

test('resize clamps ratios into the open interval', () => {
  const t = sample();
  const split = t.splits()[0];
  t.resize(split.id, 5);
  assert.ok(split.ratio < 1 && split.ratio > 0.9);
  t.resize(split.id, -1);
  assert.ok(split.ratio > 0 && split.ratio < 0.1);
  t.resize(split.id, NaN);
  assert.equal(split.ratio, 0.5);
});

test('serialize → deserialize is lossless', () => {
  const t = sample();
  const leaf = t.leaves()[1];
  t.replaceEditor(leaf.id, 'history', { filter: 'rent' });
  t.maximize(leaf.id);
  const json = JSON.parse(JSON.stringify(t.serialize()));
  const back = AreaTree.deserialize(json);
  assert.deepEqual(back.serialize(), t.serialize());
  assert.equal(back.maximizedId, leaf.id);
});

test('deserialize rejects corrupt layouts (duplicate ids, bad ratios, unknown types)', () => {
  const t = sample();
  const json = t.serialize();
  const dup = structuredClone(json);
  dup.root.b.b.id = dup.root.b.a.id;
  assert.throws(() => AreaTree.deserialize(dup), /duplicate id/);
  const ratio = structuredClone(json);
  ratio.root.ratio = 1.5;
  assert.throws(() => AreaTree.deserialize(ratio), /bad ratio/);
  assert.throws(() => AreaTree.deserialize(json, { knownTypes: new Set(['chat']) }), /unknown editor type/);
  assert.throws(() => AreaTree.deserialize({}), /missing root/);
});

test('maximize and restore', () => {
  const t = sample();
  const id = t.leaves()[0].id;
  t.maximize(id);
  assert.equal(t.maximizedId, id);
  t.restore();
  assert.equal(t.maximizedId, null);
  assert.throws(() => t.maximize('nope'), /no area/);
});
