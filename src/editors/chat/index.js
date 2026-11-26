/**
 * Chat Transcript editor. Every Chat area shows the same conversation; the single composer
 * lives in the shell. Assistant prose is rendered from templates: numbers are bound values
 * that update in place when the graph recomputes.
 * @module editors/chat
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues, renderTemplateInto } from '../shared/bound-value.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { renderSwarmStrip, renderCertChip, renderReceipt, renderSimVoice } from './view.js';

export default class ChatEditor extends BaseEditor {
  static id = 'chat';
  static label = 'Chat';
  static icon = 'comment-discussion';
  static group = 'General';

  async mount(ctx, state) {
    await loadCss(new URL('./chat.css', import.meta.url));
    this.state = { query: state.query || '', pinned: state.pinned || [] };
    this.chat = ctx.services.chat;
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
    this.disposables.add({ dispose: () => this.bv.dispose() });
    /** @type {Map<string, HTMLElement>} */
    this.nodes = new Map();

    const root = document.createElement('div');
    root.className = 'ms-ed ms-chat';
    this.scroll = document.createElement('div');
    this.scroll.className = 'ms-ed-scroll ms-chat-scroll';
    this.scroll.setAttribute('role', 'log');
    this.scroll.setAttribute('aria-label', 'Conversation');
    this.scroll.setAttribute('aria-live', 'off');
    this.list = document.createElement('div');
    this.list.className = 'ms-chat-list';
    this.scroll.appendChild(this.list);
    this.jump = document.createElement('button');
    this.jump.className = 'ms-btn is-secondary is-small ms-chat-jump';
    this.jump.innerHTML = '<span class="codicon codicon-arrow-down" aria-hidden="true"></span>Jump to latest';
    this.jump.hidden = true;
    root.append(this.scroll, this.jump);
    ctx.el.appendChild(root);
    this.root = root;

    this.listen(this.jump, 'click', () => this.scrollToEnd(true));
    this.listen(this.scroll, 'scroll', () => {
      const atEnd = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 40;
      this.stick = atEnd;
      this.jump.hidden = atEnd;
    }, { passive: true });
    this.stick = true;

    this.on('chat:message', (p) => this.onMessage(p));
    this.on('swarm:event', (p) => this.onSwarm(p));
    this.on('certificate:updated', () => this.refreshChips());
    this.renderAll();
  }

  getHeaderTools() {
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const search = document.createElement('input');
    search.className = 'ms-input is-small';
    search.type = 'search';
    search.placeholder = 'Search conversation';
    search.setAttribute('aria-label', 'Search in conversation');
    search.value = this.state?.query || '';
    search.style.width = '150px';
    search.addEventListener('input', () => {
      this.state.query = search.value;
      this.applySearch();
      this.save();
    });
    this.searchEl = search;
    const latest = document.createElement('button');
    latest.className = 'ms-icon-btn is-small';
    latest.setAttribute('aria-label', 'Jump to latest');
    latest.dataset.tooltip = 'Jump to latest';
    latest.innerHTML = '<span class="codicon codicon-arrow-down" aria-hidden="true"></span>';
    latest.addEventListener('click', () => this.scrollToEnd(true));
    wrap.append(search, latest);
    return [wrap];
  }

  focusSearch() { this.searchEl?.focus(); }

  getState() { return { query: this.state.query, pinned: this.state.pinned }; }

  renderAll() {
    this.bv.releaseWithin(this.list);
    this.list.replaceChildren();
    this.nodes.clear();
    const msgs = this.chat?.messages || [];
    if (!msgs.length) {
      this.list.appendChild(emptyState({ icon: 'comment-discussion', title: 'No conversation yet', text: 'Ask a question in the composer below.' }));
      return;
    }
    for (const m of msgs) this.list.appendChild(this.renderMessage(m));
    this.applySearch();
    this.scrollToEnd(false);
  }

  /** @param {any} m */
  renderMessage(m) {
    const el = document.createElement('article');
    el.className = `ms-msg is-${m.role}${m.kind ? ` is-${m.kind}` : ''}`;
    el.dataset.id = m.id;
    el.setAttribute('aria-label', `${m.role === 'user' ? 'You' : m.role === 'assistant' ? 'MillionScope' : 'Engine'} message`);
    this.nodes.set(m.id, el);
    this.fillMessage(el, m);
    return el;
  }

  /** @param {HTMLElement} el @param {any} m */
  fillMessage(el, m) {
    const ctx = /** @type {any} */ (this.ctx);
    this.bv.releaseWithin(el);
    el.replaceChildren();
    if (m.kind === 'receipt' || m.kind === 'error') {
      el.appendChild(renderReceipt(m, { engine: ctx.engine, bv: this.bv }));
      return;
    }
    const head = document.createElement('div');
    head.className = 'ms-msg-head';
    const icon = m.role === 'user' ? 'account' : 'sparkle';
    const who = m.role === 'user' ? 'You' : 'MillionScope';
    head.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="ms-msg-who"></span>`;
    /** @type {HTMLElement} */ (head.querySelector('.ms-msg-who')).textContent = who;
    if (m.role === 'user' && m.route) {
      const r = document.createElement('span');
      r.className = 'ms-msg-route';
      r.textContent = m.route === 'numeric' ? 'local' : m.route === 'command' ? 'command' : m.route === 'structural' ? 'structural' : 'question';
      head.appendChild(r);
    }
    if (m.role === 'assistant') {
      const meta = document.createElement('span');
      meta.className = 'ms-msg-meta';
      meta.textContent = m.streaming ? 'streaming…' : m.tokens ? `${m.tokens.toLocaleString('en-US')} tokens` : '';
      head.appendChild(meta);
      if (this.state.pinned.includes(m.id)) {
        const pin = document.createElement('span');
        pin.className = 'codicon codicon-pinned ms-msg-pinned';
        pin.title = 'Pinned answer';
        head.appendChild(pin);
      }
      head.appendChild(this.actions(m));
    }
    el.appendChild(head);

    if (m.role === 'assistant' && m.buildId) {
      const build = ctx.services.swarm?.get(m.buildId);
      if (build) el.appendChild(renderSwarmStrip(build, { expanded: !!m.streaming && !build.ended, onSelect: (id) => this.select([id]) }));
    }

    const body = document.createElement('div');
    body.className = 'ms-msg-body';
    if (m.role === 'user') body.textContent = m.text;
    else if (m.template !== undefined) {
      renderTemplateInto(body, m.template || '', { engine: ctx.engine, bv: this.bv });
      if (m.streaming) {
        const caret = document.createElement('span');
        caret.className = 'ms-caret-blink';
        caret.setAttribute('aria-hidden', 'true');
        (body.lastElementChild || body).appendChild(caret);
      }
    }
    el.appendChild(body);

    if (m.simVoice?.length) for (const q of m.simVoice) el.appendChild(renderSimVoice(q));
    if (m.stopped) {
      const s = document.createElement('div');
      s.className = 'ms-msg-stopped';
      s.textContent = 'Stopped. Partial answer kept; numbers above are still live.';
      el.appendChild(s);
    }
    if (m.role === 'assistant' && m.certificate && m.done) {
      el.appendChild(renderCertChip(ctx.services.verify?.certificate(), {
        onOpen: () => ctx.commands.execute('view.reveal', 'certificate'),
      }));
    }
  }

  /** @param {any} m */
  actions(m) {
    const ctx = /** @type {any} */ (this.ctx);
    const bar = document.createElement('div');
    bar.className = 'ms-msg-actions';
    const btn = (icon, label, run) => {
      const b = document.createElement('button');
      b.className = 'ms-icon-btn is-small';
      b.setAttribute('aria-label', label);
      b.dataset.tooltip = label;
      b.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
      b.addEventListener('click', run);
      bar.appendChild(b);
      return b;
    };
    btn('copy', 'Copy with current values', async () => {
      const text = this.chat.plainText(m.template || '');
      try { await navigator.clipboard.writeText(text); ctx.services.notify.success('Copied with current values.'); } catch { ctx.services.notify.warn('Clipboard is not available here.'); }
    });
    const pinned = this.state.pinned.includes(m.id);
    btn(pinned ? 'pinned' : 'pin', pinned ? 'Unpin answer' : 'Pin answer', () => {
      this.state.pinned = pinned ? this.state.pinned.filter((x) => x !== m.id) : [...this.state.pinned, m.id];
      this.save();
      this.update(m);
      ctx.refreshRegions?.();
    });
    btn('repo-forked', 'Fork scenario from here', () => {
      const t = new Date(m.time);
      const name = `From answer ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
      const r = ctx.services.scenarios.fork(name, [], { parent: ctx.services.scenarios.activeId });
      if (r.ok) {
        ctx.services.scenarios.setActive(r.id);
        ctx.services.notify.success(`Forked scenario “${name}” and made it active.`);
      }
    });
    if (m.sourceText) btn('refresh', 'Retry', () => this.chat.retry(m.id));
    return bar;
  }

  /** @param {any} m */
  update(m) {
    const el = this.nodes.get(m.id);
    if (el) this.fillMessage(el, m);
  }

  /** @param {{message: any, kind: string}} p */
  onMessage(p) {
    if (p.kind === 'add') {
      if (this.list.querySelector('.ms-empty')) this.list.replaceChildren();
      this.list.appendChild(this.renderMessage(p.message));
    } else this.update(p.message);
    this.applySearch();
    if (this.stick) this.scrollToEnd(false);
  }

  /** @param {{buildId: string}} p */
  onSwarm(p) {
    const m = this.chat.messages.find((x) => x.buildId === p.buildId);
    if (!m) return;
    const el = this.nodes.get(m.id);
    const old = el?.querySelector('.ms-swarm-strip');
    const build = this.ctx?.services.swarm.get(p.buildId);
    if (!el || !old || !build) return;
    const expanded = old.classList.contains('is-expanded');
    old.replaceWith(renderSwarmStrip(build, { expanded, onSelect: (id) => this.select([id]) }));
  }

  refreshChips() {
    const cert = this.ctx?.services.verify?.certificate();
    for (const chip of this.list.querySelectorAll('.ms-cert-chip')) {
      const expanded = chip.classList.contains('is-expanded');
      const fresh = renderCertChip(cert, { onOpen: () => this.ctx?.commands.execute('view.reveal', 'certificate'), expanded });
      chip.replaceWith(fresh);
    }
  }

  applySearch() {
    const q = (this.state.query || '').trim().toLowerCase();
    for (const [, el] of this.nodes) {
      const hit = !q || (el.textContent || '').toLowerCase().includes(q);
      el.classList.toggle('is-filtered', !hit);
      el.classList.toggle('is-hit', !!q && hit);
    }
  }

  /** @param {boolean} smooth */
  scrollToEnd(smooth) {
    this.ctx?.scheduler.afterFrame(() => {
      this.scroll.scrollTo({ top: this.scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
    this.ctx?.scheduler.request(this);
  }

  onRecompute(changed, payload) {
    if (payload?.structural || payload?.full) this.bv.updateAll(true);
    else this.bv.update(changed);
  }

  onStructure() { this.bv.updateAll(); }
  onScenario() { this.bv.updateAll(); }
  onTheme() { this.refreshChips(); }
  onSelection(sel) { this.bv.select(sel.selected); }
  onHover(id) { this.bv.hover(id); }

  renderSidebar(el) {
    const pinned = (this.chat?.messages || []).filter((m) => this.state.pinned.includes(m.id));
    if (!pinned.length) {
      el.innerHTML = '<div class="ms-region-empty">Pin an answer to keep it here.</div>';
      return;
    }
    for (const m of pinned) {
      const card = document.createElement('div');
      card.className = 'ms-chat-pinned';
      renderTemplateInto(card, m.template || '', { engine: /** @type {any} */ (this.ctx).engine, bv: this.bv });
      el.appendChild(card);
    }
  }

  render() {}

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}
