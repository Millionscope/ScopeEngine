/**
 * Minds editor: the modeled parties as Mind Scopes. Simulation, not assessment.
 *   Parties          one card per party: goals, traits, knowledge partition, beliefs by world,
 *                    relationships, affect; LOD chip and banner on every header
 *   Nested beliefs   depth 0 -> 1 -> 2 as a d3 tree or radial layout with live values
 *   Relationships    d3 force layout, edge width = trust (ticked by the shared scheduler)
 *   Evidence trail   Infer (mind.infer): log Bayes factor waterfall, prior vs posterior,
 *                    observations (speech as a simulation voice) and live downstream values
 *   Claims           a probability with reasons, not a verdict
 * @module editors/minds
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { emptyState } from '../shared/empty-state.js';
import { tableToggle } from '../shared/chart-table.js';
import { DisposableStore } from '../../core/disposable.js';
import { loadCss } from '../../core/lazy.js';
import { CardsView } from './cards.js';
import { NestedView } from './nested.js';
import { RelationsView } from './relations.js';
import { TrailView } from './trail.js';
import { ClaimsView } from './claims.js';

const TABS = [
  { id: 'cards', label: 'Parties', short: 'Parties' },
  { id: 'nested', label: 'Nested beliefs', short: 'Nested' },
  { id: 'relations', label: 'Relationships', short: 'Relations' },
  { id: 'trail', label: 'Evidence trail', short: 'Trail' },
  { id: 'claims', label: 'Claims', short: 'Claims' },
];
const CHART_TABS = new Set(['nested', 'relations', 'trail']);

export default class MindsEditor extends BaseEditor {
  static id = 'minds';
  static label = 'Minds';
  static icon = 'organization';
  static group = 'Minds & Sim';
  static needs = ['d3'];

  constructor() {
    super();
    /** editor state (set here so getState can never throw) */
    this.state = { tab: 'cards', agentId: null, table: false, layout: 'tree' };
  }

  async mount(ctx, state) {
    // restore state synchronously, before the first await, so a save during mount keeps it
    const s = state || {};
    this.mind = ctx.services.mind;
    const parties = this.mind.parties();
    this.state = {
      tab: TABS.some((t) => t.id === s.tab) ? s.tab : 'cards',
      agentId: parties.some((p) => p.id === s.agentId) ? s.agentId : parties[0]?.id || null,
      table: !!s.table,
      layout: s.layout === 'radial' ? 'radial' : 'tree',
    };
    await loadCss(new URL('./minds.css', import.meta.url));
    if (this._disposed) return; // the area moved on while the stylesheet loaded
    this.d3 = ctx.libs.d3;
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    /** disposables of the current tab view (force simulation, animations) */
    this.viewD = this.disposables.add(new DisposableStore());
    /** @type {any} */
    this.view = null;
    this.needsBuild = false;
    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-minds';
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'ms-tabs ms-minds-tabs';
    this.tabsEl.setAttribute('role', 'tablist');
    this.tabsEl.setAttribute('aria-label', 'Minds views');
    this.panel = document.createElement('div');
    this.panel.className = 'ms-ed-scroll ms-minds-panel';
    this.panel.setAttribute('role', 'tabpanel');
    this.panel.id = `${ctx.areaId}-minds-panel`;
    this.panel.tabIndex = -1;
    this.root.append(this.tabsEl, this.panel);
    ctx.el.appendChild(this.root);
    this.w = ctx.el.clientWidth || 600;
    this.h = ctx.el.clientHeight || 400;

    this.listen(this.tabsEl, 'keydown', (e) => this.onTabKey(/** @type {KeyboardEvent} */ (e)));
    this.on('mind:inferred', () => { this.needsBuild = true; this.invalidate(); });
    this.on('evidence:changed', () => { if (this.state.tab === 'cards' || this.state.tab === 'trail') { this.needsBuild = true; this.invalidate(); } });

    const sel = ctx.services.selection.get();
    const fromSel = this.partyOf(sel.primary);
    if (fromSel && !s.agentId) this.state.agentId = fromSel;
    this.buildTabs();
    this.buildPanel();
  }

  getState() {
    const st = this.state || {};
    return { tab: st.tab || 'cards', agentId: st.agentId ?? null, table: !!st.table, layout: st.layout === 'radial' ? 'radial' : 'tree' };
  }

  /** The selected party profile. */
  agent() {
    const parties = this.mind.parties();
    return parties.find((p) => p.id === this.state.agentId) || parties[0] || null;
  }

  /** Party id for a scope or metric id (null when it is not a modeled party). @param {string|null} id */
  partyOf(id) {
    if (!id) return null;
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const sid = g.scopeIdOf(id);
    return this.mind.parties().some((p) => p.id === sid) ? sid : null;
  }

  // ------------------------------------------------------------------ header

  getHeaderTools() {
    const ctx = /** @type {any} */ (this.ctx);
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const sel = document.createElement('select');
    sel.className = 'ms-select is-small';
    sel.setAttribute('aria-label', 'Party');
    sel.dataset.tooltip = 'Party shown in Nested beliefs, Evidence trail and Claims';
    for (const p of this.mind.parties()) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.value = this.state.agentId || '';
    sel.addEventListener('change', () => this.setAgent(sel.value, true));
    const infer = document.createElement('button');
    infer.type = 'button';
    infer.className = 'ms-btn is-small';
    infer.innerHTML = '<span class="codicon codicon-play" aria-hidden="true"></span>Infer';
    infer.addEventListener('click', () => this.infer());
    this.inferBtn = infer;
    this.labelInfer();
    wrap.append(sel, infer);
    if (CHART_TABS.has(this.state.tab)) {
      const tt = tableToggle(this.state.table, (v) => this.setTable(v));
      tt.classList.add('ms-mind-tt');
      wrap.appendChild(tt);
    }
    return [wrap];
  }

  /** @param {boolean} v */
  setTable(v) {
    this.state.table = v;
    this.save();
    this.buildPanel();
    /** @type {any} */ (this.ctx).refreshHeader();
  }

  /** Keep the header Infer button's label in step with the current party. */
  labelInfer() {
    const b = this.inferBtn;
    if (!b) return;
    const m = this.agent();
    b.setAttribute('aria-label', m ? `Infer ${m.name}'s ${m.hidden.name} from observations` : 'Infer');
    b.dataset.tooltip = m ? `Infer ${m.name}'s ${m.hidden.name} from what they did and said (inverse planning); writes an estimated distribution to the graph` : 'No party';
    b.disabled = !m;
  }

  // ------------------------------------------------------------------ tabs

  buildTabs() {
    const ctx = /** @type {any} */ (this.ctx);
    this.tabsEl.replaceChildren();
    for (const t of TABS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ms-tab';
      b.id = `${ctx.areaId}-minds-tab-${t.id}`;
      b.dataset.tab = t.id;
      b.setAttribute('role', 'tab');
      const on = t.id === this.state.tab;
      b.setAttribute('aria-selected', String(on));
      b.setAttribute('aria-controls', this.panel.id);
      b.tabIndex = on ? 0 : -1;
      b.append(Object.assign(document.createElement('span'), { className: 'ms-mind-tab-full', textContent: t.label }));
      b.append(Object.assign(document.createElement('span'), { className: 'ms-mind-tab-short', textContent: t.short }));
      b.setAttribute('aria-label', t.label);
      b.addEventListener('click', () => this.setTab(t.id));
      this.tabsEl.appendChild(b);
      if (on) /** @type {any} */ (ctx).scheduler.afterFrame(() => { if (b.isConnected) b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    }
    this.panel.setAttribute('aria-labelledby', `${ctx.areaId}-minds-tab-${this.state.tab}`);
  }

  /** @param {KeyboardEvent} e */
  onTabKey(e) {
    const tabs = [...this.tabsEl.querySelectorAll('.ms-tab')];
    const i = tabs.indexOf(/** @type {Element} */ (document.activeElement));
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    else return;
    e.preventDefault();
    const id = /** @type {HTMLElement} */ (tabs[j]).dataset.tab || 'cards';
    this.setTab(id);
    /** @type {HTMLElement|null} */ (this.tabsEl.querySelector(`[data-tab="${id}"]`))?.focus();
  }

  /** @param {string} id */
  setTab(id) {
    if (id === this.state.tab) return;
    this.state.tab = id;
    this.save();
    this.buildTabs();
    this.buildPanel();
    /** @type {any} */ (this.ctx).refreshHeader();
  }

  /** @param {string} id @param {boolean} [fromHeader] */
  setAgent(id, fromHeader = false) {
    if (!id || id === this.state.agentId) return;
    this.state.agentId = id;
    this.save();
    if (this.state.tab === 'cards') this.view?.reveal?.(id);
    else if (this.state.tab !== 'relations') this.buildPanel();
    // the header select already shows the new value when the change came from it
    if (!fromHeader) /** @type {any} */ (this.ctx).refreshHeader();
    else this.labelInfer();
  }

  /** Open a party in a tab (card footer buttons, claims empty state). @param {string} agentId @param {string} [tab] */
  open(agentId, tab) {
    this.state.agentId = agentId;
    if (tab) this.state.tab = tab;
    this.save();
    this.buildTabs();
    this.buildPanel();
    /** @type {any} */ (this.ctx).refreshHeader();
    this.panel.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ inference

  infer() {
    const ctx = /** @type {any} */ (this.ctx);
    const m = this.agent();
    if (!m) return;
    const res = this.mind.infer(m.id);
    if (!res) {
      ctx.services.notify.warn(`Could not infer ${m.name}'s ${m.hidden.name}.`);
      return;
    }
    if (res.applied === false) {
      ctx.services.notify.warn(`Inference for ${m.name} ran but the graph rejected the update.`);
    } else {
      ctx.services.notify.success(`${m.name}: ${m.hidden.name} re-estimated from ${res.observations} observations. Downstream values recomputed (simulation, not assessment).`);
    }
    if (this.state.tab !== 'trail') {
      this.state.tab = 'trail';
      this.save();
      this.buildTabs();
      ctx.refreshHeader();
    }
    this.needsBuild = true;
    this.invalidate();
  }

  // ------------------------------------------------------------------ panel

  /** @returns {import('./view.js').MindsHost} */
  host() {
    const ctx = /** @type {any} */ (this.ctx);
    return {
      ctx,
      d3: this.d3,
      bv: this.bv,
      mind: this.mind,
      owner: this,
      table: this.state.table,
      layout: /** @type {'tree'|'radial'} */ (this.state.layout),
      width: () => Math.max(240, (this.panel.clientWidth || this.w) - 24),
      height: () => Math.max(240, (this.panel.clientHeight || this.h) - 16),
      reducedMotion: () => !!ctx.scheduler.reducedMotion || document.documentElement.classList.contains('ms-reduced-motion'),
      agentId: () => this.state.agentId,
      select: (ids) => {
        this.select(ids);
        // clicking a party in the cards or the relationship graph makes it the current party
        const p = this.partyOf(ids[0] ?? null);
        if (p && (this.state.tab === 'cards' || this.state.tab === 'relations')) this.setAgent(p);
      },
      hover: (id) => this.hover(id),
      open: (agentId, tab) => this.open(agentId, tab),
      setLayout: (l) => { this.state.layout = l; this.save(); this.buildPanel(); },
      infer: () => this.infer(),
    };
  }

  buildPanel() {
    this.needsBuild = false;
    const top = this.panel.scrollTop;
    const key = `${this.state.tab}:${this.state.agentId}:${this.state.table}:${this.state.layout}`;
    const sameView = this.lastBuilt === key;
    this.viewD.clear();
    this.view = null;
    this.bv.releaseWithin(this.panel);
    this.panel.replaceChildren();
    this.panel.dataset.tab = this.state.tab;
    const parties = this.mind.parties();
    const m = this.agent();
    if (!parties.length || !m) {
      this.panel.appendChild(emptyState({ icon: 'organization', title: 'No modeled parties', text: 'Mind Scopes appear here when the graph models the people involved (std.social.Mind).' }));
      return;
    }
    if (CHART_TABS.has(this.state.tab)) {
      // narrow areas hide the header's Chart/Table switch; this copy shows instead (minds.css)
      const bar = document.createElement('div');
      bar.className = 'ms-mind-narrowbar';
      bar.appendChild(tableToggle(this.state.table, (v) => this.setTable(v)));
      this.panel.appendChild(bar);
    }
    const host = this.host();
    switch (this.state.tab) {
      case 'nested': this.view = new NestedView(this.panel, m, host); break;
      case 'relations': this.view = new RelationsView(this.panel, parties, host); break;
      case 'trail': this.view = new TrailView(this.panel, m, host); break;
      case 'claims': this.view = new ClaimsView(this.panel, parties, m, host); break;
      default: this.view = new CardsView(this.panel, parties, host);
    }
    this.viewD.add(this.view);
    this.lastBuilt = key;
    if (sameView) this.panel.scrollTop = top;
    const sel = this.selection();
    this.bv.select(sel.selected);
    this.view.onSelection?.(sel.selected);
  }

  render() {
    if (this.needsBuild) this.buildPanel();
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.view?.resize?.();
  }

  onSelection(sel) {
    this.bv.select(sel.selected);
    this.view?.onSelection?.(sel.selected);
    if (sel.source === this.ctx?.areaId) return;
    const p = this.partyOf(sel.primary);
    if (p && p !== this.state.agentId) this.setAgent(p);
  }

  onHover(id) {
    this.bv.hover(id);
    this.view?.onHover?.(id);
  }

  onRecompute(changed, payload) {
    if (payload?.full) { this.bv.updateAll(false); this.view?.update?.([...this.bv.byNode.keys()]); return; }
    this.bv.update(changed);
    this.view?.update?.(changed, payload);
  }

  onStructure() {
    this.needsBuild = true;
    this.invalidate();
  }

  onTheme() {
    // SVG and meters use CSS variables; only token-derived values would need a redraw
  }

  dispose() {
    this.viewD?.dispose();
    this.view = null;
    this.root?.remove();
    super.dispose();
  }
}
