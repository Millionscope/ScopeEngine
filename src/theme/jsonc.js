/**
 * JSONC -> JSON: strips // and /* *\/ comments (outside strings) and trailing commas, so the
 * VS Code theme files can be copied unmodified (light_modern.json has a `// modern ui` comment
 * and both files have trailing commas).
 * @module theme/jsonc
 */

/**
 * @param {string} text
 * @returns {string} strict JSON text
 */
export function stripJsonc(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const n = src.length;
  let out = '';
  let i = 0;

  /** Index of the next significant character at or after j (skips whitespace and comments). */
  const nextSignificant = (j) => {
    while (j < n) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { j++; continue; }
      if (c === '/' && src[j + 1] === '/') {
        j += 2;
        while (j < n && src[j] !== '\n' && src[j] !== '\r') j++;
        continue;
      }
      if (c === '/' && src[j + 1] === '*') {
        j += 2;
        while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
        j += 2;
        continue;
      }
      return j;
    }
    return n;
  };

  while (i < n) {
    const ch = src[i];
    if (ch === '"') {
      // copy the whole string literal, honoring escapes
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ',') {
      const j = nextSignificant(i + 1);
      if (src[j] === '}' || src[j] === ']') { i++; continue; } // trailing comma
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parse JSONC text.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
