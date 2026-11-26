/**
 * Sheet: spreadsheet view of one shape (struct-of-arrays): rows are scopes of the shape,
 * columns are its metric slots. Inputs edit in place (local deltas); observed/estimated cells
 * ask to convert to input; computed cells are read-only (formula on hover). Sort, filter,
 * frozen first column, resizable columns, virtualized rows (100k rows scroll smoothly).
 * Honors the area's scenario.
 * @module editors/sheet
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { VirtualList } from '../shared/virtual-list.js';
import { provMark } from '../shared/prov-mark.js';
import { sparkline } from '../shared/sparkline.js';
import { loadCss } from '../../core/lazy.js';
import { toScopeLang } from '../../model/expr.js';
import { shiftDist } from '../../model/distributions.js';
import { PROVENANCE } from '../../theme/tokens.js';

const ROW_H = 24;

export default class SheetEditor extends BaseEditor {
  static id = 'sheet';
  static label = 'Sheet';
  static icon = 'table';
  static group = 'Scope';
  static usesScenario = true;

  async mount(ctx, state) {
    await loadCss(new URL('./sheet.css', import.meta.url));
    const g = ctx.engine.graph;
    const shapes = [...g.shapes.values()];
    this.state = {
      shape: state.shape && g.shapes.has(state.shape) ? state.shape : (g.shapes.has('Month/v1') ? 'Month/v1' : shapes[0]?.id),
      sort: state.sort || null,
      filter: state.filter || '',
      widths: state.widths || {},
    };
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services, scenarioId: () => this.scenarioId() });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-sheet';
    this.headEl = document.createElement('div');
    this.headEl.className = 'ms-sheet-head';
    this.headEl.setAttribute('role', 'row');
    this.bodyHost = document.createElement('div');
    this.bodyHost.className = 'ms-sheet-body';
    this.foot = document.createElement('div');
    this.foot.className = 'ms-ed-foot';
    this.root.append(this.headEl, this.bodyHost, this.foot);
    ctx.el.appendChild(this.root);
    this.vl = new VirtualList({
      container: this.bodyHost,
      rowHeight: ROW_H,
      renderRow: (i, row) => this.renderRow(i, row),
      schedule: (fn) => ctx.scheduler.beforeFrame(fn),
      role: 'grid',
      label: 'Sheet',
    });
    this.disposables.add({ dispose: () => this.vl.dispose() });
    this.listen(this.vl.el, 'scroll', () => { this.headEl.scrollLeft = this.vl.el.scrollLeft; }, { passive: true });
    this.listen(this.vl.el, 'dblclick', (e) => this.beginEdit(/** @type {HTMLElement} */ (e.target).closest('.ms-cell')));
    this.listen(this.vl.el, 'click', (e) => {
      const cell = /** @type {HTMLElement} */ (e.target).closest?.('.ms-cell');
      if (!cell) return;
      const id = cell.dataset.node || cell.dataset.scope;
      if (id && !(/** @type {HTMLElement} */ (e.target)).closest('.ms-bv')) this.select([id]);
    });
    this.listen(this.vl.el, 'keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      if (ke.key === 'Enter' || ke.key === 'F2') {
        const cell = /** @type {HTMLElement} */ (document.activeElement)?.closest?.('.ms-cell');
        if (cell) { ke.preventDefault(); this.beginEdit(cell); }
      }
    });
    this.rebuild();
  }

  getHeaderTools() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const sel = document.createElement('select');
    sel.className = 'ms-select is-small';
    sel.setAttribute('aria-label', 'Shape');
    sel.dataset.tooltip = 'Shape: all scopes with the same metric slots';
    const shapes = [...g.shapes.values()].filter((s) => s.scopeIds.length > 0 && s.metricNames.length > 0).sort((a, b) => b.scopeIds.length - a.scopeIds.length);
    for (const s of shapes) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${s.id} (${s.scopeIds.length} × ${s.metricNames.length})`;
      if (s.id === this.state.shape) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { this.state.shape = sel.value; this.state.sort = null; this.rebuild(); this.save(); });
    const filter = document.createElement('input');
    filter.className = 'ms-input is-small';
    filter.type = 'search';
    filter.placeholder = 'Filter rows';
    filter.setAttribute('aria-label', 'Filter rows');
    filter.value = this.state.filter;
    filter.style.width = '120px';
    filter.addEventListener('input', () => { this.state.filter = filter.value; this.rebuild(); });
    this.searchEl = filter;
    wrap.append(sel, filter);
    return [wrap];
  }

  focusSearch() { this.searchEl?.focus(); }
  getState() { return { shape: this.state.shape, sort: this.state.sort, filter: this.state.filter, widths: this.state.widths }; }

  columns() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const shape = g.shapes.get(this.state.shape);
    if (!shape) return [];
    const rank = { input: 0, observed: 1, estimated: 2, computed: 3 };
    const first = g.scope(shape.scopeIds[0]);
    const kindOf = (name) => {
      const id = first?.metrics.find((m) => g.node(m)?.name === name);
      return id ? g.node(id).kind : 'computed';
    };
    return [...shape.metricNames].sort((a, b) => rank[kindOf(a)] - rank[kindOf(b)] || a.localeCompare(b)).map((name) => ({ name, kind: kindOf(name) }));
  }

  rebuild() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const shape = g.shapes.get(this.state.shape);
    this.cols = this.columns();
    let rows = shape ? [...shape.scopeIds] : [];
    const q = this.state.filter.trim().toLowerCase();
    if (q) rows = rows.filter((sid) => g.path(sid).toLowerCase().includes(q));
    const view = ctx.engine.view(this.scenarioId());
    /** @type {Map<string, Map<string, string>>} */
    this.cellIds = new Map();
    for (const sid of rows) {
      const m = new Map();
      for (const mid of g.scope(sid)?.metrics || []) m.set(g.node(mid).name, mid);
      this.cellIds.set(sid, m);
    }
    if (this.state.sort) {
      const { col, dir } = this.state.sort;
      const val = (sid) => {
        if (col === '__name') return g.scope(sid)?.name || '';
        const id = this.cellIds.get(sid)?.get(col);
        if (!id) return -Infinity;
        const st = view.stats(id);
        return st ? st.p50 : view.value(id);
      };
      rows.sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        const c = typeof va === 'string' ? va.localeCompare(String(vb), undefined, { numeric: true }) : va - vb;
        return dir === 'asc' ? c : -c;
      });
    }
    this.rowIds = rows;
    this.renderHead();
    this.bv.releaseWithin(this.vl.el);
    this.vl.setCount(rows.length);
    this.foot.textContent = `${rows.length.toLocaleString('en-US')} rows · ${this.cols.length} metrics · shape ${this.state.shape || '—'} · values ${this.scenarioId() && this.scenarioId() !== 'base' ? `in scenario ${ctx.services.scenarios.label(this.scenarioId())}` : 'in base'}`;
  }

  colWidth(name) {
    return this.state.widths[name] || (name === '__name' ? 150 : 118);
  }

  gridTemplate() {
    return [this.colWidth('__name'), ...this.cols.map((c) => this.colWidth(c.name))].map((w) => `${w}px`).join(' ');
  }

  renderHead() {
    const head = this.headEl;
    head.replaceChildren();
    const tmpl = this.gridTemplate();
    const inner = document.createElement('div');
    inner.className = 'ms-sheet-row ms-sheet-headrow';
    inner.style.gridTemplateColumns = tmpl;
    const mk = (name, label, kind) => {
      const c = document.createElement('div');
      c.className = 'ms-cell ms-hcell' + (name === '__name' ? ' is-frozen' : '');
      c.setAttribute('role', 'columnheader');
      const s = this.state.sort;
      const sorted = s && s.col === name;
      c.setAttribute('aria-sort', sorted ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      if (kind) c.appendChild(provMark(kind));
      const t = document.createElement('span');
      t.className = 'ms-ellipsis';
      t.textContent = label;
      c.appendChild(t);
      if (sorted) {
        const i = document.createElement('span');
        i.className = `codicon codicon-arrow-${s.dir === 'asc' ? 'up' : 'down'}`;
        c.appendChild(i);
      }
      c.tabIndex = 0;
      c.addEventListener('click', () => {
        const cur = this.state.sort;
        this.state.sort = cur && cur.col === name ? (cur.dir === 'asc' ? { col: name, dir: 'desc' } : null) : { col: name, dir: 'asc' };
        this.rebuild();
        this.save();
      });
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') c.click(); });
      const grip = document.createElement('span');
      grip.className = 'ms-col-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.addEventListener('pointerdown', (e) => this.resizeCol(e, name));
      grip.addEventListener('click', (e) => e.stopPropagation());
      c.appendChild(grip);
      return c;
    };
    inner.appendChild(mk('__name', 'scope', null));
    for (const col of this.cols) inner.appendChild(mk(col.name, col.name, col.kind));
    head.appendChild(inner);
    this.vl.sizer.style.minWidth = `${[this.colWidth('__name'), ...this.cols.map((c) => this.colWidth(c.name))].reduce((a, b) => a + b, 0)}px`;
  }

  /** @param {PointerEvent} e @param {string} name */
  resizeCol(e, name) {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const w0 = this.colWidth(name);
    const target = /** @type {HTMLElement} */ (e.target);
    target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      this.state.widths[name] = Math.max(60, Math.min(420, w0 + ev.clientX - start));
      this.renderHead();
      for (const row of this.vl.rows.values()) row.firstElementChild && (/** @type {HTMLElement} */ (row.firstElementChild).style.gridTemplateColumns = this.gridTemplate());
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      this.save();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  /** @param {number} i @param {HTMLElement} row */
  renderRow(i, row) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.bv.releaseWithin(row);
    row.replaceChildren();
    const sid = this.rowIds[i];
    if (!sid) return;
    const view = ctx.engine.view(this.scenarioId());
    const inner = document.createElement('div');
    inner.className = 'ms-sheet-row';
    inner.setAttribute('role', 'row');
    inner.style.gridTemplateColumns = this.gridTemplate();
    const sel = new Set(ctx.services.selection.get().selected);
    const nameCell = document.createElement('div');
    nameCell.className = 'ms-cell is-frozen ms-cell-name' + (sel.has(sid) ? ' is-selected' : '');
    nameCell.setAttribute('role', 'rowheader');
    nameCell.dataset.scope = sid;
    nameCell.tabIndex = -1;
    nameCell.textContent = g.scope(sid)?.name || sid;
    nameCell.title = g.path(sid);
    inner.appendChild(nameCell);
    const ids = this.cellIds.get(sid);
    for (const col of this.cols) {
      const id = ids?.get(col.name);
      const cell = document.createElement('div');
      cell.className = 'ms-cell ms-num';
      cell.setAttribute('role', 'gridcell');
      cell.tabIndex = -1;
      if (!id) { cell.textContent = '—'; inner.appendChild(cell); continue; }
      const n = g.node(id);
      cell.dataset.node = id;
      cell.dataset.kind = n.kind;
      if (sel.has(id)) cell.classList.add('is-selected');
      const st = view.stats(id);
      if (st && !st.deterministic) {
        cell.appendChild(sparkline(view.sample(id), { width: 34, height: 12, color: `var(${PROVENANCE[g.displayProv(id)]?.var || '--ms-prov-computed'})`, label: `${n.name} distribution` }));
      }
      cell.appendChild(this.bv.create({ node: id, stat: st && !st.deterministic ? 'p50' : 'value', fmt: 'bare', glyph: true, plain: true }));
      if (n.kind === 'computed') cell.title = `${n.name} = ${toScopeLang(n.expr)} (computed; edit its inputs)`;
      else cell.title = `${n.kind}: double-click or Enter to edit`;
      inner.appendChild(cell);
    }
    row.appendChild(inner);
  }

  /** @param {HTMLElement|null} cell */
  beginEdit(cell) {
    const ctx = /** @type {any} */ (this.ctx);
    if (!cell || !cell.dataset.node) return;
    const g = ctx.engine.graph;
    const id = cell.dataset.node;
    const n = g.node(id);
    if (!n || n.kind === 'computed') {
      ctx.services.notify.info(`${g.path(id)} is computed: edit its inputs or its formula.`);
      return;
    }
    const scen = this.scenarioId();
    const view = ctx.engine.view(scen);
    const st = view.stats(id);
    const cur = st && !st.deterministic ? st.p50 : view.value(id);
    const input = document.createElement('input');
    input.className = 'ms-num-input ms-cell-edit';
    input.type = 'number';
    input.step = 'any';
    input.value = String(Number(cur.toPrecision(6)));
    input.setAttribute('aria-label', `Edit ${g.path(id)}`);
    this.bv.releaseWithin(cell);
    cell.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = Number(input.value);
      const changed = commit && Number.isFinite(v) && Math.abs(v - cur) > 1e-12;
      const apply = () => {
        const delta = { op: 'set', target: id, prov: 'input' };
        if (n.dist && n.dist.family !== 'Point') delta.dist = shiftDist(n.dist, cur, v);
        else delta.value = v;
        if (scen && scen !== 'base') delta.scenario = scen;
        const res = ctx.services.history.apply([delta], { author: 'user', kind: 'local' });
        ctx.store.set('status.tokens', { count: 0, local: true, touched: true });
        if (!res.ok) ctx.services.notify.warn(`Rejected: ${res.errors[0].message}`, { detail: res.errors[0].hint });
      };
      if (changed && n.kind !== 'input' && (!scen || scen === 'base')) {
        ctx.ui.showMenu([
          { header: `${n.name} is ${n.kind}${n.prov?.src ? ` (${n.prov.src})` : n.prov?.by ? ` (${n.prov.by})` : ''}` },
          { label: `Override: ${n.kind} → input`, icon: 'edit', run: apply },
          { label: 'Cancel', icon: 'close', run: () => this.vl.refresh() },
        ], cell, { label: 'Override provenance' });
      } else if (changed) apply();
      this.vl.refresh();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  onRecompute(changed, payload) {
    if (payload?.full || payload?.scenarioChanged) this.bv.updateAll(); else this.bv.update(changed);
    if (this.state.sort && !payload?.transient) this.invalidate();
  }

  onStructure() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    if (!g.shapes.has(this.state.shape)) this.state.shape = g.shapes.has('Month/v1') ? 'Month/v1' : [...g.shapes.keys()][0];
    this.rebuild();
    this.ctx?.refreshHeader();
  }

  onScenario() { this.rebuild(); }
  onSelection() { this.vl.refresh(); }
  onHover(id) {
    for (const el of this.vl.el.querySelectorAll('.ms-cell')) el.classList.toggle('is-hovered', !!id && (/** @type {HTMLElement} */ (el).dataset.node === id || /** @type {HTMLElement} */ (el).dataset.scope === id));
  }

  render() { this.rebuild(); }

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}
