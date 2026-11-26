/**
 * Certificate editor: the full verification certificate of the current answer. Counts by
 * provenance class, sources matched, proven / not proven claims, failed checks, top drivers,
 * what was NOT checked, the verification ladder 0-8 as a vertical stepper, and Replay
 * (rebuild from hash + seed and compare bit for bit). Never says "true": only computed,
 * sourced, estimated, proven or not proven.
 * @module editors/certificate
 */
import { BaseEditor } from '../base-editor.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { STATUS_LABEL, certificateText, ladderIcon } from './view.js';

/** Ladder items rendered per level before "Show more" (stress graphs have thousands). */
const ITEM_PAGE = 40;
const ITEM_STEP = 200;
const FAILED_LIMIT = 20;

export default class CertificateEditor extends BaseEditor {
  static id = 'certificate';
  static label = 'Certificate';
  static icon = 'verified';
  static group = 'Verify & Source';

  constructor() {
    super();
    /** @type {Set<number>} expanded ladder levels (set here so getState can never throw) */
    this.expanded = new Set();
    this.lastReplay = null;
    /** @type {Map<number, number>} items shown per ladder level (paged) */
    this.itemLimit = new Map();
  }

  async mount(ctx, state) {
    // restore state synchronously, before the first await, so a save during mount keeps it
    const saved = state && Array.isArray(state.expanded) ? state.expanded : [];
    this.expanded = new Set(saved.filter((x) => Number.isInteger(x)));
    await loadCss(new URL('./certificate.css', import.meta.url));
    if (this._disposed) return; // the area moved on while the stylesheet loaded
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-cert';
    this.scroll = document.createElement('div');
    this.scroll.className = 'ms-ed-scroll ms-cert-scroll';
    this.root.appendChild(this.scroll);
    ctx.el.appendChild(this.root);
    this.on('certificate:updated', () => this.invalidate());
    // ladder keyboard navigation (one listener on the persistent scroller; the ladder is rebuilt)
    this.listen(this.scroll, 'keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ke.key)) return;
      const ol = /** @type {HTMLElement|null} */ (ke.target)?.closest?.('.ms-cert-ladder');
      if (!ol) return;
      const heads = [...ol.querySelectorAll('.ms-cert-step-head')];
      const i = heads.indexOf(/** @type {Element} */ (document.activeElement));
      if (i < 0) return;
      ke.preventDefault();
      const j = ke.key === 'Home' ? 0 : ke.key === 'End' ? heads.length - 1 : Math.max(0, Math.min(heads.length - 1, i + (ke.key === 'ArrowDown' ? 1 : -1)));
      /** @type {HTMLElement} */ (heads[j]).focus();
    });
    this.build();
  }

  getState() {
    return { expanded: this.expanded instanceof Set ? [...this.expanded] : [] };
  }

  getHeaderTools() {
    const ctx = /** @type {any} */ (this.ctx);
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const mk = (icon, label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ms-icon-btn is-small';
      b.setAttribute('aria-label', label);
      b.dataset.tooltip = label;
      b.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
      b.addEventListener('click', run);
      wrap.appendChild(b);
      return b;
    };
    mk('sync', 'Re-run the verification ladder', () => {
      ctx.services.verify.refresh();
      ctx.services.notify.info(`Verification ladder re-run on ${ctx.engine.graph.versionLabel}.`);
    });
    mk('debug-restart', 'Replay from graph hash and seed', () => this.replay());
    mk('copy', 'Copy certificate as text', () => this.copy());
    return [wrap];
  }

  /** @returns {any} */
  cert() {
    return /** @type {any} */ (this.ctx).services.verify?.certificate() || null;
  }

  build() {
    const ctx = /** @type {any} */ (this.ctx);
    const focusedLevel = /** @type {HTMLElement|null} */ (document.activeElement)?.closest?.('.ms-cert-step')?.getAttribute('data-level');
    const top = this.scroll.scrollTop;
    this.scroll.replaceChildren();
    const cert = this.cert();
    if (!cert) {
      this.scroll.appendChild(emptyState({ icon: 'verified', title: 'No certificate yet', text: 'A certificate is issued with every answer.' }));
      return;
    }
    const g = ctx.engine.graph;
    // paging of long ladder levels starts over when a different graph is loaded
    if (this.graphId !== g.graphId) {
      this.graphId = g.graphId;
      this.itemLimit.clear();
    }

    // ---------------------------------------------------------------- summary
    const failed = cert.failed.length;
    const notProven = cert.notProven.length;
    const summary = document.createElement('section');
    summary.className = 'ms-cert-summary';
    summary.dataset.state = failed ? 'fail' : notProven ? 'partial' : 'pass';
    summary.setAttribute('aria-label', 'Certificate summary');
    const badge = document.createElement('div');
    badge.className = 'ms-cert-badge';
    badge.innerHTML = `<span class="codicon codicon-${failed ? 'error' : 'verified'}" aria-hidden="true"></span>`;
    const bt = document.createElement('span');
    bt.textContent = failed
      ? `${failed} failed check${failed === 1 ? '' : 's'}`
      : `0 failed${notProven ? ` · ${notProven} not proven` : ''}`;
    badge.appendChild(bt);
    const meta = document.createElement('dl');
    meta.className = 'ms-cert-meta';
    const addMeta = (k, v, mono = true) => {
      // each term/value pair wraps as a unit
      const pair = document.createElement('div');
      pair.className = 'ms-cert-meta-item';
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      if (mono) dd.className = 'ms-mono';
      dd.textContent = v;
      pair.append(dt, dd);
      meta.appendChild(pair);
    };
    addMeta('answer', cert.answerId);
    addMeta('graph', `${cert.graphVersion} (b3:${cert.graphHash.slice(0, 4)}…)`);
    addMeta('engine', `${cert.engineName} ${cert.engineVersion}`);
    addMeta('seed', String(cert.seed));
    addMeta('samples', cert.samples.toLocaleString('en-US'));
    summary.append(badge, meta);
    this.scroll.appendChild(summary);

    // ---------------------------------------------------------------- the note
    const note = document.createElement('p');
    note.className = 'ms-cert-note';
    note.setAttribute('role', 'note');
    note.innerHTML = '<span class="codicon codicon-info" aria-hidden="true"></span>';
    const nt = document.createElement('span');
    nt.textContent = 'Verified means the conclusions follow from the graph. Whether the graph matches reality is measured, not proven.';
    note.appendChild(nt);
    this.scroll.appendChild(note);

    // ---------------------------------------------------------------- failed checks first
    if (failed) {
      const sec = this.section('Failed checks', 'error');
      const ul = document.createElement('ul');
      ul.className = 'ms-cert-list';
      for (const f of cert.failed.slice(0, FAILED_LIMIT)) {
        const li = document.createElement('li');
        li.append(this.statusPill('fail'), this.itemLabel(`L${f.level} ${f.check}: ${f.message}`, f.nodeId));
        ul.appendChild(li);
      }
      if (cert.failed.length > FAILED_LIMIT) {
        const li = document.createElement('li');
        li.className = 'ms-muted';
        li.textContent = `+${(cert.failed.length - FAILED_LIMIT).toLocaleString('en-US')} more failed checks; expand the ladder levels below to see them.`;
        ul.appendChild(li);
      }
      sec.appendChild(ul);
    }

    // ---------------------------------------------------------------- counts (the certificate block)
    const counts = this.section('What this answer rests on', 'checklist');
    const grid = document.createElement('div');
    grid.className = 'ms-cert-counts';
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', 'Metrics by provenance');
    const row = (mark, label, count, unit, detail) => {
      const r = document.createElement('div');
      r.className = 'ms-cert-count-row';
      r.setAttribute('role', 'row');
      const c1 = document.createElement('span');
      c1.className = 'ms-cert-count-label';
      c1.setAttribute('role', 'rowheader');
      if (mark) c1.appendChild(mark);
      c1.appendChild(document.createTextNode(label));
      const c2 = document.createElement('span');
      c2.className = 'ms-cert-count-n ms-tabular';
      c2.setAttribute('role', 'cell');
      c2.textContent = count;
      const c3 = document.createElement('span');
      c3.className = 'ms-cert-count-unit';
      c3.setAttribute('role', 'cell');
      c3.textContent = unit;
      const c4 = document.createElement('span');
      c4.className = 'ms-cert-count-detail';
      c4.setAttribute('role', 'cell');
      if (detail instanceof Node) c4.appendChild(detail); else c4.textContent = detail || '';
      r.append(c1, c2, c3, c4);
      grid.appendChild(r);
    };
    const c = cert.counts;
    row(provMark('computed'), 'computed', fmt(c.computed), 'metrics', 'deterministic, reproducible from hash and seed');
    row(provMark('observed'), 'observed', fmt(c.observed), 'metrics', `${cert.sources.matched}/${cert.sources.total} sources matched`);
    row(provMark('estimated'), 'estimated', fmt(c.estimated), 'metrics',
      `${cert.estimators.map((e) => `${e.name}, calibration error ${e.calibrationError} on ${e.backtests.toLocaleString('en-US')} backtests`).join('; ')}${cert.contested.length ? `; ${cert.contested.length} contested (flagged mixture)` : ''}`);
    row(provMark('input'), 'input', fmt(c.input), 'metrics', cert.overridden ? `user (${cert.overridden} overridden from model values)` : 'user');
    row(provMark('proven'), 'proven', fmt(cert.proven.length), cert.proven.length === 1 ? 'claim' : 'claims', groupClaims(cert.proven));
    const np = document.createElement('span');
    np.className = 'codicon codicon-warning ms-cert-icon-warn';
    np.setAttribute('aria-hidden', 'true');
    row(np, 'not proven', fmt(notProven), notProven === 1 ? 'claim' : 'claims', groupClaims(cert.notProven) || 'none');
    row(provMark('failed'), 'failed', fmt(failed), failed === 1 ? 'check' : 'checks', failed ? 'see the ladder below' : '');
    // top drivers (clickable)
    const drivers = document.createElement('span');
    drivers.className = 'ms-cert-drivers';
    cert.topDrivers.forEach((d, i) => {
      if (i) drivers.appendChild(document.createTextNode(' · '));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ms-cert-link';
      b.textContent = d.name;
      b.title = `${g.path(d.id)}: first-order index ${d.sobol.toFixed(2)}`;
      b.addEventListener('click', () => this.select([d.id]));
      const s = document.createElement('span');
      s.className = 'ms-tabular ms-muted';
      s.textContent = ` ${d.sobol.toFixed(2)}`;
      drivers.append(b, s);
    });
    row(null, 'top drivers (Sobol)', '', '', drivers);
    const nc = document.createElement('span');
    nc.textContent = cert.notChecked.join(' · ') || 'nothing listed';
    row(null, 'not checked', '', '', nc);
    counts.appendChild(grid);

    // ---------------------------------------------------------------- ladder
    const ladderSec = this.section('Verification ladder', 'list-ordered');
    const ol = document.createElement('ol');
    ol.className = 'ms-cert-ladder';
    ol.setAttribute('aria-label', 'Verification ladder, levels 0 to 8');
    for (const l of cert.ladder) ol.appendChild(this.step(l));
    ladderSec.appendChild(ol);

    // ---------------------------------------------------------------- claims
    const claimsSec = this.section('Claims', 'law');
    const cl = document.createElement('ul');
    cl.className = 'ms-cert-list';
    for (const p of cert.proven) {
      const li = document.createElement('li');
      li.append(this.statusPill('proven'), this.claimText(p));
      cl.appendChild(li);
    }
    for (const p of cert.notProven) {
      const li = document.createElement('li');
      li.append(this.statusPill('not_proven'), this.claimText(p));
      cl.appendChild(li);
    }
    if (!cl.children.length) cl.innerHTML = '<li class="ms-muted">No formal claims on this answer.</li>';
    claimsSec.appendChild(cl);

    // ---------------------------------------------------------------- replay
    const rep = this.section('Replay', 'debug-restart');
    const rp = document.createElement('div');
    rp.className = 'ms-cert-replay';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-btn is-secondary is-small';
    btn.innerHTML = '<span class="codicon codicon-debug-restart" aria-hidden="true"></span>Replay from hash and seed';
    btn.addEventListener('click', () => this.replay());
    const out = document.createElement('div');
    out.className = 'ms-cert-replay-out';
    out.setAttribute('role', 'status');
    out.setAttribute('aria-live', 'polite');
    this.replayOut = out;
    this.renderReplay();
    const why = document.createElement('p');
    why.className = 'ms-small ms-muted';
    why.textContent = 'Rebuilds the graph from its content, starts a fresh engine with the same seed and sample count, and compares every Monte Carlo sample of the key outputs bit for bit.';
    rp.append(btn, out, why);
    rep.appendChild(rp);

    this.scroll.scrollTop = top;
    if (focusedLevel != null) /** @type {HTMLElement|null} */ (this.scroll.querySelector(`.ms-cert-step[data-level="${focusedLevel}"] .ms-cert-step-head`))?.focus();
  }

  /** @param {string} title @param {string} icon */
  section(title, icon) {
    const sec = document.createElement('section');
    sec.className = 'ms-cert-section';
    const h = document.createElement('h3');
    h.className = 'ms-cert-h';
    h.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
    const t = document.createElement('span');
    t.textContent = title;
    h.appendChild(t);
    sec.appendChild(h);
    this.scroll.appendChild(sec);
    return sec;
  }

  /** @param {any} l ladder level */
  step(l) {
    const li = document.createElement('li');
    li.className = 'ms-cert-step';
    li.dataset.level = String(l.level);
    li.dataset.status = l.status;
    const open = this.expanded.has(l.level);
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'ms-cert-step-head';
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-label', `Level ${l.level}, ${l.name}: ${STATUS_LABEL[l.status] || l.status}. ${l.detail}`);
    const marker = document.createElement('span');
    marker.className = 'ms-cert-marker';
    marker.innerHTML = `<span class="codicon codicon-${ladderIcon(l.status)}" aria-hidden="true"></span>`;
    const num = document.createElement('span');
    num.className = 'ms-cert-level';
    num.textContent = String(l.level);
    marker.appendChild(num);
    const body = document.createElement('span');
    body.className = 'ms-cert-step-body';
    const name = document.createElement('span');
    name.className = 'ms-cert-step-name';
    name.textContent = l.name;
    const tool = document.createElement('span');
    tool.className = 'ms-cert-step-tool';
    tool.textContent = l.tool;
    const det = document.createElement('span');
    det.className = 'ms-cert-step-detail';
    det.textContent = l.detail;
    body.append(name, tool, det);
    const pill = this.statusPill(l.status);
    head.append(marker, body, pill);
    if (l.items.length) {
      const chev = document.createElement('span');
      chev.className = `codicon codicon-chevron-${open ? 'down' : 'right'} ms-cert-chev`;
      chev.setAttribute('aria-hidden', 'true');
      head.appendChild(chev);
    }
    li.appendChild(head);
    const panel = document.createElement('div');
    panel.className = 'ms-cert-step-panel';
    panel.hidden = !open;
    const catches = document.createElement('div');
    catches.className = 'ms-small ms-muted';
    catches.textContent = `Catches: ${l.catches}`;
    panel.appendChild(catches);
    if (l.items.length) {
      const ul = document.createElement('ul');
      ul.className = 'ms-cert-items';
      // failures first; large graphs list thousands of items, so render a page at a time
      const items = l.items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.status === 'fail' ? 0 : 1) - (b.it.status === 'fail' ? 0 : 1) || a.i - b.i).map((x) => x.it);
      const limit = this.itemLimit.get(l.level) || ITEM_PAGE;
      for (const it of items.slice(0, limit)) {
        const row = document.createElement('li');
        row.append(this.statusPill(it.status), this.itemLabel(it.label, it.nodeId));
        if (it.detail) {
          const d = document.createElement('div');
          d.className = 'ms-small ms-muted ms-cert-item-detail';
          d.textContent = it.detail;
          row.appendChild(d);
        }
        ul.appendChild(row);
      }
      if (items.length > limit) {
        const rest = items.length - limit;
        const row = document.createElement('li');
        row.className = 'ms-cert-more';
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'ms-btn is-secondary is-small';
        more.textContent = `Show ${Math.min(ITEM_STEP, rest).toLocaleString('en-US')} more`;
        more.addEventListener('click', () => {
          this.itemLimit.set(l.level, limit + ITEM_STEP);
          this.build();
          /** @type {HTMLElement|null} */ (this.scroll.querySelector(`.ms-cert-step[data-level="${l.level}"] .ms-cert-more button`))?.focus();
        });
        const t = document.createElement('span');
        t.className = 'ms-muted';
        t.textContent = `+${rest.toLocaleString('en-US')} more items`;
        row.append(t, more);
        ul.appendChild(row);
      }
      panel.appendChild(ul);
    }
    li.appendChild(panel);
    head.addEventListener('click', () => {
      if (this.expanded.has(l.level)) this.expanded.delete(l.level); else this.expanded.add(l.level);
      const isOpen = this.expanded.has(l.level);
      panel.hidden = !isOpen;
      head.setAttribute('aria-expanded', String(isOpen));
      const chev = head.querySelector('.ms-cert-chev');
      if (chev) chev.className = `codicon codicon-chevron-${isOpen ? 'down' : 'right'} ms-cert-chev`;
      this.save();
    });
    return li;
  }

  /** @param {string} status */
  statusPill(status) {
    const s = document.createElement('span');
    s.className = 'ms-status';
    s.dataset.status = status === 'pass' ? 'pass' : status;
    s.textContent = STATUS_LABEL[status] || status;
    return s;
  }

  /** @param {string} label @param {string|undefined} nodeId */
  itemLabel(label, nodeId) {
    if (!nodeId) {
      const s = document.createElement('span');
      s.className = 'ms-cert-item-label';
      s.textContent = label;
      return s;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ms-cert-item-label ms-cert-link';
    b.textContent = label;
    b.title = 'Select this metric';
    b.addEventListener('click', () => this.select([nodeId]));
    b.addEventListener('pointerenter', () => this.hover(nodeId));
    b.addEventListener('pointerleave', () => this.hover(null));
    return b;
  }

  /** @param {any} c */
  claimText(c) {
    const span = document.createElement('span');
    span.className = 'ms-cert-claim';
    const id = document.createElement('code');
    id.className = 'ms-inline';
    id.textContent = c.id;
    const tool = document.createElement('span');
    tool.className = 'ms-chip is-lod';
    tool.textContent = c.tool === 'lean' ? 'Lean 4' : 'SMT';
    const t = document.createElement('span');
    t.textContent = ` ${c.title}`;
    const d = document.createElement('div');
    d.className = 'ms-small ms-muted';
    d.textContent = c.detail || '';
    span.append(id, tool, t, d);
    return span;
  }

  replay() {
    const ctx = /** @type {any} */ (this.ctx);
    try {
      this.lastReplay = { ...ctx.services.verify.replay(), at: Date.now(), version: ctx.engine.graph.versionLabel };
    } catch (err) {
      this.lastReplay = { error: String(/** @type {Error} */ (err).message || err) };
    }
    this.renderReplay();
    if (this.lastReplay && this.lastReplay.identical) ctx.services.notify.success(`Replay identical: ${this.lastReplay.compared.toLocaleString('en-US')} samples compared bit for bit.`);
  }

  renderReplay() {
    const out = this.replayOut;
    if (!out) return;
    out.replaceChildren();
    const r = this.lastReplay;
    if (!r) {
      out.textContent = 'Not replayed in this session.';
      out.className = 'ms-cert-replay-out ms-muted';
      return;
    }
    if (r.error) {
      out.className = 'ms-cert-replay-out is-bad';
      out.textContent = `Replay failed: ${r.error}`;
      return;
    }
    out.className = `ms-cert-replay-out ${r.identical ? 'is-good' : 'is-bad'}`;
    const icon = document.createElement('span');
    icon.className = `codicon codicon-${r.identical ? 'pass' : 'error'}`;
    icon.setAttribute('aria-hidden', 'true');
    const t = document.createElement('span');
    t.textContent = `${r.identical ? 'Identical' : 'Differs'} on ${r.version}: ${r.compared.toLocaleString('en-US')} samples compared bit for bit · rebuilt hash b3:${r.hash.slice(0, 8)}… (${r.sameHash ? 'matches the live graph' : 'differs from the live graph hash'}) · seed ${r.seed} · ${r.samples.toLocaleString('en-US')} samples · ${Math.round(r.ms)} ms`;
    out.append(icon, t);
  }

  async copy() {
    const ctx = /** @type {any} */ (this.ctx);
    const cert = this.cert();
    if (!cert) return;
    try {
      await navigator.clipboard.writeText(certificateText(cert));
      ctx.services.notify.success('Certificate copied as text.');
    } catch {
      ctx.services.notify.warn('Clipboard is not available here.');
    }
  }

  onRecompute() { /* the verify service re-issues the certificate (certificate:updated) */ }
  onStructure() { /* idem */ }
  onTheme() { this.invalidate(); }

  render() { this.build(); }

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}

/** @param {number} n */
function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** "lean: margin_pos, cash_bounds · smt: debt_ratio_lt_0_6" @param {any[]} claims */
function groupClaims(claims) {
  const by = {};
  for (const c of claims) (by[c.tool] = by[c.tool] || []).push(c.id);
  return Object.entries(by).map(([tool, ids]) => `${tool}: ${ids.join(', ')}`).join(' · ');
}
