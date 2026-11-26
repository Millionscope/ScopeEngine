/**
 * Properties: the anatomy of the focused scope, mirroring the IR. Identity · Prototype chain ·
 * Parent/Children · Metrics (inline editors for inputs and distributions) · Formulas ·
 * Relations · Constraints · Provenance detail (source span / estimator / proof) · Override log.
 * Honors the area's scenario: edits in a scenario become scenario overrides.
 * @module editors/inspector
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { DistEditor } from '../shared/dist-editor.js';
import { provMark } from '../shared/prov-mark.js';
import { scopeChip, kindIcon } from '../shared/scope-chip.js';
import { sparkline } from '../shared/sparkline.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { describe } from '../../model/distributions.js';
import { toScopeLang } from '../../model/expr.js';
import { unitValue } from '../../model/format.js';
import { PROVENANCE } from '../../theme/tokens.js';

const SECTIONS = ['identity', 'prototype', 'family', 'metrics', 'formulas', 'relations', 'constraints', 'provenance', 'overrides'];

export default class InspectorEditor extends BaseEditor {
  static id = 'inspector';
  static label = 'Properties';
  static icon = 'symbol-property';
  static group = 'Scope';
  static usesScenario = true;

  async mount(ctx, state) {
    await loadCss(new URL('./inspector.css', import.meta.url));
    this.collapsed = new Set(state.collapsed || []);
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services, scenarioId: () => this.scenarioId() });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    /** @type {DistEditor[]} */
    this.distEditors = [];
    this.openDist = new Set();
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-inspector';
    this.scroll = document.createElement('div');
    this.scroll.className = 'ms-ed-scroll';
    this.root.appendChild(this.scroll);
    ctx.el.appendChild(this.root);
    const sel = ctx.services.selection.get();
    this.metricId = sel.primary && ctx.engine.graph.node(sel.primary) ? sel.primary : null;
    this.build();
  }

  getState() { return { collapsed: [...this.collapsed] }; }

  getHeaderTools() {
    const b = document.createElement('button');
    b.className = 'ms-icon-btn is-small';
    b.setAttribute('aria-label', 'Collapse all sections');
    b.dataset.tooltip = 'Collapse or expand all sections';
    b.innerHTML = '<span class="codicon codicon-collapse-all" aria-hidden="true"></span>';
    b.addEventListener('click', () => {
      if (this.collapsed.size) this.collapsed.clear();
      else SECTIONS.forEach((s) => this.collapsed.add(s));
      this.save();
      this.build();
    });
    return [b];
  }

  scopeId() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const f = this.focusScope();
    return f && g.scope(f) ? f : g.rootId;
  }

  build() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    this.bv.releaseWithin(this.scroll);
    for (const d of this.distEditors) d.dispose();
    this.distEditors = [];
    this.scroll.replaceChildren();
    const sid = this.scopeId();
    const s = g.scope(sid);
    if (!s) {
      this.scroll.appendChild(emptyState({ icon: 'symbol-property', title: 'Nothing selected', text: 'Select a scope or metric to see its properties.' }));
      return;
    }
    const view = ctx.engine.view(this.scenarioId());
    const scen = this.scenarioId();

    // ---- title
    const title = document.createElement('div');
    title.className = 'ms-insp-title';
    title.innerHTML = `<span class="codicon codicon-${kindIcon(s.kind)}" aria-hidden="true"></span>`;
    const tn = document.createElement('span');
    tn.className = 'ms-insp-name';
    tn.textContent = s.name;
    const tp = document.createElement('span');
    tp.className = 'ms-muted ms-small';
    tp.textContent = g.path(sid);
    title.append(tn, tp);
    if (s.realPerson) {
      const banner = document.createElement('span');
      banner.className = 'ms-sim-banner';
      banner.textContent = 'simulation, not assessment';
      title.appendChild(banner);
    }
    if (scen && scen !== 'base') {
      const sc = document.createElement('span');
      sc.className = 'ms-chip is-lod';
      sc.textContent = `scenario: ${ctx.services.scenarios.label(scen)}`;
      title.appendChild(sc);
    }
    this.scroll.appendChild(title);

    // ---- Identity
    this.section('identity', 'Identity', (body) => {
      const dl = document.createElement('dl');
      dl.className = 'ms-kv';
      const add = (k, v) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        if (v instanceof Node) dd.appendChild(v); else dd.textContent = v;
        dl.append(dt, dd);
      };
      add('id', mono(s.id));
      add('key', mono(s.key));
      add('shape', g.shapeOfScope.get(sid) || '—');
      add('version', mono(`${g.versionLabel}:${g.shortHash.replace('b3:', '')}…`));
      if (s.lod) add('level of detail', s.lod);
      if (s.description) add('description', s.description);
      body.appendChild(dl);
    });

    // ---- Prototype chain
    this.section('prototype', 'Prototype chain', (body) => {
      const row = document.createElement('div');
      row.className = 'ms-insp-chain';
      const ids = g.protoChainIds(sid);
      ids.forEach((pid, i) => {
        const chip = document.createElement('span');
        chip.className = 'ms-chip';
        chip.textContent = g.protoName(pid);
        chip.title = `${pid}${g.prototypes[pid]?.description ? `\n${g.prototypes[pid].description}` : ''}`;
        row.appendChild(chip);
        if (i < ids.length - 1) {
          const a = document.createElement('span');
          a.className = 'codicon codicon-arrow-small-right ms-muted';
          a.setAttribute('aria-hidden', 'true');
          row.appendChild(a);
        }
      });
      body.appendChild(row);
      const sub = document.createElement('div');
      sub.className = 'ms-small ms-muted';
      sub.textContent = ids[0] || '';
      body.appendChild(sub);
    });

    // ---- Parent / children
    this.section('family', `Parent and children`, (body) => {
      const row = document.createElement('div');
      row.className = 'ms-insp-chips';
      const focus = (id) => { ctx.services.selection.select([id], { source: ctx.areaId }); };
      if (s.parent) {
        const p = document.createElement('span');
        p.className = 'ms-muted ms-small';
        p.textContent = 'parent';
        row.append(p, scopeChip(g, s.parent, { onClick: focus }));
      }
      if (s.children.length) {
        const c = document.createElement('span');
        c.className = 'ms-muted ms-small';
        c.textContent = `children (${s.children.length})`;
        row.appendChild(c);
        for (const ch of s.children.slice(0, 40)) row.appendChild(scopeChip(g, ch, { onClick: focus }));
      }
      body.appendChild(row);
    }, s.children.length);

    // ---- Metrics
    this.section('metrics', 'Metrics', (body) => {
      const table = document.createElement('table');
      table.className = 'ms-table ms-insp-metrics';
      table.innerHTML = '<thead><tr><th>metric</th><th class="num">value</th><th>unit</th><th>uncertainty</th><th>source</th></tr></thead>';
      const tbody = document.createElement('tbody');
      for (const mid of s.metrics) {
        const n = g.node(mid);
        if (!n) continue;
        const tr = document.createElement('tr');
        tr.dataset.node = mid;
        tr.classList.toggle('is-selected', mid === this.metricId);
        tr.classList.add('ms-prov-bar');
        tr.dataset.prov = g.displayProv(mid);
        const tdName = document.createElement('td');
        tdName.append(provMark(g.displayProv(mid)), document.createTextNode(` ${n.name}`));
        tdName.title = n.label || n.name;
        tdName.className = 'ms-insp-mname';
        tdName.addEventListener('click', () => this.select([mid]));
        const st = view.stats(mid);
        const tdVal = document.createElement('td');
        tdVal.className = 'num';
        const editable = n.kind !== 'computed';
        if (editable && !(n.dist && n.dist.family !== 'Point')) tdVal.appendChild(this.numberEditor(mid, view.value(mid)));
        else tdVal.appendChild(this.bv.create({ node: mid, stat: st && !st.deterministic ? 'p50' : 'value', fmt: 'bare', glyph: false }));
        const tdUnit = document.createElement('td');
        tdUnit.className = 'ms-unit';
        tdUnit.textContent = n.type.unit;
        const tdUnc = document.createElement('td');
        if (st && !st.deterministic) {
          tdUnc.appendChild(sparkline(view.sample(mid), { width: 48, height: 14, color: `var(${PROVENANCE[g.displayProv(mid)]?.var || '--ms-prov-computed'})`, label: `p10 ${unitValue(st.p10, n.type.unit, { compact: true })}, p90 ${unitValue(st.p90, n.type.unit, { compact: true })}` }));
          const txt = document.createElement('span');
          txt.className = 'ms-small ms-muted';
          txt.textContent = ` ${unitValue(st.p10, n.type.unit, { bare: true, compact: true })}–${unitValue(st.p90, n.type.unit, { bare: true, compact: true })}`;
          tdUnc.appendChild(txt);
        } else tdUnc.innerHTML = '<span class="ms-muted ms-small">point</span>';
        if (n.dist && n.dist.family !== 'Point') {
          const eb = document.createElement('button');
          eb.className = 'ms-icon-btn is-small';
          eb.setAttribute('aria-label', `Edit distribution of ${n.name}`);
          eb.dataset.tooltip = n.dist.family === 'Mixture' ? 'Contested mixture: edit to override with your own distribution' : describe(n.dist);
          eb.innerHTML = '<span class="codicon codicon-edit" aria-hidden="true"></span>';
          eb.addEventListener('click', () => {
            if (this.openDist.has(mid)) this.openDist.delete(mid); else this.openDist.add(mid);
            this.build();
          });
          tdUnc.appendChild(eb);
        }
        const tdSrc = document.createElement('td');
        tdSrc.className = 'ms-small ms-muted ms-insp-src';
        tdSrc.textContent = n.prov?.src ? `${n.prov.src}${n.prov.page ? ` p${n.prov.page}` : ''}` : n.prov?.by ? n.prov.by : n.kind === 'computed' ? 'engine' : n.prov?.overriddenFrom ? `user (was ${n.prov.overriddenFrom})` : 'user';
        tr.append(tdName, tdVal, tdUnit, tdUnc, tdSrc);
        tbody.appendChild(tr);
        if (this.openDist.has(mid) && n.dist) {
          const tr2 = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = 5;
          const de = new DistEditor({
            spec: scen && scen !== 'base' ? (ctx.engine.scenarios.get(scen)?.overrides.get(mid)?.dist || n.dist) : n.dist,
            unit: n.type.unit,
            onChange: (spec, info) => this.commitDist(mid, spec, info.final),
          });
          this.distEditors.push(de);
          td.appendChild(de.el);
          tr2.appendChild(td);
          tbody.appendChild(tr2);
        }
      }
      table.appendChild(tbody);
      body.appendChild(table);
    }, s.metrics.length);

    // ---- Formulas
    const computed = s.metrics.map((m) => g.node(m)).filter((n) => n && n.kind === 'computed');
    this.section('formulas', 'Formulas', (body) => {
      if (!computed.length) { body.innerHTML = '<div class="ms-muted ms-small">No formulas in this scope.</div>'; return; }
      for (const n of computed) {
        const row = document.createElement('div');
        row.className = 'ms-insp-formula';
        const code = document.createElement('code');
        code.className = 'ms-inline';
        code.textContent = `${n.name} = ${toScopeLang(n.expr)}`;
        const open = document.createElement('button');
        open.className = 'ms-btn is-secondary is-small';
        open.textContent = 'Open in Formula';
        open.addEventListener('click', () => ctx.commands.execute('view.reveal', 'formula', n.id));
        row.append(code, open);
        body.appendChild(row);
      }
    }, computed.length);

    // ---- Relations
    const incoming = [];
    for (const other of g.scopes.values()) for (const r of other.relations) if (r.target === sid) incoming.push({ from: other.id, r });
    this.section('relations', 'Relations', (body) => {
      if (!s.relations.length && !incoming.length) { body.innerHTML = '<div class="ms-muted ms-small">No relations.</div>'; return; }
      for (const r of s.relations) {
        const row = document.createElement('div');
        row.className = 'ms-insp-rel';
        const t = document.createElement('span');
        t.className = 'ms-mono ms-small';
        t.textContent = `${r.type} →`;
        row.append(t, scopeChip(g, r.target, { onClick: (id) => ctx.services.selection.select([id]) }));
        body.appendChild(row);
      }
      for (const { from, r } of incoming) {
        const row = document.createElement('div');
        row.className = 'ms-insp-rel';
        const t = document.createElement('span');
        t.className = 'ms-mono ms-small ms-muted';
        t.textContent = `← ${r.type}`;
        row.append(scopeChip(g, from, { onClick: (id) => ctx.services.selection.select([id]) }), t);
        body.appendChild(row);
      }
    }, s.relations.length + incoming.length);

    // ---- Constraints
    const cons = ctx.engine.constraintStatus(view === ctx.engine ? undefined : view).filter((c) => c.scope === sid);
    this.section('constraints', 'Constraints', (body) => {
      if (!cons.length) { body.innerHTML = '<div class="ms-muted ms-small">No constraints declared on this scope.</div>'; return; }
      for (const c of cons) {
        const row = document.createElement('div');
        row.className = 'ms-insp-con';
        const st = document.createElement('span');
        st.className = 'ms-status';
        st.dataset.status = c.ok ? 'pass' : c.severity === 'hard' ? 'fail' : 'warn';
        st.textContent = c.ok ? '✓ holds' : c.severity === 'hard' ? '✕ violated' : '⚠ soft warning';
        const code = document.createElement('code');
        code.className = 'ms-inline';
        code.textContent = c.label;
        row.append(st, code);
        if (c.share != null) {
          const sh = document.createElement('span');
          sh.className = 'ms-small ms-muted';
          sh.textContent = `holds in ${Math.round(c.share * 100)}% of samples`;
          row.appendChild(sh);
        }
        body.appendChild(row);
      }
    }, cons.length);

    // ---- Provenance detail (selected metric)
    this.section('provenance', 'Provenance detail', (body) => this.renderProvenance(body, view));

    // ---- Override log
    const log = ctx.services.history.entries.filter((e) => e.deltas.some((d) => (d.target && (g.scopeIdOf(d.target) === sid || d.target === sid)) || d.scope === sid || d.parent === sid));
    this.section('overrides', 'Override log', (body) => {
      if (!log.length) { body.innerHTML = '<div class="ms-muted ms-small">No changes to this scope yet.</div>'; return; }
      for (const e of log.slice(-12).reverse()) {
        const row = document.createElement('div');
        row.className = 'ms-insp-log';
        const v = document.createElement('span');
        v.className = 'ms-mono ms-small';
        v.textContent = e.version;
        const a = document.createElement('span');
        a.className = 'ms-small ms-muted';
        a.textContent = e.author;
        const t = document.createElement('span');
        t.className = 'ms-small';
        t.textContent = e.summaries.join('; ');
        row.append(v, a, t);
        body.appendChild(row);
      }
    }, log.length);
  }

  /**
   * @param {string} key @param {string} title @param {(body: HTMLElement) => void} fill @param {number} [count]
   */
  section(key, title, fill, count) {
    const sec = document.createElement('section');
    sec.className = 'ms-section' + (this.collapsed.has(key) ? ' is-collapsed' : '');
    const head = document.createElement('button');
    head.className = 'ms-section-head';
    head.setAttribute('aria-expanded', String(!this.collapsed.has(key)));
    head.innerHTML = '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>';
    const t = document.createElement('span');
    t.textContent = title;
    head.appendChild(t);
    if (count != null) {
      const b = document.createElement('span');
      b.className = 'ms-badge';
      b.textContent = String(count);
      head.appendChild(b);
    }
    head.addEventListener('click', () => {
      if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
      sec.classList.toggle('is-collapsed');
      head.setAttribute('aria-expanded', String(!this.collapsed.has(key)));
      this.save();
    });
    const body = document.createElement('div');
    body.className = 'ms-section-body';
    fill(body);
    sec.append(head, body);
    this.scroll.appendChild(sec);
  }

  /** @param {HTMLElement} body @param {any} view */
  renderProvenance(body, view) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const id = this.metricId && g.node(this.metricId) && g.scopeIdOf(this.metricId) === this.scopeId() ? this.metricId : null;
    if (!id) { body.innerHTML = '<div class="ms-muted ms-small">Select a metric to see where its value comes from.</div>'; return; }
    const n = g.node(id);
    const prov = g.displayProv(id);
    const head = document.createElement('div');
    head.className = 'ms-row';
    const name = document.createElement('strong');
    name.textContent = n.name;
    head.append(provMark(prov), name, this.bv.create({ node: id, stat: view.stats(id)?.deterministic ? 'value' : 'p50' }));
    body.appendChild(head);
    const p = document.createElement('div');
    p.className = 'ms-small ms-muted';
    p.textContent = PROVENANCE[prov]?.description || '';
    body.appendChild(p);
    if (n.kind === 'observed' || n.prov?.evidence) {
      const evs = ctx.services.evidence.forNode(id);
      for (const ev of evs) {
        const src = ctx.services.evidence.source(ev.source);
        const q = document.createElement('blockquote');
        q.className = 'ms-quote';
        q.appendChild(highlightSpan(ev.span, ev.match));
        const cite = document.createElement('div');
        cite.className = 'ms-small ms-muted';
        cite.textContent = `${src?.name || ev.source}, page ${ev.page} · ${ctx.services.evidence.status(ev, g)}`;
        q.appendChild(cite);
        body.appendChild(q);
      }
      if (!evs.length && n.prov?.src) {
        const d = document.createElement('div');
        d.className = 'ms-small';
        d.textContent = `${n.prov.src}${n.prov.page ? `, page ${n.prov.page}` : ''}${n.prov.note ? ` (${n.prov.note})` : ''}`;
        body.appendChild(d);
      }
    }
    if (n.kind === 'estimated' || n.prov?.by) {
      const d = document.createElement('div');
      d.className = 'ms-small';
      d.textContent = `Estimated by ${n.prov?.by || 'model'}${n.prov?.calib != null ? `; calibration error ${n.prov.calib} on backtests` : ''}${n.dist ? `; ${describe(n.dist)}` : ''}${n.dist?.contested ? '; contested: estimators disagree' : ''}`;
      body.appendChild(d);
    }
    if (n.prov?.overriddenFrom) {
      const d = document.createElement('div');
      d.className = 'ms-small';
      d.textContent = `Overridden by you; was ${n.prov.overriddenFrom}${n.prov.originalDist ? ` ${describe(n.prov.originalDist)}` : n.prov.originalValue != null ? ` ${unitValue(n.prov.originalValue, n.type.unit)}` : ''}.`;
      body.appendChild(d);
    }
    if (n.proven?.length) {
      for (const cid of n.proven) {
        const st = ctx.services.verify.claimStatus(cid);
        const d = document.createElement('div');
        d.className = 'ms-small';
        d.textContent = `Claim ${cid}: ${st.status.replace('_', ' ')} (${st.detail})`;
        body.appendChild(d);
      }
    }
    if (n.kind === 'computed') {
      const c = document.createElement('code');
      c.className = 'ms-inline';
      c.textContent = `${n.name} = ${toScopeLang(n.expr)}`;
      body.appendChild(c);
    }
  }

  /** Inline number field for point-valued leaf metrics. @param {string} id @param {number} value */
  numberEditor(id, value) {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const n = g.node(id);
    const inp = document.createElement('input');
    inp.className = 'ms-num-input';
    inp.type = 'number';
    inp.step = 'any';
    inp.value = String(roundInput(value));
    inp.setAttribute('aria-label', `${g.path(id)} (${n.type.unit})`);
    inp.dataset.node = id;
    const commit = () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) { inp.classList.add('is-invalid'); return; }
      inp.classList.remove('is-invalid');
      if (Math.abs(v - value) < 1e-12) return;
      const scen = this.scenarioId();
      if ((!scen || scen === 'base') && n.kind !== 'input') {
        this.confirmOverride(inp, n, () => this.applySet(id, { value: v }), () => { inp.value = String(roundInput(value)); });
        return;
      }
      this.applySet(id, { value: v });
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { inp.value = String(roundInput(value)); inp.blur(); }
    });
    return inp;
  }

  /** Inline confirmation before an observed/estimated value becomes input. */
  confirmOverride(anchor, n, ok, cancel) {
    const ctx = /** @type {any} */ (this.ctx);
    ctx.ui.showMenu([
      { header: `${n.name} is ${n.kind}${n.prov?.src ? ` (${n.prov.src}${n.prov.page ? ` p${n.prov.page}` : ''})` : ''}` },
      { label: `Override: ${n.kind} → input`, icon: 'edit', run: ok },
      { label: 'Cancel', icon: 'close', run: cancel },
    ], anchor, { label: 'Override provenance' });
  }

  /** @param {string} id @param {{value?: number, dist?: any}} change */
  applySet(id, change) {
    const ctx = /** @type {any} */ (this.ctx);
    const scen = this.scenarioId();
    const delta = { op: 'set', target: id, ...change, prov: 'input' };
    if (scen && scen !== 'base') delta.scenario = scen;
    const res = ctx.services.history.apply([delta], { author: 'user', kind: 'local' });
    ctx.store.set('status.tokens', { count: 0, local: true, touched: true });
    if (!res.ok) ctx.services.notify.warn(`Rejected: ${res.errors[0].message}`, { detail: res.errors[0].hint });
  }

  /** Distribution edits: preview while typing, commit on change. */
  commitDist(id, spec, final) {
    const ctx = /** @type {any} */ (this.ctx);
    const scen = this.scenarioId();
    const delta = { op: 'set', target: id, dist: spec, prov: 'input' };
    if (scen && scen !== 'base') delta.scenario = scen;
    if (final) {
      const res = ctx.services.history.commit([delta]);
      ctx.store.set('status.tokens', { count: 0, local: true, touched: true });
      if (!res.ok) ctx.services.notify.warn(`Rejected: ${res.errors[0].message}`);
    } else ctx.services.history.preview([delta]);
  }

  onSelection(sel) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    this.metricId = sel.primary && g.node(sel.primary) ? sel.primary : null;
    this.invalidate();
  }

  onRecompute(changed, payload) {
    if (payload?.transient || this.root.contains(document.activeElement)) {
      // keep focus in inline editors; refresh values only
      if (payload?.full || payload?.scenarioChanged) this.bv.updateAll(); else this.bv.update(changed);
      return;
    }
    const sid = this.scopeId();
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const mine = new Set(g.scope(sid)?.metrics || []);
    if (payload?.full || payload?.scenarioChanged || changed.some((id) => mine.has(id))) this.invalidate();
    else this.bv.update(changed);
  }

  onStructure() { this.invalidate(); }
  onScenario() { this.invalidate(); }
  onFlags() { this.invalidate(); }
  onHover(id) { this.bv.hover(id); }

  render() {
    const top = this.scroll.scrollTop;
    this.build();
    this.scroll.scrollTop = top;
  }

  dispose() {
    for (const d of this.distEditors) d.dispose();
    this.root?.remove();
    super.dispose();
  }
}

/** @param {string} s */
function mono(s) {
  const c = document.createElement('code');
  c.className = 'ms-inline';
  c.textContent = s;
  return c;
}

/** @param {number} v */
function roundInput(v) {
  if (!Number.isFinite(v)) return '';
  return Math.abs(v) >= 1000 ? Math.round(v * 100) / 100 : Number(v.toPrecision(6));
}

/** Quote with the matched value highlighted. @param {string} span @param {string} match */
export function highlightSpan(span, match) {
  const frag = document.createElement('span');
  const i = match ? span.indexOf(match) : -1;
  if (i < 0) { frag.textContent = span; return frag; }
  frag.append(document.createTextNode(span.slice(0, i)));
  const m = document.createElement('mark');
  m.className = 'ms-hit';
  m.textContent = match;
  frag.append(m, document.createTextNode(span.slice(i + match.length)));
  return frag;
}
