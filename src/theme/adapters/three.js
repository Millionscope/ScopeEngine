/**
 * three.js theme adapter: THREE.Color values for scene background, node colors by provenance,
 * edge, selection and cone colors. Receives THREE from the editor; never imports it.
 * @module theme/adapters/three
 */
import { token, provColor, seriesColors, seqColors, parseColor } from '../tokens.js';

/**
 * @param {any} THREE
 */
export function threeTheme(THREE) {
  const c = (css, fallback = '#888888') => {
    const [r, g, b] = parseColor(css || fallback);
    // CSS colors are sRGB; three.js (r152+) works in linear space, so say which space these are in
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  };
  return {
    background: c(token('editor.background', '#1f1f1f')),
    fg: c(token('editor.foreground', '#cccccc')),
    muted: c(token('descriptionForeground', '#9d9d9d')),
    grid: c(token('editorGroup.border', '#2b2b2b')),
    edge: c(token('descriptionForeground', '#9d9d9d')),
    selection: c(token('focusBorder', '#0078d4')),
    cone: c(token('focusBorder', '#0078d4')),
    fail: c(token('--ms-fail', '#f85149')),
    prov: {
      input: c(provColor('input')),
      observed: c(provColor('observed')),
      estimated: c(provColor('estimated')),
      computed: c(provColor('computed')),
      proven: c(provColor('proven')),
      contested: c(token('--ms-contested-color')),
    },
    series: seriesColors().map((s) => c(s)),
    seq: seqColors().map((s) => c(s)),
    isDark: document.documentElement.dataset.theme !== 'light',
  };
}

/**
 * Apply the theme to a scene and a map of materials keyed by role.
 * @param {any} THREE @param {any} scene @param {Record<string, any>} materials
 */
export function applyToScene(THREE, scene, materials = {}) {
  const t = threeTheme(THREE);
  scene.background = t.background;
  if (scene.fog) scene.fog.color = t.background;
  if (materials.edge) materials.edge.color = t.edge;
  if (materials.grid) materials.grid.color = t.grid;
  if (materials.selection) materials.selection.color = t.selection;
  return t;
}
