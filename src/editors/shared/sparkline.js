/**
 * Tiny inline SVG for distributions in tables: a smoothed histogram of the samples with a p50
 * tick. Color comes from a CSS variable (provenance), never a literal.
 * @module editors/shared/sparkline
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {Float64Array|number[]|null} samples
 * @param {{width?: number, height?: number, color?: string, p50?: number, bins?: number, label?: string}} [opts]
 * @returns {SVGSVGElement}
 */
export function sparkline(samples, opts = {}) {
  const w = opts.width || 56;
  const h = opts.height || 14;
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(NS, 'svg'));
  svg.setAttribute('class', 'ms-spark');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.label || 'distribution');
  if (opts.color) svg.style.setProperty('--ms-spark-color', opts.color);
  if (!samples || !samples.length) return svg;
  const bins = opts.bins || 20;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of samples) { if (v < lo) lo = v; if (v > hi) hi = v; }
  // trim 1% tails for a readable shape
  const sorted = Float64Array.from(samples).sort();
  lo = sorted[Math.floor(sorted.length * 0.01)];
  hi = sorted[Math.floor(sorted.length * 0.99)];
  if (!(hi > lo)) { hi = lo + 1; }
  const counts = new Array(bins).fill(0);
  for (const v of samples) {
    if (v < lo || v > hi) continue;
    const b = Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins));
    counts[b]++;
  }
  // light smoothing
  const sm = counts.map((c, i) => (counts[i - 1] || 0) * 0.25 + c * 0.5 + (counts[i + 1] || 0) * 0.25);
  const max = Math.max(...sm) || 1;
  const pts = sm.map((c, i) => [(i / (bins - 1)) * w, h - 1 - (c / max) * (h - 2)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = `${line}L${w},${h}L0,${h}Z`;
  const a = document.createElementNS(NS, 'path');
  a.setAttribute('class', 'area');
  a.setAttribute('d', area);
  const l = document.createElementNS(NS, 'path');
  l.setAttribute('class', 'line');
  l.setAttribute('d', line);
  svg.append(a, l);
  const p50 = opts.p50 ?? sorted[Math.floor(sorted.length / 2)];
  if (p50 >= lo && p50 <= hi) {
    const x = ((p50 - lo) / (hi - lo)) * w;
    const m = document.createElementNS(NS, 'line');
    m.setAttribute('class', 'mark');
    m.setAttribute('x1', x.toFixed(1));
    m.setAttribute('x2', x.toFixed(1));
    m.setAttribute('y1', '1');
    m.setAttribute('y2', String(h));
    svg.appendChild(m);
  }
  return svg;
}
