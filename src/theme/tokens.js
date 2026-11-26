/**
 * Token access for code that cannot use CSS directly (canvas, WebGL, chart libraries), plus
 * provenance metadata (glyph + label + color variable). Provenance is never color-only.
 * @module theme/tokens
 */

/** VS Code webview mapping: 'editor.background' -> '--vscode-editor-background'. @param {string} key */
export function cssVarName(key) {
  return '--vscode-' + key.replace(/\./g, '-');
}

/** @param {string} key VS Code key or --ms-* name */
export function cssVar(key) {
  return `var(${key.startsWith('--') ? key : cssVarName(key)})`;
}

/** @type {Map<string, string>} */
let cache = new Map();
let epoch = 0;

/** Called by the theme service whenever variables change. */
export function invalidateTokenCache() {
  cache = new Map();
  epoch++;
}
export function tokenEpoch() { return epoch; }

/**
 * Resolved color for a VS Code key ('editor.background') or a custom property ('--ms-cone').
 * @param {string} name
 * @param {string} [fallback]
 */
export function token(name, fallback = '') {
  const prop = name.startsWith('--') ? name : cssVarName(name);
  let v = cache.get(prop);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    cache.set(prop, v);
  }
  return v || fallback;
}

/**
 * @typedef {'input'|'observed'|'estimated'|'computed'|'proven'|'failed'|'contested'} ProvKind
 */

/** @type {Record<ProvKind, {glyph:string, label:string, description:string, var:string}>} */
export const PROVENANCE = {
  input: { glyph: '●', label: 'input', description: 'set by the user; overridable', var: '--ms-prov-input' },
  observed: { glyph: '◆', label: 'observed', description: 'from a cited source, verified to appear in it; overriding makes it input', var: '--ms-prov-observed' },
  estimated: { glyph: '~', label: 'estimated', description: 'a distribution from the model or swarm; overriding makes it input', var: '--ms-prov-estimated' },
  computed: { glyph: 'ƒ', label: 'computed', description: 'produced by the engine from formulas; edit its inputs or formula', var: '--ms-prov-computed' },
  proven: { glyph: '✓', label: 'proven', description: 'proven by SMT or Lean for all inputs in declared ranges', var: '--ms-prov-proven' },
  failed: { glyph: '✕', label: 'failed check', description: 'a verifier check failed', var: '--ms-fail' },
  contested: { glyph: '≈', label: 'contested', description: 'estimators disagree; kept as a flagged mixture', var: '--ms-contested-color' },
};

export const PROV_ORDER = /** @type {ProvKind[]} */ (['input', 'observed', 'estimated', 'computed', 'proven']);

/** @param {string} kind */
export function provGlyph(kind) { return (PROVENANCE[kind] || PROVENANCE.computed).glyph; }
/** @param {string} kind */
export function provLabel(kind) { return (PROVENANCE[kind] || PROVENANCE.computed).label; }
/** Resolved color for canvas/WebGL use. @param {string} kind */
export function provColor(kind) { return token((PROVENANCE[kind] || PROVENANCE.computed).var); }

/** Categorical series color, fixed order (index 0-based, never cycled past 8). @param {number} i */
export function seriesColor(i) {
  const idx = Math.max(0, Math.min(7, i));
  return token(`--ms-series-${idx + 1}`);
}
/** @returns {string[]} */
export function seriesColors() {
  return Array.from({ length: 8 }, (_, i) => seriesColor(i));
}
/** Sequential ramp, low -> high (anchor already flipped for dark). @returns {string[]} */
export function seqColors() {
  return Array.from({ length: 9 }, (_, i) => token(`--ms-seq-${i}`));
}

/** UI font stacks (mirrors base.css). */
export const FONT_UI = '"TTT", -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, Ubuntu, sans-serif';
export const FONT_MONO = '"Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * Parse #RGB/#RRGGBB/#RRGGBBAA/rgb()/rgba() into [r,g,b,a] (0-255, a 0-1).
 * @param {string} color
 * @returns {[number, number, number, number]}
 */
export function parseColor(color) {
  const c = String(color || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
  }
  return [128, 128, 128, 1];
}

/** CSS rgba() string with an alpha override. @param {string} color @param {number} alpha */
export function alpha(color, a) {
  const [r, g, b] = parseColor(color);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
