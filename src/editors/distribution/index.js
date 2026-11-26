/**
 * Distributions: histogram (or CDF) of the focused metric's Monte Carlo samples with p10/p50/p90
 * markers, a shaded threshold region and P(metric < threshold); overlay mode compares the same
 * metric across up to four scenarios. Updates within a frame after a recompute.
 * @module editors/distribution
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { tableView, tableToggle } from '../shared/chart-table.js';
import { loadCss } from '../../core/lazy.js';
import { formatAs, unitValue, pct, compact } from '../../model/format.js';
import { defaultFmt } from '../../model/binding.js';
import { applyChartTheme, chartPalette, trackChart } from '../../theme/adapters/chartjs.js';
import { alpha } from '../../theme/tokens.js';

const BINS = 40;

export default class DistributionEditor extends BaseEditor {
  static id = 'distribution';
  static label = 'Distributions';
  static icon = 'graph';
  static group = 'Analysis';
  static needs = ['chartjs'];
  static usesScenario = true;

  async mount(ctx, state) {
    await loadCss(new URL('./distribution.css', import.meta.url));
    this.Chart = ctx.libs.chartjs.Chart;
    applyChartTheme(this.Chart);
    this.state = {
      mode: state.mode || 'pdf',
      overlay: state.overlay || [],
      threshold: state.threshold ?? 0,
      table: !!state.table,
      metric: state.metric || null,
    };
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services, scenarioId: () => this.scenarioId() });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-dist';
    this.head = document.createElement('div');
    this.head.className = 'ms-dist-head';
    this.body = document.createElement('div');
    this.body.className = 'ms-dist-body';
    this.markers = document.createElement('div');
    this.markers.className = 'ms-dist-markers';
    this.foot = document.createElement('div');
    this.foot.className = 'ms-ed-foot';
    this.root.append(this.head, this.body, this.markers, this.foot);
    ctx.el.appendChild(this.root);
    const sel = ctx.services.selection.get();
    this.metric = this.pickMetric(sel.primary);
    this.disposables.add({ dispose: () => this.destroyChart() });
    this.build();
  }

  /** Numeric node with samples (or deterministic numeric node) to show. @param {string|null} id */
  pickMetric(id) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    if (this.state.metric && this.ctx?.areaFlags().pinnedScopeId && g.node(this.state.metric)) return this.state.metric;
    if (id && g.node(id) && g.node(id).type.unit !== 'text') return id;
    return this.metric && g.node(this.metric) ? this.metric : 'sc_bakery.monthly_cash';
  }

  getState() { return { ...this.state, metric: this.metric }; }

  getHeaderTools() {
    const ctx = /** @type {any} */ (this.ctx);
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const seg = document.createElement('div');
    seg.className = 'ms-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Density or cumulative');
    for (const [label, val] of [['PDF', 'pdf'], ['CDF', 'cdf']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(this.state.mode === val));
      b.addEventListener('click', () => { this.state.mode = val; this.save(); this.build(); ctx.refreshHeader(); });
      seg.appendChild(b);
    }
    const ov = document.createElement('button');
    ov.className = 'ms-btn is-secondary is-small';
    ov.innerHTML = '<span class="codicon codicon-repo-forked" aria-hidden="true"></span>';
    ov.append(this.state.overlay.length ? `Overlay (${this.state.overlay.length})` : 'Overlay');
    ov.dataset.tooltip = 'Compare this metric across up to four scenarios';
    ov.addEventListener('click', () => {
      const list = ctx.services.scenarios.list();
      ctx.ui.showMenu([
        { header: 'Overlay scenarios (max 4)' },
        ...list.map((s) => ({
          label: s.name,
          checked: this.state.overlay.includes(s.id),
          disabled: !this.state.overlay.includes(s.id) && this.state.overlay.length >= 4,
          run: () => {
            this.state.overlay = this.state.overlay.includes(s.id) ? this.state.overlay.filter((x) => x !== s.id) : [...this.state.overlay, s.id];
            this.save();
            this.build();
            ctx.refreshHeader();
          },
        })),
        { separator: true },
        { label: 'Clear overlay', disabled: !this.state.overlay.length, run: () => { this.state.overlay = []; this.save(); this.build(); ctx.refreshHeader(); } },
      ], ov, { label: 'Overlay scenarios' });
    });
    const tl = document.createElement('span');
    tl.className = 'ms-small ms-muted';
    tl.textContent = 'threshold';
    const thr = document.createElement('input');
    thr.className = 'ms-num-input';
    thr.type = 'number';
    thr.step = 'any';
    thr.value = String(this.state.threshold);
    thr.style.width = '70px';
    thr.setAttribute('aria-label', 'Threshold');
    thr.addEventListener('change', () => { this.state.threshold = Number(thr.value) || 0; this.save(); this.build(); });
    const tt = tableToggle(this.state.table, (v) => { this.state.table = v; this.save(); this.build(); ctx.refreshHeader(); });
    wrap.append(seg, ov, tl, thr, tt);
    return [wrap];
  }

  /** Series (base or area scenario + overlays). */
  series() {
    const ctx = /** @type {any} */ (this.ctx);
    const main = this.scenarioId() || 'base';
    const ids = this.state.overlay.length ? this.state.overlay.filter((id) => ctx.services.scenarios.get(id)) : [main];
    return ids.map((sid) => {
      const sc = ctx.services.scenarios.get(sid);
      return { id: sid, name: sc?.name || 'base', color: sc ? sc.color : 0, view: ctx.engine.view(sid) };
    });
  }

  build() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.destroyChart();
    this.bv.releaseWithin(this.root);
    this.head.replaceChildren();
    this.body.replaceChildren();
    this.markers.replaceChildren();
    const id = this.metric;
    const n = g.node(id);
    if (!n) {
      this.body.appendChild(emptyState({ icon: 'graph', title: 'Select a metric', text: 'Select a numeric metric to see its distribution.' }));
      return;
    }
    const series = this.series();
    const primary = series[0];
    const st = primary.view.stats(id);
    // head: name + main stat
    const title = document.createElement('div');
    title.className = 'ms-dist-title';
    title.append(provMark(g.displayProv(id)));
    const name = document.createElement('span');
    name.className = 'ms-dist-name';
    name.textContent = n.label || g.path(id);
    name.title = g.path(id);
    title.appendChild(name);
    this.head.appendChild(title);
    if (!st || st.deterministic) {
      const p = document.createElement('div');
      p.className = 'ms-dist-point';
      p.append('Point value ', this.bv.create({ node: id }), ' (no uncertainty upstream)');
      this.body.appendChild(p);
      this.foot.textContent = `${g.path(id)} is deterministic: none of its inputs carries a distribution.`;
      return;
    }
    const probRow = document.createElement('div');
    probRow.className = 'ms-dist-prob';
    this.probEl = probRow;
    this.head.appendChild(probRow);
    this.renderProb();

    if (this.state.table) {
      this.body.appendChild(this.tableFor(series));
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'ms-chart-wrap';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${this.state.mode === 'pdf' ? 'Histogram' : 'Cumulative distribution'} of ${n.name}${series.length > 1 ? ` across ${series.length} scenarios` : ''}`);
      wrap.appendChild(canvas);
      this.body.appendChild(wrap);
      this.makeChart(canvas, series);
    }
    // markers legend (bound values)
    for (const s of series) {
      const row = document.createElement('div');
      row.className = 'ms-dist-marker-row';
      if (series.length > 1) {
        const key = document.createElement('span');
        key.className = 'ms-legend-key';
        key.style.background = `var(--ms-series-${(s.color % 8) + 1})`;
        const nm = document.createElement('span');
        nm.className = 'ms-dist-sname';
        nm.textContent = s.name;
        row.append(key, nm);
      }
      for (const q of ['p10', 'p50', 'p90']) {
        const lab = document.createElement('span');
        lab.className = 'ms-muted ms-small';
        lab.textContent = q;
        row.append(lab, this.bv.create({ node: id, stat: q, scenario: s.id === 'base' ? null : s.id, glyph: q === 'p50' }));
      }
      const mean = document.createElement('span');
      mean.className = 'ms-muted ms-small';
      mean.textContent = 'mean';
      row.append(mean, this.bv.create({ node: id, stat: 'mean', scenario: s.id === 'base' ? null : s.id, glyph: false }));
      this.markers.appendChild(row);
    }
    this.foot.textContent = `${ctx.engine.n.toLocaleString('en-US')} Monte Carlo samples · seed ${g.seed} · Latin hypercube + Gaussian copula for correlated inputs · ${n.type.unit}`;
  }

  renderProb() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const id = this.metric;
    const n = g.node(id);
    if (!this.probEl || !n) return;
    this.bv.releaseWithin(this.probEl);
    this.probEl.replaceChildren();
    const t = this.state.threshold;
    const label = document.createElement('span');
    label.className = 'ms-muted';
    label.textContent = `P(${n.name} < ${formatAs(t, defaultFmt(n.type.unit), n.type.unit)}) = `;
    this.probEl.appendChild(label);
    // bind to a statistic node when one exists for this exact question
    const statNode = id === 'sc_bakery.monthly_cash' && t === 0 ? 'sc_bakery.p_cash_negative' : id === 'sc_projection.min_cumulative' && t === 0 ? 'sc_projection.p_buffer_breach' : null;
    for (const s of this.series()) {
      if (statNode) this.probEl.appendChild(this.bv.create({ node: statNode, scenario: s.id === 'base' ? null : s.id }));
      else {
        const span = document.createElement('span');
        span.className = 'ms-bv';
        span.dataset.node = id;
        span.dataset.stat = 'p50';
        span.title = `computed from the ${ctx.engine.n.toLocaleString('en-US')} samples of ${g.path(id)}`;
        span.textContent = pct(s.view.prob(id, '<', t));
        span.addEventListener('click', () => this.select([id]));
        this.probEl.appendChild(span);
      }
      if (this.series().length > 1) {
        const nm = document.createElement('span');
        nm.className = 'ms-muted ms-small';
        nm.textContent = ` ${s.name}  `;
        this.probEl.appendChild(nm);
      }
    }
  }

  /** @param {Float64Array} samples @param {number} lo @param {number} hi */
  histogram(samples, lo, hi) {
    const counts = new Array(BINS).fill(0);
    const w = (hi - lo) / BINS || 1;
    for (const v of samples) {
      if (v < lo || v > hi) continue;
      counts[Math.min(BINS - 1, Math.floor((v - lo) / w))]++;
    }
    return counts.map((c) => c / samples.length);
  }

  /** Shared x-range across series (1st–99th percentile). */
  range(series) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      const a = s.view.sample(this.metric);
      if (!a) continue;
      const sorted = Float64Array.from(a).sort();
      lo = Math.min(lo, sorted[Math.floor(sorted.length * 0.005)]);
      hi = Math.max(hi, sorted[Math.floor(sorted.length * 0.995)]);
    }
    if (!(hi > lo)) { hi = lo + 1; }
    return [lo, hi];
  }

  datasets(series) {
    const p = chartPalette();
    const [lo, hi] = this.range(series);
    const w = (hi - lo) / BINS;
    const labels = Array.from({ length: BINS }, (_, i) => lo + w * (i + 0.5));
    const t = this.state.threshold;
    const overlay = series.length > 1;
    const sets = series.map((s) => {
      const a = /** @type {Float64Array} */ (s.view.sample(this.metric));
      const color = p.series[(s.color % 8)];
      if (this.state.mode === 'cdf') {
        const sorted = Float64Array.from(a).sort();
        const data = labels.map((x) => {
          let lo2 = 0;
          let hi2 = sorted.length;
          while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (sorted[mid] <= x) lo2 = mid + 1; else hi2 = mid; }
          return lo2 / sorted.length;
        });
        return { type: 'line', label: s.name, data, borderColor: color, backgroundColor: alpha(color, 0.1), borderWidth: 2, fill: !overlay, tension: 0.25, pointRadius: 0 };
      }
      const data = this.histogram(a, lo, hi);
      if (overlay) return { type: 'line', label: s.name, data, borderColor: color, backgroundColor: alpha(color, 0.08), borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0 };
      return {
        type: 'bar', label: s.name, data,
        backgroundColor: labels.map((x) => (x < t ? alpha(p.fail, 0.7) : alpha(color, 0.8))),
        borderWidth: 0, barPercentage: 1, categoryPercentage: 0.94, borderRadius: { topLeft: 2, topRight: 2 },
      };
    });
    return { labels, sets, lo, hi };
  }

  makeChart(canvas, series) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const n = g.node(this.metric);
    const unit = n.type.unit;
    const { labels, sets } = this.datasets(series);
    const p = chartPalette();
    const editor = this;
    const markerPlugin = {
      id: 'msMarkers',
      afterDatasetsDraw(chart) {
        const { ctx: c, chartArea: a, scales } = chart;
        const xs = scales.x;
        const lbls = chart.data.labels;
        const step = lbls.length > 1 ? lbls[1] - lbls[0] : 1;
        const toPx = (v) => {
          const i = (v - lbls[0]) / step;
          return xs.getPixelForValue(i);
        };
        c.save();
        // threshold region
        const tx = toPx(editor.state.threshold);
        if (tx > a.left && editor.state.mode === 'pdf' && series.length === 1) {
          c.fillStyle = alpha(p.fail, 0.08);
          c.fillRect(a.left, a.top, Math.min(tx, a.right) - a.left, a.bottom - a.top);
        }
        if (tx >= a.left && tx <= a.right) {
          c.strokeStyle = p.fail;
          c.setLineDash([3, 3]);
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(tx, a.top);
          c.lineTo(tx, a.bottom);
          c.stroke();
          c.setLineDash([]);
        }
        // p10 / p50 / p90 of the first series
        const st = series[0].view.stats(editor.metric);
        if (st) {
          for (const [q, v] of [['p10', st.p10], ['p50', st.p50], ['p90', st.p90]]) {
            const x = toPx(v);
            if (x < a.left || x > a.right) continue;
            c.strokeStyle = q === 'p50' ? p.fg : p.muted;
            c.lineWidth = q === 'p50' ? 1.5 : 1;
            c.beginPath();
            c.moveTo(x, a.top + 12);
            c.lineTo(x, a.bottom);
            c.stroke();
            c.fillStyle = p.muted;
            c.font = '10px ' + (editor.Chart.defaults.font.family || 'sans-serif');
            c.textAlign = 'center';
            c.fillText(q, x, a.top + 9);
          }
        }
        c.restore();
      },
    };
    const xTick = (v) => unitValue(labels[0] + (labels.length > 1 ? (labels[1] - labels[0]) : 1) * v, unit, { compact: true, bare: true });
    this.chart = new this.Chart(canvas, {
      type: this.state.mode === 'cdf' || series.length > 1 ? 'line' : 'bar',
      data: { labels: labels.map((_, i) => i), datasets: sets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: series.length > 1, position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: (items) => `${n.name} ≈ ${unitValue(labels[items[0].dataIndex], unit, { compact: true })}`,
              label: (item) => `${item.dataset.label}: ${this.state.mode === 'cdf' ? pct(item.raw) : `${pct(item.raw)} of samples`}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 7, callback: (v) => xTick(Number(v)) } },
          y: { beginAtZero: true, grid: { color: p.grid }, ticks: { maxTicksLimit: 5, callback: (v) => (this.state.mode === 'cdf' ? pct(Number(v)) : `${compact(Number(v) * 100)}%`) }, title: { display: true, text: this.state.mode === 'cdf' ? 'P(X ≤ x)' : 'share of samples', color: p.muted } },
        },
      },
      plugins: [markerPlugin],
    });
    trackChart(this.chart);
  }

  /** @param {any[]} series */
  tableFor(series) {
    const ctx = /** @type {any} */ (this.ctx);
    const n = ctx.engine.graph.node(this.metric);
    const unit = n.type.unit;
    const { labels, sets, lo, hi } = this.datasets(series);
    const w = (hi - lo) / BINS;
    const rows = labels.map((x, i) => [
      `${unitValue(x - w / 2, unit, { compact: true, bare: true })} to ${unitValue(x + w / 2, unit, { compact: true, bare: true })}`,
      ...sets.map((s) => pct(s.data[i])),
    ]);
    return tableView({
      caption: `${this.state.mode === 'cdf' ? 'Cumulative distribution' : 'Histogram'} of ${n.name}`,
      columns: [{ label: `${n.name} (${unit})` }, ...series.map((s) => ({ label: s.name, align: 'right' }))],
      rows,
    });
  }

  updateChart() {
    if (!this.chart || this.state.table) return this.build();
    const series = this.series();
    if (!series[0].view.sample(this.metric)) return this.build();
    const { labels, sets } = this.datasets(series);
    this.chart.data.labels = labels.map((_, i) => i);
    // keep x tick formatting in sync with the new bins
    this.chart.options.scales.x.ticks.callback = (v) => unitValue(labels[0] + (labels[1] - labels[0]) * Number(v), this.ctx.engine.graph.node(this.metric).type.unit, { compact: true, bare: true });
    sets.forEach((s, i) => {
      if (this.chart.data.datasets[i]) Object.assign(this.chart.data.datasets[i], { data: s.data, backgroundColor: s.backgroundColor });
    });
    this.chart.update('none');
  }

  destroyChart() {
    this.chart?.destroy();
    this.chart = null;
  }

  onSelection(sel) {
    const next = this.pickMetric(sel.primary);
    if (next !== this.metric) {
      this.metric = next;
      this.save();
      this.build();
    }
  }

  onRecompute(changed, payload) {
    if (payload?.full || payload?.structural) { this.build(); return; }
    if (payload?.scenarioChanged || changed.includes(this.metric) || this.state.overlay.length) {
      this.bv.updateAll();
      this.dirty = true;
      this.invalidate();
    } else this.bv.update(changed);
  }

  render() {
    if (!this.dirty) return;
    this.dirty = false;
    this.renderProb();
    this.updateChart();
  }

  onScenario() { this.build(); }
  onFlags() { this.build(); }
  onTheme() { applyChartTheme(this.Chart); this.build(); }
  onHover(id) { this.bv.hover(id); }

  dispose() {
    this.destroyChart();
    this.root?.remove();
    super.dispose();
  }
}
