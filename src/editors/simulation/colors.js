/**
 * Theme colors for three.js in the renderer's linear working space.
 *
 * The shared adapter builds colors with `new THREE.Color(r, g, b)`, which three.js r152+ reads
 * as linear values, so with the default sRGB output every theme color renders lighter than its
 * CSS value (a #1f1f1f background shows as #626262). Convert once here, unless the adapter (or a
 * disabled ColorManagement) already yields the exact CSS color.
 * @module editors/simulation/colors
 */
import { threeTheme } from '../../theme/adapters/three.js';
import { token, parseColor } from '../../theme/tokens.js';

/** @param {any} THREE */
export function themeColors(THREE) {
  const t = threeTheme(THREE);
  const [r, g, b] = parseColor(token('editor.background', '#1f1f1f'));
  if (t.background.getHex() === ((r << 16) | (g << 8) | b)) return t;
  const fix = (c) => { if (c && c.isColor) c.convertSRGBToLinear(); };
  for (const v of Object.values(t)) {
    if (v && v.isColor) fix(v);
    else if (Array.isArray(v)) v.forEach(fix);
    else if (v && typeof v === 'object') Object.values(v).forEach(fix);
  }
  return t;
}
