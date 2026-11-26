/**
 * d3 theme adapter: a palette object for SVG editors. SVG editors should prefer
 * fill="var(--…)" so most theme switches are free; this covers what must be computed
 * (interpolators, canvas fallbacks). Receives d3 from the editor; never imports it.
 * @module theme/adapters/d3
 */
import { token, seriesColors, seqColors, provColor, FONT_UI, FONT_MONO } from '../tokens.js';

/**
 * @param {any} [d3] optional: enables a sequential interpolator over the --ms-seq-* ramp
 */
export function d3Palette(d3) {
  const seq = seqColors();
  return {
    fg: token('editor.foreground', '#cccccc'),
    muted: token('descriptionForeground', '#9d9d9d'),
    grid: token('editorGroup.border', '#2b2b2b'),
    surface: token('editor.background', '#1f1f1f'),
    panel: token('sideBar.background', '#181818'),
    widget: token('editorWidget.background', '#202020'),
    border: token('widget.border', '#313131'),
    accent: token('focusBorder', '#0078d4'),
    link: token('textLink.foreground', '#4daafc'),
    selection: token('list.activeSelectionBackground', '#04395e'),
    cone: token('--ms-cone', 'rgba(0,120,212,.35)'),
    coneStrong: token('--ms-cone-strong', 'rgba(0,120,212,.7)'),
    upstream: token('--ms-upstream', 'rgba(226,192,141,.3)'),
    fail: token('--ms-fail', '#f85149'),
    ok: token('--ms-ok', '#2ea043'),
    prov: {
      input: provColor('input'),
      observed: provColor('observed'),
      estimated: provColor('estimated'),
      computed: provColor('computed'),
      proven: provColor('proven'),
      contested: token('--ms-contested-color'),
      failed: token('--ms-fail'),
    },
    series: seriesColors(),
    seq,
    /** sequential interpolator t in [0,1] -> color (piecewise over the 9-step ramp) */
    seqInterp: d3 ? d3.interpolateRgbBasis(seq) : (t) => seq[Math.max(0, Math.min(seq.length - 1, Math.round(t * (seq.length - 1))))],
    fontUi: FONT_UI,
    fontMono: FONT_MONO,
  };
}
