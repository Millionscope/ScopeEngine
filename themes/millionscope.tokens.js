/**
 * MillionScope semantic tokens (--ms-*), derived from the merged VS Code palette so they feel
 * native. Where a token is defined as "the value of a VS Code key", it is read from the merged
 * color map, so editing that key in themes/*.json changes the token too.
 *
 * Categorical series palettes were validated with the dataviz six-check validator against the
 * actual surfaces (#1F1F1F dark editor.background, #FFFFFF light): lightness band, chroma floor,
 * adjacent CVD separation (worst dE 10.1 dark / 9.3 light), normal-vision floor, and >= 3:1
 * contrast. Order matters (it is the CVD-safety mechanism): never reorder or cycle.
 *
 * Sequential ramp: one hue (blue), light->dark in light mode; the anchor flips in dark mode so
 * "near zero" recedes toward the dark surface.
 */

const SERIES = {
  dark: ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'],
  light: ['#257de0', '#d4581a', '#00876c', '#a87400', '#d6437f', '#008a17', '#6a4ce2', '#e03a3b'],
};

const SEQ_BLUE = ['#cce3fd', '#b6d5f8', '#9dc8f7', '#84b9f3', '#6aabf1', '#338ced', '#2370cd', '#1757ac', '#0e3d7e'];

/**
 * Append an alpha channel (0..1) to a #RRGGBB or #RRGGBBAA color.
 * @param {string} hex @param {number} alpha
 */
export function withAlpha(hex, alpha) {
  const h = String(hex || '').trim();
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return h;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return h.slice(0, 7) + a;
}

/** @param {string} hex @returns {[number, number, number]|null} */
function rgbOf(hex) {
  const m = /^#([0-9a-f]{6})/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @param {[number, number, number]} c */
function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Keep a token's hue but move it toward white (dark themes) or black (light themes) until it
 * reaches `ratio` contrast against every given background. Colors that already pass are
 * returned unchanged, so theme values win wherever they are legible.
 * @param {string} fg #RRGGBB @param {string[]} bgs @param {number} ratio @param {boolean} dark
 */
export function ensureContrast(fg, bgs, ratio, dark) {
  const c = rgbOf(fg);
  const backs = bgs.map(rgbOf).filter(Boolean);
  if (!c || !backs.length) return fg;
  const worst = (rgb) => Math.min(...backs.map((b) => {
    const a = luminance(rgb);
    const z = luminance(/** @type {[number, number, number]} */ (b));
    return (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05);
  }));
  if (worst(c) >= ratio) return fg;
  const target = dark ? 255 : 0;
  for (let k = 1; k <= 20; k++) {
    const t = k / 20;
    /** @type {[number, number, number]} */
    const mixed = [0, 1, 2].map((i) => Math.round(c[i] + (target - c[i]) * t));
    if (worst(mixed) >= ratio) return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  return dark ? '#ffffff' : '#000000';
}

/**
 * Build the --ms-* custom properties for one theme kind from the merged color map.
 * @param {'dark'|'light'} kind
 * @param {Record<string,string>} c merged colors (theme keys win over fallbacks)
 * @returns {Record<string,string>}
 */
export function buildSemanticTokens(kind, c) {
  const dark = kind === 'dark';
  const pick = (key, fallback) => c[key] || fallback;
  const estimated = dark ? pick('chat.editedFileForeground', '#E2C08D') : pick('chat.editedFileForeground', '#895503');
  const t = {
    '--ms-prov-input': dark ? pick('textLink.foreground', '#4DAAFC') : pick('textLink.foreground', '#005FB8'),
    '--ms-prov-observed': dark ? pick('editorGutter.addedBackground', '#2EA043') : '#1A7F37',
    '--ms-prov-estimated': estimated,
    '--ms-prov-computed': dark ? pick('descriptionForeground', '#9D9D9D') : pick('tab.inactiveForeground', '#616161'),
    '--ms-prov-proven': dark ? '#B180D7' : '#8250DF',
    '--ms-fail': dark ? pick('errorForeground', '#F85149') : pick('statusBarItem.errorBackground', '#C72E0F'),
    '--ms-contested-color': estimated,
    '--ms-contested': `repeating-linear-gradient(135deg, ${withAlpha(estimated, 0.55)} 0 3px, transparent 3px 6px)`,
    '--ms-sim-voice-bg': pick('chat.slashCommandBackground', dark ? '#26477866' : '#ADCEFF7A'),
    '--ms-sim-voice-fg': pick('chat.slashCommandForeground', dark ? '#85B6FF' : '#26569E'),
    '--ms-cone': withAlpha(pick('focusBorder', dark ? '#0078D4' : '#005FB8'), dark ? 0.35 : 0.25),
    '--ms-cone-strong': withAlpha(pick('focusBorder', dark ? '#0078D4' : '#005FB8'), dark ? 0.7 : 0.55),
    '--ms-upstream': withAlpha(pick('chat.editedFileForeground', dark ? '#E2C08D' : '#895503'), dark ? 0.3 : 0.22),
    '--ms-warn': pick('editorWarning.foreground', dark ? '#CCA700' : '#BF8803'),
    '--ms-ok': dark ? pick('editorGutter.addedBackground', '#2EA043') : '#1A7F37',
    '--ms-shadow': pick('widget.shadow', dark ? '#0000005C' : '#00000029'),
    '--ms-scrim': dark ? '#0000008C' : '#00000040',
  };
  // status and provenance colors also color text (labels, glyphs): keep them >= 4.5:1 on the
  // surfaces they sit on (editor, side bar, panel, widgets)
  const surfaces = [pick('editor.background', dark ? '#1F1F1F' : '#FFFFFF'), pick('sideBar.background', dark ? '#181818' : '#F8F8F8'), pick('panel.background', dark ? '#181818' : '#F8F8F8'), pick('editorWidget.background', dark ? '#202020' : '#F8F8F8')];
  for (const key of ['--ms-warn', '--ms-fail', '--ms-ok', '--ms-prov-input', '--ms-prov-observed', '--ms-prov-estimated', '--ms-prov-computed', '--ms-prov-proven', '--ms-contested-color']) {
    t[key] = ensureContrast(t[key], surfaces, 4.5, dark);
  }
  const series = SERIES[kind];
  series.forEach((col, i) => { t[`--ms-series-${i + 1}`] = col; });
  // syntax colors are text: derive them from the series hues but at >= 4.5:1 (series are 3:1 marks)
  t['--ms-syn-type'] = ensureContrast(series[0], surfaces, 4.5, dark);
  t['--ms-syn-unit'] = ensureContrast(series[2], surfaces, 4.5, dark);
  // line numbers are referenced by users: theme color, lifted to 4.5:1 where it falls short
  t['--ms-line-number'] = ensureContrast(pick('editorLineNumber.foreground', dark ? '#6E7681' : '#6E7681'), surfaces, 4.5, dark);
  // the active line sits on a selection background: keep type names legible there too
  t['--ms-syn-type'] = ensureContrast(t['--ms-syn-type'], [...surfaces, pick('list.inactiveSelectionBackground', dark ? '#37373D' : '#E4E6F1')], 4.5, dark);
  const seq = dark ? [...SEQ_BLUE].reverse() : SEQ_BLUE;
  seq.forEach((col, i) => { t[`--ms-seq-${i}`] = col; });
  return t;
}

export const SERIES_COUNT = 8;
export const SEQ_STEPS = 9;
