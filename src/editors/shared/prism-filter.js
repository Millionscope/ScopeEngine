/**
 * Prism shader for Highcharts scopes, as an SVG filter graph (GPU-composited): the R and B channels
 * are pulled apart horizontally (dispersion, like light through a prism) and screen-blended back
 * over G, under a soft halo whose hue sweeps through the spectrum.
 * @module editors/shared/prism-filter
 */
const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

const fe = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const channel = (rgb, result) => fe('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', result,
  values: `${rgb[0]} 0 0 0 0  0 ${rgb[1]} 0 0 0  0 0 ${rgb[2]} 0 0  0 0 0 1 0` });

/**
 * Put the prism filter on the chart's series group.
 * @param {any} chart Highcharts chart
 * @returns {(time: number, reducedMotion: boolean) => void} per-frame animator: dispersion breathes,
 *   halo hue sweeps the spectrum (gentler with reduced motion)
 */
export function addPrism(chart) {
  const id = `ms-prism-${++uid}`;
  const filter = fe('filter', { id, x: '-10%', y: '-10%', width: '120%', height: '120%', 'color-interpolation-filters': 'sRGB' });
  const hue = fe('feColorMatrix', { in: 'blur', type: 'hueRotate', values: '0', result: 'hue' });
  const dispR = fe('feOffset', { in: 'r', dx: '-1.2', result: 'r2' });
  const dispB = fe('feOffset', { in: 'b', dx: '1.2', result: 'b2' });
  const merge = fe('feMerge', {});
  merge.append(fe('feMergeNode', { in: 'halo' }), fe('feMergeNode', { in: 'prism' }));
  filter.append(
    fe('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '3.5', result: 'blur' }),
    hue,
    fe('feColorMatrix', { in: 'hue', type: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.55 0', result: 'halo' }),
    channel([1, 0, 0], 'r'), channel([0, 1, 0], 'g'), channel([0, 0, 1], 'b'),
    dispR, dispB,
    fe('feBlend', { in: 'r2', in2: 'g', mode: 'screen', result: 'rg' }),
    fe('feBlend', { in: 'rg', in2: 'b2', mode: 'screen', result: 'prism' }),
    merge,
  );
  chart.renderer.defs.element.append(filter);
  chart.seriesGroup.attr({ filter: `url(#${id})` });
  return (time, reducedMotion) => {
    const m = reducedMotion ? 0.3 : 1;
    const d = (1.2 + Math.sin(time / 700) * 0.6 * m).toFixed(2);
    dispR.setAttribute('dx', `-${d}`);
    dispB.setAttribute('dx', d);
    hue.setAttribute('values', (Math.sin(time / 1800) * 45 * m).toFixed(1));
  };
}
