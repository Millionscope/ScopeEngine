/**
 * Candlestick: a live, randomly generated OHLC market on the hologram stage.
 *  - Highcharts Stock draws the candles; the forming candle ticks every TICK_MS and a new one opens
 *    every CANDLE_MS (each is one simulated minute), the oldest scrolls off past MAX candles;
 *  - glow: an SVG bloom filter (blur + merge, GPU-composited) on the series group, its radius
 *    breathing with time like the WebGL scopes' bloom; dark navy stage from scope.css in both themes.
 * @module editors/candlestick
 */
import { BaseEditor } from '../base-editor.js';
import { loadCss } from '../../core/lazy.js';

const TICK_MS = 40;
const CANDLE_MS = 600;
const MAX = 90;
const MINUTE = 60_000;
const UP = '#3fffb0';
const DOWN = '#ff4f8b';
const CYAN = '#3fd8ff';
let uid = 0;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Random walk step with occasional volatility bursts. @param {number} price */
const step = (price) => price * (1 + (Math.random() - 0.5) * 0.004 * (Math.random() < 0.05 ? 4 : 1));

/** @param {number} x @param {number} open → [x, o, h, l, c] after a candle's worth of ticks */
function candle(x, open) {
  let c = open, h = open, l = open;
  for (let i = 0; i < CANDLE_MS / TICK_MS; i++) { c = step(c); h = Math.max(h, c); l = Math.min(l, c); }
  return [x, open, h, l, c];
}

export default class CandlestickEditor extends BaseEditor {
  static id = 'candlestick';
  static label = 'Candlestick';
  static icon = 'graph-line';
  static group = 'Scope';
  static needs = ['highcharts'];

  async mount(ctx, state) {
    await Promise.all([loadCss(new URL('../scope/scope.css', import.meta.url)), loadCss(new URL('./candlestick.css', import.meta.url))]);
    const Highcharts = ctx.libs.highcharts;
    this.running = state.running !== false;

    const root = (this.root = el('div', 'ms-ed ms-scope ms-cs'));
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'img');
    this.host.setAttribute('aria-label', 'Live candlestick chart of a simulated market. S pauses or resumes the feed.');
    const plot = el('div', 'ms-cs-plot');
    this.host.append(plot);
    root.append(this.host);
    ctx.el.append(root);

    // seed history
    const data = [];
    let x = Date.UTC(2026, 0, 1, 9, 30), price = 100;
    for (let i = 0; i < MAX; i++, x += MINUTE) { const k = candle(x, price); data.push(k); price = k[4]; }
    this.count = MAX;

    const axis = { gridLineColor: 'rgba(63,216,255,.08)', lineColor: 'rgba(63,216,255,.25)', tickColor: 'rgba(63,216,255,.25)', labels: { style: { color: '#7aa6bb' } } };
    this.chart = Highcharts.stockChart(plot, {
      chart: { backgroundColor: 'transparent', animation: { duration: 150 }, style: { fontFamily: 'var(--ms-font-mono)' }, spacing: [12, 8, 8, 8] },
      credits: { enabled: false },
      navigator: { enabled: false },
      scrollbar: { enabled: false },
      rangeSelector: { enabled: false },
      accessibility: { enabled: false },
      tooltip: { backgroundColor: 'rgba(4,16,30,.85)', borderColor: CYAN, style: { color: '#d8f3ff' }, split: false, valueDecimals: 2 },
      xAxis: { ...axis, overscroll: 6 * MINUTE, crosshair: { color: 'rgba(63,216,255,.35)' } },
      yAxis: { ...axis, opposite: true, crosshair: { color: 'rgba(63,216,255,.35)', label: { enabled: true, backgroundColor: CYAN, style: { color: '#02060d' } } } },
      plotOptions: { candlestick: { color: DOWN, lineColor: DOWN, upColor: UP, upLineColor: UP, pointPadding: 0.18 } },
      series: [{
        type: 'candlestick', name: 'SCOPE', data,
      }],
    });
    this.series = this.chart.series[0];
    this.addGlow();
    this.buildOverlay();

    this.tickT = 0;
    this.candleT = 0;
    this.time = 0;
    this.disposables.add(ctx.scheduler.animate(this, (info) => this.tick(info)));
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
  }

  /** SVG bloom: a wide halo and a tight core blur merged under the sharp candles (keeps up/down colours). */
  addGlow() {
    const NS = 'http://www.w3.org/2000/svg';
    const id = `ms-cs-glow-${++uid}`;
    const filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', id);
    for (const [k, v] of Object.entries({ x: '-20%', y: '-20%', width: '140%', height: '140%' })) filter.setAttribute(k, v);
    const blur = (sd, result) => {
      const b = document.createElementNS(NS, 'feGaussianBlur');
      b.setAttribute('in', 'SourceGraphic');
      b.setAttribute('stdDeviation', sd);
      b.setAttribute('result', result);
      return b;
    };
    this.blur = blur('7', 'wide');
    const merge = document.createElementNS(NS, 'feMerge');
    for (const src of ['wide', 'wide', 'core', 'core', 'SourceGraphic']) {
      const n = document.createElementNS(NS, 'feMergeNode');
      n.setAttribute('in', src);
      merge.append(n);
    }
    filter.append(this.blur, blur('2', 'core'), merge);
    this.chart.renderer.defs.element.append(filter);
    this.chart.seriesGroup.attr({ filter: `url(#${id})` });
  }

  buildOverlay() {
    const left = el('div', 'ms-sc-col is-left');
    const panel = el('section', 'ms-sc-panel ms-sc-detail ms-cs-ticker');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'SCOPE · 1m · simulated'));
    this.priceEl = el('h3', '');
    this.metaEl = el('div', 'ms-sc-meta');
    panel.append(head, this.priceEl, this.metaEl);
    left.append(panel);
    this.host.append(left);
    this.updateTicker();
  }

  /** HUD numbers + the glowing last-price line. */
  updateTicker() {
    const pts = this.series.points;
    const last = pts[pts.length - 1];
    const y = this.chart.yAxis[0];
    y.removePlotLine('last');
    y.addPlotLine({
      id: 'last', value: last.close, color: CYAN, width: 1, dashStyle: 'ShortDash', zIndex: 5, className: 'ms-cs-last',
      label: { text: last.close.toFixed(2), align: 'right', x: -4, y: -4, style: { color: CYAN, fontWeight: '600' } },
    });
    const chg = ((last.close - pts[0].open) / pts[0].open) * 100;
    this.priceEl.textContent = last.close.toFixed(2);
    this.priceEl.style.setProperty('--c', last.close >= last.open ? UP : DOWN);
    this.metaEl.replaceChildren(
      el('span', '', `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%`),
      el('span', '', `H ${last.high.toFixed(2)} · L ${last.low.toFixed(2)}`),
      el('span', '', this.running ? 'LIVE' : 'PAUSED'),
    );
  }

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = Math.min(info.dt, 100);
    this.time += dt;
    // breathing bloom, like the scopes' pulsing glow
    this.blur.setAttribute('stdDeviation', (7 + Math.sin(this.time / 600) * (info.reducedMotion ? 0.5 : 2.5)).toFixed(2));
    if (!this.running) return;
    const k = info.reducedMotion ? 0.5 : 1;
    this.tickT += dt * k;
    this.candleT += dt * k;
    if (this.tickT < TICK_MS) return;
    this.tickT = 0;
    const pts = this.series.points;
    const p = pts[pts.length - 1];
    if (this.candleT >= CANDLE_MS) {
      this.candleT = 0;
      this.series.addPoint([p.x + MINUTE, p.close, p.close, p.close, p.close], true, true);
      this.loopCheck(this.count, ++this.count, 60); // an hour of candles = one loop for the Home cycle
    } else {
      const c = step(p.close);
      p.update([p.x, p.open, Math.max(p.high, c), Math.min(p.low, c), c], true, false);
    }
    this.updateTicker();
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (e.target !== this.host || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    this.running = !this.running;
    this.updateTicker();
    this.save();
  }

  resize() {
    this.chart?.reflow();
  }

  getState() {
    return { running: this.running };
  }

  dispose() {
    this.chart?.destroy();
    this.chart = null;
    this.root?.remove();
    super.dispose();
  }
}
