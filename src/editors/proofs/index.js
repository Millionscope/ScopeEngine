/**
 * Proofs editor: the formal claims checked for this answer (Lean 4 theorems, SMT bound
 * claims). Left: the claims with their live status from the verifier. Right: the selected
 * claim's statement (KaTeX), the verifier's detail, the hypotheses (Lean) or declared input
 * ranges (SMT) evaluated at the current values, the scopes it covers, its source, and the
 * floating-point note.
 *
 * Statuses are only "proven" or "not proven": a proof says the statement follows from the
 * formulas and stated assumptions, nothing about whether those assumptions match the world.
 * @module editors/proofs
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { codeView } from '../shared/code-view.js';
import { scopeChip } from '../shared/scope-chip.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { renderTex } from '../../theme/adapters/katex.js';
import { interval } from '../../model/format.js';
import { defaultFmt } from '../../model/binding.js';

const TOOL = {
  lean: { label: 'Lean 4', long: 'Lean 4 + Mathlib', icon: 'law', lang: 'lean' },
  smt: { label: 'SMT', long: 'SMT (Z3 / cvc5, mocked)', icon: 'symbol-boolean', lang: 'smt' },
};
const STATUS = {
  proven: { glyph: '✓', text: 'proven' },
  not_proven: { glyph: '⚠', text: 'not proven' },
};
const OP = { '<': '<', '>': '>', '<=': '≤', '>=': '≥' };

/** @param {number} a @param {string} op @param {number} b */
function compare(a, op, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
}

export default class ProofsEditor extends BaseEditor {
  static id = 'proofs';
  static label = 'Proofs';
  static icon = 'law';
  static group = 'Verify & Source';
  static needs = ['katex'];

  async mount(ctx, state) {
    await loadCss(new URL('./proofs.css', import.meta.url));
    this.katex = ctx.libs.katex;
    this.verify = ctx.services.verify;
    const claims = this.claims();
    const sel = ctx.services.selection.get();
    this.state = {
      claimId: claims.some((c) => c.id === state.claimId) ? state.claimId : this.claimFor(sel.primary)?.id || claims[0]?.id || null,
    };
    this.selected = new Set(sel.selected);
    this.bv = new BoundValues({
      engine: ctx.engine,
      services: ctx.services,
      onClick: (node, e) => this.select([node], { mode: e.ctrlKey || e.metaKey ? 'toggle' : 'replace' }),
    });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    /** live rows re-evaluated on recompute: hypothesis / range / target states */
    /** @type {Array<() => void>} */
    this.live = [];

    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-proofs';
    const body = document.createElement('div');
    body.className = 'ms-pf-body';
    this.listEl = document.createElement('ul');
    this.listEl.className = 'ms-pf-list';
    this.listEl.setAttribute('role', 'listbox');
    this.listEl.setAttribute('aria-label', 'Claims checked by the formal verifiers');
    this.detailEl = document.createElement('div');
    this.detailEl.className = 'ms-pf-detail ms-ed-scroll';
    body.append(this.listEl, this.detailEl);
    this.footEl = document.createElement('div');
    this.footEl.className = 'ms-ed-foot';
    this.footEl.setAttribute('role', 'status');
    this.root.append(body, this.footEl);
    ctx.el.appendChild(this.root);

    // list interaction (delegated; the list is rebuilt on updates)
    this.listen(this.listEl, 'click', (e) => {
      const li = /** @type {HTMLElement} */ (e.target).closest?.('[data-claim]');
      if (li) this.choose(/** @type {string} */ (li.dataset.claim), { focus: true, select: true });
    });
    this.listen(this.listEl, 'keydown', (e) => this.onListKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.detailEl, 'pointerover', (e) => {
      const el = /** @type {HTMLElement} */ (e.target).closest?.('.ms-chip[data-node]');
      const id = el ? /** @type {HTMLElement} */ (el).dataset.node || null : null;
      if (id !== this._hover) { this._hover = id; this.hover(id); }
    });
    this.listen(this.detailEl, 'pointerleave', () => { if (this._hover) { this._hover = null; this.hover(null); } });

    this.on('certificate:updated', () => this.refreshStatus());
    this.build();
  }

  /** @returns {any[]} */
  claims() {
    return this.verify?.claims || [];
  }

  /** The claim that best explains a selected id (target first, then coverage). @param {string|null} id */
  claimFor(id) {
    if (!id) return null;
    const list = this.claims();
    return list.find((c) => c.target === id) || list.find((c) => c.covers?.includes(id)) || null;
  }

  getState() {
    return { claimId: this.state.claimId };
  }

  // ------------------------------------------------------------------ header

  getHeaderTools() {
    const b = document.createElement('button');
    b.className = 'ms-btn is-secondary is-small';
    b.innerHTML = '<span class="codicon codicon-refresh" aria-hidden="true"></span>';
    b.appendChild(document.createTextNode(' Re-check'));
    b.setAttribute('aria-label', 'Re-check all claims against the current graph');
    b.dataset.tooltip = 'Re-run the verifier on the current graph';
    b.addEventListener('click', () => {
      this.verify?.refresh();
      this.ctx?.services.notify?.info?.('Claims re-checked against the current graph.');
    });
    return [b];
  }

  getHeaderMenus() {
    return [{
      label: 'Claim',
      items: () => {
        const c = this.current();
        return [
          { label: 'Select Covered Metric', icon: 'target', disabled: !c, run: () => c && this.select([c.target || c.covers[0]]) },
          { label: 'Select All Covered', icon: 'checklist', disabled: !c, run: () => c && this.select(this.covers(c)) },
          { separator: true },
          { label: `Copy ${c ? TOOL[c.tool]?.label || '' : ''} Source`, icon: 'copy', disabled: !c?.source, run: () => this.copy(c?.source || '', 'Source copied.') },
          { label: 'Copy LaTeX Statement', icon: 'copy', disabled: !c?.latex, run: () => this.copy(c?.latex || '', 'LaTeX copied.') },
          { separator: true },
          { label: 'Re-check All Claims', icon: 'refresh', run: () => this.verify?.refresh() },
        ];
      },
    }];
  }

  /** @param {string} text @param {string} msg */
  async copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      this.ctx?.services.notify?.success?.(msg);
    } catch {
      this.ctx?.services.notify?.warn?.('Clipboard is not available here.');
    }
  }

  // ------------------------------------------------------------------ selection of claims

  current() {
    return this.claims().find((c) => c.id === this.state.claimId) || null;
  }

  /** Covered ids that still exist. @param {any} c */
  covers(c) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    return (c.covers || []).filter((id) => g.node(id) || g.scope(id));
  }

  /**
   * Show a claim. @param {string} id
   * @param {{focus?: boolean, select?: boolean}} [opts]
   */
  choose(id, opts = {}) {
    const c = this.claims().find((x) => x.id === id);
    if (!c) return;
    const changed = id !== this.state.claimId;
    this.state.claimId = id;
    if (changed) {
      this.save();
      this.buildList();
      this.buildDetail();
      this.detailEl.scrollTop = 0;
    }
    if (opts.focus) /** @type {HTMLElement|null} */ (this.listEl.querySelector(`[data-claim="${CSS.escape(id)}"]`))?.focus();
    if (opts.select) {
      const target = c.target || this.covers(c)[0];
      if (target) this.select([target]);
    }
  }

  /** @param {KeyboardEvent} e */
  onListKey(e) {
    const list = this.claims();
    const i = list.findIndex((c) => c.id === this.state.claimId);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(list.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (this.state.claimId) this.choose(this.state.claimId, { select: true });
      return;
    } else return;
    e.preventDefault();
    if (next >= 0 && list[next]) this.choose(list[next].id, { focus: true });
  }

  // ------------------------------------------------------------------ rendering

  render() {
    this.build();
  }

  build() {
    this.buildList();
    const top = this.detailEl.scrollTop;
    this.buildDetail();
    this.detailEl.scrollTop = top;
    this.buildFoot();
  }

  /** @param {string} id */
  status(id) {
    return this.verify ? this.verify.claimStatus(id) : { status: 'not_proven', detail: 'verifier unavailable' };
  }

  /** Lean hypotheses failing at the current values. @param {any} c */
  failedHypotheses(c) {
    const engine = /** @type {any} */ (this.ctx).engine;
    return (c.hypotheses || []).filter((h) => !compare(engine.value(h.a), h.op, typeof h.b === 'number' ? h.b : engine.value(h.b)));
  }

  buildList() {
    const hadFocus = this.listEl.contains(document.activeElement);
    this.listEl.replaceChildren();
    for (const c of this.claims()) {
      const st = this.status(c.id);
      const info = STATUS[st.status] || STATUS.not_proven;
      const li = document.createElement('li');
      li.className = 'ms-pf-item';
      li.id = `${this.ctx?.areaId || 'area'}-claim-${c.id}`;
      li.dataset.claim = c.id;
      li.setAttribute('role', 'option');
      const selected = c.id === this.state.claimId;
      li.setAttribute('aria-selected', String(selected));
      li.tabIndex = selected ? 0 : -1;
      const covered = this.covers(c);
      if (covered.some((id) => this.selected.has(id))) li.classList.add('is-hit');
      const mark = document.createElement('span');
      mark.className = 'ms-pf-mark';
      mark.dataset.status = st.status;
      mark.textContent = info.glyph;
      mark.setAttribute('aria-hidden', 'true');
      const body = document.createElement('span');
      body.className = 'ms-pf-item-body';
      const title = document.createElement('span');
      title.className = 'ms-pf-item-title';
      title.textContent = c.title;
      const sub = document.createElement('span');
      sub.className = 'ms-pf-item-sub';
      const tool = document.createElement('span');
      tool.className = 'ms-pf-tool';
      tool.dataset.tool = c.tool;
      tool.textContent = TOOL[c.tool]?.label || c.tool;
      const stx = document.createElement('span');
      stx.className = 'ms-pf-item-status';
      stx.dataset.status = st.status;
      stx.textContent = info.text;
      sub.append(tool, stx);
      const failed = c.tool === 'lean' && st.status === 'proven' ? this.failedHypotheses(c) : [];
      if (failed.length) {
        const w = document.createElement('span');
        w.className = 'ms-pf-item-warn';
        w.textContent = 'hypotheses do not hold now';
        sub.appendChild(w);
      }
      body.append(title, sub);
      li.append(mark, body);
      li.setAttribute('aria-label', `${c.title}. ${TOOL[c.tool]?.long || c.tool}. ${info.text}${failed.length ? ', hypotheses do not hold for the current inputs' : ''}.`);
      li.title = `${c.statement}\n${st.detail}`;
      this.listEl.appendChild(li);
    }
    const active = this.listEl.querySelector('[aria-selected="true"]');
    if (hadFocus) /** @type {HTMLElement|null} */ (active)?.focus();
  }

  buildDetail() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.bv.releaseWithin(this.detailEl);
    this.live = [];
    this.detailEl.replaceChildren();
    const c = this.current();
    if (!c) {
      this.detailEl.appendChild(emptyState({ icon: 'law', title: 'No claims', text: 'The verifier has no formal claims for this graph yet.' }));
      return;
    }
    const tool = TOOL[c.tool] || { label: c.tool, long: c.tool, icon: 'law', lang: 'text' };

    // header
    const head = document.createElement('div');
    head.className = 'ms-pf-head';
    const h = document.createElement('h2');
    h.className = 'ms-pf-title';
    h.textContent = c.title;
    const pill = document.createElement('span');
    pill.className = 'ms-status ms-pf-pill';
    const badge = document.createElement('span');
    badge.className = 'ms-pf-tool is-large';
    badge.dataset.tool = c.tool;
    badge.innerHTML = `<span class="codicon codicon-${tool.icon}" aria-hidden="true"></span>`;
    badge.appendChild(document.createTextNode(tool.long));
    head.append(h, pill, badge);
    this.detailEl.appendChild(head);

    // statement
    const stmt = document.createElement('div');
    stmt.className = 'ms-pf-statement';
    stmt.setAttribute('role', 'math');
    stmt.setAttribute('aria-label', c.statement);
    if (c.latex && this.katex) renderTex(this.katex, c.latex, stmt, { display: true });
    else stmt.textContent = c.statement;
    const plain = document.createElement('div');
    plain.className = 'ms-pf-plain ms-small ms-muted';
    plain.textContent = c.statement;
    this.detailEl.append(stmt, plain);

    // verifier detail
    const ver = this.section('Verifier', 'shield');
    const det = document.createElement('div');
    det.className = 'ms-pf-verdict';
    det.setAttribute('aria-live', 'polite');
    ver.body.appendChild(det);
    this.detailEl.appendChild(ver.el);
    const updateHead = () => {
      const st = this.status(c.id);
      const info = STATUS[st.status] || STATUS.not_proven;
      pill.dataset.status = st.status;
      pill.textContent = `${info.glyph} ${info.text}`;
      pill.setAttribute('aria-label', `Status: ${info.text}`);
      det.dataset.status = st.status;
      det.replaceChildren();
      const icon = document.createElement('span');
      icon.className = `codicon codicon-${st.status === 'proven' ? 'pass' : 'warning'}`;
      icon.setAttribute('aria-hidden', 'true');
      const txt = document.createElement('span');
      txt.textContent = `${tool.long}: ${st.detail}`;
      det.append(icon, txt);
    };
    updateHead();
    this.live.push(updateHead);

    // hypotheses (Lean) / declared ranges (SMT)
    if (c.tool === 'lean' && c.hypotheses?.length) this.detailEl.appendChild(this.hypothesesSection(c));
    if (c.tool === 'smt') this.detailEl.appendChild(this.rangesSection(c));

    // covered scopes
    const cov = this.section('Covers', 'symbol-namespace');
    const chips = document.createElement('div');
    chips.className = 'ms-pf-chips';
    for (const id of this.covers(c)) {
      const chip = scopeChip(g, id, { onClick: (nid, e) => this.select([nid], { mode: e?.ctrlKey || e?.metaKey ? 'toggle' : 'replace' }) });
      chip.dataset.node = id;
      if (this.selected.has(id)) chip.classList.add('is-selected');
      chips.appendChild(chip);
    }
    if (!chips.childElementCount) chips.textContent = 'None of the covered metrics exist in the current graph.';
    cov.body.appendChild(chips);
    this.detailEl.appendChild(cov.el);

    // source
    if (c.source) {
      const src = this.section(c.tool === 'lean' ? 'Lean 4 source' : 'SMT-LIB source', 'code');
      src.body.appendChild(codeView(c.source, { lang: /** @type {any} */ (tool.lang), lineNumbers: true, label: `${tool.long} source for ${c.id}` }));
      this.detailEl.appendChild(src.el);
    }

    // floating point + what "proven" means
    const fp = this.section('Floating point', 'symbol-numeric');
    const fpText = document.createElement('p');
    fpText.className = 'ms-pf-note';
    fpText.textContent = c.floatNote || 'No floating-point note recorded for this claim.';
    fp.body.appendChild(fpText);
    this.detailEl.appendChild(fp.el);

    const meaning = document.createElement('p');
    meaning.className = 'ms-pf-meaning';
    meaning.setAttribute('role', 'note');
    meaning.innerHTML = '<span class="codicon codicon-info" aria-hidden="true"></span>';
    meaning.appendChild(document.createTextNode(
      c.tool === 'lean'
        ? 'Proven means the statement follows from the formulas whenever the hypotheses hold. It says nothing about whether the inputs match the world.'
        : 'Proven means the bound holds for every input inside the declared ranges. It says nothing about inputs outside them, or about whether the ranges match the world.',
    ));
    this.detailEl.appendChild(meaning);
  }

  /** @param {any} c */
  hypothesesSection(c) {
    const ctx = /** @type {any} */ (this.ctx);
    const engine = ctx.engine;
    const sec = this.section('Hypotheses at current values', 'checklist');
    const list = document.createElement('div');
    list.className = 'ms-pf-checks';
    list.setAttribute('role', 'list');
    for (const hyp of c.hypotheses) {
      const row = document.createElement('div');
      row.className = 'ms-pf-check';
      row.setAttribute('role', 'listitem');
      const label = document.createElement('code');
      label.className = 'ms-pf-check-label';
      label.textContent = hyp.label;
      const expr = document.createElement('span');
      expr.className = 'ms-pf-check-expr';
      expr.append(this.operand(hyp.a), document.createTextNode(` ${OP[hyp.op] || hyp.op} `), this.operand(hyp.b));
      const state = document.createElement('span');
      state.className = 'ms-status ms-pf-check-state';
      row.append(label, expr, state);
      list.appendChild(row);
      const update = () => {
        const a = engine.value(hyp.a);
        const b = typeof hyp.b === 'number' ? hyp.b : engine.value(hyp.b);
        const ok = compare(a, hyp.op, b);
        state.dataset.status = ok ? 'pass' : 'fail';
        state.textContent = ok ? '✓ holds' : '✕ violated';
        row.classList.toggle('is-violated', !ok);
      };
      update();
      this.live.push(update);
    }
    sec.body.appendChild(list);
    const note = document.createElement('p');
    note.className = 'ms-small ms-muted ms-pf-hint';
    note.textContent = 'The theorem applies only while every hypothesis holds. Values are bound to the graph and update as you edit inputs.';
    sec.body.appendChild(note);
    return sec.el;
  }

  /** @param {any} c */
  rangesSection(c) {
    const ctx = /** @type {any} */ (this.ctx);
    const engine = ctx.engine;
    const g = engine.graph;
    const sec = this.section('Declared input ranges', 'symbol-ruler');
    const table = document.createElement('table');
    table.className = 'ms-table ms-pf-ranges';
    const cap = document.createElement('caption');
    cap.className = 'ms-sr-only';
    cap.textContent = `Inputs of ${c.id} and their declared ranges`;
    table.appendChild(cap);
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th scope="col">Input</th><th scope="col" class="num">Current</th><th scope="col" class="num">Declared range</th><th scope="col">State</th></tr>';
    const tbody = document.createElement('tbody');
    for (const id of c.vars || []) {
      const n = g.node(id);
      if (!n) continue;
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      const name = document.createElement('button');
      name.className = 'ms-pf-link';
      name.textContent = g.path(id).split('.').slice(-2).join('.');
      name.title = `Select ${g.path(id)}`;
      name.addEventListener('click', () => this.select([id]));
      td1.appendChild(name);
      const td2 = document.createElement('td');
      td2.className = 'num';
      td2.appendChild(this.bv.create({ node: id, stat: 'value' }));
      const td3 = document.createElement('td');
      td3.className = 'num ms-muted';
      td3.textContent = Array.isArray(n.range) ? `[${interval(n.range[0], n.range[1], n.type.unit, defaultFmt(n.type.unit)).replace('–', ', ')}]` : 'none declared';
      const td4 = document.createElement('td');
      const state = document.createElement('span');
      state.className = 'ms-status';
      td4.appendChild(state);
      tr.append(td1, td2, td3, td4);
      tbody.appendChild(tr);
      const update = () => {
        const v = engine.value(id);
        const r = n.range;
        const inside = !Array.isArray(r) || (v >= r[0] - 1e-9 && v <= r[1] + 1e-9);
        state.dataset.status = !Array.isArray(r) ? 'na' : inside ? 'pass' : 'fail';
        state.textContent = !Array.isArray(r) ? 'unbounded' : inside ? '✓ in range' : '✕ outside';
        tr.classList.toggle('is-violated', !inside);
      };
      update();
      this.live.push(update);
    }
    table.append(thead, tbody);
    sec.body.appendChild(table);

    if (c.target && g.node(c.target)) {
      const t = document.createElement('div');
      t.className = 'ms-pf-target';
      const lab = document.createElement('span');
      lab.className = 'ms-muted';
      lab.textContent = 'Target at current inputs:';
      const expr = document.createElement('span');
      expr.className = 'ms-pf-check-expr';
      expr.append(this.operand(c.target), document.createTextNode(` ${OP[c.op] || c.op} `), this.operand(c.bound));
      const state = document.createElement('span');
      state.className = 'ms-status';
      t.append(lab, expr, state);
      sec.body.appendChild(t);
      const update = () => {
        const ok = compare(engine.value(c.target), c.op, c.bound);
        state.dataset.status = ok ? 'pass' : 'fail';
        state.textContent = ok ? '✓ holds here' : '✕ fails here';
      };
      update();
      this.live.push(update);
      const note = document.createElement('p');
      note.className = 'ms-small ms-muted ms-pf-hint';
      note.textContent = 'The solver checks every input combination inside the box of declared ranges, not just the current point. Moving an input outside its range makes the claim not proven.';
      sec.body.appendChild(note);
    }
    return sec.el;
  }

  /** A node id as a bound value, or a constant. @param {string|number} x */
  operand(x) {
    if (typeof x === 'number') {
      const s = document.createElement('span');
      s.className = 'ms-pf-const';
      s.textContent = String(x);
      return s;
    }
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const wrap = document.createElement('span');
    wrap.className = 'ms-pf-operand';
    const name = document.createElement('span');
    name.className = 'ms-pf-operand-name';
    name.textContent = g.node(x)?.name || x;
    wrap.append(name, document.createTextNode(' '), this.bv.create({ node: x, stat: 'value' }));
    return wrap;
  }

  /** @param {string} title @param {string} icon */
  section(title, icon) {
    const el = document.createElement('section');
    el.className = 'ms-pf-section';
    const h = document.createElement('h3');
    h.className = 'ms-pf-section-title';
    h.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
    h.appendChild(document.createTextNode(title));
    const body = document.createElement('div');
    body.className = 'ms-pf-section-body';
    el.append(h, body);
    return { el, body };
  }

  buildFoot() {
    const list = this.claims();
    let proven = 0;
    for (const c of list) if (this.status(c.id).status === 'proven') proven++;
    this.footEl.replaceChildren();
    const a = document.createElement('span');
    a.textContent = `${list.length} claims · ${proven} proven · ${list.length - proven} not proven`;
    const sp = document.createElement('span');
    sp.className = 'ms-spacer';
    const b = document.createElement('span');
    b.textContent = 'Lean 4 + Mathlib · SMT (Z3 / cvc5, mocked)';
    this.footEl.append(a, sp, b);
  }

  /** Statuses changed (certificate re-issued): update in place, keep focus and scroll. */
  refreshStatus() {
    if (this._disposed) return;
    this.buildList();
    for (const fn of this.live) fn();
    this.buildFoot();
  }

  // ------------------------------------------------------------------ events

  onSelection(sel) {
    this.selected = new Set(sel.selected);
    if (sel.source !== this.ctx?.areaId && sel.source !== 'local') {
      const c = this.claimFor(sel.primary);
      if (c && c.id !== this.state.claimId) {
        this.state.claimId = c.id;
        this.save();
        this.build();
        this.detailEl.scrollTop = 0;
        return;
      }
    }
    for (const li of this.listEl.querySelectorAll('[data-claim]')) {
      const c = this.claims().find((x) => x.id === /** @type {HTMLElement} */ (li).dataset.claim);
      li.classList.toggle('is-hit', !!c && this.covers(c).some((id) => this.selected.has(id)));
    }
    for (const chip of this.detailEl.querySelectorAll('.ms-chip[data-node]')) {
      chip.classList.toggle('is-selected', this.selected.has(/** @type {string} */ (/** @type {HTMLElement} */ (chip).dataset.node)));
    }
    this.bv.select([...this.selected]);
  }

  onHover(id) {
    for (const chip of this.detailEl.querySelectorAll('.ms-chip[data-node]')) {
      chip.classList.toggle('is-hovered', !!id && /** @type {HTMLElement} */ (chip).dataset.node === id);
    }
    this.bv.hover(id);
  }

  onRecompute(changed, payload) {
    if (payload?.structural) return;
    if (payload?.full || payload?.scenarioChanged) this.bv.updateAll();
    else this.bv.update(changed);
    for (const fn of this.live) fn();
    // statuses follow on certificate:updated (the verifier debounces recompute bursts)
  }

  onStructure() { this.invalidate(); }
  onTheme() { this.invalidate(); }
  onScenario() {}
  onFlags() {}

  dispose() {
    this.live = [];
    this.root?.remove();
    super.dispose();
  }
}
