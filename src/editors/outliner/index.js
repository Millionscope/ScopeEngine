/**
 * Scope Outliner: Blender-Outliner-like hierarchy of scopes and metrics (virtualized).
 * Twisty · prototype icon · name · provenance glyph · bound value · unit. Collapsed subtrees
 * show a one-line summary. Filter by text/prototype/unit, toggle provenance classes, or show
 * only the top-N sensitive inputs. Arrows/Home/End/Enter, F2 renames (a ScopeDelta), rows drag
 * into the composer.
 * @module editors/outliner
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { VirtualList } from '../shared/virtual-list.js';
import { provMark } from '../shared/prov-mark.js';
import { kindIcon } from '../shared/scope-chip.js';
import { loadCss } from '../../core/lazy.js';
import { PROVENANCE } from '../../theme/tokens.js';

const PROVS = ['input', 'observed', 'estimated', 'computed', 'proven'];

export default class OutlinerEditor extends BaseEditor {
  static id = 'outliner';
  static label = 'Outliner';
  static icon = 'list-tree';
  static group = 'Scope';

  async mount(ctx, state) {
    await loadCss(new URL('./outliner.css', import.meta.url));
    const g = ctx.engine.graph;
    this.state = {
      expanded: new Set(state.expanded || [g.rootId, 'sc_7Q2f']),
      filter: state.filter || '',
      provs: new Set(state.provs || PROVS),
      topN: state.topN || 0,
      showMetrics: state.showMetrics ?? true,
    };
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-outliner';
    ctx.el.appendChild(this.root);
    /** @type {Array<{id: string, isScope: boolean, depth: number, hasChildren: boolean}>} */
    this.rows = [];
    this.focusIndex = 0;
    this.selectedSet = new Set(ctx.services.selection.get().selected);
    this.hovered = null;
    this.vl = new VirtualList({
      container: this.root,
      rowHeight: 22,
      renderRow: (i, row) => this.renderRow(i, row),
      schedule: (fn) => ctx.scheduler.beforeFrame(fn),
      role: 'tree',
      label: 'Scope outliner',
    });
    this.disposables.add({ dispose: () => this.vl.dispose() });
    this.listen(this.vl.el, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.vl.el, 'click', (e) => this.onClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.vl.el, 'dblclick', (e) => this.onDblClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.vl.el, 'pointerover', (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest?.('.ms-vlist-row');
      const id = row?.dataset.id || null;
      if (id !== this._lastHover) { this._lastHover = id; this.hover(id); }
    });
    this.listen(this.vl.el, 'pointerleave', () => { this._lastHover = null; this.hover(null); });
    this.listen(this.vl.el, 'dragstart', (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest?.('.ms-vlist-row');
      const id = row?.dataset.id;
      const de = /** @type {DragEvent} */ (e);
      if (id && de.dataTransfer) {
        de.dataTransfer.setData('text/x-ms-node', id);
        de.dataTransfer.setData('text/plain', `@${ctx.engine.graph.path(id)}`);
      }
    });
    this.rebuild();
    const sel = ctx.services.selection.get();
    if (sel.primary) this.reveal(sel.primary);
  }

  getHeaderMenus() {
    const ctx = /** @type {any} */ (this.ctx);
    return [{
      label: 'View',
      items: () => [
        { label: 'Expand All', run: () => { for (const s of ctx.engine.graph.scopes.keys()) this.state.expanded.add(s); this.rebuild(); } },
        { label: 'Collapse All', run: () => { this.state.expanded = new Set([ctx.engine.graph.rootId]); this.rebuild(); } },
        { label: 'Show Metrics', checked: this.state.showMetrics, run: () => { this.state.showMetrics = !this.state.showMetrics; this.rebuild(); } },
        { separator: true },
        { header: 'Only top-N sensitive inputs' },
        ...[0, 5, 10, 20].map((n) => ({ label: n ? `Top ${n} for monthly cash` : 'Off', checked: this.state.topN === n, run: () => { this.state.topN = n; this.rebuild(); } })),
      ],
    }];
  }

  getHeaderTools() {
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const input = document.createElement('input');
    input.className = 'ms-input is-small';
    input.type = 'search';
    input.placeholder = 'Filter name, prototype, unit';
    input.setAttribute('aria-label', 'Filter scopes and metrics');
    input.value = this.state.filter;
    input.style.width = '150px';
    input.addEventListener('input', () => { this.state.filter = input.value; this.rebuild(); });
    this.searchEl = input;
    wrap.appendChild(input);
    for (const p of PROVS) {
      const b = document.createElement('button');
      b.className = 'ms-icon-btn is-small ms-toggle';
      b.setAttribute('aria-pressed', String(this.state.provs.has(p)));
      b.setAttribute('aria-label', `Show ${p} metrics`);
      b.dataset.tooltip = `Show ${PROVENANCE[p].label} metrics`;
      b.appendChild(provMark(p));
      b.addEventListener('click', () => {
        if (this.state.provs.has(p)) this.state.provs.delete(p);
        else this.state.provs.add(p);
        b.setAttribute('aria-pressed', String(this.state.provs.has(p)));
        this.rebuild();
      });
      wrap.appendChild(b);
    }
    return [wrap];
  }

  focusSearch() { this.searchEl?.focus(); }

  getState() {
    return { expanded: [...this.state.expanded], filter: this.state.filter, provs: [...this.state.provs], topN: this.state.topN, showMetrics: this.state.showMetrics };
  }

  /** Flatten the visible tree. */
  rebuild() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const q = this.state.filter.trim().toLowerCase();
    let allowed = null;
    if (this.state.topN) {
      const s = ctx.engine.sensitivity('sc_bakery.monthly_cash');
      allowed = new Set(s.items.slice(0, this.state.topN).map((it) => it.id));
    }
    const nodeVisible = (id) => {
      const n = g.node(id);
      if (!n) return false;
      if (!this.state.provs.has(g.displayProv(id) === 'contested' ? 'estimated' : g.displayProv(id))) return false;
      if (allowed && !allowed.has(id)) return false;
      if (!q) return true;
      return n.name.toLowerCase().includes(q) || (n.type.unit || '').toLowerCase().includes(q) || g.path(id).toLowerCase().includes(q) || (n.label || '').toLowerCase().includes(q);
    };
    /** @type {Map<string, boolean>} */
    const memo = new Map();
    const scopeMatches = (sid) => {
      if (memo.has(sid)) return memo.get(sid);
      const s = g.scope(sid);
      let ok = !q && !allowed;
      if (!ok && q && !allowed) ok = s.name.toLowerCase().includes(q) || g.protoChainNames(sid).some((p) => p.toLowerCase().includes(q));
      if (!ok) ok = (this.state.showMetrics && s.metrics.some(nodeVisible)) || s.children.some(scopeMatches);
      memo.set(sid, ok);
      return ok;
    };
    const rows = [];
    const filtering = !!q || !!allowed;
    const walk = (sid, depth) => {
      const s = g.scope(sid);
      if (!s || !scopeMatches(sid)) return;
      const hasChildren = s.children.length > 0 || (this.state.showMetrics && s.metrics.length > 0);
      rows.push({ id: sid, isScope: true, depth, hasChildren });
      const open = this.state.expanded.has(sid) || filtering;
      if (!open) return;
      if (this.state.showMetrics) for (const m of s.metrics) if (nodeVisible(m)) rows.push({ id: m, isScope: false, depth: depth + 1, hasChildren: false });
      for (const c of s.children) walk(c, depth + 1);
    };
    if (g.rootId) walk(g.rootId, 0);
    this.rows = rows;
    this.focusIndex = Math.min(this.focusIndex, Math.max(0, rows.length - 1));
    this.bv.releaseWithin(this.vl.el);
    this.vl.setCount(rows.length);
    this.save();
  }

  /** @param {number} i @param {HTMLElement} row */
  renderRow(i, row) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const r = this.rows[i];
    this.bv.releaseWithin(row);
    row.replaceChildren();
    if (!r) return;
    row.className = 'ms-vlist-row ms-list-row';
    row.dataset.id = r.id;
    row.draggable = true;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(r.depth + 1));
    row.setAttribute('aria-selected', String(this.selectedSet.has(r.id)));
    row.classList.toggle('is-selected', this.selectedSet.has(r.id));
    row.classList.toggle('is-focused', i === this.focusIndex && this.vl.el === document.activeElement);
    row.classList.toggle('is-hovered-elsewhere', this.hovered === r.id);
    row.style.paddingLeft = `${6 + r.depth * 14}px`;
    const tw = document.createElement('span');
    tw.className = 'ms-ol-twisty';
    if (r.isScope && r.hasChildren) {
      const open = this.state.expanded.has(r.id) || !!this.state.filter || !!this.state.topN;
      tw.className += ` codicon codicon-chevron-${open ? 'down' : 'right'}`;
      tw.dataset.twisty = '1';
      row.setAttribute('aria-expanded', String(open));
    }
    row.appendChild(tw);
    if (r.isScope) {
      const s = g.scope(r.id);
      // a row can outlive its scope for one frame while another graph loads; the rebuild follows
      if (!s) return row;
      const icon = document.createElement('span');
      icon.className = `codicon codicon-${kindIcon(s.kind)} ms-ol-icon`;
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'ms-ol-name is-scope';
      name.textContent = s.name;
      const proto = document.createElement('span');
      proto.className = 'ms-ol-proto';
      proto.textContent = `: ${g.protoName(s.proto)}${s.lod ? ` · ${s.lod}` : ''}`;
      row.append(icon, name, proto);
      const open = this.state.expanded.has(r.id) || !!this.state.filter || !!this.state.topN;
      if (!open && r.hasChildren) {
        const sum = document.createElement('span');
        sum.className = 'ms-ol-summary';
        sum.textContent = g.summary(r.id, (id) => {
          const st = ctx.engine.stats(id);
          return st && !st.deterministic ? st.p50 : ctx.engine.value(id);
        });
        row.appendChild(sum);
      }
      row.setAttribute('aria-label', `${s.name} scope, ${g.protoChainNames(r.id).join(' to ')}`);
    } else {
      const n = g.node(r.id);
      if (!n) return row;
      const prov = g.displayProv(r.id);
      const mark = provMark(prov);
      mark.classList.add('ms-ol-mark');
      const name = document.createElement('span');
      name.className = 'ms-ol-name';
      name.textContent = n.name;
      const spacer = document.createElement('span');
      spacer.className = 'ms-spacer';
      const st = ctx.engine.stats(r.id);
      const val = this.bv.create({ node: r.id, stat: st && !st.deterministic ? 'p50' : 'value', fmt: 'bare', glyph: false, plain: true });
      val.classList.add('ms-ol-value');
      const unit = document.createElement('span');
      unit.className = 'ms-unit ms-ol-unit';
      unit.textContent = n.type.unit;
      row.append(mark, name, spacer, val, unit);
      row.setAttribute('aria-label', `${n.name}, ${PROVENANCE[prov]?.label || prov}`);
    }
  }

  /** @param {MouseEvent} e */
  onClick(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const row = t.closest?.('.ms-vlist-row');
    if (!row) return;
    const i = Number(row.dataset.index);
    const r = this.rows[i];
    if (!r) return;
    this.focusIndex = i;
    if (t.dataset.twisty) {
      this.toggle(r.id);
      return;
    }
    if (e.shiftKey && this.anchorIndex != null) {
      const [a, b] = [Math.min(this.anchorIndex, i), Math.max(this.anchorIndex, i)];
      this.select(this.rows.slice(a, b + 1).map((x) => x.id));
    } else if (e.ctrlKey || e.metaKey) this.select([r.id], { mode: 'toggle' });
    else {
      this.anchorIndex = i;
      this.select([r.id]);
    }
  }

  /** @param {MouseEvent} e */
  onDblClick(e) {
    const row = /** @type {HTMLElement} */ (e.target).closest?.('.ms-vlist-row');
    const r = row ? this.rows[Number(row.dataset.index)] : null;
    if (r?.isScope) this.toggle(r.id);
  }

  /** @param {string} id */
  toggle(id) {
    if (this.state.expanded.has(id)) this.state.expanded.delete(id);
    else this.state.expanded.add(id);
    this.rebuild();
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const n = this.rows.length;
    if (!n) return;
    let i = this.focusIndex;
    const r = this.rows[i];
    switch (e.key) {
      case 'ArrowDown': i = Math.min(n - 1, i + 1); break;
      case 'ArrowUp': i = Math.max(0, i - 1); break;
      case 'Home': i = 0; break;
      case 'End': i = n - 1; break;
      case 'PageDown': i = Math.min(n - 1, i + 15); break;
      case 'PageUp': i = Math.max(0, i - 15); break;
      case 'ArrowRight':
        if (r?.isScope && r.hasChildren && !this.state.expanded.has(r.id)) { this.toggle(r.id); e.preventDefault(); return; }
        i = Math.min(n - 1, i + 1);
        break;
      case 'ArrowLeft':
        if (r?.isScope && this.state.expanded.has(r.id)) { this.toggle(r.id); e.preventDefault(); return; }
        for (let k = i - 1; k >= 0; k--) if (this.rows[k].depth < r.depth) { i = k; break; }
        break;
      case 'Enter': case ' ':
        if (r) this.select([r.id], { mode: e.ctrlKey || e.metaKey ? 'toggle' : 'replace' });
        e.preventDefault();
        return;
      case 'F2':
        if (r) this.rename(r.id);
        e.preventDefault();
        return;
      default: return;
    }
    e.preventDefault();
    this.focusIndex = i;
    this.vl.scrollToIndex(i);
    this.vl.refresh();
  }

  /** Rename a scope inline (creates a rename ScopeDelta). @param {string} id */
  rename(id) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const scopeId = g.isScope(id) ? id : g.scopeIdOf(id);
    const s = g.scope(scopeId);
    const idx = this.rows.findIndex((r) => r.id === scopeId);
    if (!s || idx < 0) return;
    this.vl.scrollToIndex(idx);
    const row = this.vl.rowAt(idx);
    const nameEl = row?.querySelector('.ms-ol-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'ms-input is-small ms-ol-rename';
    input.value = s.name;
    input.setAttribute('aria-label', `Rename ${s.name}`);
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (commit && name && name !== s.name) {
        const res = ctx.services.history.apply([{ op: 'rename', target: scopeId, name }], { author: 'user', kind: 'edit' });
        if (!res.ok) ctx.services.notify.warn(`Rename rejected: ${res.errors[0].message}`, { detail: res.errors[0].hint });
      }
      this.vl.refresh();
      this.vl.el.focus();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Expand ancestors and scroll to an id. @param {string} id */
  reveal(id) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const sid = g.scopeIdOf(id);
    if (!sid) return;
    let changed = false;
    const toOpen = g.isScope(id) ? g.ancestors(sid) : [sid, ...g.ancestors(sid)];
    for (const a of toOpen) if (!this.state.expanded.has(a)) { this.state.expanded.add(a); changed = true; }
    if (changed) this.rebuild();
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.focusIndex = idx;
      this.vl.scrollToIndex(idx, 'center');
    }
  }

  onSelection(sel) {
    this.selectedSet = new Set(sel.selected);
    this.bv.select(sel.selected);
    if (sel.primary && sel.source !== this.ctx?.areaId) this.reveal(sel.primary);
    this.vl.refresh();
  }

  onHover(id) {
    this.hovered = id;
    for (const row of this.vl.rows.values()) row.classList.toggle('is-hovered-elsewhere', !!id && row.dataset.id === id);
  }

  onRecompute(changed, payload) {
    if (payload?.full) this.bv.updateAll();
    else this.bv.update(changed);
    // summaries of collapsed scopes may include changed headline values
    if (this._sumTimer) return;
    this._sumTimer = setTimeout(() => { this._sumTimer = 0; this.vl.refresh(); }, 250);
  }

  onStructure() {
    const ctx = /** @type {any} */ (this.ctx);
    for (const id of [...this.state.expanded]) if (!ctx.engine.graph.scope(id)) this.state.expanded.delete(id);
    this.rebuild();
  }

  onScenario() { this.bv.updateAll(); }
  onTheme() { this.vl.refresh(); }

  render() {}

  dispose() {
    clearTimeout(this._sumTimer);
    this.root?.remove();
    super.dispose();
  }
}
