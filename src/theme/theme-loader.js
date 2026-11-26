/**
 * Fetch a VS Code theme file, parse it as JSONC and merge fallbacks for missing keys.
 * Theme keys always win over fallbacks.
 * @module theme/theme-loader
 */
import { parseJsonc } from './jsonc.js';
import { fallbacksFor } from '../../themes/fallbacks.js';
import { buildSemanticTokens } from '../../themes/millionscope.tokens.js';

/** @typedef {'dark'|'light'} ThemeKind */

/**
 * @typedef {Object} LoadedTheme
 * @property {ThemeKind} kind
 * @property {string} name                 "Dark Modern"
 * @property {string|undefined} include   base theme the file extends (not shipped)
 * @property {Record<string,string>} colors   merged (fallbacks + theme)
 * @property {string[]} themeKeys          keys present in the theme file itself
 * @property {string[]} fallbackKeys       keys supplied by themes/fallbacks.js
 * @property {Record<string,string>} semantic  --ms-* tokens
 */

export const THEME_FILES = {
  dark: 'dark_modern.json',
  light: 'light_modern.json',
};

/**
 * @param {ThemeKind} kind
 * @returns {Promise<LoadedTheme>}
 */
export async function loadTheme(kind) {
  const url = new URL(`../../themes/${THEME_FILES[kind]}`, import.meta.url);
  // no-cache = revalidate: editing a theme file shows up on the next reload.
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`theme ${THEME_FILES[kind]}: HTTP ${res.status}`);
  const json = parseJsonc(await res.text());
  const own = json.colors || {};
  const fb = fallbacksFor(kind);
  const colors = { ...fb, ...own };
  return {
    kind,
    name: json.name || THEME_FILES[kind],
    include: json.include,
    colors,
    themeKeys: Object.keys(own),
    fallbackKeys: Object.keys(fb).filter((k) => !(k in own)),
    semantic: buildSemanticTokens(kind, colors),
  };
}
