import { suite, assert } from './harness.js';
import { pickModel, tourParts, plddtBand } from '../src/editors/protein/afdb.js';

const test = suite('protein');

test('pickModel: BinaryCIF first, CIF fallback, AFDB files only', () => {
  const d = { bcifUrl: 'https://alphafold.ebi.ac.uk/files/AF-X-F1-model_v6.bcif', cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-X-F1-model_v6.cif', sequenceStart: 1, sequenceEnd: 142, globalMetricValue: 98.06, fractionPlddtVeryHigh: 0.99 };
  const m = pickModel([d]);
  assert.equal(m.url, d.bcifUrl);
  assert.ok(m.binary);
  assert.equal(m.length, 142);
  assert.equal(m.bands[0], 0.99);
  assert.equal(m.chain, 'A');
  assert.equal(pickModel([{ ...d, bcifUrl: undefined }]).binary, false);
  assert.equal(pickModel([{ ...d, bcifUrl: 'https://evil.example/x.bcif', cifUrl: 'http://alphafold.ebi.ac.uk/files/x.cif' }]), null);
  assert.equal(pickModel([]), null);
  assert.equal(pickModel({}), null);
});

test('tourParts: confident runs, chunked, short or disordered stretches skipped', () => {
  const s = [...Array(100).fill(95), ...Array(30).fill(30), ...Array(8).fill(90), ...Array(5).fill(30), ...Array(20).fill(80)];
  const parts = tourParts(s, { chunk: 48 });
  // 100 residues -> 3 chunks; the 30 disordered and the 8-residue run are skipped; 20 -> 1 chunk
  assert.deepEqual(parts.map((p) => [p.beg, p.end]), [[1, 33], [34, 67], [68, 100], [144, 163]]);
  assert.equal(parts[3].plddt, 80);
  assert.deepEqual(tourParts(Array(10).fill(20)).map((p) => [p.beg, p.end]), [[1, 10]], 'all disordered: the whole chain');
  assert.equal(tourParts(Array(2000).fill(95)).length, 8, 'capped');
  assert.deepEqual(tourParts([]), []);
});

test('plddtBand follows AlphaFold thresholds', () => {
  assert.deepEqual([95, 90, 75, 70, 55, 50, 10].map((v) => plddtBand(v).label), ['Very high', 'Confident', 'Confident', 'Low', 'Low', 'Very low', 'Very low']);
});
