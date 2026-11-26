/**
 * KaTeX theme adapter. KaTeX inherits `color`; provenance macros color variables:
 *   \inputv{} (\input is a TeX primitive name, so the input macro is \inputv; \input is also
 *   defined as an alias where the renderer allows it), \observed{}, \estimated{}, \computed{},
 *   \proven{}. Colors come from the current CSS variables (re-render on theme:changed).
 * @module theme/adapters/katex
 */
import { provColor, parseColor } from '../tokens.js';

/** KaTeX `macros` option for provenance coloring. */
export function katexMacros() {
  const m = {};
  // KaTeX reads '#' inside a macro body as a parameter marker, so colors go in as bare hex
  const hex = (k) => parseColor(provColor(k)).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  for (const k of ['observed', 'estimated', 'computed', 'proven']) m[`\\${k}`] = `\\textcolor{${hex(k)}}{#1}`;
  m['\\inputv'] = `\\textcolor{${hex('input')}}{#1}`;
  m['\\input'] = m['\\inputv'];
  return m;
}

/**
 * Render with the project's options.
 * @param {any} katex @param {string} tex @param {HTMLElement} el @param {{display?: boolean, trustHtmlData?: boolean}} [opts]
 */
export function renderTex(katex, tex, el, opts = {}) {
  katex.render(tex, el, {
    displayMode: opts.display !== false,
    throwOnError: false,
    output: 'htmlAndMathml',
    macros: katexMacros(),
    // only \htmlData is trusted (used to make variables clickable)
    trust: opts.trustHtmlData ? (ctx) => ctx.command === '\\htmlData' : false,
    strict: 'ignore',
  });
}
