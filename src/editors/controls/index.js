/**
 * Controls: the assumption board. By default the five inputs/estimates with the highest
 * sensitivity for the focused output (progressive disclosure), with "show all". Each row: name,
 * provenance, slider over a sensible range, number field with unit, and for distributions an
 * inline distribution editor. Slider drags preview at one recompute per frame (no versions) and
 * commit one delta on release. The top shows the output's live value, interval and P(threshold)
 * with a tiny Chart.js histogram.
 * @module editors/controls
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { DistEditor } from '../shared/dist-editor.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { describe, makeDist, shiftDist } from '../../model/distributions.js';
import { unitValue, pct } from '../../model/format.js';
import { analysisRange } from '../../model/sensitivity.js';
import { token, alpha } from '../../theme/tokens.js';
import { applyChartTheme, trackChart } from '../../theme/adapters/chartjs.js';

const OUTPUTS = ['sc_bakery.monthly_cash', 'sc_7Q2f.net_cash', 'sc_projection.min_cumulative', 'sc_bakery.annual_cash', 'sc_bakery.dscr'];

export default class ControlsEditor extends BaseEditor {
  static id = 'controls';
  static label = 'Controls';
  static icon = 'settings';
  static group = 'Analysis';
  static needs = ['chartjs'];
  static usesScenario = true;

  async mount(ctx, state) {
    await loadCss(new URL('./controls.css', import.meta.url));
    this.state = {
      output: state.output || 'sc_bakery.monthly_cash',
      threshold: state.threshold ?? 0,
      showAll: !!state.showAll,
    };
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services, scenarioId: () => this.scenarioId() });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    this.Chart = ctx.libs.chartjs.Chart;
    applyChartTheme(this.Chart);
    /** @type {DistEditor[]} */
    this.distEditors = [];
    this.openDist = new Set();
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-controls';
    this.top = document.createElement('div');
    this.top.className = 'ms-ctl-top';
    this.list = document.createElement('div');
    this.list.className = 'ms-ed-scroll ms-ctl-list';
    this.foot = document.createElement('div');
    this.foot.className = 'ms-ed-foot';
    this.root.append(this.top, this.list, this.foot);
    ctx.el.appendChild(this.root);
    this.dragging = null;
    this.rankTimer = 0;
    this.rank();
    this.buildTop();
    this.buildRows();
    this.disposables.add({ dispose: () => { clearTimeout(this.rankTimer); this.chart?.destroy(); } });
  }

  getState() { return { ...this.state }; }

  getHeaderTools() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const sel = document.createElement('select');
    sel.className = 'ms-select is-small';
    sel.setAttribute('aria-label', 'Focused output');
    sel.dataset.tooltip = 'Output whose drivers are listed';
    for (const id of OUTPUTS) {
      if (!g.node(id)) continue;
      const o = document.createElement('option');
      o.value = id;
      o.textContent = g.path(id).replace(/^Bakery\./, '');
      if (id === this.state.output) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { this.state.output = sel.value; this.save(); this.rank(); this.buildTop(); this.buildRows(); });
    const lab = document.createElement('span');
    lab.className = 'ms-small ms-muted';
    lab.textContent = 'P(<';
    const thr = document.createElement('input');
    thr.className = 'ms-num-input';
    thr.type = 'number';
    thr.step = 'any';
    thr.value = String(this.state.threshold);
    thr.style.width = '64px';
    thr.setAttribute('aria-label', 'Threshold for the probability readout');
    thr.addEventListener('change', () => { this.state.threshold = Number(thr.value) || 0; this.save(); this.buildTop(); });
    const close = document.createElement('span');
    close.className = 'ms-small ms-muted';
    close.textContent = ')';
    const reset = document.createElement('button');
    // icon-only: the area header has little room next to the output picker and threshold
    reset.className = 'ms-icon-btn is-small';
    reset.innerHTML = '<span class="codicon codicon-discard" aria-hidden="true"></span>';
    reset.setAttribute('aria-label', 'Reset to model values');
    reset.dataset.tooltip = 'Reset to model values: restore overridden inputs to their original observed or estimated values';
    reset.addEventListener('click', () => this.resetToModel());
    wrap.append(sel, lab, thr, close, reset);
    return [wrap];
  }

  /** Rank assumptions by sensitivity (cached by the engine; recomputed lazily, never while dragging). */
  rank() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    try {
      const s = ctx.engine.sensitivity(this.state.output);
      // levers and uncertainties together, ranked by how far they move the output across their range
      this.ranking = s.items.filter((it) => g.isEditable(it.id)).sort((a, b) => b.swing - a.swing);
      this.method = s.method;
    } catch {
      this.ranking = [];
    }
  }

  scheduleRank() {
    clearTimeout(this.rankTimer);
    this.rankTimer = setTimeout(() => {
      if (this.dragging) return this.scheduleRank();
      const before = (this.ranking || []).slice(0, 5).map((x) => x.id).join();
      this.rank();
      const after = this.ranking.slice(0, 5).map((x) => x.id).join();
      if (before !== after && !this.root.contains(document.activeElement)) this.buildRows();
    }, 700);
  }

  buildTop() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const id = this.state.output;
    const n = g.node(id);
    this.bv.releaseWithin(this.top);
    this.top.replaceChildren();
    if (!n) return;
    const view = ctx.engine.view(this.scenarioId());
    const st = view.stats(id);
    const head = document.createElement('div');
    head.className = 'ms-ctl-out';
    const name = document.createElement('div');
    name.className = 'ms-ctl-out-name';
    name.textContent = n.label || g.path(id);
    const big = document.createElement('div');
    big.className = 'ms-ctl-out-value';
    big.append(this.bv.create({ node: id, stat: st && !st.deterministic ? 'p50' : 'value' }));
    const sub = document.createElement('div');
    sub.className = 'ms-ctl-out-sub';
    if (st && !st.deterministic) {
      sub.append('median · p10 ', this.bv.create({ node: id, stat: 'p10', glyph: false, plain: true }), ' to p90 ', this.bv.create({ node: id, stat: 'p90', glyph: false, plain: true }));
    }
    this.probEl = document.createElement('div');
    this.probEl.className = 'ms-ctl-prob';
    this.renderProb();
    head.append(name, big, sub, this.probEl);
    const chartWrap = document.createElement('div');
    chartWrap.className = 'ms-ctl-chart';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Histogram of ${n.name}`);
    chartWrap.appendChild(canvas);
    this.top.append(head, chartWrap);
    this.chart?.destroy();
    this.chart = null;
    if (st && !st.deterministic) this.makeChart(canvas, view.sample(id));
  }

  renderProb() {
    const ctx = /** @type {any} */ (this.ctx);
    if (!this.probEl) return;
    const view = ctx.engine.view(this.scenarioId());
    const n = ctx.engine.graph.node(this.state.output);
    const p = view.prob(this.state.output, '<', this.state.threshold);
    this.probEl.replaceChildren();
    const l = document.createElement('span');
    l.className = 'ms-muted';
    l.textContent = `P(${n?.name} < ${unitValue(this.state.threshold, n?.type.unit || '', { bare: true })}) `;
    const v = document.createElement('strong');
    v.className = 'ms-tabular';
    v.textContent = pct(p);
    const s = document.createElement('span');
    s.className = 'ms-muted ms-small';
    s.textContent = ` · ${ctx.engine.n.toLocaleString('en-US')} samples`;
    this.probEl.append(l, v, s);
  }

  /** @param {HTMLCanvasElement} canvas @param {Float64Array|null} samples */
  makeChart(canvas, samples) {
    if (!samples) return;
    const { labels, counts, neg } = this.bins(samples);
    const blue = token('--ms-series-1');
    const red = token('--ms-fail');
    this.chart = new this.Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: counts, backgroundColor: counts.map((_, i) => (neg[i] ? alpha(red, 0.75) : alpha(blue, 0.75))), borderWidth: 0, barPercentage: 1, categoryPercentage: 1 }] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
        events: [],
      },
    });
    trackChart(this.chart);
  }

  /** @param {Float64Array} samples */
  bins(samples) {
    const sorted = Float64Array.from(samples).sort();
    const lo = sorted[Math.floor(sorted.length * 0.01)];
    const hi = sorted[Math.floor(sorted.length * 0.99)];
    const B = 28;
    const counts = new Array(B).fill(0);
    for (const v of samples) {
      if (v < lo || v > hi) continue;
      counts[Math.min(B - 1, Math.floor(((v - lo) / (hi - lo || 1)) * B))]++;
    }
    const labels = counts.map((_, i) => lo + ((hi - lo) * (i + 0.5)) / B);
    const neg = labels.map((x) => x < this.state.threshold);
    return { labels, counts, neg };
  }

  updateChart() {
    const ctx = /** @type {any} */ (this.ctx);
    if (!this.chart) return this.buildTop();
    const samples = ctx.engine.view(this.scenarioId()).sample(this.state.output);
    if (!samples) return;
    const { labels, counts, neg } = this.bins(samples);
    const blue = token('--ms-series-1');
    const red = token('--ms-fail');
    this.chart.data.labels = labels;
    this.chart.data.datasets[0].data = counts;
    this.chart.data.datasets[0].backgroundColor = counts.map((_, i) => (neg[i] ? alpha(red, 0.75) : alpha(blue, 0.75)));
    this.chart.update('none');
  }

  buildRows() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.bv.releaseWithin(this.list);
    for (const d of this.distEditors) d.dispose();
    this.distEditors = [];
    this.list.replaceChildren();
    const items = this.state.showAll ? this.ranking : this.ranking.slice(0, 5);
    if (!items.length) {
      this.list.appendChild(emptyState({ icon: 'settings', title: 'No assumptions upstream', text: 'This output has no editable inputs.' }));
      return;
    }
    const max = Math.max(...items.map((it) => it.swing), 1e-9);
    for (const it of items) this.list.appendChild(this.row(it, max));
    const more = document.createElement('button');
    more.className = 'ms-btn is-secondary is-small ms-ctl-more';
    more.textContent = this.state.showAll ? 'Show top five only' : `Show all ${this.ranking.length} assumptions`;
    more.addEventListener('click', () => { this.state.showAll = !this.state.showAll; this.save(); this.buildRows(); });
    this.list.appendChild(more);
    this.foot.textContent = `Ranked by swing: how far ${g.path(this.state.output)} moves as each assumption crosses its range. Edits are local: zero model tokens.`;
  }

  /** @param {any} it @param {number} max */
  row(it, max) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const n = g.node(it.id);
    const view = ctx.engine.view(this.scenarioId());
    const isDist = !!(n.dist && n.dist.family !== 'Point');
    const r = document.createElement('div');
    r.className = 'ms-ctl-row';
    r.dataset.node = it.id;
    const head = document.createElement('div');
    head.className = 'ms-ctl-row-head';
    const name = document.createElement('button');
    name.className = 'ms-ctl-name';
    name.textContent = n.label || n.name;
    const swingText = unitValue(it.swing, g.node(this.state.output)?.type.unit || '');
    name.title = `${g.path(it.id)}\nSwing ${swingText} in ${g.node(this.state.output)?.name} across its range`;
    name.addEventListener('click', () => this.select([it.id]));
    const bar = document.createElement('span');
    bar.className = 'ms-ctl-sens';
    bar.style.setProperty('--w', `${Math.round((it.swing / max) * 100)}%`);
    bar.title = `Swing ${swingText}`;
    bar.setAttribute('aria-label', `swing ${swingText}`);
    head.append(provMark(g.displayProv(it.id)), name, bar);
    r.appendChild(head);

    const st = view.stats(it.id);
    const cur = st && !st.deterministic ? st.p50 : view.value(it.id);
    const [lo, hi] = this.sliderRange(n, cur);
    const ctl = document.createElement('div');
    ctl.className = 'ms-ctl-row-ctl';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'ms-range';
    slider.min = String(lo);
    slider.max = String(hi);
    slider.step = String(niceStep(lo, hi));
    slider.value = String(cur);
    slider.setAttribute('aria-label', `${n.name} (${n.type.unit})`);
    slider.setAttribute('aria-valuetext', unitValue(cur, n.type.unit));
    const setFill = () => slider.style.setProperty('--ms-range-pct', `${((Number(slider.value) - lo) / (hi - lo || 1)) * 100}%`);
    setFill();
    const num = document.createElement('input');
    num.className = 'ms-num-input';
    num.type = 'number';
    num.step = 'any';
    num.value = fmtInput(cur);
    num.setAttribute('aria-label', `${n.name} value`);
    const unit = document.createElement('span');
    unit.className = 'ms-unit';
    unit.textContent = n.type.unit;
    ctl.append(slider, num, unit);
    if (isDist) {
      const eb = document.createElement('button');
      eb.className = 'ms-icon-btn is-small';
      eb.setAttribute('aria-label', `Edit the distribution of ${n.name}`);
      eb.dataset.tooltip = describe(n.dist);
      eb.innerHTML = '<span class="codicon codicon-edit" aria-hidden="true"></span>';
      eb.addEventListener('click', () => {
        if (this.openDist.has(it.id)) this.openDist.delete(it.id); else this.openDist.add(it.id);
        this.buildRows();
      });
      ctl.appendChild(eb);
    }
    r.appendChild(ctl);
    if (isDist) {
      const d = document.createElement('div');
      d.className = 'ms-ctl-dist ms-mono';
      d.textContent = `~ ${describe(n.dist)}`;
      r.appendChild(d);
    }

    // shift from the distribution as it was when the row was built (previews mutate the node)
    const scenOv = this.scenarioId() && this.scenarioId() !== 'base' ? ctx.engine.scenarios.get(this.scenarioId())?.overrides.get(it.id) : null;
    const dist0 = isDist ? structuredClone(scenOv?.dist || n.dist) : null;
    const deltaFor = (v) => {
      const delta = { op: 'set', target: it.id, prov: 'input' };
      if (isDist) delta.dist = shiftDist(dist0, cur, v);
      else delta.value = v;
      const scen = this.scenarioId();
      if (scen && scen !== 'base') delta.scenario = scen;
      return delta;
    };
    const preview = ctx.scheduler.rafThrottle((v) => {
      ctx.services.history.preview([deltaFor(v)]);
      ctx.store.set('status.tokens', { count: 0, local: true, touched: true });
    });
    const commit = (v) => {
      preview.cancel();
      const res = ctx.services.history.commit([deltaFor(v)]);
      if (!res.ok) ctx.services.notify.warn(`Rejected: ${res.errors[0].message}`, { detail: res.errors[0].hint });
      this.dragging = null;
      ctx.store.set('status.tokens', { count: 0, local: true, touched: true });
      this.scheduleRank();
    };
    slider.addEventListener('input', () => {
      this.dragging = it.id;
      const v = Number(slider.value);
      num.value = fmtInput(v);
      setFill();
      slider.setAttribute('aria-valuetext', unitValue(v, n.type.unit));
      preview(v);
    });
    slider.addEventListener('change', () => commit(Number(slider.value)));
    slider.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dragging) {
        preview.cancel();
        ctx.services.history.cancelPreview();
        this.dragging = null;
        this.buildRows();
      }
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (!Number.isFinite(v)) { num.classList.add('is-invalid'); return; }
      num.classList.remove('is-invalid');
      commit(v);
    });
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.dispatchEvent(new Event('change')); });

    if (this.openDist.has(it.id) && isDist) {
      const scen = this.scenarioId();
      const spec = scen && scen !== 'base' ? (ctx.engine.scenarios.get(scen)?.overrides.get(it.id)?.dist || n.dist) : n.dist;
      const de = new DistEditor({
        spec,
        unit: n.type.unit,
        compact: true,
        onChange: (s, info) => {
          const delta = { op: 'set', target: it.id, dist: s, prov: 'input' };
          if (scen && scen !== 'base') delta.scenario = scen;
          if (info.final) commit2(delta);
          else ctx.services.history.preview([delta]);
        },
      });
      const commit2 = (delta) => {
        const res = ctx.services.history.commit([delta]);
        if (!res.ok) ctx.services.notify.warn(`Rejected: ${res.errors[0].message}`);
        this.scheduleRank();
      };
      this.distEditors.push(de);
      r.appendChild(de.el);
    }
    r._refs = { slider, num, setFill, lo, hi, n };
    return r;
  }

  /** Slider range: distribution p01–p99, declared range, or ±50%. */
  sliderRange(n, cur) {
    let lo;
    let hi;
    if (n.dist && n.dist.family !== 'Point') {
      const d = makeDist(n.dist);
      lo = d.quantile(0.01);
      hi = d.quantile(0.99);
    } else if (n.range) [lo, hi] = n.range;
    else {
      const r = analysisRange(n);
      if (r) { lo = cur - Math.abs(cur) * 0.5; hi = cur + Math.abs(cur) * 0.5; } else { lo = 0; hi = 1; }
    }
    lo = Math.min(lo, cur);
    hi = Math.max(hi, cur);
    if (!(hi > lo)) hi = lo + 1;
    return [lo, hi];
  }

  resetToModel() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const deltas = [];
    for (const n of g.nodes.values()) {
      if (!n.prov?.overriddenFrom) continue;
      const { overriddenFrom, originalValue, originalDist, ...rest } = n.prov;
      deltas.push({ op: 'set', target: n.id, value: originalValue, dist: originalDist ?? null, kind: overriddenFrom, provDetail: rest, restore: true });
    }
    if (!deltas.length) { ctx.services.notify.info('No overridden values: everything is at its model value.'); return; }
    const res = ctx.services.history.apply(deltas, { author: 'user', kind: 'edit' });
    if (res.ok) ctx.services.notify.success(`Restored ${deltas.length} value(s) to their observed or estimated originals.`);
  }

  onRecompute(changed, payload) {
    if (payload?.full || payload?.scenarioChanged) this.bv.updateAll(); else this.bv.update(changed);
    this.renderProb();
    this.chartDirty = true;
    this.invalidate();
    // sync sliders that changed elsewhere (not the one being dragged)
    const ctx = /** @type {any} */ (this.ctx);
    const view = ctx.engine.view(this.scenarioId());
    for (const r of this.list.querySelectorAll('.ms-ctl-row')) {
      const id = /** @type {HTMLElement} */ (r).dataset.node;
      const refs = /** @type {any} */ (r)._refs;
      if (!refs || id === this.dragging || !changed.includes(id)) continue;
      const st = view.stats(id);
      const v = st && !st.deterministic ? st.p50 : view.value(id);
      if (document.activeElement !== refs.num) refs.num.value = fmtInput(v);
      refs.slider.value = String(v);
      refs.setFill();
    }
    if (!payload?.transient) this.scheduleRank();
  }

  render() {
    if (this.chartDirty) {
      this.chartDirty = false;
      this.updateChart();
    }
  }

  onStructure() { this.rank(); this.buildTop(); this.buildRows(); }
  onScenario() { this.buildTop(); this.buildRows(); }
  onTheme() {
    applyChartTheme(this.Chart);
    this.buildTop();
  }
  onSelection(sel) { this.bv.select(sel.selected); }
  onHover(id) {
    this.bv.hover(id);
    for (const r of this.list.querySelectorAll('.ms-ctl-row')) r.classList.toggle('is-hovered', !!id && /** @type {HTMLElement} */ (r).dataset.node === id);
  }

  dispose() {
    for (const d of this.distEditors) d.dispose();
    this.chart?.destroy();
    this.chart = null;
    this.root?.remove();
    super.dispose();
  }
}

/** @param {number} lo @param {number} hi */
function niceStep(lo, hi) {
  const span = hi - lo;
  if (!(span > 0)) return 1;
  const raw = span / 400;
  const p = 10 ** Math.floor(Math.log10(raw));
  return Math.max(p, Math.round(raw / p) * p);
}

/** @param {number} v */
function fmtInput(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  return String(a >= 1000 ? Math.round(v) : a >= 10 ? Math.round(v * 10) / 10 : Number(v.toPrecision(4)));
}
