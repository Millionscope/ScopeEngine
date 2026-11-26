/**
 * Formula editor (KaTeX). For the focused computed metric: the equation with provenance-colored,
 * clickable variables; the units row with a dimensional check; the point evaluation built from
 * bound values (it updates live on recompute); and a derivation chain that expands dependencies
 * one level at a time. A Reference tab shows the math behind the concept (inverse planning for
 * Mind metrics, the annuity for loan payments, Monte Carlo and sensitivity definitions otherwise).
 *
 * Click a variable to select it everywhere; double-click a computed variable to open its formula
 * here (Back returns).
 * @module editors/formula
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { describe } from '../../model/distributions.js';
import { PROVENANCE } from '../../theme/tokens.js';
import { renderMath } from './tex.js';
import { equationTex, exprDom, fmtFor, referenceItems, unitsCheck, unitsTex } from './view.js';

const DEFAULT_FOCUS = 'sc_bakery.monthly_cash';
const MAX_DEPTH = 8;

export default class FormulaEditor extends BaseEditor {
  static id = 'formula';
  static label = 'Formula';
  static icon = 'symbol-operator';
  static group = 'Verify & Source';
  static needs = ['katex'];

  async mount(ctx, state) {
    await loadCss(new URL('./formula.css', import.meta.url));
    this.katex = ctx.libs.katex;
    const g = ctx.engine.graph;
    const sel = ctx.services.selection.get();
    const initial = (state.focus && g.node(state.focus) && state.focus)
      || (sel.primary && g.node(sel.primary) && sel.primary)
      || DEFAULT_FOCUS;
    this.state = {
      tab: state.tab === 'reference' ? 'reference' : 'formula',
      focus: initial,
      expanded: new Set(state.expanded || []),
    };
    /** @type {string[]} */
    this.back = [];
    this.selected = new Set(sel.selected);
    // bound-value clicks go through this.select so the selection carries this area as its
    // source (the formula stays put instead of refocusing on the clicked variable)
    this.bv = new BoundValues({
      engine: ctx.engine,
      services: ctx.services,
      onClick: (node, e) => this.select([node], { mode: e.ctrlKey || e.metaKey ? 'toggle' : 'replace' }),
    });
    this.disposables.add({ dispose: () => this.bv.dispose() });

    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-formula';
    this.scroll = document.createElement('div');
    this.scroll.className = 'ms-ed-scroll ms-fx-scroll';
    this.root.appendChild(this.scroll);
    ctx.el.appendChild(this.root);

    // clickable variables inside KaTeX output and derivation rows
    this.listen(this.scroll, 'click', (e) => {
      const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-node]');
      if (!el || el.classList.contains('ms-bv')) return;
      const id = el.dataset.node;
      if (id) this.select([id], { mode: /** @type {MouseEvent} */ (e).ctrlKey || /** @type {MouseEvent} */ (e).metaKey ? 'toggle' : 'replace' });
    });
    this.listen(this.scroll, 'dblclick', (e) => {
      const el = /** @type {HTMLElement} */ (e.target).closest?.('[data-node]');
      const id = el?.dataset.node;
      if (id && id !== this.currentId() && ctx.engine.graph.node(id)?.kind === 'computed') this.open(id);
    });
    this.listen(this.scroll, 'pointerover', (e) => {
      const el = /** @type {HTMLElement} */ (e.target).closest?.('.katex [data-node], .ms-fx-dep-name');
      const id = el ? /** @type {HTMLElement} */ (el).dataset.node || null : null;
      if (id !== this._hover) { this._hover = id; this.hover(id); }
    });
    this.listen(this.scroll, 'pointerleave', () => { if (this._hover) { this._hover = null; this.hover(null); } });
    // keyboard: the derivation rows list every variable of the equation (KaTeX's visual
    // layer is aria-hidden, so it stays mouse-only); Enter selects, Shift+Enter opens
    this.listen(this.scroll, 'keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      if (ke.key !== 'Enter' || !ke.shiftKey) return;
      const el = /** @type {HTMLElement} */ (ke.target);
      if (!el.matches?.('.ms-fx-dep-name')) return;
      const id = /** @type {string} */ (el.dataset.node);
      if (id !== this.currentId() && ctx.engine.graph.node(id)?.kind === 'computed') {
        ke.preventDefault();
        this.open(id);
      }
    });
    this.build();
  }

  // ------------------------------------------------------------------ focus

  /** The metric shown (pinned metric wins). */
  currentId() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const pinned = this.ctx?.areaFlags().pinnedScopeId;
    if (pinned && g.node(pinned)) return pinned;
    return g.node(this.state.focus) ? this.state.focus : DEFAULT_FOCUS;
  }

  /** Pinning this area pins the focused metric. */
  focusScope() {
    return this.currentId();
  }

  /** Open a metric here, remembering where we came from. @param {string} id */
  open(id) {
    if (id === this.state.focus) return;
    this.back.push(this.state.focus);
    if (this.back.length > 30) this.back.shift();
    this.state.focus = id;
    this.save();
    this.ctx?.refreshHeader();
    this.invalidate();
  }

  goBack() {
    const prev = this.back.pop();
    if (!prev) return;
    this.state.focus = prev;
    this.save();
    this.ctx?.refreshHeader();
    this.invalidate();
  }

  getState() {
    return { tab: this.state.tab, focus: this.state.focus, expanded: [...this.state.expanded].slice(0, 200) };
  }

  // ------------------------------------------------------------------ header

  getHeaderMenus() {
    return [{
      label: 'View',
      items: () => [
        { label: 'Expand Derivation One Level', icon: 'unfold', disabled: this.state.tab !== 'formula', run: () => this.expandOneLevel() },
        { label: 'Collapse Derivation', icon: 'fold', run: () => { this.state.expanded.clear(); this.save(); this.invalidate(); } },
        { separator: true },
        { label: 'Copy LaTeX', icon: 'copy', run: () => this.copyLatex() },
        { label: 'Back', icon: 'arrow-left', disabled: !this.back.length, run: () => this.goBack() },
      ],
    }];
  }

  getHeaderTools() {
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const back = document.createElement('button');
    back.className = 'ms-icon-btn is-small';
    back.setAttribute('aria-label', 'Back to the previous formula');
    back.dataset.tooltip = 'Back';
    back.innerHTML = '<span class="codicon codicon-arrow-left" aria-hidden="true"></span>';
    back.disabled = !this.back?.length;
    back.addEventListener('click', () => this.goBack());
    const seg = document.createElement('div');
    seg.className = 'ms-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Formula view');
    for (const [id, label] of [['formula', 'Formula'], ['reference', 'Reference']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(this.state?.tab === id));
      b.addEventListener('click', () => {
        this.state.tab = /** @type {any} */ (id);
        this.save();
        this.ctx?.refreshHeader();
        this.invalidate();
      });
      seg.appendChild(b);
    }
    wrap.append(back, seg);
    return [wrap];
  }

  async copyLatex() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const id = this.currentId();
    if (g.node(id)?.kind !== 'computed') return;
    try {
      await navigator.clipboard.writeText(equationTex(g, id, { htmlData: false }));
      this.ctx?.services.notify.success('LaTeX copied.');
    } catch {
      this.ctx?.services.notify.warn('Clipboard is not available here.');
    }
  }

  // ------------------------------------------------------------------ rendering

  render() {
    const top = this.scroll.scrollTop;
    this.build();
    this.scroll.scrollTop = top;
  }

  build() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.bv.releaseWithin(this.scroll);
    this.scroll.replaceChildren();
    const id = this.currentId();
    const n = g.node(id);
    if (!n) {
      this.scroll.appendChild(emptyState({ icon: 'symbol-operator', title: 'Select a computed metric', text: 'Select a computed metric to see its formula, units and derivation.' }));
      return;
    }
    this.scroll.appendChild(this.headCard(id));
    if (this.state.tab === 'reference') this.buildReference(id);
    else if (n.kind !== 'computed') this.buildNotComputed(id);
    else this.buildFormula(id);
    this.markSelected();
  }

  /** @param {string} id */
  headCard(id) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const n = g.node(id);
    const prov = g.displayProv(id);
    const head = document.createElement('div');
    head.className = 'ms-fx-head';
    const name = document.createElement('button');
    name.className = 'ms-fx-name';
    name.dataset.node = id;
    name.textContent = n.label || n.name;
    name.title = `Select ${g.path(id)}`;
    const path = document.createElement('span');
    path.className = 'ms-fx-path ms-muted';
    path.textContent = `${g.path(id)} · ${n.type.unit || '1'}`;
    const st = ctx.engine.stats(id);
    this._stoch = !!st && !st.deterministic;
    const val = this.bv.create({ node: id, stat: st && !st.deterministic ? 'p50' : 'value' });
    val.classList.add('ms-fx-value');
    const label = document.createElement('span');
    label.className = 'ms-small ms-muted';
    label.textContent = st && !st.deterministic ? 'median' : PROVENANCE[prov]?.label || prov;
    const spacer = document.createElement('span');
    spacer.className = 'ms-spacer';
    head.append(provMark(prov), name, path, spacer, label, val);
    return head;
  }

  /** @param {string} id */
  buildFormula(id) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const n = g.node(id);

    // main equation
    const eq = document.createElement('div');
    eq.className = 'ms-fx-eq';
    renderMath(this.katex, equationTex(g, id), eq, { trustHtmlData: true, label: `Formula for ${n.name}` });
    this.scroll.appendChild(eq);

    // units row
    const units = this.row('Units', 'symbol-ruler');
    const ut = document.createElement('div');
    ut.className = 'ms-fx-units';
    renderMath(this.katex, unitsTex(g, id), ut, { display: false, label: `Units of ${n.name}` });
    const chk = unitsCheck(g, id);
    const badge = document.createElement('span');
    badge.className = 'ms-status';
    badge.dataset.status = chk.ok ? 'pass' : 'fail';
    badge.textContent = chk.ok ? '✓ units' : '✕ units';
    badge.title = chk.text;
    const why = document.createElement('span');
    why.className = 'ms-small ms-muted ms-fx-unitnote';
    why.textContent = chk.text;
    units.body.append(ut, badge, why);
    this.scroll.appendChild(units.el);

    // point evaluation with bound values
    const pe = this.row('Point evaluation', 'symbol-numeric');
    const line = document.createElement('div');
    line.className = 'ms-fx-subst';
    line.appendChild(this.bv.create({ node: id, stat: 'value', fmt: fmtFor(n.type.unit) }));
    line.appendChild(document.createTextNode(' = '));
    line.appendChild(exprDom(g.resolved.get(id), { graph: g, bv: this.bv }));
    const note = document.createElement('div');
    note.className = 'ms-small ms-muted';
    const st = ctx.engine.stats(id);
    note.textContent = st && !st.deterministic
      ? 'Point values (each input at its nominal value). Medians of the Monte Carlo samples need not satisfy the formula exactly; the head shows the median.'
      : 'Every number is bound to its metric and updates when the graph recomputes.';
    pe.body.append(line, note);
    this.scroll.appendChild(pe.el);

    // derivation chain
    const der = document.createElement('section');
    der.className = 'ms-fx-derivation';
    const dh = document.createElement('div');
    dh.className = 'ms-fx-derivation-head';
    const t = document.createElement('span');
    t.className = 'ms-fx-row-title';
    t.innerHTML = '<span class="codicon codicon-type-hierarchy-sub" aria-hidden="true"></span>';
    t.appendChild(document.createTextNode('Derivation'));
    const more = document.createElement('button');
    more.className = 'ms-btn is-secondary is-small';
    more.textContent = 'Expand one level';
    more.addEventListener('click', () => this.expandOneLevel());
    const less = document.createElement('button');
    less.className = 'ms-btn is-secondary is-small';
    less.textContent = 'Collapse all';
    less.disabled = !this.state.expanded.size;
    less.addEventListener('click', () => { this.state.expanded.clear(); this.save(); this.invalidate(); });
    dh.append(t, more, less);
    const tree = document.createElement('div');
    tree.className = 'ms-fx-tree';
    tree.setAttribute('role', 'list');
    tree.setAttribute('aria-label', `Dependencies of ${n.name}`);
    this.renderDeps(tree, id, 0, new Set([id]));
    der.append(dh, tree);
    this.scroll.appendChild(der);
  }

  /**
   * One level of dependencies; expanded computed deps show their equation and recurse.
   * @param {HTMLElement} parent @param {string} id @param {number} depth @param {Set<string>} ancestors
   */
  renderDeps(parent, id, depth, ancestors) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const n = g.node(id);
    const deps = [...new Set(n.deps || [])];
    for (const d of deps) {
      const dn = g.node(d);
      if (!dn) continue;
      const row = document.createElement('div');
      row.className = 'ms-fx-dep';
      row.setAttribute('role', 'listitem');
      row.style.setProperty('--depth', String(depth));
      const line = document.createElement('div');
      line.className = 'ms-fx-dep-line';
      const isComputed = dn.kind === 'computed';
      const open = isComputed && this.state.expanded.has(d) && !ancestors.has(d) && depth < MAX_DEPTH;
      if (isComputed) {
        const tw = document.createElement('button');
        tw.className = `ms-icon-btn is-small ms-fx-twisty codicon codicon-chevron-${open ? 'down' : 'right'}`;
        tw.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${dn.name}`);
        tw.setAttribute('aria-expanded', String(open));
        tw.addEventListener('click', () => {
          if (this.state.expanded.has(d)) this.state.expanded.delete(d); else this.state.expanded.add(d);
          this.save();
          this.invalidate();
        });
        line.appendChild(tw);
      } else {
        const sp = document.createElement('span');
        sp.className = 'ms-fx-twisty-space';
        line.appendChild(sp);
      }
      line.appendChild(provMark(g.displayProv(d)));
      const nm = document.createElement('button');
      nm.className = 'ms-fx-dep-name';
      nm.dataset.node = d;
      nm.textContent = g.scopeIdOf(d) === n.scope ? dn.name : g.path(d).split('.').slice(-2).join('.');
      nm.title = `${g.path(d)} (${dn.kind}). Click to select${isComputed ? ', double-click (or Shift+Enter) to open its formula' : ''}`;
      line.appendChild(nm);
      const kind = document.createElement('span');
      kind.className = 'ms-small ms-muted';
      kind.textContent = dn.kind === 'computed' ? '' : dn.dist && dn.dist.family !== 'Point' ? `~ ${describe(dn.dist)}` : dn.kind;
      line.appendChild(kind);
      const sp = document.createElement('span');
      sp.className = 'ms-spacer';
      line.appendChild(sp);
      line.appendChild(this.bv.create({ node: d, stat: 'value', fmt: fmtFor(dn.type.unit) }));
      const unit = document.createElement('span');
      unit.className = 'ms-unit';
      unit.textContent = dn.type.unit;
      line.appendChild(unit);
      row.appendChild(line);
      if (open) {
        const eq = document.createElement('div');
        eq.className = 'ms-fx-dep-eq';
        renderMath(this.katex, equationTex(g, d), eq, { trustHtmlData: true, label: `Formula for ${dn.name}` });
        row.appendChild(eq);
        const kids = document.createElement('div');
        kids.setAttribute('role', 'list');
        this.renderDeps(kids, d, depth + 1, new Set([...ancestors, d]));
        row.appendChild(kids);
      }
      parent.appendChild(row);
    }
  }

  /** Expand every visible, collapsed computed dependency by one level. */
  expandOneLevel() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const frontier = [];
    const walk = (id, depth, ancestors) => {
      for (const d of new Set(g.node(id)?.deps || [])) {
        const dn = g.node(d);
        if (!dn || dn.kind !== 'computed' || ancestors.has(d) || depth >= MAX_DEPTH) continue;
        if (this.state.expanded.has(d)) walk(d, depth + 1, new Set([...ancestors, d]));
        else frontier.push(d);
      }
    };
    walk(this.currentId(), 0, new Set([this.currentId()]));
    for (const d of frontier) this.state.expanded.add(d);
    this.save();
    this.invalidate();
  }

  /** @param {string} id */
  buildNotComputed(id) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const n = g.node(id);
    const scope = g.scope(n.scope);
    const box = emptyState({
      icon: 'symbol-operator',
      title: 'Select a computed metric',
      text: `${g.path(id)} is ${n.kind}${n.dist && n.dist.family !== 'Point' ? ` (${describe(n.dist)})` : ''}, so it has no formula. ${scope?.kind === 'mind' ? 'The Reference tab shows the inference math behind this estimate.' : 'Select a computed metric to see its formula, units and derivation.'}`,
    });
    const row = document.createElement('div');
    row.className = 'ms-row ms-fx-quick';
    const used = g.dependents(id).slice(0, 4);
    for (const d of used.length ? used : ['sc_bakery.monthly_cash', 'sc_bakery.gross_margin', 'sc_loan.payment']) {
      const dn = g.node(d);
      if (!dn) continue;
      const b = document.createElement('button');
      b.className = 'ms-btn is-secondary is-small';
      b.textContent = used.length ? `Used by ${dn.name}` : dn.name;
      b.addEventListener('click', () => this.open(d));
      row.appendChild(b);
    }
    box.appendChild(row);
    this.scroll.appendChild(box);
  }

  /** @param {string} id */
  buildReference(id) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    for (const item of referenceItems(g, ctx.engine, id)) {
      const card = document.createElement('section');
      card.className = 'ms-fx-ref';
      const h = document.createElement('h3');
      h.className = 'ms-fx-ref-title';
      h.textContent = item.title;
      const eq = document.createElement('div');
      eq.className = 'ms-fx-eq is-ref';
      renderMath(this.katex, item.tex, eq, { label: item.title });
      card.append(h, eq);
      if (item.bindings?.length) {
        const b = document.createElement('div');
        b.className = 'ms-fx-bindings';
        for (const x of item.bindings) {
          const unit = g.node(x.node)?.type.unit || '';
          const lab = document.createElement('span');
          lab.className = 'ms-fx-bind-label';
          lab.textContent = `${x.label} =`;
          b.append(lab, this.bv.create({ node: x.node, stat: x.stat || 'value', fmt: fmtFor(unit) }));
        }
        card.appendChild(b);
      }
      if (item.note) {
        const p = document.createElement('p');
        p.className = 'ms-small ms-muted ms-fx-ref-note';
        p.textContent = item.note;
        card.appendChild(p);
      }
      this.scroll.appendChild(card);
    }
  }

  /** @param {string} title @param {string} icon */
  row(title, icon) {
    const el = document.createElement('div');
    el.className = 'ms-fx-row';
    const t = document.createElement('div');
    t.className = 'ms-fx-row-title';
    t.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
    t.appendChild(document.createTextNode(title));
    const body = document.createElement('div');
    body.className = 'ms-fx-row-body';
    el.append(t, body);
    return { el, body };
  }

  /** Highlight selected variables in equations and rows. */
  markSelected() {
    for (const el of this.scroll.querySelectorAll('[data-node]')) {
      const h = /** @type {HTMLElement} */ (el);
      if (h.classList.contains('ms-bv')) continue;
      h.classList.toggle('is-selected', this.selected.has(/** @type {string} */ (h.dataset.node)));
    }
    this.bv.select([...this.selected]);
  }

  // ------------------------------------------------------------------ events

  onSelection(sel) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    this.selected = new Set(sel.selected);
    if (sel.source === this.ctx?.areaId || sel.source === 'local') { this.markSelected(); return; }
    const p = sel.primary;
    let next = null;
    if (p && g.node(p)) next = p;
    else if (p && g.scope(p)) {
      const metrics = g.scope(p).metrics.map((m) => g.node(m)).filter((m) => m && m.kind === 'computed');
      next = (metrics.find((m) => m.output) || metrics.find((m) => m.headline) || metrics[0])?.id || null;
    }
    if (next && next !== this.state.focus) {
      this.back = [];
      this.state.focus = next;
      this.save();
      this.ctx?.refreshHeader();
      this.invalidate();
    } else this.markSelected();
  }

  onHover(id) {
    for (const el of this.scroll.querySelectorAll('[data-node]')) {
      const h = /** @type {HTMLElement} */ (el);
      if (h.classList.contains('ms-bv')) continue;
      h.classList.toggle('is-hovered', !!id && h.dataset.node === id);
    }
    this.bv.hover(id);
  }

  onRecompute(changed, payload) {
    if (payload?.structural) return; // onStructure rebuilds
    const id = this.currentId();
    if (payload?.full || changed.includes(id)) {
      // a point value that became a distribution (or back) changes the head (median vs value)
      const st = /** @type {any} */ (this.ctx).engine.stats(id);
      if ((!!st && !st.deterministic) !== this._stoch) { this.invalidate(); return; }
    }
    if (payload?.full || payload?.scenarioChanged) this.bv.updateAll();
    else this.bv.update(changed);
  }

  onStructure() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    if (!g.node(this.state.focus)) this.state.focus = DEFAULT_FOCUS;
    this.back = this.back.filter((id) => g.node(id));
    for (const id of [...this.state.expanded]) if (!g.node(id)) this.state.expanded.delete(id);
    this.invalidate();
  }

  onTheme() { this.invalidate(); }
  onFlags() { this.invalidate(); }

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}
