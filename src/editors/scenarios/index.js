/**
 * Scenarios: scenario tree (base and forks with override counts; create, rename, delete, set
 * active) and three tabs: Compare (key outputs side by side with deltas vs base + grouped bar
 * chart), Sweep (1-2 inputs over a grid -> d3 heatmap on the sequential ramp; click a cell to
 * fork), Goal seek (bracketed root finding on the Monte Carlo estimate; the result is written as
 * a new scenario, never over your inputs).
 * @module editors/scenarios
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { tableView } from '../shared/chart-table.js';
import { loadCss } from '../../core/lazy.js';
import { unitValue, pct, delta as fmtDelta, formatAs } from '../../model/format.js';
import { defaultFmt } from '../../model/binding.js';
import { applyChartTheme, chartPalette, trackChart } from '../../theme/adapters/chartjs.js';
import { d3Palette } from '../../theme/adapters/d3.js';

const OUTPUTS = [
  { id: 'sc_bakery.monthly_cash', stat: 'p50', label: 'Monthly cash (median)' },
  { id: 'sc_bakery.p_cash_negative', stat: 'value', label: 'P(negative month)' },
  { id: 'sc_7Q2f.net_cash', stat: 'p50', label: 'Location B net cash (median)' },
  { id: 'sc_projection.p_buffer_breach', stat: 'value', label: 'P(buffer breached, 24 months)' },
  { id: 'sc_loan.payment', stat: 'value', label: 'Loan payment' },
  { id: 'sc_bakery.dscr', stat: 'p50', label: 'Debt service coverage (median)' },
];

export default class ScenariosEditor extends BaseEditor {
  static id = 'scenarios';
  static label = 'Scenarios';
  static icon = 'repo-forked';
  static group = 'Analysis';
  static needs = ['chartjs', 'd3'];

  async mount(ctx, state) {
    await loadCss(new URL('./scenarios.css', import.meta.url));
    this.Chart = ctx.libs.chartjs.Chart;
    this.d3 = ctx.libs.d3;
    applyChartTheme(this.Chart);
    const ids = ctx.services.scenarios.list().map((s) => s.id);
    this.state = {
      tab: state.tab || 'compare',
      compare: (state.compare || ids).filter((id) => ids.includes(id)).slice(0, 4),
      sweep: state.sweep || { x: 'sc_bakery.rent', xlo: 5000, xhi: 9000, xstep: 500, y: 'sc_bakery.price', ylo: 3.5, yhi: 5, ystep: 0.25, use2d: true, output: 'sc_bakery.monthly_cash', stat: 'prob_lt' },
      goal: state.goal || { target: 'sc_bakery.monthly_cash', stat: 'prob_lt', threshold: 0, op: '<', value: 0.1, decision: 'sc_bakery.price' },
    };
    if (!this.state.compare.includes('base')) this.state.compare.unshift('base');
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
    this.disposables.add({ dispose: () => { this.bv.dispose(); this.destroyChart(); if (this.sweepAbort) this.sweepAbort.aborted = true; } });
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-scn';
    this.side = document.createElement('div');
    this.side.className = 'ms-scn-side';
    this.main = document.createElement('div');
    this.main.className = 'ms-scn-main';
    this.root.append(this.side, this.main);
    ctx.el.appendChild(this.root);
    this.grid = null;
    this.buildSide();
    this.buildMain();
    this.consumeRequest();
  }

  getState() { return { tab: this.state.tab, compare: this.state.compare, sweep: this.state.sweep, goal: this.state.goal }; }

  /** Requests from the chat (/compare, /sweep). */
  consumeRequest() {
    const svc = /** @type {any} */ (this.ctx).services.scenarios;
    const req = svc.request;
    if (!req) return;
    svc.request = null;
    if (req.tab) this.state.tab = req.tab;
    if (req.spec) {
      const s = req.spec;
      const ax = (a) => ({ lo: a.values[0], hi: a.values[a.values.length - 1], step: a.values.length > 1 ? a.values[1] - a.values[0] : 1 });
      const x = ax(s.x);
      this.state.sweep = { ...this.state.sweep, x: s.x.id, xlo: x.lo, xhi: x.hi, xstep: x.step, use2d: !!s.y };
      if (s.y) {
        const y = ax(s.y);
        Object.assign(this.state.sweep, { y: s.y.id, ylo: y.lo, yhi: y.hi, ystep: y.step });
      }
      this.buildMain();
      this.runSweep();
      return;
    }
    this.buildMain();
  }

  // ------------------------------------------------------------------ side: scenario tree

  buildSide() {
    const ctx = /** @type {any} */ (this.ctx);
    const svc = ctx.services.scenarios;
    this.side.replaceChildren();
    const head = document.createElement('div');
    head.className = 'ms-scn-side-head';
    const t = document.createElement('span');
    t.textContent = 'Scenarios';
    const add = document.createElement('button');
    add.className = 'ms-icon-btn is-small';
    add.setAttribute('aria-label', 'Fork the active scenario');
    add.dataset.tooltip = 'Fork the active scenario';
    add.innerHTML = '<span class="codicon codicon-repo-forked" aria-hidden="true"></span>';
    add.addEventListener('click', () => {
      const parent = svc.activeId;
      const r = svc.fork(`Fork of ${svc.label(parent)}`, [], { parent });
      if (r.ok) {
        this.state.compare = [...new Set([...this.state.compare, r.id])].slice(-4);
        svc.setActive(r.id);
      }
    });
    head.append(t, add);
    this.side.appendChild(head);
    const list = document.createElement('ul');
    list.className = 'ms-scn-tree';
    list.setAttribute('role', 'tree');
    list.setAttribute('aria-label', 'Scenario tree');
    const walk = (id, depth) => {
      const s = svc.get(id);
      if (!s) return;
      const li = document.createElement('li');
      li.className = 'ms-scn-item' + (svc.activeId === id ? ' is-active' : '');
      li.setAttribute('role', 'treeitem');
      li.style.paddingLeft = `${6 + depth * 12}px`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.state.compare.includes(id);
      cb.setAttribute('aria-label', `Compare ${s.name}`);
      cb.addEventListener('change', () => {
        if (cb.checked) this.state.compare = [...this.state.compare.filter((x) => x !== id), id].slice(-4);
        else this.state.compare = this.state.compare.filter((x) => x !== id);
        this.save();
        this.buildSide();
        if (this.state.tab === 'compare') this.buildMain();
      });
      const sw = document.createElement('span');
      sw.className = 'ms-legend-key is-rect';
      sw.style.background = `var(--ms-series-${(s.color % 8) + 1})`;
      const name = document.createElement('button');
      name.className = 'ms-scn-name';
      name.textContent = s.name;
      name.title = svc.activeId === id ? 'Active scenario' : 'Make active';
      name.addEventListener('click', () => svc.setActive(id));
      name.addEventListener('dblclick', () => { if (id !== 'base') this.rename(li, id); });
      const count = document.createElement('span');
      count.className = 'ms-badge';
      count.textContent = String(s.overrides.size);
      count.title = `${s.overrides.size} override(s)`;
      const menu = document.createElement('button');
      menu.className = 'ms-icon-btn is-small';
      menu.setAttribute('aria-label', `Actions for ${s.name}`);
      menu.innerHTML = '<span class="codicon codicon-ellipsis" aria-hidden="true"></span>';
      menu.addEventListener('click', () => ctx.ui.showMenu([
        { label: 'Make active', icon: 'check', run: () => svc.setActive(id) },
        { label: 'Fork from here', icon: 'repo-forked', run: () => { const r = svc.fork(`Fork of ${s.name}`, [], { parent: id }); if (r.ok) svc.setActive(r.id); } },
        { label: 'Rename', icon: 'edit', disabled: id === 'base', run: () => this.rename(li, id) },
        { label: 'Delete', icon: 'trash', disabled: id === 'base', run: () => svc.remove(id) },
        { separator: true },
        ...[...s.overrides.entries()].slice(0, 8).map(([nid, ov]) => ({ label: `${ctx.engine.graph.path(nid)} = ${ov.value !== undefined ? unitValue(ov.value, ctx.engine.graph.node(nid)?.type.unit || '') : 'distribution'}`, disabled: true })),
      ], menu, { label: s.name }));
      li.append(cb, sw, name, count, menu);
      list.appendChild(li);
      for (const c of svc.store.children(id)) walk(c.id, depth + 1);
    };
    walk('base', 0);
    this.side.appendChild(list);
    const note = document.createElement('p');
    note.className = 'ms-small ms-muted ms-scn-note';
    note.textContent = 'A scenario is a fork of the graph plus overrides (copy-on-write). Numeric edits in an area set to a scenario land in that scenario.';
    this.side.appendChild(note);
  }

  /** @param {HTMLElement} li @param {string} id */
  rename(li, id) {
    const svc = /** @type {any} */ (this.ctx).services.scenarios;
    const btn = li.querySelector('.ms-scn-name');
    const input = document.createElement('input');
    input.className = 'ms-input is-small';
    input.value = svc.label(id);
    btn?.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok && input.value.trim()) svc.rename(id, input.value.trim());
      this.buildSide();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }

  // ------------------------------------------------------------------ main: tabs

  buildMain() {
    this.destroyChart();
    this.bv.releaseWithin(this.main);
    this.main.replaceChildren();
    const tabs = document.createElement('div');
    tabs.className = 'ms-tabs';
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['compare', 'Compare'], ['sweep', 'Sweep'], ['goal', 'Goal seek']]) {
      const b = document.createElement('button');
      b.className = 'ms-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(this.state.tab === id));
      b.textContent = label;
      b.addEventListener('click', () => { this.state.tab = id; this.save(); this.buildMain(); });
      tabs.appendChild(b);
    }
    const body = document.createElement('div');
    body.className = 'ms-ed-scroll ms-scn-body';
    this.main.append(tabs, body);
    this.bodyEl = body;
    if (this.state.tab === 'compare') this.buildCompare(body);
    else if (this.state.tab === 'sweep') this.buildSweep(body);
    else this.buildGoal(body);
  }

  /** @param {HTMLElement} body */
  buildCompare(body) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const svc = ctx.services.scenarios;
    const ids = this.state.compare.filter((id) => svc.get(id));
    const table = document.createElement('table');
    table.className = 'ms-table ms-scn-compare';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const th0 = document.createElement('th');
    th0.textContent = 'output';
    hr.appendChild(th0);
    for (const id of ids) {
      const th = document.createElement('th');
      th.className = 'num';
      const key = document.createElement('span');
      key.className = 'ms-legend-key is-rect';
      key.style.background = `var(--ms-series-${(svc.get(id).color % 8) + 1})`;
      th.append(key, ` ${svc.label(id)}`);
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    for (const o of OUTPUTS) {
      if (!g.node(o.id)) continue;
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.textContent = o.label;
      td0.title = g.path(o.id);
      tr.appendChild(td0);
      const unit = g.node(o.id).type.unit;
      const baseV = this.statOf('base', o);
      for (const id of ids) {
        const td = document.createElement('td');
        td.className = 'num';
        td.appendChild(this.bv.create({ node: o.id, stat: o.stat, scenario: id === 'base' ? null : id }));
        if (id !== 'base') {
          const d = this.statOf(id, o) - baseV;
          const span = document.createElement('div');
          span.className = `ms-scn-delta ${Math.abs(d) < 1e-9 ? '' : (d > 0) === !/p_|breach/.test(o.id) ? 'is-pos' : 'is-neg'}`;
          span.textContent = Math.abs(d) < 1e-9 ? 'same' : fmtDelta(d, unit);
          td.appendChild(span);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    body.appendChild(table);
    // grouped bar chart: p10 / p50 / p90 of monthly cash per scenario
    const wrap = document.createElement('div');
    wrap.className = 'ms-chart-wrap ms-scn-chart';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Monthly cash p10, p50 and p90 per scenario');
    wrap.appendChild(canvas);
    body.appendChild(wrap);
    const p = chartPalette();
    const stats = ids.map((id) => svc.view(id).stats('sc_bakery.monthly_cash'));
    this.chart = new this.Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['p10', 'p50', 'p90'],
        datasets: ids.map((id, i) => ({
          label: svc.label(id),
          data: [stats[i]?.p10, stats[i]?.p50, stats[i]?.p90],
          backgroundColor: p.series[svc.get(id).color % 8],
          borderRadius: 3,
          maxBarThickness: 24,
        })),
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end' }, title: { display: true, text: 'Monthly cash by scenario', color: p.muted, align: 'start' }, tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${unitValue(it.raw, 'USD/month')}` } } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: p.grid }, ticks: { callback: (v) => unitValue(Number(v), 'USD', { compact: true }) } } },
      },
    });
    trackChart(this.chart);
  }

  /** @param {string} id @param {{id: string, stat: string}} o */
  statOf(id, o) {
    const view = /** @type {any} */ (this.ctx).services.scenarios.view(id);
    if (o.stat === 'value') return view.value(o.id);
    const s = view.stats(o.id);
    return s ? s[o.stat] : NaN;
  }

  // ------------------------------------------------------------------ sweep

  /** @param {HTMLElement} body */
  buildSweep(body) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const s = this.state.sweep;
    const form = document.createElement('div');
    form.className = 'ms-scn-form';
    const editable = [...g.nodes.values()].filter((n) => n.kind !== 'computed' && n.type.unit !== 'text' && (n.range || n.value)).sort((a, b) => g.path(a.id).localeCompare(g.path(b.id)));
    const sel = (value, onChange, label) => {
      const el = document.createElement('select');
      el.className = 'ms-select is-small';
      el.setAttribute('aria-label', label);
      for (const n of editable) {
        const o = document.createElement('option');
        o.value = n.id;
        o.textContent = g.path(n.id).replace(/^Bakery\./, '');
        if (n.id === value) o.selected = true;
        el.appendChild(o);
      }
      el.addEventListener('change', () => onChange(el.value));
      return el;
    };
    const num = (value, onChange, label, w = 60) => {
      const el = document.createElement('input');
      el.className = 'ms-num-input';
      el.type = 'number';
      el.step = 'any';
      el.value = String(value);
      el.style.width = `${w}px`;
      el.setAttribute('aria-label', label);
      el.addEventListener('change', () => onChange(Number(el.value)));
      return el;
    };
    const setRange = (axis, id) => {
      const n = g.node(id);
      const r = n.range || [n.value * 0.7, n.value * 1.3];
      s[`${axis}lo`] = round(r[0]);
      s[`${axis}hi`] = round(r[1]);
      s[`${axis}step`] = round((r[1] - r[0]) / 8);
    };
    /** @param {string|Node} label @param {...Node} els */
    const row = (label, ...els) => {
      const r = document.createElement('div');
      r.className = 'ms-scn-form-row';
      let l = label;
      if (typeof label === 'string') {
        l = document.createElement('span');
        l.className = 'ms-scn-form-label';
        l.textContent = label;
      }
      r.append(l, ...els);
      form.appendChild(r);
      return r;
    };
    const t = (x) => { const e = document.createElement('span'); e.className = 'ms-muted ms-small'; e.textContent = x; return e; };
    // the from/to/step group wraps as one unit in narrow areas
    const range = (...els) => { const g2 = document.createElement('span'); g2.className = 'ms-scn-range'; g2.append(...els); return g2; };
    row('x input', sel(s.x, (v) => { s.x = v; setRange('x', v); this.save(); this.buildMain(); }, 'X input'),
      range(t('from'), num(s.xlo, (v) => { s.xlo = v; this.save(); }, 'X from'), t('to'), num(s.xhi, (v) => { s.xhi = v; this.save(); }, 'X to'), t('step'), num(s.xstep, (v) => { s.xstep = v; this.save(); }, 'X step', 52)));
    const yToggle = document.createElement('label');
    yToggle.className = 'ms-scn-form-label ms-checkbox';
    const yc = document.createElement('input');
    yc.type = 'checkbox';
    yc.checked = s.use2d;
    yc.setAttribute('aria-label', 'Sweep a second input (2-D heatmap)');
    yc.addEventListener('change', () => { s.use2d = yc.checked; this.save(); this.buildMain(); });
    yToggle.append(yc, ' y input');
    const yRow = row(yToggle, sel(s.y, (v) => { s.y = v; setRange('y', v); this.save(); this.buildMain(); }, 'Y input'),
      range(t('from'), num(s.ylo, (v) => { s.ylo = v; this.save(); }, 'Y from'), t('to'), num(s.yhi, (v) => { s.yhi = v; this.save(); }, 'Y to'), t('step'), num(s.ystep, (v) => { s.ystep = v; this.save(); }, 'Y step', 52)));
    if (!s.use2d) for (const el of yRow.querySelectorAll('select, .ms-num-input')) /** @type {HTMLInputElement} */ (el).disabled = true;
    const stat = document.createElement('select');
    stat.className = 'ms-select is-small';
    stat.setAttribute('aria-label', 'Output statistic');
    for (const [v, l] of [['prob_lt', 'P(monthly cash < 0)'], ['p50', 'median monthly cash'], ['p10', 'p10 monthly cash']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      if (v === s.stat) o.selected = true;
      stat.appendChild(o);
    }
    stat.addEventListener('change', () => { s.stat = stat.value; this.save(); });
    const run = document.createElement('button');
    run.className = 'ms-btn is-small';
    run.textContent = this.sweeping ? 'Running…' : 'Run sweep';
    run.disabled = !!this.sweeping;
    run.addEventListener('click', () => this.runSweep());
    row('output', stat, run);
    const meta = document.createElement('div');
    meta.className = 'ms-small ms-muted';
    meta.textContent = 'Each cell is a full Monte Carlo evaluation of the overridden cone (common random numbers), in the browser, zero model tokens.';
    form.appendChild(meta);
    body.appendChild(form);
    this.sweepOut = document.createElement('div');
    this.sweepOut.className = 'ms-scn-sweep';
    body.appendChild(this.sweepOut);
    if (this.grid) this.drawSweep();
  }

  values(lo, hi, step) {
    const out = [];
    if (!(step > 0) || !(hi > lo)) return [lo];
    for (let v = lo; v <= hi + step * 1e-9 && out.length < 25; v += step) out.push(round(v));
    return out;
  }

  async runSweep() {
    const ctx = /** @type {any} */ (this.ctx);
    const s = this.state.sweep;
    if (this.sweepAbort) this.sweepAbort.aborted = true;
    const abort = { aborted: false };
    this.sweepAbort = abort;
    const spec = {
      scenarioId: ctx.services.scenarios.activeId,
      x: { id: s.x, values: this.values(s.xlo, s.xhi, s.xstep) },
      y: s.use2d ? { id: s.y, values: this.values(s.ylo, s.yhi, s.ystep) } : null,
      output: { id: s.output, stat: s.stat, threshold: 0 },
    };
    this.sweepSpec = spec;
    this.sweeping = true;
    this.grid = null;
    if (this.state.tab === 'sweep') this.buildMain();
    const t0 = performance.now();
    await ctx.services.scenarios.sweep(spec, (prog) => {
      if (abort.aborted) return;
      this.grid = prog.grid;
      this.progress = prog;
      if (this.state.tab === 'sweep' && this.sweepOut) this.drawSweep();
    }, { signal: abort });
    this.sweeping = false;
    this.sweepMs = performance.now() - t0;
    ctx.store.set('status.tokens', { count: 0, local: true, touched: true, kind: 'sweep' });
    if (this.state.tab === 'sweep' && !abort.aborted) this.buildMain();
  }

  drawSweep() {
    const ctx = /** @type {any} */ (this.ctx);
    const d3 = this.d3;
    const P = d3Palette(d3);
    const g = ctx.engine.graph;
    const spec = this.sweepSpec;
    const out = this.sweepOut;
    if (!out || !spec || !this.grid) return;
    out.replaceChildren();
    const xs = spec.x.values;
    const ys = spec.y ? spec.y.values : [NaN];
    const isProb = spec.output.stat === 'prob_lt';
    const fmt = (v) => (isProb ? pct(v) : unitValue(v, 'USD/month', { compact: true, bare: true }));
    const flat = this.grid.flat().filter(Number.isFinite);
    const status = document.createElement('div');
    status.className = 'ms-small ms-muted';
    status.textContent = this.sweeping ? `computing ${this.progress?.done || 0}/${this.progress?.total || xs.length * ys.length} cells…` : `${xs.length * ys.length} cells in ${Math.round(this.sweepMs || 0)} ms · click a cell to fork a scenario with those values`;
    out.appendChild(status);
    const W = Math.max(300, (this.bodyEl?.clientWidth || 500) - 24);
    const cellW = Math.max(18, Math.min(52, (W - 90) / xs.length));
    const cellH = spec.y ? Math.max(16, Math.min(30, 260 / ys.length)) : 34;
    const H = ys.length * cellH + 48;
    const svg = d3.create('svg').attr('class', 'ms-scn-heat').attr('width', xs.length * cellW + 96).attr('height', H)
      .attr('role', 'img').attr('aria-label', `Sweep of ${g.path(spec.x.id)}${spec.y ? ` by ${g.path(spec.y.id)}` : ''}: ${isProb ? 'probability of a negative month' : 'monthly cash'}`);
    const color = d3.scaleSequential((t) => P.seqInterp(t)).domain(isProb ? [0, Math.max(0.05, d3.max(flat) || 1)] : d3.extent(flat.length ? flat : [0, 1]));
    const gx = svg.append('g').attr('transform', 'translate(90, 6)');
    const cells = [];
    ys.forEach((yv, yi) => xs.forEach((xv, xi) => cells.push({ xi, yi, xv, yv, v: this.grid[yi]?.[xi] })));
    const sel = gx.selectAll('rect').data(cells).join('rect')
      .attr('x', (d) => d.xi * cellW).attr('y', (d) => (ys.length - 1 - d.yi) * cellH)
      .attr('width', cellW - 2).attr('height', cellH - 2).attr('rx', 2)
      .attr('fill', (d) => (Number.isFinite(d.v) ? color(d.v) : 'var(--vscode-editorWidget-background)'))
      .attr('class', 'cell')
      .attr('tabindex', 0)
      .attr('aria-label', (d) => `${g.node(spec.x.id).name} ${fmtIn(d.xv)}${spec.y ? `, ${g.node(spec.y.id).name} ${fmtIn(d.yv)}` : ''}: ${Number.isFinite(d.v) ? fmt(d.v) : 'pending'}`)
      .on('click', (_, d) => this.forkCell(d))
      .on('keydown', (e, d) => { if (e.key === 'Enter') this.forkCell(d); });
    sel.append('title').text((d) => `${g.node(spec.x.id).name} = ${fmtIn(d.xv)}${spec.y ? `\n${g.node(spec.y.id).name} = ${fmtIn(d.yv)}` : ''}\n${isProb ? 'P(monthly cash < 0)' : spec.output.stat + ' monthly cash'} = ${Number.isFinite(d.v) ? fmt(d.v) : '…'}\nclick to fork a scenario`);
    if (cellW >= 34 && cellH >= 16) {
      gx.selectAll('text.v').data(cells.filter((c) => Number.isFinite(c.v))).join('text').attr('class', 'v')
        .attr('x', (d) => d.xi * cellW + (cellW - 2) / 2).attr('y', (d) => (ys.length - 1 - d.yi) * cellH + (cellH - 2) / 2).attr('dy', '0.35em')
        .attr('fill', (d) => (color(d.v) && luminance(color(d.v)) < 0.45 ? '#ffffff' : '#0b0b0b'))
        .text((d) => fmt(d.v));
    }
    // axes labels
    gx.append('g').attr('transform', `translate(0, ${ys.length * cellH + 4})`).selectAll('text').data(xs).join('text')
      .attr('class', 'tick').attr('x', (_, i) => i * cellW + (cellW - 2) / 2).attr('y', 8)
      .text((v, i) => (xs.length > 12 && i % 2 ? '' : fmtIn(v)));
    svg.append('text').attr('class', 'axis-title').attr('x', 90).attr('y', H - 4).text(g.path(spec.x.id).replace(/^Bakery\./, ''));
    if (spec.y) {
      gx.append('g').selectAll('text').data(ys).join('text').attr('class', 'tick').attr('text-anchor', 'end')
        .attr('x', -6).attr('y', (_, i) => (ys.length - 1 - i) * cellH + (cellH - 2) / 2).attr('dy', '0.35em').text((v) => fmtIn(v));
      svg.append('text').attr('class', 'axis-title').attr('transform', `translate(10, ${(ys.length * cellH) / 2 + 6}) rotate(-90)`).attr('text-anchor', 'middle').text(g.node(spec.y.id).name);
    }
    out.appendChild(svg.node());
    // ramp legend
    const legend = document.createElement('div');
    legend.className = 'ms-scn-legend';
    const [d0, d1] = color.domain();
    legend.innerHTML = '<span class="ms-small ms-muted"></span><span class="ms-scn-ramp"></span><span class="ms-small ms-muted"></span>';
    /** @type {HTMLElement} */ (legend.children[0]).textContent = fmt(d0);
    /** @type {HTMLElement} */ (legend.children[2]).textContent = fmt(d1);
    /** @type {HTMLElement} */ (legend.children[1]).style.background = `linear-gradient(90deg, ${P.seq.join(', ')})`;
    out.appendChild(legend);
    if (!this.sweeping) {
      out.appendChild(tableView({
        caption: 'Sweep results',
        columns: [{ label: g.node(spec.x.id).name }, ...(spec.y ? [{ label: g.node(spec.y.id).name }] : []), { label: isProb ? 'P(monthly cash < 0)' : 'monthly cash', align: 'right' }],
        rows: cells.map((c) => [fmtIn(c.xv), ...(spec.y ? [fmtIn(c.yv)] : []), Number.isFinite(c.v) ? fmt(c.v) : '…']),
      })).classList.add('ms-scn-sweep-table');
    }
    function fmtIn(v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : String(round(v)); }
  }

  /** @param {{xv: number, yv: number}} cell */
  forkCell(cell) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const spec = this.sweepSpec;
    if (!spec) return;
    const ov = [{ target: spec.x.id, value: cell.xv }];
    if (spec.y) ov.push({ target: spec.y.id, value: cell.yv });
    const name = `${g.node(spec.x.id).name} ${shortNum(cell.xv)}${spec.y ? `, ${g.node(spec.y.id).name} ${shortNum(cell.yv)}` : ''}`;
    const r = ctx.services.scenarios.fork(name, ov, { parent: spec.scenarioId || 'base' });
    if (r.ok) {
      this.state.compare = [...new Set([...this.state.compare, r.id])].slice(-4);
      ctx.services.notify.success(`Forked scenario “${name}”.`, { actions: [{ label: 'Compare', run: () => { this.state.tab = 'compare'; this.buildMain(); } }] });
    }
  }

  // ------------------------------------------------------------------ goal seek

  /** @param {HTMLElement} body */
  buildGoal(body) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const s = this.state.goal;
    const form = document.createElement('div');
    form.className = 'ms-scn-form';
    const p = document.createElement('p');
    p.className = 'ms-small ms-muted';
    p.textContent = 'Find the smallest change to one input that meets a target on the Monte Carlo estimate. Bisection with common random numbers keeps the target smooth; the result is written as a new scenario, never over your inputs.';
    form.appendChild(p);
    const row = (label, ...els) => {
      const r = document.createElement('div');
      r.className = 'ms-scn-form-row';
      const l = document.createElement('span');
      l.className = 'ms-scn-form-label';
      l.textContent = label;
      r.append(l, ...els);
      form.appendChild(r);
    };
    const select = (opts, value, onChange, label) => {
      const el = document.createElement('select');
      el.className = 'ms-select is-small';
      el.setAttribute('aria-label', label);
      for (const [v, l] of opts) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = l;
        if (v === value) o.selected = true;
        el.appendChild(o);
      }
      el.addEventListener('change', () => onChange(el.value));
      return el;
    };
    const outputs = [...g.nodes.values()].filter((n) => n.kind === 'computed' && /USD/.test(n.type.unit) && !n.expr?.[0]?.startsWith?.('prob')).slice(0, 80).map((n) => [n.id, g.path(n.id).replace(/^Bakery\./, '')]);
    const inputs = [...g.nodes.values()].filter((n) => n.kind !== 'computed' && n.type.unit !== 'text').map((n) => [n.id, g.path(n.id).replace(/^Bakery\./, '')]);
    row('target', select([['prob_lt', 'P(output < threshold)'], ['p50', 'median of output'], ['p10', 'p10 of output']], s.stat, (v) => { s.stat = v; this.save(); this.buildMain(); }, 'Target statistic'), select(outputs, s.target, (v) => { s.target = v; this.save(); }, 'Target output'));
    const num = (v, on, label) => {
      const el = document.createElement('input');
      el.className = 'ms-num-input';
      el.type = 'number';
      el.step = 'any';
      el.value = String(v);
      el.setAttribute('aria-label', label);
      el.addEventListener('change', () => { on(Number(el.value)); this.save(); });
      return el;
    };
    if (s.stat === 'prob_lt') row('threshold', num(s.threshold, (v) => { s.threshold = v; }, 'Threshold'));
    row('goal', select([['<', 'less than'], ['>', 'greater than']], s.op, (v) => { s.op = v; this.save(); }, 'Goal operator'), num(s.stat === 'prob_lt' ? s.value * 100 : s.value, (v) => { s.value = s.stat === 'prob_lt' ? v / 100 : v; }, 'Goal value'), spanText(s.stat === 'prob_lt' ? '%' : 'USD/month'));
    row('by changing', select(inputs, s.decision, (v) => { s.decision = v; this.save(); }, 'Decision input'));
    const run = document.createElement('button');
    run.className = 'ms-btn is-small';
    run.textContent = 'Run goal seek';
    run.addEventListener('click', () => this.runGoal());
    row('', run);
    body.appendChild(form);
    this.goalOut = document.createElement('div');
    this.goalOut.className = 'ms-scn-goal';
    body.appendChild(this.goalOut);
    if (this.goalResult) this.drawGoal();
  }

  runGoal() {
    const ctx = /** @type {any} */ (this.ctx);
    const s = this.state.goal;
    const t0 = performance.now();
    const { result, scenarioId, reused } = ctx.services.scenarios.goalSeek({
      target: { id: s.target, stat: s.stat, threshold: s.threshold },
      goal: { op: s.op, value: s.value },
      decision: { id: s.decision },
    });
    this.goalResult = { result, scenarioId, reused, ms: performance.now() - t0, spec: { ...s } };
    if (scenarioId) this.state.compare = [...new Set([...this.state.compare, scenarioId])].slice(-4);
    ctx.store.set('status.tokens', { count: 0, local: true, touched: true, kind: 'goal seek' });
    this.drawGoal();
  }

  drawGoal() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const out = this.goalOut;
    if (!out || !this.goalResult) return;
    this.bv.releaseWithin(out);
    out.replaceChildren();
    const { result, scenarioId, reused, ms, spec } = this.goalResult;
    const card = document.createElement('div');
    card.className = 'ms-pcard';
    const head = document.createElement('div');
    head.className = 'ms-pcard-head';
    const st = document.createElement('span');
    st.className = 'ms-status';
    st.dataset.status = result.ok ? 'pass' : 'fail';
    st.textContent = result.ok ? (scenarioId ? (reused ? 'existing scenario' : 'scenario written') : 'already met') : 'no solution';
    const title = document.createElement('span');
    title.className = 'ms-pcard-title';
    title.textContent = scenarioId ? ctx.services.scenarios.label(scenarioId) : 'Goal seek';
    head.append(st, title);
    const body = document.createElement('div');
    body.className = 'ms-pcard-body';
    const msg = document.createElement('p');
    msg.className = 'ms-small';
    msg.textContent = result.message;
    body.appendChild(msg);
    if (scenarioId) {
      const dn = g.node(spec.decision);
      const line = document.createElement('div');
      line.className = 'ms-scn-goal-line';
      const targetNode = spec.stat === 'prob_lt' && spec.target === 'sc_bakery.monthly_cash' && spec.threshold === 0 ? 'sc_bakery.p_cash_negative' : null;
      line.append(`${dn.name}: `, this.bv.create({ node: spec.decision, scenario: scenarioId }), ' (now ', this.bv.create({ node: spec.decision }), ')');
      body.appendChild(line);
      if (targetNode) {
        const l2 = document.createElement('div');
        l2.className = 'ms-scn-goal-line';
        l2.append('P(negative month): ', this.bv.create({ node: targetNode, scenario: scenarioId }), ' (now ', this.bv.create({ node: targetNode }), ')');
        body.appendChild(l2);
      }
      const act = document.createElement('div');
      act.className = 'ms-row';
      const mk = document.createElement('button');
      mk.className = 'ms-btn is-small';
      mk.textContent = 'Make active';
      mk.addEventListener('click', () => ctx.services.scenarios.setActive(scenarioId));
      const cmp = document.createElement('button');
      cmp.className = 'ms-btn is-secondary is-small';
      cmp.textContent = 'Compare';
      cmp.addEventListener('click', () => { this.state.tab = 'compare'; this.buildMain(); });
      act.append(mk, cmp);
      body.appendChild(act);
    }
    // trace
    if (result.trace.length > 1) {
      const d3 = this.d3;
      const W = 360;
      const H = 120;
      const xs = d3.scaleLinear().domain(d3.extent(result.trace, (d) => d.x)).nice().range([40, W - 10]);
      const ys = d3.scaleLinear().domain(d3.extent(result.trace.concat([{ x: 0, y: spec.value }]), (d) => d.y)).nice().range([H - 22, 8]);
      const svg = d3.create('svg').attr('class', 'ms-scn-trace').attr('width', W).attr('height', H).attr('role', 'img').attr('aria-label', 'Goal seek evaluations');
      svg.append('line').attr('x1', 40).attr('x2', W - 10).attr('y1', ys(spec.value)).attr('y2', ys(spec.value)).attr('class', 'goal');
      svg.append('g').selectAll('circle').data(result.trace).join('circle').attr('cx', (d) => xs(d.x)).attr('cy', (d) => ys(d.y)).attr('r', 3.5).attr('class', 'pt');
      const ax = svg.append('g').attr('transform', `translate(0, ${H - 20})`).call(d3.axisBottom(xs).ticks(4));
      const ay = svg.append('g').attr('transform', 'translate(40, 0)').call(d3.axisLeft(ys).ticks(3).tickFormat((v) => (spec.stat === 'prob_lt' ? pct(Number(v)) : unitValue(Number(v), 'USD', { compact: true }))));
      for (const a of [ax, ay]) { a.selectAll('path,line').attr('stroke', 'var(--vscode-editorGroup-border)'); a.selectAll('text').attr('fill', 'var(--vscode-descriptionForeground)'); }
      body.appendChild(svg.node());
      const n = document.createElement('div');
      n.className = 'ms-small ms-muted';
      n.textContent = `${result.trace.length} Monte Carlo evaluations · ${Math.round(ms)} ms · dashed line = goal`;
      body.appendChild(n);
    }
    card.append(head, body);
    out.appendChild(card);
  }

  // ------------------------------------------------------------------ lifecycle

  destroyChart() {
    this.chart?.destroy();
    this.chart = null;
  }

  onRecompute(changed, payload) {
    if (payload?.transient) {
      this.bv.update(changed);
      return;
    }
    this.bv.updateAll();
    if (this.state.tab === 'compare') this.dirty = true;
    this.invalidate();
  }

  render() {
    if (this.dirty) {
      this.dirty = false;
      this.buildMain();
    }
  }

  onScenario() {
    const ids = /** @type {any} */ (this.ctx).services.scenarios.list().map((s) => s.id);
    this.state.compare = this.state.compare.filter((id) => ids.includes(id));
    this.buildSide();
    this.consumeRequest();
    if (this.state.tab === 'compare') this.buildMain();
    else this.bv.updateAll();
  }

  onStructure() { this.buildSide(); this.buildMain(); }
  onTheme() { applyChartTheme(this.Chart); this.buildMain(); }
  onHover(id) { this.bv.hover(id); }

  dispose() {
    this.destroyChart();
    if (this.sweepAbort) this.sweepAbort.aborted = true;
    this.root?.remove();
    super.dispose();
  }
}

/** @param {number} x */
function round(x) {
  if (!Number.isFinite(x)) return x;
  return Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 1000) / 1000;
}

/** @param {number} x */
function shortNum(x) {
  return Math.abs(x) >= 1000 ? `${Math.round(x / 100) / 10}k` : String(round(x));
}

/** @param {string} t */
function spanText(t) {
  const s = document.createElement('span');
  s.className = 'ms-unit';
  s.textContent = t;
  return s;
}

/** Relative luminance of an rgb()/hex color (text contrast on heat cells). @param {string} c */
function luminance(c) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  let r; let g; let b;
  if (m) [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    const h = c.replace('#', '');
    [r, g, b] = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

void formatAs;
void defaultFmt;
