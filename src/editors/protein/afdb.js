/**
 * AlphaFold DB data for the Protein editor: the protein list, the API response check and the
 * zoom-tour parts. Pure (no DOM, no Mol*) so tests can import it.
 * @module editors/protein/afdb
 */

export const API = 'https://alphafold.ebi.ac.uk/api/prediction/';

/** UniProt accessions with AlphaFold models: well-known folds plus disordered ones that show pLDDT well. */
export const PROTEINS = [
  { acc: 'P42212', name: 'Green fluorescent protein' },
  { acc: 'P69905', name: 'Hemoglobin α' },
  { acc: 'P61626', name: 'Lysozyme C' },
  { acc: 'P01116', name: 'KRAS GTPase' },
  { acc: 'P01308', name: 'Insulin' },
  { acc: 'P04637', name: 'p53 tumor suppressor' },
  { acc: 'P10636', name: 'Tau' },
  { acc: 'P00533', name: 'EGF receptor' },
  { acc: 'P13569', name: 'CFTR' },
];

/** AlphaFold's pLDDT bands (colours as on alphafold.ebi.ac.uk); `key` is the API's fraction field. */
export const PLDDT = [
  { label: 'Very high', range: '> 90', color: '#0053d6', min: 90, key: 'fractionPlddtVeryHigh' },
  { label: 'Confident', range: '90 – 70', color: '#65cbf3', min: 70, key: 'fractionPlddtConfident' },
  { label: 'Low', range: '70 – 50', color: '#ffdb13', min: 50, key: 'fractionPlddtLow' },
  { label: 'Very low', range: '< 50', color: '#ff7d45', min: -Infinity, key: 'fractionPlddtVeryLow' },
];

/** @param {number} v pLDDT 0..100 */
export const plddtBand = (v) => PLDDT.find((b) => v > b.min) ?? PLDDT[PLDDT.length - 1];

const AFDB_FILE = /^https:\/\/alphafold\.ebi\.ac\.uk\/files\//;

/**
 * The model to load from an /api/prediction response, or null. Only AFDB file URLs are accepted:
 * the URL goes straight into the Mol* loader.
 * @param {any} json
 */
export function pickModel(json) {
  const d = Array.isArray(json) ? json[0] : null;
  if (!d) return null;
  const url = [d.bcifUrl, d.cifUrl].find((u) => typeof u === 'string' && AFDB_FILE.test(u));
  if (!url) return null;
  return {
    url,
    binary: url === d.bcifUrl,
    plddtUrl: typeof d.plddtDocUrl === 'string' && AFDB_FILE.test(d.plddtDocUrl) ? d.plddtDocUrl : null,
    id: String(d.modelEntityId ?? d.entryId ?? ''),
    acc: String(d.uniprotAccession ?? ''),
    name: String(d.uniprotDescription ?? ''),
    gene: String(d.gene ?? '–'),
    organism: String(d.organismScientificName ?? '–'),
    chain: String(d.chainId ?? 'A'),
    length: (d.sequenceEnd ?? 0) - (d.sequenceStart ?? 1) + 1,
    plddt: Number(d.globalMetricValue) || 0,
    version: d.latestVersion ?? null,
    bands: PLDDT.map((b) => Number(d[b.key]) || 0),
  };
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

/**
 * Parts of the chain for the zoom tour: confident runs (pLDDT >= min, at least minLen residues),
 * split into chunks of about `chunk` residues (about a helix or a strand pair, small enough for a
 * real zoom), at most `max`, evenly picked. A chain with no confident run is toured as a whole. Residues are numbered 1..N (AlphaFold label_seq_id).
 * @param {number[]} scores per-residue pLDDT
 * @returns {{beg: number, end: number, plddt: number}[]}
 */
export function tourParts(scores, { min = 70, minLen = 12, chunk = 22, max = 8 } = {}) {
  const runs = [];
  let beg = -1;
  for (let i = 0; i <= scores.length; i++) {
    const ok = i < scores.length && scores[i] >= min;
    if (ok && beg < 0) beg = i;
    else if (!ok && beg >= 0) {
      if (i - beg >= minLen) runs.push([beg, i - 1]);
      beg = -1;
    }
  }
  if (!runs.length && scores.length) runs.push([0, scores.length - 1]);
  const parts = runs.flatMap(([b, e]) => {
    const n = Math.ceil((e - b + 1) / chunk);
    const len = (e - b + 1) / n;
    return Array.from({ length: n }, (_, k) => [b + Math.round(k * len), b + Math.round((k + 1) * len) - 1]);
  });
  const picked = parts.length <= max ? parts : Array.from({ length: max }, (_, k) => parts[Math.floor((k * parts.length) / max)]);
  return picked.map(([b, e]) => ({ beg: b + 1, end: e + 1, plddt: mean(scores.slice(b, e + 1)) }));
}
