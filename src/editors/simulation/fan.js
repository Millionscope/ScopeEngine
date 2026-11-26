/**
 * Ensemble fan chart for the Simulation editor: the p10–p90 band and p50 line of a chosen world
 * metric over steps across runs, the selected run as a dashed line and the inspected step as a
 * marker. Chart.js is passed in (never imported); colors come from the Chart.js theme adapter.
 * Series math is pure (no DOM) so it can move to a worker.
 * @module editors/simulation/fan
 */
import { chartPalette, trackChart } from '../../theme/adapters/chartjs.js';
import { alpha } from '../../theme/tokens.js';
import { usd, usdCompact, int, compact } from '../../model/format.js';

/** World metrics the fan chart can show. */
export const METRICS = [
  { id: 'cash', label: 'Cash balance', axis: 'cash balance (USD)', fmt: usd, tick: usdCompact, zero: true },
  { id: 'flow', label: 'Monthly cash flow', axis: 'cash flow (USD/month)', fmt: usd, tick: usdCompact, zero: true },
  { id: 'customersB', label: 'Customers at Location B', axis: 'customers (agent field)', fmt: int, tick: compact, zero: false },
];

/** @param {string} id */
export function metricById(id) {
  return METRICS.find((m) => m.id === id) || METRICS[0];
}

/**
 * Per-run values of a metric over steps 0..steps.
 * @param {any} result SimResult
 * @param {string} metric
 * @param {number} run
 * @param {(run: number) => (Int32Array|null)} [customersB] counts per step (agent field), if computed
 * @returns {number[]|null}
 */
export function runSeries(result, metric, run, customersB) {
  const cash = result.cash[run];
  if (!cash) return null;
  if (metric === 'flow') {
    const out = new Array(cash.length);
    out[0] = NaN;
    for (let t = 1; t < cash.length; t++) out[t] = cash[t] - cash[t - 1];
    return out;
  }
  if (metric === 'customersB') {
    const c = customersB ? customersB(run) : null;
    return c ? Array.from(c) : null;
  }
  return Array.from(cash);
}

/**
 * p10/p50/p90 per step across the runs that have values (same quantile rule as the service).
 * @param {Array<number[]>} series @param {number} steps
 */
export function quantiles(series, steps) {
  const p10 = [];
  const p50 = [];
  const p90 = [];
  const n = series.length;
  const col = new Float64Array(n);
  for (let t = 0; t <= steps; t++) {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const v = series[i][t];
      if (Number.isFinite(v)) col[m++] = v;
    }
    if (!m) { p10.push(NaN); p50.push(NaN); p90.push(NaN); continue; }
    const s = col.subarray(0, m).slice().sort();
    const q = (p) => s[Math.min(m - 1, Math.max(0, Math.round(p * (m - 1))))];
    p10.push(q(0.1));
    p50.push(q(0.5));
    p90.push(q(0.9));
  }
  return { p10, p50, p90 };
}

/**
 * Chart/table data for a metric.
 * @param {any} result @param {string} metric @param {number} run
 * @param {(run: number) => (Int32Array|null)} [customersB]
 */
export function fanData(result, metric, run, customersB) {
  const steps = result.steps;
  const labels = Array.from({ length: steps + 1 }, (_, i) => i);
  let band;
  let used = result.cash.length;
  if (metric === 'cash' && result.fan && result.fan.p50.length) {
    band = { p10: result.fan.p10.slice(), p50: result.fan.p50.slice(), p90: result.fan.p90.slice() };
  } else {
    const all = [];
    for (let i = 0; i < result.cash.length; i++) {
      const s = runSeries(result, metric, i, customersB);
      if (s) all.push(s);
    }
    used = all.length;
    band = quantiles(all, steps);
  }
  const own = runSeries(result, metric, run, customersB) || [];
  return { labels, ...band, run: own, used };
}

/**
 * @param {any} Chart
 * @param {HTMLCanvasElement} canvas
 * @param {{ step: () => number, metric: () => typeof METRICS[number] }} hooks
 */
export function createFanChart(Chart, canvas, hooks) {
  const p = chartPalette();
  const base = p.series[0] || p.accent;
  const stepMarker = {
    id: 'msSimStep',
    afterDatasetsDraw(chart) {
      const step = hooks.step();
      const xs = chart.scales.x;
      const a = chart.chartArea;
      if (!xs || !a || !Number.isFinite(step) || !chart.data.labels.length) return;
      const x = xs.getPixelForValue(step);
      if (x < a.left - 1 || x > a.right + 1) return;
      const c = chart.ctx;
      c.save();
      c.strokeStyle = p.fg;
      c.globalAlpha = 0.55;
      c.lineWidth = 1;
      c.setLineDash([2, 3]);
      c.beginPath();
      c.moveTo(x, a.top);
      c.lineTo(x, a.bottom);
      c.stroke();
      c.restore();
    },
  };
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'p90', data: [], borderColor: alpha(base, 0.55), borderWidth: 1, pointRadius: 0, fill: false, order: 3, spanGaps: false },
        { label: 'p10–p90 of runs', data: [], borderColor: alpha(base, 0.55), borderWidth: 1, backgroundColor: alpha(base, 0.2), pointRadius: 0, fill: '-1', order: 3 },
        { label: 'median (p50)', data: [], borderColor: base, borderWidth: 2, pointRadius: 0, fill: false, order: 2 },
        { label: 'selected run', data: [], borderColor: p.fg, borderWidth: 1.25, borderDash: [4, 3], pointRadius: 0, fill: false, order: 1 },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: { filter: (item) => item.text !== 'p90' },
        },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? `Month ${items[0].label}` : ''),
            label: (item) => {
              const name = item.datasetIndex === 1 ? 'p10' : item.dataset.label;
              const v = Number(item.raw);
              return `${name}: ${Number.isFinite(v) ? hooks.metric().fmt(v) : '—'}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 13, autoSkip: true, maxRotation: 0 },
          title: { display: true, text: 'month', color: p.muted },
        },
        y: {
          grid: { color: (c) => (hooks.metric().zero && c.tick && c.tick.value === 0 ? alpha(p.fail, 0.75) : p.grid) },
          ticks: { maxTicksLimit: 6, callback: (v) => hooks.metric().tick(Number(v)) },
          title: { display: true, text: hooks.metric().axis, color: p.muted },
        },
      },
    },
    plugins: [stepMarker],
  });
  return trackChart(chart);
}

/**
 * Push new data into an existing chart (progressive updates, metric, run or step changes).
 * @param {any} chart @param {ReturnType<typeof fanData>} d @param {string} runLabel @param {typeof METRICS[number]} metric
 */
export function updateFanChart(chart, d, runLabel, metric) {
  chart.data.labels = d.labels;
  const [p90, p10, p50, run] = chart.data.datasets;
  p90.data = d.p90;
  p10.data = d.p10;
  p50.data = d.p50;
  run.data = d.run;
  run.label = runLabel;
  chart.options.scales.y.title.text = metric.axis;
  chart.update('none');
}

/**
 * Table alternative for the fan chart.
 * @param {ReturnType<typeof fanData>} d @param {string} runLabel @param {typeof METRICS[number]} metric
 */
export function fanTableSpec(d, runLabel, metric) {
  const f = (v) => (v === undefined || !Number.isFinite(v) ? '—' : metric.fmt(v));
  return {
    caption: `${metric.label} by month across ${d.used} runs: p10, median and p90, and ${runLabel}`,
    columns: [
      { label: 'Month' },
      { label: 'p10', align: /** @type {'right'} */ ('right') },
      { label: 'Median (p50)', align: /** @type {'right'} */ ('right') },
      { label: 'p90', align: /** @type {'right'} */ ('right') },
      { label: runLabel, align: /** @type {'right'} */ ('right') },
    ],
    rows: d.labels.map((m, i) => [String(m), f(d.p10[i]), f(d.p50[i]), f(d.p90[i]), f(d.run[i])]),
  };
}

/**
 * One-sentence summary for the chart's accessible name.
 * @param {ReturnType<typeof fanData>} d @param {number} runs @param {typeof METRICS[number]} metric
 */
export function fanSummary(d, runs, metric) {
  const last = d.p50.length - 1;
  if (last < 0 || !d.used) return `Ensemble fan chart of ${metric.label.toLowerCase()}: no runs yet.`;
  return `Ensemble fan chart of ${metric.label.toLowerCase()} over ${last} months across ${d.used}${d.used < runs ? ` of ${runs}` : ''} runs. ` +
    `At month ${last} the median is ${metric.fmt(d.p50[last])}, p10 ${metric.fmt(d.p10[last])}, p90 ${metric.fmt(d.p90[last])}.`;
}
