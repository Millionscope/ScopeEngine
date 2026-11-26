/**
 * Swarm blackboard: the current or last build as lanes per role (or one chronological stream),
 * events as cards (proposed delta with its one-line rationale, accepted / rejected by verifier
 * level N with the reason), and a Delphi panel per estimated metric: sealed independent
 * estimates, reveal, spread, revised estimates, calibration-weighted mixture and a "contested"
 * flag when the spread stays wide. Filter by role and outcome. Reads services.swarm and listens
 * to swarm:event; never imports another editor.
 * @module editors/swarm
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { makeDist, describe } from '../../model/distributions.js';
import { unitValue } from '../../model/format.js';

const KIND_ICON = { plan: 'list-tree', propose: 'diff-added', research: 'search', estimate: 'graph-scatter', review: 'eye', explain: 'comment', verify: 'verified' };
const OUTCOME_STATUS = { accepted: 'pass', rejected: 'fail', proposed: 'warn', thinking: 'na' };
const OUTCOMES = [['all', 'All'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['open', 'Open']];
/** relative spread of the medians above which a Delphi result stays contested */
const CONTESTED_SPREAD = 0.35;

export default class SwarmEditor extends BaseEditor {
  static id = 'swarm';
  static label = 'Swarm';
  static icon = 'hubot';
  static group = 'Minds & Sim';
  static needs = [];

  async mount(ctx, state) {
    await loadCss(new URL('./swarm.css', import.meta.url));
    this.state = {
      tab: state.tab || 'board',
      mode: state.mode || 'lanes',
      outcome: state.outcome || 'all',
      hiddenRoles: Array.isArray(state.hiddenRoles) ? state.hiddenRoles : [],
      showIdle: !!state.showIdle,
      /** null = follow the running build, else the last one */
      buildId: null,
    };
    /** Delphi entries whose sealed round 1 has been revealed (by event id) */
    this.revealed = new Set();
    /** cards expanded to full text */
    this.expanded = new Set();
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
    this.disposables.add({ dispose: () => this.bv.dispose() });

    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-swarm';
    this.tabs = document.createElement('div');
    this.tabs.className = 'ms-tabs';
    this.tabs.setAttribute('role', 'tablist');
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'ms-ed-toolbar ms-swarm-toolbar';
    this.body = document.createElement('div');
    this.body.className = 'ms-ed-scroll ms-swarm-body';
    this.foot = document.createElement('div');
    this.foot.className = 'ms-ed-foot';
    this.root.append(this.tabs, this.toolbar, this.body, this.foot);
    ctx.el.appendChild(this.root);

    this.on('swarm:event', (p) => {
      const shown = this.build();
      // follow a new build when not pinned to an older one
      if (p.type === 'start' && this.state.buildId === null) this.followNew = true;
      if (!shown || p.buildId === shown.id || p.type === 'start') {
        if (p.type === 'event' && p.event) this.lastEventId = p.event.id;
        this.invalidate();
      }
    });
    this.listen(this.body, 'click', (e) => this.onBodyClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.body, 'keydown', (e) => this.onBodyKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.body, 'pointerover', (e) => {
      const chip = /** @type {HTMLElement} */ (e.target).closest?.('[data-node]');
      this.hover(chip ? /** @type {HTMLElement} */ (chip).dataset.node || null : null);
    });
    this.listen(this.body, 'pointerleave', () => this.hover(null));
    this.renderAll();
  }

  getState() {
    const { tab, mode, outcome, hiddenRoles, showIdle } = this.state;
    return { tab, mode, outcome, hiddenRoles, showIdle };
  }

  /** The build on screen: the pinned one, else the running one, else the last. */
  build() {
    const svc = /** @type {any} */ (this.ctx).services.swarm;
    if (this.state.buildId) {
      const b = svc.get(this.state.buildId);
      if (b) return b;
      this.state.buildId = null;
    }
    return svc.current || svc.last();
  }

  // ------------------------------------------------------------------ header

  getHeaderTools() {
    const seg = document.createElement('div');
    seg.className = 'ms-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Layout');
    for (const [v, label, icon] of [['lanes', 'Lanes', 'layout'], ['stream', 'Stream', 'list-flat']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(this.state.mode === v));
      b.setAttribute('aria-label', label === 'Lanes' ? 'Lanes: one per role' : 'Stream: one chronological list');
      b.dataset.tooltip = label === 'Lanes' ? 'One lane per role' : 'One chronological stream';
      b.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
      b.addEventListener('click', () => {
        this.state.mode = v;
        this.save();
        this.ctx?.refreshHeader();
        this.renderAll();
      });
      seg.appendChild(b);
    }
    return [seg];
  }

  /** Build picker (in the editor toolbar, so it never crowds the area header). */
  buildPicker() {
    const svc = /** @type {any} */ (this.ctx).services.swarm;
    const sel = document.createElement('select');
    sel.className = 'ms-select is-small ms-swarm-build';
    sel.setAttribute('aria-label', 'Build');
    const follow = document.createElement('option');
    follow.value = '';
    follow.textContent = 'Latest build';
    sel.appendChild(follow);
    for (const b of [...svc.builds].reverse()) {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = `${b.title.length > 42 ? b.title.slice(0, 41) + '…' : b.title}${b.ended ? '' : ' (running)'}`;
      if (b.id === this.state.buildId) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      this.state.buildId = sel.value || null;
      this.renderAll();
    });
    return sel;
  }

  // ------------------------------------------------------------------ rendering

  render() {
    this.renderAll();
  }

  renderAll() {
    const b = this.build();
    if (this.followNew) {
      this.followNew = false;
      this.ctx?.refreshHeader();
    }
    this.renderTabs(b);
    this.bv.releaseWithin(this.body);
    const scrollTop = this.body.scrollTop;
    /** keep each lane's horizontal scroll across rebuilds */
    const laneScroll = new Map([...this.body.querySelectorAll('.ms-swarm-track')].map((t) => [/** @type {HTMLElement} */ (t).dataset.role, t.scrollLeft]));
    this.body.replaceChildren();
    this.toolbar.replaceChildren();
    if (!b) {
      this.toolbar.hidden = true;
      this.body.appendChild(emptyState({ icon: 'hubot', title: 'No swarm activity yet', text: 'Ask a question or request a structural change in the composer; the roles that work on it appear here.' }));
      this.foot.textContent = '';
      return;
    }
    this.toolbar.hidden = false;
    this.toolbar.appendChild(this.buildPicker());
    if (this.state.tab === 'delphi') {
      this.renderDelphi(b);
    } else {
      this.renderToolbar(b);
      if (this.state.mode === 'stream') this.renderStream(b);
      else this.renderLanes(b, laneScroll);
    }
    this.body.scrollTop = scrollTop;
    const acc = b.events.filter((e) => e.outcome === 'accepted').length;
    const rej = b.events.filter((e) => e.outcome === 'rejected').length;
    const dur = ((b.ended || Date.now()) - b.started) / 1000;
    this.foot.textContent = `${b.title} · ${b.events.length} events · ${acc} accepted · ${rej} rejected · ${b.ended ? `${dur < 10 ? dur.toFixed(1) : Math.round(dur)} s` : 'running'} · mock ${b.tokens.toLocaleString('en-US')} tokens`;
  }

  /** @param {any} b */
  renderTabs(b) {
    this.tabs.replaceChildren();
    const delphiCount = b ? b.delphi.length : 0;
    for (const [id, label] of [['board', 'Blackboard'], ['delphi', `Delphi${delphiCount ? ` (${delphiCount})` : ''}`]]) {
      const t = document.createElement('button');
      t.className = 'ms-tab';
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(this.state.tab === id));
      t.textContent = label;
      t.addEventListener('click', () => {
        this.state.tab = id;
        this.save();
        this.renderAll();
      });
      this.tabs.appendChild(t);
    }
  }

  /** @param {any} b */
  renderToolbar(b) {
    const seg = document.createElement('div');
    seg.className = 'ms-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Filter by outcome');
    for (const [v, label] of OUTCOMES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.setAttribute('aria-pressed', String(this.state.outcome === v));
      btn.addEventListener('click', () => {
        this.state.outcome = v;
        this.save();
        this.renderAll();
      });
      seg.appendChild(btn);
    }
    const roles = document.createElement('button');
    roles.className = 'ms-btn is-secondary is-small';
    const hidden = this.state.hiddenRoles.length;
    roles.innerHTML = '<span class="codicon codicon-filter" aria-hidden="true"></span>';
    roles.append(` Roles${hidden ? ` (${Object.keys(b.roles).length - hidden}/${Object.keys(b.roles).length})` : ''}`);
    roles.setAttribute('aria-haspopup', 'menu');
    roles.addEventListener('click', () => {
      const all = Object.keys(b.roles);
      /** @type {any[]} */
      const items = all.map((r) => ({
        label: r,
        checked: !this.state.hiddenRoles.includes(r),
        run: () => {
          const set = new Set(this.state.hiddenRoles);
          if (set.has(r)) set.delete(r);
          else set.add(r);
          this.state.hiddenRoles = [...set];
          this.save();
          this.renderAll();
        },
      }));
      items.push({ separator: true });
      items.push({ label: 'Show all roles', disabled: !this.state.hiddenRoles.length, run: () => { this.state.hiddenRoles = []; this.save(); this.renderAll(); } });
      items.push({ label: 'Show idle roles', checked: this.state.showIdle, run: () => { this.state.showIdle = !this.state.showIdle; this.save(); this.renderAll(); } });
      /** @type {any} */ (this.ctx).ui.showMenu(items, roles, { label: 'Roles' });
    });
    this.toolbar.append(seg, roles);
  }

  /** @param {any} e */
  passes(e) {
    if (this.state.hiddenRoles.includes(e.role)) return false;
    switch (this.state.outcome) {
      case 'accepted': return e.outcome === 'accepted';
      case 'rejected': return e.outcome === 'rejected';
      case 'open': return e.outcome === 'thinking' || e.outcome === 'proposed';
      default: return true;
    }
  }

  /** @param {any} b @param {Map<string, number>} laneScroll */
  renderLanes(b, laneScroll) {
    const grid = document.createElement('div');
    grid.className = 'ms-swarm-lanes';
    const byRole = new Map(Object.keys(b.roles).map((r) => [r, []]));
    b.events.forEach((e, i) => {
      if (!byRole.has(e.role)) byRole.set(e.role, []);
      byRole.get(e.role).push([e, i]);
      // Delphi estimates involve every estimator in the round
      if (e.delphi) for (const est of e.delphi.round1 || []) if (est.role !== e.role && byRole.has(est.role)) byRole.get(est.role).push([e, i, true]);
    });
    let shown = 0;
    for (const [role, list] of byRole) {
      if (this.state.hiddenRoles.includes(role)) continue;
      const visible = list.filter(([e]) => this.passes({ ...e, role }));
      const state = b.roles[role] || 'idle';
      if (!visible.length && !this.state.showIdle && (state === 'idle' || this.state.outcome !== 'all')) continue;
      shown++;
      const lane = document.createElement('div');
      lane.className = 'ms-swarm-lane';
      lane.setAttribute('role', 'group');
      lane.setAttribute('aria-label', `${role}: ${state}, ${visible.length} event${visible.length === 1 ? '' : 's'}`);
      const label = document.createElement('div');
      label.className = 'ms-swarm-lane-label';
      const dot = document.createElement('span');
      dot.className = `ms-swarm-state is-${state}`;
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'ms-swarm-role';
      name.textContent = role;
      const st = document.createElement('span');
      st.className = 'ms-swarm-state-label';
      st.textContent = state;
      label.append(dot, name, st);
      const track = document.createElement('div');
      track.className = 'ms-swarm-track';
      track.dataset.role = role;
      if (!visible.length) {
        const none = document.createElement('span');
        none.className = 'ms-muted ms-small ms-swarm-none';
        none.textContent = state === 'idle' ? 'idle in this build' : 'no events match the filter';
        track.appendChild(none);
      }
      for (const [e, i, mirror] of visible) track.appendChild(this.card(b, e, i, { mirror: !!mirror, role }));
      lane.append(label, track);
      grid.appendChild(lane);
      const prev = laneScroll.get(role);
      if (this.lastEventId && visible.some(([e]) => e.id === this.lastEventId) && !b.ended) {
        // follow live: scroll the lane that just received an event to its end
        requestScrollEnd(track);
      } else if (prev) track.scrollLeft = prev;
    }
    if (!shown) grid.appendChild(emptyState({ icon: 'filter', title: 'Nothing matches the filter', text: 'Change the outcome filter or show more roles.' }));
    this.body.appendChild(grid);
  }

  /** @param {any} b */
  renderStream(b) {
    const list = document.createElement('div');
    list.className = 'ms-swarm-stream';
    list.setAttribute('role', 'list');
    let n = 0;
    b.events.forEach((e, i) => {
      if (!this.passes(e)) return;
      n++;
      const c = this.card(b, e, i, { stream: true, role: e.role });
      c.setAttribute('role', 'listitem');
      list.appendChild(c);
    });
    if (!n) list.appendChild(emptyState({ icon: 'filter', title: 'Nothing matches the filter', text: 'Change the outcome filter or show more roles.' }));
    this.body.appendChild(list);
    if (!b.ended && this.lastEventId) requestScrollEnd(this.body, true);
  }

  /**
   * @param {any} b @param {any} e @param {number} i
   * @param {{stream?: boolean, mirror?: boolean, role: string}} opts
   */
  card(b, e, i, opts) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const el = document.createElement('article');
    const outcome = opts.mirror ? 'proposed' : e.outcome;
    el.className = `ms-swarm-card is-${outcome}${this.expanded.has(e.id) ? ' is-expanded' : ''}${opts.stream ? ' is-stream' : ''}${opts.mirror ? ' is-mirror' : ''}`;
    el.dataset.event = e.id;
    el.tabIndex = 0;
    el.setAttribute('aria-expanded', String(this.expanded.has(e.id)));
    const head = document.createElement('div');
    head.className = 'ms-swarm-card-head';
    const seq = document.createElement('span');
    seq.className = 'ms-swarm-seq';
    seq.textContent = `#${i + 1}`;
    const kind = document.createElement('span');
    kind.className = 'ms-swarm-kind';
    kind.innerHTML = `<span class="codicon codicon-${KIND_ICON[e.kind] || 'circle'}" aria-hidden="true"></span>`;
    kind.append(` ${opts.stream ? `${e.role} · ` : ''}${e.kind}`);
    const pill = document.createElement('span');
    pill.className = 'ms-status';
    pill.dataset.status = OUTCOME_STATUS[outcome] || 'na';
    if (outcome === 'thinking') pill.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>';
    pill.append(`${outcome}${e.level != null && (outcome === 'accepted' || outcome === 'rejected') ? ` · L${e.level}` : ''}`);
    if (e.level != null) pill.title = `Decided at verification ladder level ${e.level}`;
    head.append(seq, kind, pill);
    const text = document.createElement('div');
    text.className = 'ms-swarm-text';
    text.textContent = opts.mirror ? `Sealed estimate for ${e.delphi?.metric ? g.path(e.delphi.metric) : 'the new metric'} (Delphi round 1, with ${e.role})` : e.text;
    el.append(head, text);
    if (e.reason && !opts.mirror) {
      const why = document.createElement('div');
      why.className = `ms-swarm-reason${e.outcome === 'rejected' ? ' is-rejected' : ''}`;
      why.textContent = e.reason;
      el.appendChild(why);
      if (e.hint) {
        const hint = document.createElement('div');
        hint.className = 'ms-swarm-hint';
        hint.textContent = `Fix: ${e.hint}`;
        el.appendChild(hint);
      }
    }
    const foot = document.createElement('div');
    foot.className = 'ms-swarm-card-foot';
    const nodeId = e.nodeId || e.delphi?.metric;
    if (nodeId && g.node(nodeId)) {
      const chip = document.createElement('button');
      chip.className = 'ms-chip';
      chip.dataset.node = nodeId;
      chip.dataset.action = 'select';
      chip.innerHTML = '<span class="codicon codicon-symbol-field" aria-hidden="true"></span>';
      chip.append(` ${g.path(nodeId).replace(/^Bakery\./, '')}`);
      chip.title = `Select ${g.path(nodeId)}`;
      foot.appendChild(chip);
    }
    if (e.delphi && !opts.mirror) {
      const d = document.createElement('button');
      d.className = 'ms-chip';
      d.dataset.action = 'delphi';
      d.dataset.event = e.id;
      d.innerHTML = '<span class="codicon codicon-graph-scatter" aria-hidden="true"></span>';
      d.append(` Delphi${e.delphi.contested ? ' · contested' : ''}`);
      foot.appendChild(d);
    }
    const time = document.createElement('time');
    time.className = 'ms-swarm-time';
    time.dateTime = new Date(e.time).toISOString();
    time.textContent = clock(e.time);
    foot.appendChild(time);
    el.appendChild(foot);
    el.setAttribute('aria-label', `#${i + 1} ${e.role} ${e.kind}: ${text.textContent}. ${outcome}${e.level != null ? ` at level ${e.level}` : ''}${e.reason ? `. ${e.reason}` : ''}`);
    el.title = `${e.role} · ${e.kind}\n${text.textContent}${e.reason ? `\n${e.reason}` : ''}${e.hint ? `\nFix: ${e.hint}` : ''}`;
    return el;
  }

  /** @param {MouseEvent} e */
  onBodyClick(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const action = /** @type {HTMLElement|null} */ (t.closest('[data-action]'));
    if (action) {
      e.stopPropagation();
      if (action.dataset.action === 'select' && action.dataset.node) this.select([action.dataset.node]);
      else if (action.dataset.action === 'delphi') {
        this.state.tab = 'delphi';
        this.focusDelphi = action.dataset.event || null;
        this.renderAll();
      } else if (action.dataset.action === 'reveal' && action.dataset.event) {
        this.revealed.add(action.dataset.event);
        this.revealing = action.dataset.event;
        this.renderAll();
      } else if (action.dataset.action === 'seal' && action.dataset.event) {
        this.revealed.delete(action.dataset.event);
        this.renderAll();
      }
      return;
    }
    const card = /** @type {HTMLElement|null} */ (t.closest('.ms-swarm-card'));
    if (card) this.toggleCard(card);
  }

  /** @param {KeyboardEvent} e */
  onBodyKey(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.dataset?.action && t.tagName !== 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      t.click();
      return;
    }
    const card = /** @type {HTMLElement|null} */ (t.closest('.ms-swarm-card'));
    if (!card || e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.toggleCard(card);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const cards = [...this.body.querySelectorAll('.ms-swarm-card')];
      const horizontal = this.state.mode === 'lanes' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft');
      let next = null;
      if (horizontal) next = e.key === 'ArrowRight' ? card.nextElementSibling : card.previousElementSibling;
      else {
        const i = cards.indexOf(card);
        if (this.state.mode === 'lanes') {
          // jump to the first card of the next / previous lane
          const lane = card.closest('.ms-swarm-lane');
          let l = e.key === 'ArrowDown' ? lane?.nextElementSibling : lane?.previousElementSibling;
          while (l && !l.querySelector('.ms-swarm-card')) l = e.key === 'ArrowDown' ? l.nextElementSibling : l.previousElementSibling;
          next = l?.querySelector('.ms-swarm-card') || null;
        } else next = cards[i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1)] || null;
      }
      if (next instanceof HTMLElement && next.classList.contains('ms-swarm-card')) {
        e.preventDefault();
        next.focus();
        next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  /** @param {HTMLElement} card */
  toggleCard(card) {
    const id = /** @type {string} */ (card.dataset.event);
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    for (const c of this.body.querySelectorAll(`.ms-swarm-card[data-event="${id}"]`)) {
      c.classList.toggle('is-expanded', this.expanded.has(id));
      c.setAttribute('aria-expanded', String(this.expanded.has(id)));
    }
  }

  // ------------------------------------------------------------------ Delphi

  /** @param {any} b */
  renderDelphi(b) {
    if (!b.delphi.length) {
      this.body.appendChild(emptyState({ icon: 'graph-scatter', title: 'No Delphi rounds in this build', text: 'Estimated metrics get independent estimates from several estimators, a reveal, revised estimates and a calibration-weighted mixture.' }));
      return;
    }
    const intro = document.createElement('p');
    intro.className = 'ms-small ms-muted ms-delphi-intro';
    intro.textContent = 'Each estimator answers alone first; the estimates stay sealed until all are in. After the reveal they may revise, and the result is a mixture weighted by each estimator’s calibration record. A spread that stays wide is kept as a contested mixture rather than averaged away.';
    this.body.appendChild(intro);
    for (const d of b.delphi) {
      const sec = this.delphiSection(b, d);
      this.body.appendChild(sec);
      if (this.focusDelphi === d.eventId) {
        this.focusDelphi = null;
        sec.scrollIntoView({ block: 'start' });
        /** @type {HTMLElement|null} */ (sec.querySelector('button'))?.focus();
      }
    }
    this.revealing = null;
  }

  /** @param {any} b @param {any} d */
  delphiSection(b, d) {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const ev = b.events.find((e) => e.id === d.eventId);
    const revealed = this.revealed.has(d.eventId);
    const animate = this.revealing === d.eventId;
    const unit = d.unit || '';
    const r1 = (d.round1 || []).map((r) => ({ ...r, q: quantiles(r.dist) }));
    const r2 = (d.round2 || []).map((r) => ({ ...r, q: quantiles(r.dist) }));
    const mixSpec = { family: 'Mixture', components: (r2.length ? r2 : r1).map((r) => ({ w: r.weight ?? 1, dist: r.dist })) };
    const mix = quantiles(mixSpec);
    const spread1 = spreadOf(r1, mix.p50);
    const spread2 = spreadOf(r2, mix.p50);
    const contested = !!d.contested || spread2 > CONTESTED_SPREAD;
    const all = [...r1, ...r2, { q: mix }];
    let lo = Math.min(...all.map((r) => r.q.p05));
    let hi = Math.max(...all.map((r) => r.q.p95));
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.04;
    lo -= pad;
    hi += pad;
    const x = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
    const fmt = (v) => fmtVal(v, unit);

    const sec = document.createElement('section');
    sec.className = `ms-delphi${contested ? ' is-contested' : ''}`;
    sec.dataset.event = d.eventId;
    const head = document.createElement('div');
    head.className = 'ms-delphi-head';
    const title = document.createElement('h3');
    title.className = 'ms-delphi-title';
    title.textContent = d.metric && g.node(d.metric) ? g.path(d.metric) : (ev?.text || 'Estimated metric');
    head.appendChild(title);
    if (contested) {
      const flag = document.createElement('span');
      flag.className = 'ms-delphi-flag';
      flag.innerHTML = '<span class="codicon codicon-warning" aria-hidden="true"></span>';
      flag.append(' contested');
      flag.title = 'Estimators still disagree after the reveal; the result is kept as a flagged mixture.';
      head.appendChild(flag);
    }
    const act = document.createElement('button');
    act.className = revealed ? 'ms-btn is-secondary is-small' : 'ms-btn is-small';
    act.dataset.action = revealed ? 'seal' : 'reveal';
    act.dataset.event = d.eventId;
    act.innerHTML = `<span class="codicon codicon-${revealed ? 'lock' : 'unlock'}" aria-hidden="true"></span>`;
    act.append(revealed ? ' Seal again' : ' Reveal round 1');
    head.appendChild(act);
    sec.appendChild(head);

    // scale
    const axis = document.createElement('div');
    axis.className = 'ms-delphi-axis';
    axis.setAttribute('aria-hidden', 'true');
    const width = this.body.clientWidth || 600;
    for (const t of niceTicks(lo, hi, width < 420 ? 2 : width < 640 ? 4 : 6)) {
      const tk = document.createElement('span');
      tk.className = 'ms-delphi-tick';
      tk.style.left = x(t);
      tk.textContent = fmt(t);
      axis.appendChild(tk);
    }

    const rows = document.createElement('div');
    rows.className = 'ms-delphi-rows';
    rows.setAttribute('role', 'list');
    const group = (label, note) => {
      const h = document.createElement('div');
      h.className = 'ms-delphi-group';
      h.textContent = label;
      if (note) {
        const n = document.createElement('span');
        n.className = 'ms-muted';
        n.textContent = ` · ${note}`;
        h.appendChild(n);
      }
      rows.appendChild(h);
    };
    let k = 0;
    const row = (r, opts = {}) => {
      const idx = Math.max(0, Number(String(r.role || '').replace(/\D+/g, '')) - 1);
      const el = document.createElement('div');
      el.className = `ms-delphi-row${opts.sealed ? ' is-sealed' : ''}${opts.mix ? ' is-mix' : ''}${animate && !opts.sealed ? ' is-revealing' : ''}`;
      el.setAttribute('role', 'listitem');
      el.style.setProperty('--i', String(k++));
      if (!opts.mix) el.style.setProperty('--c', `var(--ms-series-${(idx % 8) + 1})`);
      const who = document.createElement('span');
      who.className = 'ms-delphi-who';
      who.textContent = opts.mix ? 'Mixture' : r.role;
      if (!opts.mix && r.weight != null) {
        const w = document.createElement('span');
        w.className = 'ms-muted';
        w.textContent = ` w ${r.weight.toFixed(2)}`;
        w.title = 'Calibration weight from this estimator’s track record';
        who.appendChild(w);
      }
      const track = document.createElement('span');
      track.className = 'ms-delphi-track';
      const vals = document.createElement('span');
      vals.className = 'ms-delphi-vals';
      if (!opts.sealed && d.metric && g.node(d.metric)) {
        // every number is clickable to its scope: estimates select the metric they estimate
        vals.dataset.action = 'select';
        vals.dataset.node = d.metric;
        vals.tabIndex = 0;
        vals.setAttribute('role', 'button');
        vals.classList.add('is-link');
      }
      if (opts.sealed) {
        track.innerHTML = '<span class="ms-delphi-seal"><span class="codicon codicon-lock" aria-hidden="true"></span> sealed</span>';
        vals.textContent = '';
        el.setAttribute('aria-label', `${r.role}: estimate sealed until all estimates are in`);
      } else {
        const bar = document.createElement('span');
        bar.className = 'ms-delphi-bar';
        bar.style.left = x(r.q.p10);
        bar.style.width = `calc(${x(r.q.p90)} - ${x(r.q.p10)})`;
        const med = document.createElement('span');
        med.className = 'ms-delphi-med';
        med.style.left = x(r.q.p50);
        track.append(bar, med);
        vals.append(provMark('estimated'), ` ${fmt(r.q.p50)}`);
        const range = document.createElement('span');
        range.className = 'ms-muted';
        range.textContent = ` (${fmt(r.q.p10)}–${fmt(r.q.p90)})`;
        vals.appendChild(range);
        const descr = opts.mix ? 'calibration-weighted mixture' : `${r.role}, ${describe(r.dist)}`;
        el.title = `${descr}\np10 ${fmt(r.q.p10)} · p50 ${fmt(r.q.p50)} · p90 ${fmt(r.q.p90)}`;
        el.setAttribute('aria-label', `${opts.mix ? 'Mixture' : r.role}: median ${fmt(r.q.p50)}, p10 to p90 ${fmt(r.q.p10)} to ${fmt(r.q.p90)}`);
      }
      el.append(who, track, vals);
      rows.appendChild(el);
    };

    group('Round 1', revealed ? `independent estimates · spread ${pctText(spread1)} of the pooled median` : 'independent estimates, sealed until all are in');
    for (const r of r1) row(r, { sealed: !revealed });
    if (revealed) {
      group('Round 2', `revised after the reveal · spread ${pctText(spread2)}${spread2 < spread1 - 0.005 ? ` (narrowed from ${pctText(spread1)})` : spread2 > spread1 + 0.005 ? ' (widened)' : ' (unchanged)'}`);
      for (const r of r2) row(r);
      group(contested ? 'Contested mixture' : 'Calibration-weighted mixture', contested ? 'kept as a flagged mixture, not averaged into one number' : 'accepted into the graph');
      row({ role: 'Mixture', dist: mixSpec, q: mix }, { mix: true });
    }
    sec.append(axis, rows);

    if (revealed) {
      const out = document.createElement('div');
      out.className = 'ms-delphi-out ms-small';
      if (d.metric && g.node(d.metric)) {
        out.append('In the graph now: ', this.bv.create({ node: d.metric, stat: 'p50' }), ' median');
        if (d.final) out.append(` · accepted as ${describe(d.final)}`);
        else if (contested) out.append(' · kept as a contested mixture (flagged in the Certificate)');
      } else if (d.final) out.append(`Accepted as ${describe(d.final)}`);
      sec.appendChild(out);
    }
    return sec;
  }

  // ------------------------------------------------------------------ sidebar

  renderSidebar(el) {
    const b = this.build();
    el.replaceChildren();
    if (!b) {
      el.innerHTML = '<div class="ms-region-empty">No build yet.</div>';
      return;
    }
    const h = document.createElement('div');
    h.className = 'ms-section-head';
    h.textContent = 'Roles';
    el.appendChild(h);
    const list = document.createElement('ul');
    list.className = 'ms-swarm-legend';
    for (const [role, state] of Object.entries(b.roles)) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `ms-swarm-state is-${state}`;
      const n = b.events.filter((e) => e.role === role).length;
      li.append(dot, ` ${role}`);
      const s = document.createElement('span');
      s.className = 'ms-muted';
      s.textContent = ` ${state}${n ? ` · ${n}` : ''}`;
      li.appendChild(s);
      list.appendChild(li);
    }
    el.appendChild(list);
  }

  onStructure() { this.invalidate(); }
  onRecompute(changed) { this.bv.update(changed); }
  onTheme() { this.invalidate(); }
  onHover(id) { this.bv.hover(id); }

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}

// ------------------------------------------------------------------ helpers

/** @param {any} spec */
function quantiles(spec) {
  const d = makeDist(spec);
  return { p05: d.quantile(0.05), p10: d.quantile(0.1), p50: d.quantile(0.5), p90: d.quantile(0.9), p95: d.quantile(0.95) };
}

/** Spread of the medians relative to the pooled median. @param {Array<{q: any}>} rows @param {number} pooled */
function spreadOf(rows, pooled) {
  if (!rows.length) return 0;
  const meds = rows.map((r) => r.q.p50);
  const scale = Math.abs(pooled) || 1;
  return (Math.max(...meds) - Math.min(...meds)) / scale;
}

/** @param {number} p */
function pctText(p) {
  return `${Math.round(p * 100)}%`;
}

/** @param {number} v @param {string} unit */
function fmtVal(v, unit) {
  if (unit === '1') return `${Math.abs(v) < 1e-9 ? '0' : (v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
  return unitValue(v, unit, { compact: true, bare: true });
}

/** @param {number} lo @param {number} hi @param {number} n */
function niceTicks(lo, hi, n) {
  const span = hi - lo;
  const raw = span / Math.max(1, n);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** @param {number} t */
function clock(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Scroll an element to its end after layout (horizontal for lanes, vertical for the stream). @param {HTMLElement} el @param {boolean} [vertical] */
function requestScrollEnd(el, vertical = false) {
  queueMicrotask(() => {
    if (vertical) el.scrollTop = el.scrollHeight;
    else el.scrollLeft = el.scrollWidth;
  });
}
