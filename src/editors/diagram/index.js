/**
 * Diagram (spec 12.17): Mermaid diagrams generated from the live model.
 *
 *  - Prototype chain (classDiagram) of the selected scope, Scope subgraph (flowchart, at most
 *    ~60 metric nodes, provenance classDefs + glyphs), Request lifecycle (9-step sequence),
 *    Swarm build (sequence from services.swarm.last()), Verification ladder (flowchart).
 *  - Themed through the shared Mermaid adapter; re-rendered (debounced, only while visible) on
 *    theme, recompute, structure, selection, scenario, swarm and certificate events.
 *  - Rendered nodes are looked up after rendering and become selectable (click / Enter), with
 *    hover sync; "Copy Mermaid source" and a source view.
 * @module editors/diagram
 */
import { BaseEditor } from '../base-editor.js';
import { loadCss, LIBS } from '../../core/lazy.js';
import { emptyState } from '../shared/empty-state.js';
import { codeView } from '../shared/code-view.js';
import { applyMermaidTheme, mermaidProvClasses } from '../../theme/adapters/mermaid.js';
import { token, provColor, parseColor } from '../../theme/tokens.js';
import { KINDS, protoChain, scopeSubgraph, requestLifecycle, swarmBuild, verificationLadder } from './sources.js';

/** Hex for Mermaid classDefs (commas in rgba() would split the style list). @param {string} c */
function hex(c) {
  const [r, g, b] = parseColor(c);
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Mermaid DOM id -> source id ('flowchart-n_price-12' -> 'n_price'). @param {string} domId */
function sourceIdOf(domId) {
  let m = /^flowchart-(.+)-\d+$/.exec(domId);
  if (m) return m[1];
  m = /^classId-(.+)-\d+$/.exec(domId);
  if (m) return m[1];
  return domId;
}

export default class DiagramEditor extends BaseEditor {
  static id = 'diagram';
  static label = 'Diagram';
  static icon = 'type-hierarchy';
  static group = 'Verify & Source';
  static needs = ['mermaid'];
  static usesScenario = false;

  /** @param {import('../base-editor.js').EditorContext} ctx @param {any} state */
  async mount(ctx, state) {
    await loadCss(new URL('./diagram.css', import.meta.url));
    this.mermaid = ctx.libs.mermaid;
    this.st = {
      kind: KINDS.some((k) => k.id === state.kind) ? state.kind : 'scope',
      showSource: !!state.showSource,
    };
    this.renderToken = 0;
    this.timer = 0;
    this.stale = true;
    /** @type {import('./sources.js').DiagramSource|null} */
    this.current = null;
    this.target = null;
    this.ms = 0;

    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-dg';
    this.head = document.createElement('div');
    this.head.className = 'ms-dg-head';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'ms-dg-title ms-ellipsis';
    this.subEl = document.createElement('div');
    this.subEl.className = 'ms-dg-sub ms-ellipsis';
    this.head.append(this.titleEl, this.subEl);
    this.body = document.createElement('div');
    this.body.className = 'ms-ed-scroll ms-dg-body';
    this.svgHost = document.createElement('div');
    this.svgHost.className = 'ms-dg-svg';
    this.srcHost = document.createElement('div');
    this.srcHost.className = 'ms-dg-src';
    this.srcHost.hidden = true;
    this.msgHost = document.createElement('div');
    this.msgHost.className = 'ms-dg-msg';
    this.msgHost.hidden = true;
    this.body.append(this.svgHost, this.srcHost, this.msgHost);
    this.foot = document.createElement('div');
    this.foot.className = 'ms-ed-foot';
    this.status = document.createElement('div');
    this.status.className = 'ms-sr-only';
    this.status.setAttribute('aria-live', 'polite');
    this.root.append(this.head, this.body, this.foot, this.status);
    ctx.el.appendChild(this.root);

    // selection by click / keyboard on decorated nodes, hover sync
    const linkOf = (t) => (t instanceof Element ? t.closest('[data-ms-ids]') : null);
    this.listen(this.svgHost, 'click', (e) => {
      const el = linkOf(e.target);
      if (!el) return;
      const me = /** @type {MouseEvent} */ (e);
      this.pick(el, me.shiftKey ? 'add' : me.ctrlKey || me.metaKey ? 'toggle' : 'replace');
    });
    this.listen(this.svgHost, 'keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      if (ke.key !== 'Enter' && ke.key !== ' ') return;
      const el = linkOf(ke.target);
      if (!el) return;
      ke.preventDefault();
      this.pick(el, ke.shiftKey ? 'add' : 'replace');
    });
    this.listen(this.svgHost, 'pointerover', (e) => {
      const el = linkOf(e.target);
      const id = el ? /** @type {HTMLElement} */ (el).dataset.msIds?.split(' ')[0] || null : null;
      if (id !== this.hovered) { this.hovered = id; this.hover(id); }
    });
    this.listen(this.svgHost, 'pointerleave', () => { if (this.hovered) { this.hovered = null; this.hover(null); } });

    this.on('swarm:event', () => { if (this.st.kind === 'swarm') this.schedule(300); });
    this.on('certificate:updated', () => { if (this.st.kind === 'ladder') this.schedule(200); });
    this.disposables.add({ dispose: () => clearTimeout(this.timer) });
    this.invalidate();
  }

  getState() { return { ...this.st }; }

  // ------------------------------------------------------------------ sources

  /** Scope the proto / scope diagrams describe: pinned scope, else the selection's scope. */
  targetScope() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const pinned = this.ctx?.areaFlags().pinnedScopeId;
    if (pinned && g.scope(pinned)) return pinned;
    const sel = this.selection();
    if (sel.primary) {
      const sid = g.scopeIdOf(sel.primary);
      if (sid) return sid;
    }
    if (sel.focusScope && g.scope(sel.focusScope)) return sel.focusScope;
    return g.rootId;
  }

  /** @returns {import('./sources.js').DiagramSource} */
  build() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = ctx.engine.graph;
    const view = ctx.engine.view(this.scenarioId());
    switch (this.st.kind) {
      case 'proto': this.target = this.targetScope(); return protoChain(g, view, this.target);
      case 'scope': this.target = this.targetScope(); return scopeSubgraph(g, view, this.target, mermaidProvClasses());
      case 'lifecycle': {
        const rc = ctx.store.get('status.recompute');
        return requestLifecycle({ recompute: rc ? { ms: rc.ms, nodes: rc.nodes } : null, version: ctx.store.get('status.version'), samples: ctx.engine.n });
      }
      case 'swarm': return swarmBuild(ctx.services.swarm?.last());
      case 'ladder': {
        const colors = {
          ok: hex(token('--ms-ok', '#2ea043')),
          fail: hex(token('--ms-fail', '#f85149')),
          proven: hex(provColor('proven')),
          open: hex(provColor('estimated')),
          stat: hex(provColor('estimated')),
          judg: hex(provColor('computed')),
          na: hex(token('widget.border', '#313131')),
        };
        return verificationLadder(ctx.services.verify?.certificate(), colors);
      }
      default: return requestLifecycle({});
    }
  }

  // ------------------------------------------------------------------ rendering

  /** Debounced, visibility-aware re-render. @param {number} [ms] */
  schedule(ms = 150) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.stale = true;
      this.invalidate();
    }, ms);
  }

  render() {
    if (!this.stale) return;
    this.stale = false;
    this.draw();
  }

  async draw() {
    const ctx = /** @type {any} */ (this.ctx);
    const token = ++this.renderToken;
    const kind = KINDS.find((k) => k.id === this.st.kind) || KINDS[0];
    /** @type {import('./sources.js').DiagramSource} */
    let ds;
    try {
      ds = this.build();
    } catch (err) {
      console.error('[diagram] source failed', err);
      this.showMessage('error', 'Could not build this diagram', String(/** @type {Error} */ (err).message || err));
      return;
    }
    this.current = ds;
    this.titleEl.textContent = ds.title || kind.label;
    this.titleEl.title = ds.title || kind.label;
    this.subEl.textContent = ds.subtitle || '';
    if (ds.empty) {
      this.showMessage('info', kind.label, ds.empty);
      this.foot.textContent = `${kind.label} · nothing to draw`;
      return;
    }
    if (this.st.showSource) {
      this.msgHost.hidden = true;
      this.svgHost.hidden = true;
      this.srcHost.hidden = false;
      this.srcHost.replaceChildren(codeView(ds.src, { lang: 'text', lineNumbers: true, label: `Mermaid source: ${ds.title}` }));
      this.foot.textContent = `Mermaid source · ${ds.src.split('\n').length} lines · ${LIBS.mermaid.version}`;
      return;
    }
    const mermaid = this.mermaid;
    const id = `ms-dg-${String(ctx.areaId).replace(/[^\w-]/g, '')}-${token}`;
    const t0 = performance.now();
    try {
      applyMermaidTheme(mermaid);
      await mermaid.parse(ds.src);
      const { svg, bindFunctions } = await mermaid.render(id, ds.src);
      if (token !== this.renderToken || this._disposed) return;
      this.ms = performance.now() - t0;
      this.msgHost.hidden = true;
      this.srcHost.hidden = true;
      this.svgHost.hidden = false;
      this.svgHost.innerHTML = svg;
      bindFunctions?.(this.svgHost);
      this.decorate(ds);
      this.foot.textContent = `${kind.label} · ${kind.type} · ${ds.count} ${this.st.kind === 'swarm' ? 'events' : this.st.kind === 'lifecycle' ? 'steps' : 'nodes'} · rendered in ${Math.max(1, Math.round(this.ms))} ms · ${LIBS.mermaid.version}`;
    } catch (err) {
      // Mermaid may leave its scratch element behind after a failure
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (token !== this.renderToken || this._disposed) return;
      console.warn('[diagram] mermaid failed', err);
      this.showMessage('error', 'Mermaid could not render this diagram', String(/** @type {any} */ (err)?.message || err).split('\n').slice(0, 3).join(' '));
    }
  }

  /** @param {'info'|'error'} kind @param {string} title @param {string} text */
  showMessage(kind, title, text) {
    this.svgHost.hidden = true;
    this.srcHost.hidden = true;
    this.msgHost.hidden = false;
    this.svgHost.replaceChildren();
    const action = kind === 'error' && this.current?.src ? { label: 'Show source', run: () => this.setShowSource(true) } : undefined;
    this.msgHost.replaceChildren(emptyState({ icon: kind === 'error' ? 'warning' : 'type-hierarchy', title, text, action }));
  }

  /**
   * Post-render: make nodes that stand for graph items selectable.
   * @param {import('./sources.js').DiagramSource} ds
   */
  decorate(ds) {
    const svg = this.svgHost.querySelector('svg');
    if (!svg) return;
    svg.classList.add('ms-dg-diagram');
    const mark = (el, ids, label) => {
      if (!ids || !ids.length) return;
      el.classList.add('ms-dg-link');
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.dataset.msIds = ids.join(' ');
      el.setAttribute('aria-label', `${label}. Press Enter to select ${ids.length === 1 ? 'it' : `${ids.length} items`}.`);
    };
    for (const el of svg.querySelectorAll('g.node')) {
      const sid = sourceIdOf(el.id);
      mark(el, ds.nodes.get(sid), (el.textContent || sid).replace(/\s+/g, ' ').trim());
    }
    for (const el of svg.querySelectorAll('g.cluster')) {
      const ids = ds.nodes.get(el.id);
      const label = el.querySelector('.cluster-label, .nodeLabel');
      if (ids) mark(label?.closest('g') || el, ids, (label?.textContent || el.id).trim());
    }
    if (ds.messages.length) {
      // Mermaid draws one text.messageText per line of a message, in message order
      const texts = [...svg.querySelectorAll('text.messageText')];
      const lines = ds.messageLines || ds.messages.map(() => 1);
      if (texts.length === lines.reduce((a, b) => a + b, 0)) {
        let k = 0;
        ds.messages.forEach((nid, i) => {
          const group = texts.slice(k, k + lines[i]);
          k += lines[i];
          if (!nid) return;
          const label = group.map((t) => t.textContent || '').join(' ').trim();
          for (const t of group) mark(t, [nid], label);
        });
      }
    }
    this.applySel();
  }

  /** @param {Element} el @param {'replace'|'add'|'toggle'} mode */
  pick(el, mode) {
    const ids = (/** @type {HTMLElement} */ (el).dataset.msIds || '').split(' ').filter(Boolean);
    if (!ids.length) return;
    this.select(ids, { mode });
    this.status.textContent = `Selected ${ids.length === 1 ? /** @type {any} */ (this.ctx).engine.graph.path(ids[0]) : `${ids.length} items`}.`;
  }

  applySel(sel = this.selection()) {
    const set = new Set(sel.selected || []);
    for (const el of this.svgHost.querySelectorAll('[data-ms-ids]')) {
      const ids = (/** @type {HTMLElement} */ (el).dataset.msIds || '').split(' ');
      el.classList.toggle('is-sel', ids.some((id) => set.has(id)));
    }
  }

  // ------------------------------------------------------------------ editor hooks

  /** @param {import('../base-editor.js').SelectionState} sel */
  onSelection(sel) {
    if ((this.st.kind === 'proto' || this.st.kind === 'scope') && this.targetScope() !== this.target) this.schedule(120);
    else this.applySel(sel);
  }

  /** @param {string|null} id */
  onHover(id) {
    for (const el of this.svgHost.querySelectorAll('.ms-dg-link.is-hover')) el.classList.remove('is-hover');
    if (!id) return;
    for (const el of this.svgHost.querySelectorAll('[data-ms-ids]')) {
      if ((/** @type {HTMLElement} */ (el).dataset.msIds || '').split(' ').includes(id)) el.classList.add('is-hover');
    }
  }

  /** @param {string[]} changed @param {any} payload */
  onRecompute(changed, payload) {
    if (this.st.kind === 'swarm' || this.st.kind === 'ladder') return; // their own events
    if (payload?.structural) return; // onStructure
    this.schedule(payload?.transient ? 600 : 250);
  }

  onStructure() { this.schedule(120); }
  onTheme() { this.schedule(0); }
  onScenario() { this.schedule(120); }
  onFlags() { this.schedule(60); }

  // ------------------------------------------------------------------ header

  /** @param {string} kind */
  setKind(kind) {
    if (!KINDS.some((k) => k.id === kind) || kind === this.st.kind) return;
    this.st.kind = kind;
    this.save();
    /** @type {any} */ (this.ctx).refreshHeader();
    this.schedule(0);
  }

  /** @param {boolean} on */
  setShowSource(on) {
    this.st.showSource = on;
    this.save();
    /** @type {any} */ (this.ctx).refreshHeader();
    this.schedule(0);
  }

  async copySource() {
    const ctx = /** @type {any} */ (this.ctx);
    const src = this.current?.src;
    if (!src) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(src);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = src;
      ta.setAttribute('readonly', '');
      ta.className = 'ms-sr-only';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) ctx.services.notify.success(`Mermaid source copied (${src.split('\n').length} lines).`);
    else ctx.services.notify.warn('Clipboard is not available here. Use Show source to select it.');
  }

  getHeaderMenus() {
    return [
      {
        label: 'View',
        items: () => [
          ...KINDS.map((k) => ({ label: k.label, checked: this.st.kind === k.id, run: () => this.setKind(k.id) })),
          { separator: true },
          { label: 'Show Source', checked: this.st.showSource, run: () => this.setShowSource(!this.st.showSource) },
          { label: 'Copy Mermaid Source', disabled: !this.current?.src, run: () => this.copySource() },
        ],
      },
    ];
  }

  getHeaderTools() {
    const wrap = document.createElement('div');
    wrap.className = 'ms-row ms-dg-tools';
    const sel = document.createElement('select');
    sel.className = 'ms-select is-small';
    sel.setAttribute('aria-label', 'Diagram type');
    for (const k of KINDS) {
      const o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.label;
      o.selected = k.id === this.st.kind;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => this.setKind(sel.value));
    const seg = document.createElement('div');
    seg.className = 'ms-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Diagram or Mermaid source');
    for (const [label, val] of [['Diagram', false], ['Source', true]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = /** @type {string} */ (label);
      b.setAttribute('aria-pressed', String(this.st.showSource === val));
      b.addEventListener('click', () => this.setShowSource(/** @type {boolean} */ (val)));
      seg.appendChild(b);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ms-icon-btn';
    copy.dataset.tooltip = 'Copy Mermaid source';
    copy.setAttribute('aria-label', 'Copy Mermaid source');
    copy.innerHTML = '<span class="codicon codicon-copy" aria-hidden="true"></span>';
    copy.addEventListener('click', () => this.copySource());
    wrap.append(sel, seg, copy);
    return [wrap];
  }

  dispose() {
    clearTimeout(this.timer);
    this.renderToken++;
    this.root?.remove();
    super.dispose();
  }
}
