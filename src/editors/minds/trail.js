/**
 * Evidence trail of an inference (inverse planning): what the party did and said, in order,
 * each observation's log Bayes factor as a waterfall (H1: hidden state above one half vs H0),
 * and the prior vs posterior curves. Infer calls mind.infer, which writes the posterior to the
 * graph as an estimated distribution, so every downstream number recomputes (shown live here).
 * Speech on record is shown as a simulation voice, never like the assistant.
 * @module editors/minds/trail
 */
import { sparkline } from '../shared/sparkline.js';
import { scopeChip } from '../shared/scope-chip.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { tableView } from '../shared/chart-table.js';
import { h, icon, button, partyStrip, svgEl, speechBlock, signed, strengthWord, sourceIcon } from './view.js';

/** P(theta > 0.5) on a grid. @param {number[]} xs @param {number[]} ps */
function massAbove(xs, ps) {
  let s = 0;
  let t = 0;
  for (let i = 0; i < xs.length; i++) {
    t += ps[i];
    if (xs[i] > 0.5) s += ps[i];
  }
  return t ? s / t : 0.5;
}

/** @param {number} p */
const logit = (p) => Math.log(Math.max(1e-9, p) / Math.max(1e-9, 1 - p));

/** Normalized Beta(a, b) on a midpoint grid (for the prior preview before any inference). */
function betaGrid(a, b, n = 201) {
  const xs = [];
  const ps = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const p = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x));
    xs.push(x);
    ps.push(p);
    s += p;
  }
  return { xs, ps: ps.map((p) => p / (s || 1)) };
}

/** Mean on a grid. @param {number[]} xs @param {number[]} ps */
function meanOf(xs, ps) {
  let m = 0;
  for (let i = 0; i < xs.length; i++) m += xs[i] * ps[i];
  return m;
}

export class TrailView {
  /**
   * @param {HTMLElement} el @param {any} m party profile
   * @param {import('./view.js').MindsHost} host
   */
  constructor(el, m, host) {
    this.host = host;
    this.m = m;
    this.res = host.mind.results.get(m.id) || null;
    this.wrap = h('div', 'ms-mind-trail');
    this.wrap.appendChild(partyStrip(m, host));
    this.wrap.appendChild(this.topBlock());
    this.chartsEl = h('div', 'ms-mind-trail-charts');
    this.obsEl = h('section', 'ms-mind-sec ms-mind-obs-sec');
    this.wrap.append(this.chartsEl, this.obsEl);
    el.appendChild(this.wrap);
    this.drawCharts();
    this.drawObservations();
  }

  get g() { return this.host.ctx.engine.graph; }

  // ------------------------------------------------------------------ hidden state + infer

  topBlock() {
    const { host, m } = this;
    const g = this.g;
    const id = m.hidden.nodeId;
    const top = h('section', 'ms-mind-trail-top');
    const hid = h('div', 'ms-mind-trail-hidden');
    const lab = h('div', 'ms-mind-hidden-label');
    lab.append(icon('eye-closed'), document.createTextNode(`Hidden state: ${m.hidden.name}`));
    hid.appendChild(lab);
    if (g.node(id)) {
      const row = h('div', 'ms-mind-hidden-row');
      this.spark = h('span', 'ms-mind-spark-host');
      const iv = h('span', 'ms-mind-iv');
      iv.append('p10 ', host.bv.create({ node: id, stat: 'p10', glyph: false, plain: true }), ' to p90 ', host.bv.create({ node: id, stat: 'p90', glyph: false, plain: true }));
      row.append(scopeChip(g, id, { onClick: (nid) => host.select([nid]) }), this.spark, host.bv.create({ node: id, stat: 'p50' }), iv);
      hid.appendChild(row);
      this.srcEl = h('div', 'ms-mind-hidden-src');
      hid.appendChild(this.srcEl);
      this.refreshHidden();
    } else {
      hid.appendChild(h('div', 'ms-muted ms-small', 'This hidden state is not in the current graph.'));
    }
    const act = h('div', 'ms-mind-trail-actions');
    const infer = button(`Infer from ${m.observations.length} observations`, 'play', () => host.infer(), 'ms-btn');
    infer.classList.add('ms-mind-infer');
    infer.setAttribute('aria-label', `Infer ${m.name}'s ${m.hidden.name} from ${m.observations.length} observations`);
    infer.disabled = !g.node(id);
    const why = h('p', 'ms-mind-why', 'Inverse planning: which hidden state best explains what this party did and said. The posterior is written to the graph as an estimated distribution, and every number downstream recomputes.');
    act.append(infer, why);
    top.append(hid, act, this.downstream());
    return top;
  }

  refreshHidden() {
    const id = this.m.hidden.nodeId;
    const engine = this.host.ctx.engine;
    if (!this.spark || !engine.graph.node(id)) return;
    const st = engine.stats(id);
    this.spark.replaceChildren(sparkline(engine.sample(id), { width: 96, height: 22, color: 'var(--ms-prov-estimated)', p50: st?.p50, label: `${this.m.hidden.name} distribution` }));
    const by = engine.graph.node(id)?.prov?.by;
    if (this.srcEl) this.srcEl.textContent = by ? `estimated by ${by}` : 'estimated';
  }

  /** Metrics that depend on the hidden state: they move when inference lands. */
  downstream() {
    const { host, m } = this;
    const g = this.g;
    const id = m.hidden.nodeId;
    const box = h('div', 'ms-mind-downstream');
    box.appendChild(h('span', 'ms-mind-ds-label', 'Downstream'));
    if (!g.node(id)) return box;
    const ids = [...g.dependents(id)];
    for (const d of g.downstream(id)) {
      const n = g.node(d);
      if (ids.length >= 4) break;
      if (n && (n.output || n.headline) && !ids.includes(d)) ids.push(d);
    }
    if (!ids.length) {
      box.appendChild(h('span', 'ms-muted ms-small', 'No metric depends on this hidden state yet; inference updates the estimate only.'));
      return box;
    }
    for (const d of ids.slice(0, 4)) {
      const item = h('span', 'ms-mind-ds-item');
      const st = host.ctx.engine.stats(d);
      item.append(scopeChip(g, d, { onClick: (nid) => host.select([nid]) }), host.bv.create({ node: d, stat: st && !st.deterministic ? 'p50' : 'value' }));
      box.appendChild(item);
    }
    return box;
  }

  // ------------------------------------------------------------------ charts

  drawCharts() {
    const { host, m } = this;
    host.bv.releaseWithin(this.chartsEl);
    this.chartsEl.replaceChildren();
    const res = this.res;
    if (host.table) {
      if (!res) {
        this.chartsEl.appendChild(emptyState({ icon: 'pulse', title: 'No inference yet', text: 'Infer to list each observation’s log Bayes factor and the prior vs posterior summary.', action: { label: 'Infer', run: () => host.infer() } }));
        return;
      }
      this.chartsEl.append(this.trailTable(res), this.summaryTable(res));
      return;
    }
    const W = Math.max(280, host.width());
    const sideBySide = W >= 780;
    const figW = sideBySide ? Math.floor((W - 16) / 2) : W;
    this.chartsEl.classList.toggle('is-side', sideBySide);
    if (res) this.chartsEl.appendChild(this.waterfallFigure(res, figW));
    else {
      const fig = h('figure', 'ms-mind-fig is-empty');
      fig.appendChild(emptyState({ icon: 'pulse', title: 'No inference yet', text: `Infer to see how each of the ${m.observations.length} observations moves the estimate (log Bayes factors) and the posterior it produces.`, action: { label: 'Infer', run: () => host.infer() } }));
      this.chartsEl.appendChild(fig);
    }
    let xs;
    let prior;
    let post = null;
    if (res) {
      xs = res.grid;
      prior = res.prior;
      post = res.posterior;
    } else {
      const bg = betaGrid(m.hidden.prior.alpha, m.hidden.prior.beta);
      xs = bg.xs;
      prior = bg.ps;
    }
    this.chartsEl.appendChild(this.curvesFigure(xs, prior, post, figW));
  }

  /** @param {string} title @param {string} sub */
  figHead(title, sub) {
    const cap = h('figcaption', 'ms-mind-fig-cap');
    cap.append(h('div', 'ms-mind-fig-title', title), h('div', 'ms-mind-fig-sub', sub));
    return cap;
  }

  /** @param {Array<[string, string, string?]>} items [cls, label, kind] */
  legend(items) {
    const lg = h('div', 'ms-legend ms-mind-legend');
    for (const [cls, label, kind] of items) {
      const it = h('span', 'ms-legend-item');
      const key = h('span', `ms-legend-key ${kind === 'rect' ? 'is-rect ' : ''}${cls}`);
      key.setAttribute('aria-hidden', 'true');
      it.append(key, document.createTextNode(label));
      lg.appendChild(it);
    }
    return lg;
  }

  /** Steps of the waterfall. @param {any} res */
  steps(res) {
    const name = this.m.hidden.name;
    const priorLO = logit(massAbove(res.grid, res.prior));
    const steps = [{ kind: 'prior', label: 'prior', from: 0, to: priorLO, v: priorLO, tip: `Prior log-odds that ${name} is above one half: ${signed(priorLO)}` }];
    let run = priorLO;
    for (const t of res.trail) {
      steps.push({
        kind: t.lbf >= 0 ? 'pos' : 'neg', label: t.when, from: run, to: run + t.lbf, v: t.lbf, t,
        tip: `${t.when}: ${t.text}. Log Bayes factor ${signed(t.lbf)} (${strengthWord(t.lbf)}, ${t.lbf >= 0 ? 'for' : 'against'}).`,
      });
      run += t.lbf;
    }
    steps.push({ kind: 'post', label: 'posterior', from: 0, to: run, v: run, tip: `Posterior log-odds that ${name} is above one half: ${signed(run)}` });
    return steps;
  }

  /** @param {any} res @param {number} W */
  waterfallFigure(res, W) {
    const d3 = this.host.d3;
    const name = this.m.hidden.name;
    const fig = h('figure', 'ms-mind-fig');
    fig.appendChild(this.figHead('Log Bayes factors', `How each observation moves the log-odds that ${name} is above one half`));
    fig.appendChild(this.legend([['is-pos', 'for', 'rect'], ['is-neg', 'against', 'rect'], ['is-total', 'prior and posterior', 'rect']]));
    const steps = this.steps(res);
    const labelW = Math.round(Math.min(110, Math.max(64, W * 0.2)));
    const rowH = 26;
    const barH = 14;
    const top = 6;
    const bottom = 40;
    const H = top + steps.length * rowH + bottom;
    let lo = 0;
    let hi = 0;
    for (const s of steps) { lo = Math.min(lo, s.from, s.to); hi = Math.max(hi, s.from, s.to); }
    const pad = (hi - lo) * 0.2 || 1;
    const x = d3.scaleLinear().domain([lo - pad, hi + pad]).range([labelW + 10, W - 14]).nice();
    const svg = /** @type {SVGSVGElement} */ (svgEl('svg', { class: 'ms-mind-wf', width: W, height: H, viewBox: `0 0 ${W} ${H}` }));
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `Waterfall of log Bayes factors for ${name}. Use Tab to step through the bars; the table view lists the same values.`);
    const plotB = top + steps.length * rowH;
    for (const t of x.ticks(5)) svg.appendChild(svgEl('line', { class: 'grid', x1: x(t), x2: x(t), y1: top, y2: plotB }));
    svg.appendChild(svgEl('line', { class: 'zero', x1: x(0), x2: x(0), y1: top, y2: plotB }));
    steps.forEach((s, i) => {
      const y = top + i * rowH;
      const gRow = svgEl('g', { class: `wf-row is-${s.kind}`, tabindex: 0, role: 'img' });
      gRow.setAttribute('aria-label', s.tip);
      /** @type {any} */ (gRow).dataset.tooltip = s.tip;
      gRow.appendChild(svgEl('rect', { class: 'hit', x: 0, y, width: W, height: rowH }));
      const lab = svgEl('text', { class: `lab${s.kind === 'prior' || s.kind === 'post' ? ' is-total' : ''}`, x: labelW, y: y + rowH / 2, dy: '0.35em', 'text-anchor': 'end' });
      lab.textContent = s.label;
      const x0 = x(Math.min(s.from, s.to));
      const x1 = x(Math.max(s.from, s.to));
      const bar = svgEl('rect', { class: `bar is-${s.kind === 'prior' || s.kind === 'post' ? 'total' : s.kind}`, x: x0, y: y + (rowH - barH) / 2, width: Math.max(1.5, x1 - x0), height: barH, rx: 3 });
      const right = s.kind === 'prior' || s.kind === 'post' ? s.to >= 0 : s.v >= 0;
      const val = svgEl('text', { class: 'val', x: right ? x1 + 4 : x0 - 4, y: y + rowH / 2, dy: '0.35em', 'text-anchor': right ? 'start' : 'end' });
      val.textContent = signed(s.v);
      gRow.append(lab, bar, val);
      if (i < steps.length - 1) {
        const yb = y + (rowH + barH) / 2;
        const xn = x(s.to);
        gRow.appendChild(svgEl('line', { class: 'conn', x1: xn, x2: xn, y1: yb, y2: yb + rowH - barH }));
      }
      svg.appendChild(gRow);
    });
    const axis = svgEl('g', { class: 'axis', transform: `translate(0,${plotB})` });
    d3.select(axis).call(d3.axisBottom(x).ticks(5).tickSizeOuter(0).tickFormat((v) => signed(Number(v), Math.abs(Number(v)) < 10 && Number(v) % 1 ? 1 : 0)));
    svg.appendChild(axis);
    const at = svgEl('text', { class: 'axis-title', x: (labelW + W) / 2, y: H - 6, 'text-anchor': 'middle' });
    at.textContent = 'log-odds (0 = even odds)';
    svg.appendChild(at);
    const wrap = h('div', 'ms-mind-chart');
    wrap.appendChild(svg);
    fig.appendChild(wrap);
    return fig;
  }

  /**
   * Prior vs posterior densities with a crosshair readout (pointer or arrow keys).
   * @param {number[]} xs @param {number[]} prior @param {number[]|null} post @param {number} W
   */
  curvesFigure(xs, prior, post, W) {
    const d3 = this.host.d3;
    const name = this.m.hidden.name;
    const N = xs.length;
    const dens = (ps) => ps.map((p) => p * N);
    const dPrior = dens(prior);
    const dPost = post ? dens(post) : null;
    const fig = h('figure', 'ms-mind-fig');
    fig.appendChild(this.figHead(post ? 'Prior and posterior' : 'Prior', post ? `Distribution of ${name} before and after the observations` : `Distribution of ${name} before any observation. Infer to add the posterior.`));
    if (post) fig.appendChild(this.legend([['is-prior-line', 'prior'], ['is-post-line', 'posterior']]));
    const H = 196;
    const m = { l: 36, r: 14, t: 18, b: 38 };
    const ymax = Math.max(...dPrior, ...(dPost || [0])) * 1.12 || 1;
    const x = d3.scaleLinear().domain([0, 1]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, ymax]).range([H - m.b, m.t]).nice();
    const svg = /** @type {SVGSVGElement} */ (svgEl('svg', { class: 'ms-mind-curves', width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: 0 }));
    const pm = meanOf(xs, prior);
    const qm = post ? meanOf(xs, post) : null;
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${post ? 'Prior and posterior' : 'Prior'} density of ${name}. Prior mean ${pm.toFixed(2)}${qm != null ? `, posterior mean ${qm.toFixed(2)}` : ''}. Arrow keys move a readout along the curve.`);
    for (const t of y.ticks(3)) svg.appendChild(svgEl('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
    // H0 | H1 split at one half
    svg.appendChild(svgEl('line', { class: 'split', x1: x(0.5), x2: x(0.5), y1: m.t - 6, y2: H - m.b }));
    const h0 = svgEl('text', { class: 'hyp', x: x(0.5) - 5, y: m.t - 6, 'text-anchor': 'end' });
    h0.textContent = 'H0: at or below one half';
    const h1 = svgEl('text', { class: 'hyp', x: x(0.5) + 5, y: m.t - 6, 'text-anchor': 'start' });
    h1.textContent = 'H1: above';
    svg.append(h0, h1);
    const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1])).curve(d3.curveMonotoneX);
    const ptsPrior = xs.map((v, i) => [v, dPrior[i]]);
    if (dPost) {
      const ptsPost = xs.map((v, i) => [v, dPost[i]]);
      const area = d3.area().x((d) => x(d[0])).y0(y(0)).y1((d) => y(d[1])).curve(d3.curveMonotoneX);
      svg.appendChild(svgEl('path', { class: 'post-area', d: area(ptsPost) }));
      svg.appendChild(svgEl('path', { class: 'prior', d: line(ptsPrior) }));
      svg.appendChild(svgEl('path', { class: 'post', d: line(ptsPost) }));
    } else {
      svg.appendChild(svgEl('path', { class: 'prior is-only', d: line(ptsPrior) }));
    }
    // mean markers + direct labels
    const at = (ds, v) => ds[Math.max(0, Math.min(N - 1, Math.round(v * N - 0.5)))];
    svg.appendChild(svgEl('circle', { class: 'mean is-prior', cx: x(pm), cy: y(at(dPrior, pm)), r: 4 }));
    if (dPost && qm != null) svg.appendChild(svgEl('circle', { class: 'mean is-post', cx: x(qm), cy: y(at(dPost, qm)), r: 4 }));
    const peak = (ds) => { let k = 0; for (let i = 1; i < ds.length; i++) if (ds[i] > ds[k]) k = i; return k; };
    const kp = peak(dPrior);
    let px = x(xs[kp]);
    let py = y(dPrior[kp]) - 8;
    let showPrior = true;
    if (dPost) {
      const kq = peak(dPost);
      const qx = x(xs[kq]);
      const qy = y(dPost[kq]) - 8;
      const lq = svgEl('text', { class: 'direct', x: qx, y: qy, 'text-anchor': 'middle' });
      lq.textContent = 'posterior';
      svg.appendChild(lq);
      // the prior's label goes where the prior is farthest above the posterior
      let best = 0;
      for (let i = 0; i < N; i += 2) {
        const vx = x(xs[i]);
        if (vx < m.l + 28 || vx > W - m.r - 28) continue;
        const d = y(dPost[i]) - y(dPrior[i]);
        if (d > best) { best = d; px = vx; py = y(dPrior[i]) - 8; }
      }
      // labels are selective: drop the prior's when it would still collide (legend and readout carry it)
      showPrior = best > 12 && (Math.abs(qx - px) > 72 || Math.abs(qy - py) > 16);
    }
    if (showPrior) {
      const lp = svgEl('text', { class: 'direct', x: px, y: py, 'text-anchor': 'middle' });
      lp.textContent = 'prior';
      svg.appendChild(lp);
    }
    const ax = svgEl('g', { class: 'axis', transform: `translate(0,${H - m.b})` });
    d3.select(ax).call(d3.axisBottom(x).tickValues([0, 0.25, 0.5, 0.75, 1]).tickSizeOuter(0).tickFormat(d3.format('.2~f')));
    const ay = svgEl('g', { class: 'axis', transform: `translate(${m.l},0)` });
    d3.select(ay).call(d3.axisLeft(y).ticks(3).tickSizeOuter(0));
    svg.append(ax, ay);
    const xt = svgEl('text', { class: 'axis-title', x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle' });
    xt.textContent = `${name} (0 to 1)`;
    svg.appendChild(xt);

    // crosshair readout
    const cross = svgEl('g', { class: 'cross', visibility: 'hidden' });
    const cl = svgEl('line', { y1: m.t, y2: H - m.b });
    const cp = svgEl('circle', { class: 'is-prior', r: 4 });
    const cq = svgEl('circle', { class: 'is-post', r: 4 });
    cross.append(cl, cp);
    if (dPost) cross.appendChild(cq);
    svg.appendChild(cross);
    const overlay = svgEl('rect', { class: 'overlay', x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b });
    svg.appendChild(overlay);
    const wrap = h('div', 'ms-mind-chart');
    const readout = h('div', 'ms-mind-readout');
    readout.hidden = true;
    readout.setAttribute('aria-live', 'polite');
    wrap.append(svg, readout);
    fig.appendChild(wrap);
    let idx = -1;
    const show = (i) => {
      idx = Math.max(0, Math.min(N - 1, i));
      const vx = x(xs[idx]);
      cross.setAttribute('visibility', 'visible');
      cl.setAttribute('x1', String(vx));
      cl.setAttribute('x2', String(vx));
      cp.setAttribute('cx', String(vx));
      cp.setAttribute('cy', String(y(dPrior[idx])));
      if (dPost) { cq.setAttribute('cx', String(vx)); cq.setAttribute('cy', String(y(dPost[idx]))); }
      readout.replaceChildren();
      const head = h('div', 'ms-mind-readout-x');
      head.append(h('strong', null, xs[idx].toFixed(2)), document.createTextNode(` ${name}`));
      readout.appendChild(head);
      const rowOf = (cls, label, v) => {
        const r = h('div', 'ms-mind-readout-row');
        const k = h('span', `ms-mind-readout-key ${cls}`);
        k.setAttribute('aria-hidden', 'true');
        r.append(k, h('strong', null, v.toFixed(2)), document.createTextNode(` ${label} density`));
        return r;
      };
      if (dPost) readout.appendChild(rowOf('is-post-line', 'posterior', dPost[idx]));
      readout.appendChild(rowOf('is-prior-line', 'prior', dPrior[idx]));
      readout.hidden = false;
      const rw = readout.offsetWidth || 160;
      const left = vx + 12 + rw > W ? vx - 12 - rw : vx + 12;
      readout.style.left = `${Math.max(0, left)}px`;
      readout.style.top = `${m.t}px`;
    };
    const hide = () => { idx = -1; cross.setAttribute('visibility', 'hidden'); readout.hidden = true; };
    overlay.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / (r.width || 1)) * W;
      const v = x.invert(px);
      show(Math.round(v * N - 0.5));
    });
    overlay.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const step = Math.max(1, Math.round(N / 100));
      if (e.key === 'ArrowRight') show((idx < 0 ? Math.round(N / 2) : idx) + step);
      else if (e.key === 'ArrowLeft') show((idx < 0 ? Math.round(N / 2) : idx) - step);
      else if (e.key === 'Home') show(0);
      else if (e.key === 'End') show(N - 1);
      else if (e.key === 'Escape') hide();
      else return;
      e.preventDefault();
    });
    return fig;
  }

  /** @param {any} res */
  trailTable(res) {
    const steps = this.steps(res);
    const pm = meanOf(res.grid, res.prior);
    const rows = steps.map((s) => {
      if (s.kind === 'prior') return ['prior', '', `Beta(${this.m.hidden.prior.alpha}, ${this.m.hidden.prior.beta}) prior`, '', signed(s.to), pm.toFixed(3)];
      if (s.kind === 'post') return ['posterior', '', `Beta(${res.posteriorDist.alpha}, ${res.posteriorDist.beta}) written to the graph`, '', signed(s.to), res.posteriorMean.toFixed(3)];
      return [s.t.id, s.t.when, s.t.text, signed(s.t.lbf), signed(s.to), s.t.mean.toFixed(3)];
    });
    const wrap = h('div', 'ms-mind-tbl');
    wrap.appendChild(h('div', 'ms-mind-fig-title', 'Evidence trail'));
    wrap.appendChild(tableView({
      caption: `Evidence trail for ${this.m.name}: log Bayes factors (computed by mind.infer)`,
      columns: [{ label: 'Step' }, { label: 'When' }, { label: 'Observation' }, { label: 'log Bayes factor', align: 'right' }, { label: 'Running log-odds', align: 'right' }, { label: 'Mean after', align: 'right' }],
      rows,
    }));
    return wrap;
  }

  /** @param {any} res */
  summaryTable(res) {
    const { host } = this;
    const id = this.m.hidden.nodeId;
    const pAbovePrior = massAbove(res.grid, res.prior);
    const pAbovePost = massAbove(res.grid, res.posterior);
    const wrap = h('div', 'ms-mind-tbl');
    wrap.appendChild(h('div', 'ms-mind-fig-title', 'Prior and posterior'));
    const graphCell = this.g.node(id) ? host.bv.create({ node: id, stat: 'mean' }) : '—';
    wrap.appendChild(tableView({
      caption: `Prior and posterior of ${this.m.hidden.name}`,
      columns: [{ label: 'Measure' }, { label: 'Prior', align: 'right' }, { label: 'Posterior', align: 'right' }],
      rows: [
        ['mean (inference grid)', res.priorMean.toFixed(3), res.posteriorMean.toFixed(3)],
        ['probability above one half', pAbovePrior.toFixed(3), pAbovePost.toFixed(3)],
        ['log-odds above one half', signed(logit(pAbovePrior)), signed(logit(pAbovePost))],
        ['mean in the graph now', '', graphCell],
      ],
    }));
    const note = h('p', 'ms-mind-foot-note', `Method: ${res.method}. Grid values are computed by mind.infer and are not graph metrics; the graph value is live.`);
    wrap.appendChild(note);
    return wrap;
  }

  // ------------------------------------------------------------------ observations

  drawObservations() {
    const { host, m } = this;
    const ev = host.ctx.services.evidence;
    this.obsEl.replaceChildren();
    const hd = h('h4', 'ms-mind-sec-h');
    hd.append(icon('eye'), document.createTextNode('Observations'));
    hd.appendChild(h('span', 'ms-mind-sec-hint', 'what the party did and said, in order'));
    this.obsEl.appendChild(hd);
    const ol = h('ol', 'ms-mind-obs');
    const byId = new Map((this.res?.trail || []).map((t) => [t.id, t]));
    for (const o of m.observations) {
      const t = byId.get(o.id);
      const li = h('li', 'ms-mind-ob');
      if (t) li.dataset.dir = t.lbf >= 0 ? 'pos' : 'neg';
      li.appendChild(h('div', 'ms-mind-ob-when', o.when));
      const body = h('div', 'ms-mind-ob-body');
      if (o.speech) body.appendChild(speechBlock(o.who || 'unknown speaker', o.text, 'observed speech'));
      else body.appendChild(h('p', 'ms-mind-ob-text', o.text));
      if (o.evidence && ev) {
        const ex = ev.extraction(o.evidence);
        const src = ex ? ev.source(ex.source) : null;
        if (src) {
          const chip = /** @type {HTMLButtonElement} */ (h('button', 'ms-chip ms-mind-know-chip'));
          chip.type = 'button';
          chip.append(icon(sourceIcon(src.type)), h('span', 'ms-ellipsis', src.name));
          chip.title = `${src.title || src.name}, page ${ex.page}\nClick to select the metric it backs`;
          const target = ex.binds?.[0];
          if (target) chip.addEventListener('click', () => host.select([target]));
          body.appendChild(chip);
        }
      }
      li.appendChild(body);
      const lbf = h('div', 'ms-mind-ob-lbf');
      if (t) {
        lbf.append(icon(t.lbf >= 0 ? 'arrow-up' : 'arrow-down'));
        const v = h('span', 'ms-mind-ob-lbf-v', signed(t.lbf));
        lbf.appendChild(v);
        lbf.appendChild(provMark('computed', { title: 'Log Bayes factor computed by mind.infer; not a graph metric' }));
        lbf.appendChild(h('span', 'ms-mind-ob-lbf-w', `${strengthWord(t.lbf)}, ${t.lbf >= 0 ? 'for' : 'against'}`));
        lbf.setAttribute('aria-label', `log Bayes factor ${signed(t.lbf)}, ${strengthWord(t.lbf)} evidence ${t.lbf >= 0 ? 'for' : 'against'} ${m.hidden.name} above one half`);
      } else {
        lbf.appendChild(h('span', 'ms-muted', 'not inferred yet'));
      }
      li.appendChild(lbf);
      ol.appendChild(li);
    }
    this.obsEl.appendChild(ol);
  }

  // ------------------------------------------------------------------ lifecycle

  /** @param {string[]} changed */
  update(changed) {
    if (changed.includes(this.m.hidden.nodeId)) this.refreshHidden();
  }

  resize() { this.drawCharts(); }

  dispose() {}
}
