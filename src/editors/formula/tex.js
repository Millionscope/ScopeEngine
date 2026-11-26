/**
 * KaTeX rendering for the Formula editor with provenance-colored variables.
 *
 * Local workaround: theme/adapters/katex.js emits macros like \textcolor{#4DAAFC}{#1}; inside a
 * macro body KaTeX reads "#4" as a parameter reference and fails. KaTeX also accepts a bare
 * 6-digit hex color, so the macros here use that form. (Suggested shared fix: strip the "#" in
 * katexMacros().)
 * @module editors/formula/tex
 */
import { provColor, parseColor } from '../../theme/tokens.js';

/** CSS color -> 6-digit hex without "#" (KaTeX-safe inside macro bodies). @param {string} css */
function hex6(css) {
  const [r, g, b] = parseColor(css);
  return [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Provenance macros: \inputv (and the \input alias), \observed, \estimated, \computed, \proven. */
export function provenanceMacros() {
  /** @type {Record<string, string>} */
  const m = {};
  for (const k of ['observed', 'estimated', 'computed', 'proven']) m[`\\${k}`] = `\\textcolor{${hex6(provColor(k))}}{#1}`;
  m['\\inputv'] = `\\textcolor{${hex6(provColor('input'))}}{#1}`;
  m['\\input'] = m['\\inputv'];
  return m;
}

/**
 * Render TeX into an element. Only \htmlData is trusted (clickable variables).
 * @param {any} katex @param {string} tex @param {HTMLElement} el
 * @param {{display?: boolean, trustHtmlData?: boolean, label?: string}} [opts]
 */
export function renderMath(katex, tex, el, opts = {}) {
  katex.render(tex, el, {
    displayMode: opts.display !== false,
    throwOnError: false,
    output: 'htmlAndMathml',
    macros: provenanceMacros(),
    trust: opts.trustHtmlData ? (ctx) => ctx.command === '\\htmlData' : false,
    strict: 'ignore',
  });
  if (opts.label) el.setAttribute('aria-label', opts.label);
  el.dataset.tex = tex;
}

/** Escape text for \text{…}. @param {string} s */
export function escTex(s) {
  return String(s).replace(/\\/g, '\\textbackslash{}').replace(/([_#%&{}$])/g, '\\$1');
}
