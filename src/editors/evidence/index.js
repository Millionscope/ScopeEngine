/**
 * Evidence editor: sources (name, date, type, title; stale sources marked), the values
 * extracted from each source shown as quoted spans with the matched value highlighted, their
 * match status (matched / mismatch / stale / supports / overridden / unbound), the metrics they
 * bind to (with live bound values), contested groups of conflicting sources, mock Attach, and
 * Bind for unbound extractions (a ScopeDelta that makes the metric observed).
 * Selecting a metric elsewhere filters the sources to the ones that bind it.
 * @module editors/evidence
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { scopeChip } from '../shared/scope-chip.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { STATUS_INFO, sourceIcon, quoteWithMatch } from './view.js';

/** 'LocationB.foot_traffic' (last two path segments). @param {any} g @param {string} id */
function shortPath(g, id) {
  return g.path(id).split('.').slice(-2).join('.');
}

export default class EvidenceEditor extends BaseEditor {
  static id = 'evidence';
  static label = 'Evidence';
  static icon = 'book';
  static group = 'Verify & Source';

  constructor() {
    super();
    /** editor state (set here so getState can never throw) */
    this.state = { sourceId: null, groupId: null, filter: '', nodeFilter: null };
  }

  async mount(ctx, state) {
    // restore state synchronously, before the first await, so a save during mount keeps it
    const s = state || {};
    this.state = {
      sourceId: typeof s.sourceId === 'string' ? s.sourceId : null,
      groupId: typeof s.groupId === 'string' ? s.groupId : null,
      filter: typeof s.filter === 'string' ? s.filter : '',
      nodeFilter: null,
    };
    await loadCss(new URL('./evidence.css', import.meta.url));
    if (this._disposed) return; // the area moved on while the stylesheet loaded
    this.svc = ctx.services.evidence;
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-evidence';
    this.listEl = document.createElement('div');
    this.listEl.className = 'ms-ev-list';
    this.detailEl = document.createElement('div');
    this.detailEl.className = 'ms-ev-detail ms-ed-scroll';
    this.detailEl.setAttribute('aria-live', 'polite');
    this.root.append(this.listEl, this.detailEl);
    ctx.el.appendChild(this.root);
    this.listen(this.listEl, 'keydown', (e) => this.onListKey(/** @type {KeyboardEvent} */ (e)));
    /** node ids currently shown with bound values in the detail pane */
    this.shownNodes = new Set();

    this.on('evidence:changed', (p) => {
      this._bound = null;
      if (p && p.added) {
        this.state.sourceId = p.added;
        this.state.groupId = null;
      }
      this.build();
    });
    const sel = ctx.services.selection.get();
    if (sel.primary) this.applyNodeFilter(sel.primary, false);
    if (!this.state.sourceId && !this.state.groupId) this.state.sourceId = this.svc.list()[0]?.id || null;
    this.build();
  }

  getState() {
    const st = this.state || {};
    return { sourceId: st.sourceId ?? null, groupId: st.groupId ?? null, filter: st.filter ?? '' };
  }

  getHeaderTools() {
    const ctx = /** @type {any} */ (this.ctx);
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const search = document.createElement('input');
    search.className = 'ms-input is-small';
    search.type = 'search';
    search.placeholder = 'Filter sources';
    search.setAttribute('aria-label', 'Filter sources by name, title or quoted text');
    search.value = this.state.filter;
    search.style.width = '130px';
    search.addEventListener('input', () => {
      this.state.filter = search.value;
      this.buildList();
      this.save();
    });
    this.searchEl = search;
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.className = 'ms-btn is-small';
    attach.innerHTML = '<span class="codicon codicon-file-add" aria-hidden="true"></span>Attach';
    attach.setAttribute('aria-label', 'Attach evidence (mock extraction)');
    attach.dataset.tooltip = 'Attach a document; a value is extracted from it (mock)';
    attach.addEventListener('click', () => ctx.commands.execute('evidence.attach'));
    // narrow areas hide text buttons in headers; this icon-only twin shows instead (evidence.css)
    const attachIcon = document.createElement('button');
    attachIcon.type = 'button';
    attachIcon.className = 'ms-icon-btn is-small ms-ev-attach-narrow';
    attachIcon.innerHTML = '<span class="codicon codicon-file-add" aria-hidden="true"></span>';
    attachIcon.setAttribute('aria-label', 'Attach evidence (mock extraction)');
    attachIcon.dataset.tooltip = 'Attach evidence';
    attachIcon.addEventListener('click', () => ctx.commands.execute('evidence.attach'));
    wrap.append(search, attach, attachIcon);
    return [wrap];
  }

  focusSearch() { this.searchEl?.focus(); }

  build() {
    // a new graph (or a removed synthetic source) can invalidate what is selected
    const g = /** @type {any} */ (this.ctx).engine.graph;
    if (this.state.nodeFilter && !g.node(this.state.nodeFilter)) this.state.nodeFilter = null;
    if (this.state.groupId && !this.svc.groups().some((x) => x.id === this.state.groupId)) this.state.groupId = null;
    if (this.state.sourceId && !this.svc.source(this.state.sourceId)) this.state.sourceId = null;
    if (!this.state.sourceId && !this.state.groupId) this.state.sourceId = this.svc.list()[0]?.id || null;
    this.buildList();
    this.buildDetail();
  }

  // ------------------------------------------------------------------ list

  sources() {
    const q = this.state.filter.trim().toLowerCase();
    let list = this.svc.list();
    if (q) {
      list = list.filter((s) => `${s.name} ${s.title} ${s.type}`.toLowerCase().includes(q)
        || this.svc.forSource(s.id).some((e) => (e.span || '').toLowerCase().includes(q)));
    }
    return list;
  }

  buildList() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.listEl.replaceChildren();
    // node filter chip
    if (this.state.nodeFilter) {
      const chip = document.createElement('div');
      chip.className = 'ms-ev-filter';
      const t = document.createElement('span');
      t.className = 'ms-ellipsis';
      t.textContent = `Sources for ${g.path(this.state.nodeFilter)}`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'ms-icon-btn is-small';
      x.setAttribute('aria-label', 'Show all sources');
      x.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
      x.addEventListener('click', () => { this.state.nodeFilter = null; this.build(); });
      chip.append(provMark(g.displayProv(this.state.nodeFilter)), t, x);
      this.listEl.appendChild(chip);
    }
    const ul = document.createElement('ul');
    ul.className = 'ms-ev-sources';
    ul.setAttribute('role', 'listbox');
    ul.setAttribute('aria-label', 'Sources');
    const groups = this.svc.groups();
    const binding = this.state.nodeFilter ? new Set(this.svc.forNode(this.state.nodeFilter).map((e) => e.source)) : null;
    const items = [];
    for (const grp of groups) {
      items.push({ kind: 'group', id: `group:${grp.id}`, grp });
    }
    for (const s of this.sources()) items.push({ kind: 'source', id: s.id, s });
    const selectedKey = this.state.groupId ? `group:${this.state.groupId}` : this.state.sourceId;
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'ms-ev-source';
      li.setAttribute('role', 'option');
      li.dataset.key = it.id;
      const selected = it.id === selectedKey;
      li.setAttribute('aria-selected', String(selected));
      li.tabIndex = selected ? 0 : -1;
      if (it.kind === 'group') {
        li.classList.add('is-group');
        const node = it.grp.items[0]?.binds[0];
        const hit = binding && it.grp.items.some((e) => binding.has(e.source));
        if (binding && !hit) li.classList.add('is-dim');
        li.innerHTML = '<span class="codicon codicon-warning ms-ev-icon" aria-hidden="true"></span>';
        const body = document.createElement('span');
        body.className = 'ms-ev-src-body';
        const name = document.createElement('span');
        name.className = 'ms-ev-src-name';
        name.textContent = `Contested: ${node && g.node(node) ? shortPath(g, node) : it.grp.id}`;
        const sub = document.createElement('span');
        sub.className = 'ms-ev-src-sub';
        sub.textContent = `${it.grp.items.length} sources disagree · kept as a contested group`;
        body.append(name, sub);
        li.appendChild(body);
        li.setAttribute('aria-label', `Contested group ${it.grp.id}, ${it.grp.items.length} sources disagree`);
      } else {
        const s = it.s;
        const exs = this.svc.forSource(s.id);
        const statuses = exs.map((e) => this.svc.status(e, g));
        if (binding) {
          if (binding.has(s.id)) li.classList.add('is-hit');
          else li.classList.add('is-dim');
        }
        if (s.stale) li.classList.add('is-stale');
        const icon = document.createElement('span');
        icon.className = `codicon codicon-${sourceIcon(s.type)} ms-ev-icon`;
        icon.setAttribute('aria-hidden', 'true');
        const body = document.createElement('span');
        body.className = 'ms-ev-src-body';
        const name = document.createElement('span');
        name.className = 'ms-ev-src-name';
        name.textContent = s.name;
        const sub = document.createElement('span');
        sub.className = 'ms-ev-src-sub';
        sub.textContent = `${s.date} · ${s.type}${s.title ? ` · ${s.title}` : ''}`;
        body.append(name, sub);
        const dots = document.createElement('span');
        dots.className = 'ms-ev-dots';
        for (const st of statuses) {
          const d = document.createElement('span');
          d.className = 'ms-ev-dot';
          d.dataset.status = st;
          d.title = STATUS_INFO[st]?.label || st;
          dots.appendChild(d);
        }
        li.append(icon, body, dots);
        if (s.stale) {
          const stale = document.createElement('span');
          stale.className = 'ms-status';
          stale.dataset.status = 'warn';
          stale.textContent = 'stale';
          li.appendChild(stale);
        }
        if (s.attached || s.found || s.synthetic) {
          const n = document.createElement('span');
          n.className = 'ms-chip is-lod';
          n.textContent = s.synthetic ? 'synthetic' : s.attached ? 'attached' : 'found';
          if (s.synthetic) n.title = 'Generated with the stress graph; not a real document';
          li.appendChild(n);
        }
        li.setAttribute('aria-label', `${s.name}, ${s.type}, ${s.date}${s.stale ? ', stale' : ''}; ${statuses.map((x) => STATUS_INFO[x]?.label || x).join(', ')}`);
      }
      li.addEventListener('click', () => this.choose(it.id));
      ul.appendChild(li);
    }
    this.listEl.appendChild(ul);
    // keep the selected source visible (attach, filter from a selection elsewhere)
    const cur = /** @type {HTMLElement|null} */ (ul.querySelector('.ms-ev-source[aria-selected="true"]'));
    if (cur && cur.dataset.key !== this.lastShownKey) {
      this.lastShownKey = cur.dataset.key;
      cur.scrollIntoView({ block: 'nearest' });
    }
    if (!items.length) this.listEl.appendChild(emptyState({ icon: 'book', title: 'No matching sources', text: 'Clear the filter or attach evidence.' }));
  }

  /** Roving focus in the sources list. @param {KeyboardEvent} ke */
  onListKey(ke) {
    const ul = this.listEl.querySelector('.ms-ev-sources');
    if (!ul) return;
    const opts = [...ul.querySelectorAll('.ms-ev-source')];
    const i = opts.indexOf(/** @type {Element} */ (document.activeElement));
    if (i < 0) return;
    let j = i;
    if (ke.key === 'ArrowDown') j = Math.min(opts.length - 1, i + 1);
    else if (ke.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (ke.key === 'Home') j = 0;
    else if (ke.key === 'End') j = opts.length - 1;
    else if (ke.key === 'Enter' || ke.key === ' ') {
      ke.preventDefault();
      this.choose(/** @type {string} */ (/** @type {HTMLElement} */ (opts[i]).dataset.key), true);
      return;
    } else return;
    ke.preventDefault();
    opts.forEach((o, k) => { /** @type {HTMLElement} */ (o).tabIndex = k === j ? 0 : -1; });
    /** @type {HTMLElement} */ (opts[j]).focus();
  }

  /** @param {string} key @param {boolean} [keepFocus] */
  choose(key, keepFocus = false) {
    if (key.startsWith('group:')) {
      this.state.groupId = key.slice(6);
      this.state.sourceId = null;
    } else {
      this.state.sourceId = key;
      this.state.groupId = null;
    }
    this.save();
    this.build();
    if (keepFocus) /** @type {HTMLElement|null} */ (this.listEl.querySelector(`.ms-ev-source[data-key="${CSS.escape(key)}"]`))?.focus();
  }

  // ------------------------------------------------------------------ detail

  buildDetail() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.bv.releaseWithin(this.detailEl);
    this.detailEl.replaceChildren();
    this.shownNodes.clear();
    if (this.state.groupId) {
      const grp = this.svc.groups().find((x) => x.id === this.state.groupId);
      if (grp) { this.renderGroup(grp); return; }
    }
    const s = this.state.sourceId ? this.svc.source(this.state.sourceId) : null;
    if (!s) {
      this.detailEl.appendChild(emptyState({ icon: 'book', title: 'Select a source', text: 'Choose a document to see the values extracted from it and the metrics they bind to.' }));
      return;
    }
    const head = document.createElement('div');
    head.className = 'ms-ev-head';
    head.innerHTML = `<span class="codicon codicon-${sourceIcon(s.type)}" aria-hidden="true"></span>`;
    const hb = document.createElement('div');
    hb.className = 'ms-ev-head-body';
    const name = document.createElement('div');
    name.className = 'ms-ev-head-name';
    name.textContent = s.name;
    const sub = document.createElement('div');
    sub.className = 'ms-ev-src-sub';
    sub.textContent = `${s.title || ''}${s.title ? ' · ' : ''}${s.type} · ${s.date}${s.pages ? ` · ${s.pages} page${s.pages === 1 ? '' : 's'}` : ''}`;
    hb.append(name, sub);
    head.appendChild(hb);
    this.detailEl.appendChild(head);
    if (s.stale) {
      const warn = document.createElement('div');
      warn.className = 'ms-ev-callout is-warn';
      warn.setAttribute('role', 'note');
      warn.innerHTML = '<span class="codicon codicon-warning" aria-hidden="true"></span>';
      const t = document.createElement('span');
      t.textContent = 'Stale source: older than the evidence it conflicts with. Values from it are not used as observed values.';
      warn.appendChild(t);
      this.detailEl.appendChild(warn);
    }
    if (s.synthetic) {
      const note = document.createElement('div');
      note.className = 'ms-ev-callout';
      note.setAttribute('role', 'note');
      note.innerHTML = '<span class="codicon codicon-beaker" aria-hidden="true"></span>';
      const t = document.createElement('span');
      t.textContent = 'Synthetic ledger generated with the stress graph: one series extraction bound to many observed metrics. Loading the demo graph removes it.';
      note.appendChild(t);
      this.detailEl.appendChild(note);
    }
    const exs = this.svc.forSource(s.id);
    if (!exs.length) {
      this.detailEl.appendChild(emptyState({ icon: 'quote', title: 'No values extracted', text: 'Nothing in this source is bound to the graph.' }));
      return;
    }
    for (const ex of exs) this.detailEl.appendChild(this.extractionCard(ex, s));
  }

  /** @param {any} ex @param {any} s */
  extractionCard(ex, s) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const status = this.svc.status(ex, g);
    const card = document.createElement('article');
    card.className = 'ms-ev-card';
    card.dataset.status = status;
    card.setAttribute('aria-label', `Extraction from ${s.name} page ${ex.page}: ${STATUS_INFO[status]?.label || status}`);
    if (this.state.nodeFilter && ex.binds.includes(this.state.nodeFilter)) card.classList.add('is-hit');
    const q = document.createElement('blockquote');
    q.className = 'ms-quote ms-ev-quote';
    q.appendChild(quoteWithMatch(ex.span, ex.match));
    card.appendChild(q);
    const meta = document.createElement('div');
    meta.className = 'ms-ev-meta';
    const page = document.createElement('span');
    page.className = 'ms-muted';
    page.textContent = `${s.name}, page ${ex.page}`;
    const pill = document.createElement('span');
    pill.className = 'ms-status';
    pill.dataset.status = STATUS_INFO[status]?.pill || 'na';
    pill.textContent = STATUS_INFO[status]?.label || status;
    pill.title = STATUS_INFO[status]?.description || '';
    meta.append(pill, page);
    card.appendChild(meta);

    // bound metrics
    if (ex.binds.length) {
      const binds = document.createElement('div');
      binds.className = 'ms-ev-binds';
      const lab = document.createElement('span');
      lab.className = 'ms-ev-label';
      lab.textContent = status === 'supports' ? 'supports the estimate' : 'binds';
      binds.appendChild(lab);
      // compact for series extractions that bind thousands of metrics (stress graphs):
      // the filtered metric first, then the first few, then "+N more"
      const LIMIT = 6;
      const nf = this.state.nodeFilter;
      const shown = nf && ex.binds.includes(nf) ? [nf, ...ex.binds.slice(0, LIMIT).filter((x) => x !== nf)].slice(0, LIMIT) : ex.binds.slice(0, LIMIT);
      for (const id of shown) {
        const n = g.node(id);
        if (!n) continue;
        const item = document.createElement('span');
        item.className = 'ms-ev-bind';
        const st = ctx.engine.stats(id);
        item.append(scopeChip(g, id, { onClick: (nid) => this.select([nid]) }), this.bv.create({ node: id, stat: st && !st.deterministic ? 'p50' : 'value' }));
        this.shownNodes.add(id);
        binds.appendChild(item);
      }
      if (ex.binds.length > shown.length) {
        const rest = ex.binds.length - shown.length;
        const more = document.createElement('span');
        more.className = 'ms-ev-more';
        more.textContent = `+${rest.toLocaleString('en-US')} more`;
        more.title = `${rest.toLocaleString('en-US')} more metrics are bound to this extraction. Select one anywhere to see its binding here.`;
        binds.appendChild(more);
      }
      card.appendChild(binds);
    }
    if (status === 'overridden') {
      const n = g.node(ex.binds[0]);
      const note = document.createElement('div');
      note.className = 'ms-ev-callout';
      note.textContent = `You overrode this value; ${n ? g.path(n.id) : 'the metric'} is now an input, so the evidence verifier no longer checks it against this span.`;
      card.appendChild(note);
    }
    if (status === 'mismatch') {
      const note = document.createElement('div');
      note.className = 'ms-ev-callout is-bad';
      note.textContent = 'The graph value no longer matches the span. Certificate level 4 reports this as a failed check.';
      card.appendChild(note);
    }
    if (ex.note) {
      const note = document.createElement('div');
      note.className = 'ms-ev-callout is-warn';
      note.textContent = ex.note;
      card.appendChild(note);
    }
    if (status === 'unbound') card.appendChild(this.bindRow(ex));
    return card;
  }

  /** Bind controls for an unbound extraction. @param {any} ex */
  bindRow(ex) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const row = document.createElement('div');
    row.className = 'ms-ev-bindrow';
    const lab = document.createElement('label');
    lab.className = 'ms-ev-label';
    lab.textContent = 'Bind to';
    const sel = document.createElement('select');
    sel.className = 'ms-select is-small';
    sel.setAttribute('aria-label', 'Metric to bind this value to');
    const candidates = [];
    if (ex.suggest && g.node(ex.suggest)) candidates.push(ex.suggest);
    for (const n of g.nodes.values()) {
      if (candidates.length > 40) break;
      if (n.kind === 'computed' || n.id === ex.suggest) continue;
      if ((n.type.unit || '') === (ex.unit || '')) candidates.push(n.id);
    }
    for (const id of candidates) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `${g.path(id)}${id === ex.suggest ? ' (suggested)' : ''}`;
      sel.appendChild(o);
    }
    lab.htmlFor = sel.id = `ms-ev-bind-${ex.id}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-btn is-small';
    btn.innerHTML = '<span class="codicon codicon-link" aria-hidden="true"></span>Bind';
    btn.disabled = !candidates.length;
    btn.addEventListener('click', () => {
      const nodeId = sel.value;
      const delta = this.svc.bindDelta(ex.id, nodeId, g.versionLabel);
      if (!delta) return;
      const res = ctx.services.history.apply([delta], { author: 'user', kind: 'edit' });
      if (!res.ok) {
        ctx.services.notify.warn(`Bind rejected: ${res.errors[0].message}`, { detail: res.errors[0].hint });
        return;
      }
      this.svc.markBound(ex.id, nodeId);
      ctx.services.notify.success(`${g.path(nodeId)} is now observed from ${this.svc.source(ex.source)?.name || 'the attached source'}.`);
      this.select([nodeId]);
    });
    const hint = document.createElement('span');
    hint.className = 'ms-small ms-muted';
    hint.textContent = candidates.length ? 'Makes the metric observed; the evidence verifier checks it against this span.' : 'No metric with a matching unit.';
    row.append(lab, sel, btn, hint);
    return row;
  }

  /** Contested group: conflicting sources side by side. @param {{id: string, items: any[]}} grp */
  renderGroup(grp) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const nodeId = grp.items[0]?.binds[0];
    const n = nodeId ? g.node(nodeId) : null;
    const head = document.createElement('div');
    head.className = 'ms-ev-head';
    head.innerHTML = '<span class="codicon codicon-warning" aria-hidden="true"></span>';
    const hb = document.createElement('div');
    hb.className = 'ms-ev-head-body';
    const name = document.createElement('div');
    name.className = 'ms-ev-head-name';
    name.textContent = `Contested: ${n ? shortPath(g, nodeId) : grp.id}`;
    const sub = document.createElement('div');
    sub.className = 'ms-ev-src-sub';
    sub.textContent = 'Sources disagree. Both are kept and shown; the estimate carries the spread, and Sensitivity shows whether the disagreement matters.';
    hb.append(name, sub);
    head.appendChild(hb);
    this.detailEl.appendChild(head);
    if (n) {
      const cur = document.createElement('div');
      cur.className = 'ms-ev-binds';
      const lab = document.createElement('span');
      lab.className = 'ms-ev-label';
      lab.textContent = 'graph value';
      const st = ctx.engine.stats(nodeId);
      cur.append(lab, scopeChip(g, nodeId, { onClick: (id) => this.select([id]) }), this.bv.create({ node: nodeId, stat: st && !st.deterministic ? 'p50' : 'value' }));
      this.shownNodes.add(nodeId);
      if (st && !st.deterministic) {
        const iv = document.createElement('span');
        iv.className = 'ms-small ms-muted';
        iv.append(' p10 ', this.bv.create({ node: nodeId, stat: 'p10', glyph: false, plain: true }), ' to p90 ', this.bv.create({ node: nodeId, stat: 'p90', glyph: false, plain: true }));
        cur.appendChild(iv);
      }
      this.detailEl.appendChild(cur);
    }
    const cmp = document.createElement('div');
    cmp.className = 'ms-ev-compare';
    for (const ex of grp.items) {
      const s = this.svc.source(ex.source);
      const col = document.createElement('div');
      col.className = 'ms-ev-compare-col';
      const t = document.createElement('div');
      t.className = 'ms-ev-head-name';
      t.textContent = s?.name || ex.source;
      const d = document.createElement('div');
      d.className = 'ms-ev-src-sub';
      d.textContent = `${s?.title || ''} · ${s?.date || ''}`;
      col.append(t, d, this.extractionCard(ex, s || { name: ex.source }));
      cmp.appendChild(col);
    }
    this.detailEl.appendChild(cmp);
  }

  /** @param {string} id @param {boolean} rebuild */
  applyNodeFilter(id, rebuild = true) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const nodeId = g.node(id) ? id : null;
    if (!nodeId) return false;
    const exs = this.svc.forNode(nodeId);
    if (!exs.length) {
      if (this.state.nodeFilter) { this.state.nodeFilter = null; if (rebuild) this.build(); }
      return false;
    }
    this.state.nodeFilter = nodeId;
    const grp = this.svc.groups().find((x) => x.items.some((e) => e.binds.includes(nodeId)));
    const firstReal = exs.find((e) => e.status !== 'stale') || exs[0];
    if (grp && exs.length > 1) {
      this.state.groupId = grp.id;
      this.state.sourceId = null;
    } else {
      this.state.sourceId = firstReal.source;
      this.state.groupId = null;
    }
    if (rebuild) this.build();
    return true;
  }

  onSelection(sel) {
    this.bv.select(sel.selected);
    if (sel.source === this.ctx?.areaId) return;
    if (sel.primary) this.applyNodeFilter(sel.primary);
    else if (this.state.nodeFilter) {
      // selection cleared elsewhere: drop the filter, keep the source that is open
      this.state.nodeFilter = null;
      this.build();
    }
  }

  onHover(id) { this.bv.hover(id); }

  /** Every metric bound by some extraction (cached; series extractions can bind thousands). */
  boundIds() {
    if (!this._bound) {
      this._bound = new Set();
      for (const s of this.svc.list()) for (const e of this.svc.forSource(s.id)) for (const id of e.binds) this._bound.add(id);
    }
    return this._bound;
  }

  onRecompute(changed, payload) {
    if (payload?.full || payload?.structural) { this._bound = null; this.invalidate(); return; }
    this.bv.update(changed);
    if (payload?.transient) return;
    // match status depends on graph values and provenance (overrides): refresh when a bound node changed
    const bound = this.boundIds();
    for (const id of changed) {
      if (this.shownNodes.has(id) || bound.has(id)) { this.invalidate(); return; }
    }
  }

  onStructure() { this._bound = null; this.invalidate(); }
  onTheme() { this.invalidate(); }

  render() {
    const top = this.detailEl.scrollTop;
    this.build();
    this.detailEl.scrollTop = top;
  }

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}
