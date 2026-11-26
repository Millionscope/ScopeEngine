/**
 * Sensitivity: tornado chart of first-order Sobol indices (or low/high swings) for the focused
 * output, bars colored by the input's provenance (glyph + label too), top 10 with "show more".
 * Second tab: value of information for estimated inputs ("research these first") with a button
 * that sends /research @input to the composer. Clicking a bar selects that input everywhere.
 * Recomputed lazily (debounced) and only while visible.
 * @module editors/sensitivity
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { tableView, tableToggle } from '../shared/chart-table.js';
import { loadCss } from '../../core/lazy.js';
import { unitValue } from '../../model/format.js';
import { d3Palette } from '../../theme/adapters/d3.js';
import { PROVENANCE } from '../../theme/tokens.js';

export default class SensitivityEditor extends BaseEditor {
  static id = 'sensitivity';
  static label = 'Sensitivity';
  static icon = 'graph-left';
  static group = 'Analysis';
  static needs = ['d3'];
  static usesScenario = true;

  async mount(ctx, state) {
    await loadCss(new URL('./sensitivity.css', import.meta.url));
    this.d3 = ctx.libs.d3;
    this.state = { tab: state.tab || 'tornado', metric: state.metric || 'sobol', showAll: !!state.showAll, table: !!state.table };
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-sens';
    this.tabs = document.createElement('div');
    this.tabs.className = 'ms-tabs';
    this.tabs.setAttribute('role', 'tablist');
    this.head = document.createElement('div');
    this.head.className = 'ms-sens-head';
    this.body = document.createElement('div');
    this.body.className = 'ms-ed-scroll ms-sens-body';
    this.foot = document.createElement('div');
    this.foot.className = 'ms-ed-foot';
    this.root.append(this.tabs, this.head, this.body, this.foot);
    ctx.el.appendChild(this.root);
    const sel = ctx.services.selection.get();
    this.output = this.pickOutput(sel.primary);
    this.hovered = null;
    this.width = ctx.el.clientWidth || 400;
    this.buildTabs();
    this.compute();
  }

  getState() { return { ...this.state }; }

  /** @param {string|null} id */
  pickOutput(id) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const n = id ? g.node(id) : null;
    if (n && n.kind === 'computed' && g.inputsOf(id).length) return id;
    return this.output || 'sc_bakery.monthly_cash';
  }

  getHeaderTools() {
    const ctx = /** @type {any} */ (this.ctx);
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const seg = document.createElement('div');
    seg.className = 'ms-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Tornado measure');
    for (const [label, val, tip] of [['Sobol', 'sobol', 'First-order Sobol index: share of output variance explained'], ['Swing', 'swing', 'Low/high swing: output at the input’s p10/p90 or range ends']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.tooltip = tip;
      b.setAttribute('aria-pressed', String(this.state.metric === val));
      b.addEventListener('click', () => { this.state.metric = val; this.save(); this.draw(); ctx.refreshHeader(); });
      seg.appendChild(b);
    }
    const tt = tableToggle(this.state.table, (v) => { this.state.table = v; this.save(); this.draw(); ctx.refreshHeader(); });
    wrap.append(seg, tt);
    return [wrap];
  }

  buildTabs() {
    this.tabs.replaceChildren();
    for (const [id, label] of [['tornado', 'Drivers (tornado)'], ['voi', 'Value of information']]) {
      const b = document.createElement('button');
      b.className = 'ms-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(this.state.tab === id));
      b.textContent = label;
      b.addEventListener('click', () => { this.state.tab = id; this.save(); this.buildTabs(); this.draw(); });
      this.tabs.appendChild(b);
    }
  }

  compute() {
    const ctx = /** @type {any} */ (this.ctx);
    const t0 = performance.now();
    try {
      this.result = ctx.engine.sensitivity(this.output, { scenarioId: this.scenarioId() });
    } catch (err) {
      this.result = null;
      console.error(err);
    }
    this.ms = performance.now() - t0;
    this.draw();
  }

  draw() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const d3 = this.d3;
    const P = d3Palette(d3);
    this.head.replaceChildren();
    this.body.replaceChildren();
    const res = this.result;
    const n = g.node(this.output);
    if (!res || !n) {
      this.body.appendChild(emptyState({ icon: 'graph-left', title: 'Select a computed output', text: 'Sensitivity ranks the assumptions upstream of a computed metric.' }));
      return;
    }
    const title = document.createElement('div');
    title.className = 'ms-sens-title';
    const name = document.createElement('strong');
    name.textContent = n.label || g.path(this.output);
    name.title = g.path(this.output);
    const sub = document.createElement('span');
    sub.className = 'ms-muted ms-small';
    sub.textContent = this.state.tab === 'voi' ? 'how much its spread (sd) would shrink if each estimate were known exactly' : this.state.metric === 'sobol' ? 'share of variance explained by each assumption' : 'output when each assumption moves to its low / high end';
    title.append(name, sub);
    this.head.appendChild(title);

    // Sobol ranks uncertainties only (decisions stay at their values); Swing ranks every assumption
    let items = this.state.tab === 'voi' ? res.items.filter((it) => it.voi != null && it.voi > 0).sort((a, b) => b.voi - a.voi)
      : this.state.metric === 'swing' ? res.items.slice().sort((a, b) => b.swing - a.swing)
        : res.items.filter((it) => !it.decision);
    const total = items.length;
    if (!this.state.showAll) items = items.slice(0, 10);
    if (!items.length) {
      this.body.appendChild(emptyState({ icon: 'info', title: 'Nothing to rank', text: this.state.tab === 'voi' ? 'No estimated inputs upstream of this output.' : 'No varying inputs upstream.' }));
      return;
    }

    if (this.state.table) {
      const unit = n.type.unit;
      this.body.appendChild(tableView({
        caption: `Sensitivity of ${n.name}`,
        columns: this.state.tab === 'voi'
          ? [{ label: 'estimate' }, { label: 'provenance' }, { label: `sd reduction (${unit})`, align: 'right' }, { label: 'first-order index', align: 'right' }]
          : [{ label: 'assumption' }, { label: 'provenance' }, { label: 'first-order index', align: 'right' }, { label: 'output at low', align: 'right' }, { label: 'output at high', align: 'right' }, { label: 'range from' }],
        rows: items.map((it) => (this.state.tab === 'voi'
          ? [it.path, PROVENANCE[it.prov]?.label || it.prov, unitValue(/** @type {number} */ (it.voi), unit, { bare: true }), it.sobol.toFixed(3)]
          : [it.path, PROVENANCE[it.prov]?.label || it.prov, it.sobol.toFixed(3), unitValue(it.low, unit, { bare: true }), unitValue(it.high, unit, { bare: true }), it.rangeSource])),
      }));
    } else this.drawBars(items, P, n);

    if (total > 10) {
      const more = document.createElement('button');
      more.className = 'ms-btn is-secondary is-small ms-sens-more';
      more.textContent = this.state.showAll ? 'Show top ten' : `Show all ${total}`;
      more.addEventListener('click', () => { this.state.showAll = !this.state.showAll; this.save(); this.draw(); });
      this.body.appendChild(more);
    }
    const scen = this.scenarioId();
    this.foot.textContent = `${res.method || 'first-order Sobol'} · ${this.state.tab === 'tornado' && this.state.metric === 'swing' ? 'one at a time across each p10–p90 or declared range' : `${res.n.toLocaleString('en-US')} samples; uncertain assumptions vary, decision inputs stay at their values (see Swing)`} · ${Math.round(this.ms || res.ms)} ms${scen && scen !== 'base' ? ` · scenario ${ctx.services.scenarios.label(scen)}` : ''}`;
  }

  /** @param {any[]} items @param {any} P @param {any} n */
  drawBars(items, P, n) {
    const ctx = /** @type {any} */ (this.ctx);
    const d3 = this.d3;
    const unit = n.type.unit;
    const W = Math.max(280, (this.body.clientWidth || this.width) - 16);
    const rowH = 26;
    const labelW = Math.min(170, Math.max(110, W * 0.32));
    const valueW = 72;
    const H = items.length * rowH + 28;
    const svg = d3.create('svg')
      .attr('class', 'ms-sens-svg')
      .attr('width', W)
      .attr('height', H)
      .attr('role', 'img')
      .attr('aria-label', `${this.state.tab === 'voi' ? 'Value of information' : 'Tornado chart'} for ${n.name}`);
    const plotL = labelW + 6;
    const plotR = W - valueW - (this.state.tab === 'voi' ? 70 : 0);
    let x;
    const swing = this.state.tab === 'tornado' && this.state.metric === 'swing';
    if (this.state.tab === 'voi') x = d3.scaleLinear().domain([0, d3.max(items, (d) => d.voi) || 1]).range([plotL, plotR]);
    else if (swing) {
      const ext = d3.extent(items.flatMap((d) => [d.low, d.high]).concat([this.result.base]));
      x = d3.scaleLinear().domain(ext).nice().range([plotL, plotR]);
    } else x = d3.scaleLinear().domain([0, Math.max(0.05, d3.max(items, (d) => d.sobol) || 0)]).range([plotL, plotR]);

    // axis
    const axis = svg.append('g').attr('class', 'ms-sens-axis').attr('transform', `translate(0, ${H - 20})`);
    axis.call(d3.axisBottom(x).ticks(Math.max(2, Math.floor((plotR - plotL) / 90))).tickFormat((v) => (this.state.tab === 'voi' || swing ? unitValue(Number(v), unit, { compact: true, bare: true }) : Number(v).toFixed(2))));
    axis.selectAll('path,line').attr('stroke', 'var(--vscode-editorGroup-border)');
    axis.selectAll('text').attr('fill', 'var(--vscode-descriptionForeground)');
    if (swing) {
      svg.append('line').attr('class', 'ms-sens-base').attr('x1', x(this.result.base)).attr('x2', x(this.result.base)).attr('y1', 0).attr('y2', H - 20);
    }
    const g = svg.append('g');
    const row = g.selectAll('g.row').data(items).join('g')
      .attr('class', 'row')
      .attr('transform', (_, i) => `translate(0, ${i * rowH + 2})`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (d) => `${d.path}, ${PROVENANCE[d.prov]?.label}, ${this.state.tab === 'voi' ? `value of information ${unitValue(d.voi, unit)}` : `index ${d.sobol.toFixed(2)}`}. Press Enter to select.`)
      .classed('is-hovered', (d) => d.id === this.hovered)
      .on('click', (_, d) => this.select([d.id]))
      .on('keydown', (e, d) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select([d.id]); } })
      .on('pointerenter', (_, d) => this.hover(d.id))
      .on('pointerleave', () => this.hover(null));
    row.append('rect').attr('class', 'hit').attr('x', 0).attr('y', 0).attr('width', W).attr('height', rowH - 2);
    // label: glyph + name
    row.append('text').attr('class', 'glyph').attr('x', 4).attr('y', rowH / 2).attr('dy', '0.35em')
      .attr('fill', (d) => `var(${PROVENANCE[d.prov]?.var || '--ms-prov-computed'})`)
      .text((d) => PROVENANCE[d.prov]?.glyph || '');
    row.append('text').attr('class', 'label').attr('x', 18).attr('y', rowH / 2).attr('dy', '0.35em')
      .text((d) => truncate(d.path.split('.').slice(-2).join('.'), Math.floor((labelW - 18) / 6.4)))
      .append('title').text((d) => `${d.path} · ${PROVENANCE[d.prov]?.label} · range from ${d.rangeSource}`);
    const barY = 6;
    const barH = rowH - 14;
    if (this.state.tab === 'voi') {
      row.append('rect').attr('class', 'bar').attr('x', plotL).attr('y', barY).attr('height', barH).attr('rx', 2)
        .attr('width', (d) => Math.max(1, x(d.voi) - plotL))
        .attr('fill', (d) => `var(${PROVENANCE[d.prov]?.var || '--ms-prov-estimated'})`);
      row.append('text').attr('class', 'value').attr('x', (d) => x(d.voi) + 4).attr('y', rowH / 2).attr('dy', '0.35em')
        .text((d) => unitValue(d.voi, unit, { compact: true, bare: true }));
      // research buttons (HTML overlay)
      this.body.appendChild(svg.node());
      const overlay = document.createElement('div');
      overlay.className = 'ms-sens-actions';
      overlay.style.height = `${H}px`;
      items.forEach((d, i) => {
        const b = document.createElement('button');
        b.className = 'ms-btn is-secondary is-small';
        b.style.top = `${i * rowH + 4}px`;
        b.textContent = 'Research';
        b.setAttribute('aria-label', `Research ${d.path}`);
        b.dataset.tooltip = `Send /research @${d.path} to the composer`;
        b.addEventListener('click', () => ctx.commands.execute('composer.insert', `/research @${d.path}`, { replace: true }));
        overlay.appendChild(b);
      });
      this.body.appendChild(overlay);
      return;
    }
    if (swing) {
      row.append('rect').attr('class', 'bar').attr('y', barY).attr('height', barH).attr('rx', 2)
        .attr('x', (d) => Math.min(x(d.low), x(d.high)))
        .attr('width', (d) => Math.max(1, Math.abs(x(d.high) - x(d.low))))
        .attr('fill', (d) => `var(${PROVENANCE[d.prov]?.var || '--ms-prov-computed'})`);
      row.append('text').attr('class', 'value').attr('x', plotR + 6).attr('y', rowH / 2).attr('dy', '0.35em')
        .text((d) => `±${unitValue(Math.abs(d.high - d.low) / 2, unit, { compact: true, bare: true })}`);
    } else {
      row.append('rect').attr('class', 'bar').attr('x', plotL).attr('y', barY).attr('height', barH).attr('rx', 2)
        .attr('width', (d) => Math.max(1, x(d.sobol) - plotL))
        .attr('fill', (d) => `var(${PROVENANCE[d.prov]?.var || '--ms-prov-computed'})`);
      row.append('text').attr('class', 'value').attr('x', (d) => x(d.sobol) + 4).attr('y', rowH / 2).attr('dy', '0.35em')
        .text((d) => d.sobol.toFixed(2));
    }
    this.body.appendChild(svg.node());
    void P;
  }

  resize(w) {
    this.width = w;
    this.redraw = true;
    this.invalidate();
  }

  onSelection(sel) {
    const next = this.pickOutput(sel.primary);
    if (next !== this.output) {
      this.output = next;
      this.compute();
    }
  }

  onHover(id) {
    this.hovered = id;
    for (const r of this.body.querySelectorAll('g.row')) {
      const d = /** @type {any} */ (r).__data__;
      r.classList.toggle('is-hovered', !!id && d?.id === id);
    }
  }

  onRecompute(changed, payload) {
    // debounced: sensitivity costs tens of ms; never recompute on every drag frame
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.stale = true; this.invalidate(); }, payload?.transient ? 400 : 150);
  }

  render() {
    if (this.stale) {
      this.stale = false;
      this.compute();
    } else if (this.redraw) {
      this.redraw = false;
      this.draw();
    }
  }

  onStructure() { this.stale = true; this.invalidate(); }
  onScenario() { this.compute(); }
  onTheme() { this.draw(); }

  dispose() {
    clearTimeout(this.timer);
    this.root?.remove();
    super.dispose();
  }
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}
