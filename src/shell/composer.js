/**
 * The single chat composer for the whole app, a centered card floating above the status bar.
 *
 *  - context chips: selected scopes, active scenario, focused area's editor type (removable;
 *    scope chips can be dropped in from any editor)
 *  - multiline auto-grow input (to 40% of the window). Enter sends, Shift+Enter newline,
 *    Up on empty recalls history, Esc blurs, "/" anywhere focuses
 *  - "@" mentions and "/" commands with autocomplete; a highlight layer styles them
 *  - live routing indicator: local · 0 tokens | model · ~3k tokens | model · ~40k tokens | command
 *  - mode selector (Answer / Build / Simulate / Verify), attach evidence, send / stop
 *  - peek card with the reply when no Chat area is visible (never forces a layout change)
 * @module shell/composer
 */
import { DisposableStore, listen } from '../core/disposable.js';
import { renderTemplateInto } from '../editors/shared/bound-value.js';
import { getEditor } from '../editors/registry.js';
import { provGlyph } from '../theme/tokens.js';

export const SLASH_COMMANDS = [
  { cmd: '/fork', args: '<name>', desc: 'fork the active scenario' },
  { cmd: '/compare', args: '', desc: 'compare scenarios side by side' },
  { cmd: '/sweep', args: 'rent 5000..9000 step 500', desc: 'sweep an input into a heatmap' },
  { cmd: '/goalseek', args: 'P(monthly_cash<0) < 10% by price', desc: 'find an input value that meets a target' },
  { cmd: '/sim', args: '100 runs', desc: 'run a seeded multi-agent simulation ensemble' },
  { cmd: '/infer', args: '@Landlord', desc: 'Bayesian inverse planning for a Mind Scope' },
  { cmd: '/verify', args: '', desc: 'run the verification ladder and refresh the certificate' },
  { cmd: '/explain', args: '@metric', desc: 'explain a metric with its formula and drivers' },
  { cmd: '/research', args: '@input', desc: 'ask the Researcher to source an estimated input' },
  { cmd: '/open', args: '<editor>', desc: 'switch the focused area to an editor type' },
  { cmd: '/theme', args: '[dark|light|auto]', desc: 'switch theme' },
  { cmd: '/undo', args: '', desc: 'undo the last graph change' },
  { cmd: '/redo', args: '', desc: 'redo' },
];

const MODES = [
  { id: 'answer', label: 'Answer', desc: 'answer first; Chat and Distributions' },
  { id: 'build', label: 'Build', desc: 'show the swarm build; Graph and Swarm' },
  { id: 'simulate', label: 'Simulate', desc: 'prefer simulations; Minds and Simulation' },
  { id: 'verify', label: 'Verify', desc: 'prefer verification; Certificate and Proofs' },
];

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Composer {
  /**
   * @param {{
   *   el: HTMLElement,
   *   env: any,
   *   ws: import('../workspace/workspaces.js').WorkspaceManager,
   *   menus: import('./context-menu.js').MenuService,
   * }} deps
   */
  constructor({ el, env, ws, menus }) {
    this.el = el;
    this.env = env;
    this.ws = ws;
    this.menus = menus;
    this.events = env.events;
    this.commands = env.commands;
    this.store = env.store;
    this.services = env.services;
    this.d = new DisposableStore();
    /** @type {string[]} */
    this.history = [];
    this.histIndex = -1;
    /** @type {Set<string>} scope ids removed from context until selection changes */
    this.excluded = new Set();
    /** @type {string[]} scope ids dropped in as chips */
    this.pinned = [];
    this.streaming = false;
    /** @type {null | {items: any[], index: number, kind: '@'|'/', start: number}} */
    this.ac = null;
    this._build();
    this._wire();
    this.refreshContext();
    this.updateRoute();
  }

  _build() {
    const el = this.el;
    el.innerHTML = '';

    this.peek = document.createElement('div');
    this.peek.className = 'ms-peek';
    this.peek.hidden = true;
    this.peek.setAttribute('role', 'dialog');
    this.peek.setAttribute('aria-label', 'Latest reply');

    this.acEl = document.createElement('div');
    this.acEl.className = 'ms-ac';
    this.acEl.hidden = true;
    this.acEl.id = 'ms-composer-ac';
    this.acEl.setAttribute('role', 'listbox');

    const box = document.createElement('div');
    box.className = 'ms-composer';
    this.box = box;

    this.progress = document.createElement('div');
    this.progress.className = 'ms-progress';
    this.progress.hidden = true;

    this.chips = document.createElement('div');
    this.chips.className = 'ms-composer-chips';
    this.chips.setAttribute('role', 'group');
    this.chips.setAttribute('aria-label', 'Composer context');

    const row = document.createElement('div');
    row.className = 'ms-composer-row';

    this.attachBtn = document.createElement('button');
    this.attachBtn.type = 'button';
    this.attachBtn.className = 'ms-icon-btn';
    this.attachBtn.setAttribute('aria-label', 'Attach evidence');
    this.attachBtn.dataset.tooltip = 'Attach evidence (mock extraction)';
    this.attachBtn.innerHTML = '<span class="codicon codicon-file-add" aria-hidden="true"></span>';

    const field = document.createElement('div');
    field.className = 'ms-composer-field';
    this.hl = document.createElement('div');
    this.hl.className = 'ms-composer-hl';
    this.hl.setAttribute('aria-hidden', 'true');
    this.input = document.createElement('textarea');
    this.input.className = 'ms-composer-input';
    this.input.rows = 1;
    this.input.id = 'ms-composer-input';
    this.input.setAttribute('role', 'textbox');
    this.input.setAttribute('aria-multiline', 'true');
    this.input.setAttribute('aria-label', 'Ask a question or edit the graph');
    this.input.setAttribute('aria-describedby', 'ms-composer-route');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-controls', 'ms-composer-ac');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.placeholder = 'Ask, or edit: "set rent to 7000" (local · 0 tokens)';
    this.input.spellcheck = false;
    field.append(this.hl, this.input);
    this.route = document.createElement('span');
    this.route.className = 'ms-route';
    this.route.id = 'ms-composer-route';

    const actions = document.createElement('div');
    actions.className = 'ms-composer-actions';
    this.modeBtn = document.createElement('button');
    this.modeBtn.type = 'button';
    this.modeBtn.className = 'ms-mode-btn';
    this.modeBtn.setAttribute('aria-haspopup', 'menu');
    this.sendBtn = document.createElement('button');
    this.sendBtn.type = 'button';
    this.sendBtn.className = 'ms-btn ms-send-btn';
    actions.append(this.route, this.modeBtn, this.sendBtn);

    // Claude-style card: input on top, one footer row of controls underneath
    row.append(this.attachBtn, this.chips, actions);
    box.append(this.progress, field, row);
    // clicking the card's empty space focuses the input
    box.addEventListener('pointerdown', (e) => {
      if (e.target === box || e.target === row) { e.preventDefault(); this.input.focus(); }
    });
    el.append(this.peek, this.acEl, box);
    this.renderMode();
    this.renderSend();
  }

  _wire() {
    const d = this.d;
    const input = this.input;
    d.add(listen(input, 'input', () => this.onInput()));
    d.add(listen(input, 'scroll', () => { this.hl.scrollTop = input.scrollTop; }));
    d.add(listen(input, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e))));
    d.add(listen(input, 'blur', () => setTimeout(() => this.closeAc(), 120)));
    d.add(listen(input, 'click', () => this.updateAc()));
    d.add(listen(this.sendBtn, 'click', () => (this.streaming ? this.stop() : this.send())));
    d.add(listen(this.attachBtn, 'click', () => this.commands.execute('evidence.attach')));
    d.add(listen(this.modeBtn, 'click', () => {
      const cur = this.store.get('ui.composerMode') || 'answer';
      this.modeBtn.setAttribute('aria-expanded', 'true');
      this.menus.show(MODES.map((m) => ({
        label: m.label, title: m.desc, checked: m.id === cur,
        run: () => { this.store.set('ui.composerMode', m.id); this.renderMode(); },
      })), this.modeBtn, { label: 'Composer mode', onClose: () => this.modeBtn.setAttribute('aria-expanded', 'false') });
    }));

    // drag scope chips in from any editor
    d.add(listen(this.box, 'dragover', (ev) => {
      const e = /** @type {DragEvent} */ (ev);
      if (!e.dataTransfer?.types.includes('text/x-ms-node')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.box.classList.add('is-drop-target');
    }));
    d.add(listen(this.box, 'dragleave', () => this.box.classList.remove('is-drop-target')));
    d.add(listen(this.box, 'drop', (ev) => {
      const e = /** @type {DragEvent} */ (ev);
      this.box.classList.remove('is-drop-target');
      const id = e.dataTransfer?.getData('text/x-ms-node');
      if (!id) return;
      e.preventDefault();
      if (!this.pinned.includes(id)) this.pinned.push(id);
      this.excluded.delete(id);
      this.refreshContext();
      this.input.focus();
    }));

    const ev = this.events;
    d.add(ev.on('selection:changed', () => { this.excluded.clear(); this.refreshContext(); }));
    d.add(ev.on('area:focused', () => this.refreshContext()));
    d.add(ev.on('area:typeChanged', () => this.refreshContext()));
    d.add(ev.on('scenario:changed', () => this.refreshContext()));
    d.add(ev.on('workspace:changed', () => this.refreshContext()));
    d.add(ev.on('graph:recomputed', (p) => { if (p.structural) this.updateRoute(); }));
    d.add(ev.on('chat:stream', (p) => {
      if (p.state === 'start') this.setStreaming(true);
      if (p.state === 'end') this.setStreaming(false);
    }));
    d.add(ev.on('chat:message', (p) => this.onMessage(p)));
  }

  // ------------------------------------------------------------------ context chips

  /** Current composer context (also emitted as composer:context). */
  context() {
    const sel = this.services.selection?.get();
    const ids = [...this.pinned];
    for (const id of sel?.selected || []) if (!ids.includes(id)) ids.push(id);
    const scopes = ids.filter((id) => !this.excluded.has(id));
    const area = this.ws.activeArea();
    return {
      scopes,
      scenarioId: this.services.scenarios?.activeId || null,
      areaType: area?.leaf.editorType || null,
      areaId: area?.id || null,
      mode: this.store.get('ui.composerMode') || 'answer',
    };
  }

  refreshContext() {
    const ctx = this.context();
    const chips = this.chips;
    chips.replaceChildren();
    const label = (id) => this.services.selection?.label?.(id) || id;
    const shown = ctx.scopes.slice(0, 4);
    for (const id of shown) {
      chips.appendChild(this.chip('symbol-class', `@${label(id)}`, 'scope', () => {
        this.pinned = this.pinned.filter((p) => p !== id);
        this.excluded.add(id);
        this.refreshContext();
      }, true));
    }
    if (ctx.scopes.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'ms-chips-hint';
      more.textContent = `+${ctx.scopes.length - shown.length} more`;
      chips.appendChild(more);
    }
    const sc = this.services.scenarios;
    chips.appendChild(this.chip('repo-forked', sc ? sc.label(ctx.scenarioId) : 'base', 'scenario', null, false));
    if (ctx.areaType) {
      const e = getEditor(ctx.areaType);
      chips.appendChild(this.chip(e?.icon || 'window', e?.label || ctx.areaType, 'area', null, false));
    }
    const hint = document.createElement('span');
    hint.className = 'ms-chips-hint';
    hint.textContent = 'Enter send · Shift+Enter newline · / commands · @ mentions';
    chips.appendChild(hint);
    this.events.emit('composer:context', ctx);
    this.updateRoute();
  }

  /**
   * @param {string} icon @param {string} text @param {string} kind
   * @param {(() => void)|null} onRemove @param {boolean} isScope
   */
  chip(icon, text, kind, onRemove, isScope) {
    const c = document.createElement('span');
    c.className = `ms-ctx-chip${isScope ? ' is-scope' : ' is-badge'}`;
    c.dataset.kind = kind;
    // scope chips say "scope:" inline; scenario/area badges carry the kind in a tooltip and screen-reader text
    c.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="${isScope ? 'ms-chip-kind' : 'ms-sr-only'}">${esc(kind)}:</span>`;
    if (!isScope) c.dataset.tooltip = `${kind[0].toUpperCase()}${kind.slice(1)}: ${text}`;
    const l = document.createElement('span');
    l.className = 'ms-chip-label';
    l.textContent = text;
    c.appendChild(l);
    if (onRemove) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'ms-chip-x';
      x.setAttribute('aria-label', `Remove ${text} from context`);
      x.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
      x.addEventListener('click', onRemove);
      c.appendChild(x);
    }
    return c;
  }

  // ------------------------------------------------------------------ input

  onInput() {
    this.autoGrow();
    this.renderHighlight();
    this.updateRoute();
    this.updateAc();
    this.histIndex = -1;
  }

  autoGrow() {
    const t = this.input;
    t.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    t.style.height = `${Math.min(max, Math.max(30, t.scrollHeight))}px`;
  }

  renderHighlight() {
    const text = this.input.value;
    let html = esc(text)
      .replace(/^(\/[a-z]+)/i, '<mark class="ms-slash">$1</mark>')
      .replace(/(^|\s)(@[\w.&\-]+)/g, '$1<mark class="ms-mention">$2</mark>');
    if (text.endsWith('\n')) html += ' ';
    this.hl.innerHTML = html;
    this.hl.scrollTop = this.input.scrollTop;
  }

  updateRoute() {
    const text = this.input.value;
    const router = this.services.router;
    /** @type {{kind: string, label: string, detail?: string}} */
    let r;
    // nothing typed: no routing chip at all (hidden also drops it from aria-describedby)
    this.route.hidden = !text.trim();
    if (this.route.hidden) { this.route.replaceChildren(); this.lastRoute = { kind: 'empty', label: '' }; return; }
    if (router) r = router.classify(text, this.context());
    else if (text.trim().startsWith('/')) r = { kind: 'command', label: 'command' };
    else r = { kind: 'question', label: 'model · ~40k tokens' };
    const icons = { numeric: 'zap', structural: 'sparkle', question: 'sparkle', command: 'terminal-cmd', invalid: 'error', empty: 'info' };
    this.route.dataset.kind = r.kind;
    this.route.innerHTML = `<span class="codicon codicon-${icons[r.kind] || 'info'}" aria-hidden="true"></span>`;
    const l = document.createElement('span');
    l.textContent = r.label;
    this.route.appendChild(l);
    this.route.dataset.tooltip = r.detail || (r.kind === 'numeric'
      ? 'Numeric edit: recomputes in the browser engine, zero model tokens'
      : r.kind === 'structural' ? 'Structural change: goes to the model as ScopeDeltas'
        : r.kind === 'question' ? 'New question: a swarm build on the model'
          : r.kind === 'command' ? 'Slash command' : 'Routing preview');
    this.lastRoute = r;
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (this.ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveAc(-1); return; }
      // a complete command ("/sim", "/compare") runs on Enter instead of being completed again
      const top = this.ac.items[this.ac.index];
      if (e.key === 'Enter' && !e.shiftKey && this.ac.kind === '/' && top && this.input.value.trim() === top.cmd) {
        e.preventDefault();
        this.closeAc();
        if (!this.streaming) this.send();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeAc(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!this.streaming) this.send();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.input.blur();
      return;
    }
    if (e.key === 'ArrowUp' && !this.input.value.includes('\n') && (this.input.value === '' || this.histIndex >= 0)) {
      if (!this.history.length) return;
      e.preventDefault();
      this.histIndex = this.histIndex < 0 ? this.history.length - 1 : Math.max(0, this.histIndex - 1);
      this.setText(this.history[this.histIndex], true);
      return;
    }
    if (e.key === 'ArrowDown' && this.histIndex >= 0) {
      e.preventDefault();
      this.histIndex++;
      if (this.histIndex >= this.history.length) { this.histIndex = -1; this.setText('', false); }
      else this.setText(this.history[this.histIndex], true);
    }
  }

  /** @param {string} text @param {boolean} [keepHist] */
  setText(text, keepHist = false) {
    const h = this.histIndex;
    this.input.value = text;
    this.onInput();
    if (keepHist) this.histIndex = h;
    this.input.setSelectionRange(text.length, text.length);
  }

  /** Insert text at the caret (used by editors via the composer.insert command). @param {string} text */
  insert(text, { focus = true, replace = false } = {}) {
    if (replace) this.input.value = text;
    else {
      const { selectionStart: s, selectionEnd: en, value } = this.input;
      const pre = value.slice(0, s);
      const sep = pre && !/\s$/.test(pre) ? ' ' : '';
      this.input.value = pre + sep + text + value.slice(en);
      const pos = (pre + sep + text).length;
      this.input.setSelectionRange(pos, pos);
    }
    this.onInput();
    if (focus) this.input.focus();
  }

  focus() {
    this.input.focus();
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  send() {
    const text = this.input.value.trim();
    if (!text) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    this.histIndex = -1;
    const ctx = this.context();
    this.setText('');
    this.hidePeek();
    const chat = this.services.chat;
    if (chat) chat.send(text, ctx);
    else this.services.notify?.info('Chat arrives with the model layer (Milestone 2).');
  }

  stop() {
    this.services.chat?.stop();
  }

  /** @param {boolean} on */
  setStreaming(on) {
    this.streaming = on;
    this.progress.hidden = !on;
    this.renderSend();
  }

  renderSend() {
    this.sendBtn.classList.toggle('is-stop', this.streaming);
    this.sendBtn.setAttribute('aria-label', this.streaming ? 'Stop generating' : 'Send (Enter)');
    this.sendBtn.dataset.tooltip = this.streaming ? 'Stop generating' : 'Send (Enter)';
    this.sendBtn.innerHTML = `<span class="codicon codicon-${this.streaming ? 'debug-stop' : 'send'}" aria-hidden="true"></span>`;
  }

  renderMode() {
    const cur = this.store.get('ui.composerMode') || 'answer';
    const m = MODES.find((x) => x.id === cur) || MODES[0];
    this.modeBtn.innerHTML = '';
    const l = document.createElement('span');
    l.textContent = m.label;
    const c = document.createElement('span');
    c.className = 'codicon codicon-chevron-down';
    c.setAttribute('aria-hidden', 'true');
    this.modeBtn.append(l, c);
    this.modeBtn.setAttribute('aria-label', `Mode: ${m.label}`);
    this.modeBtn.dataset.tooltip = `Mode: ${m.label} (${m.desc})`;
  }

  // ------------------------------------------------------------------ autocomplete

  updateAc() {
    const { value, selectionStart } = this.input;
    const before = value.slice(0, selectionStart);
    const at = /(^|\s)@([\w.&\-]*)$/.exec(before);
    const slash = /^\/([a-z]*)$/i.exec(before);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q)).map((c) => ({ kind: '/', ...c }));
      if (items.length) return this.openAc(items, '/', 0);
    } else if (at && this.services.graphQuery) {
      const q = at[2];
      const results = this.services.graphQuery.search(q, { limit: 10 });
      if (results.length) return this.openAc(results.map((r) => ({ kind: '@', ...r })), '@', before.length - q.length - 1);
    }
    this.closeAc();
  }

  /** @param {any[]} items @param {'@'|'/'} kind @param {number} start */
  openAc(items, kind, start) {
    this.ac = { items, index: 0, kind, start };
    this.renderAc();
  }

  renderAc() {
    const ac = this.ac;
    if (!ac) return;
    const el = this.acEl;
    el.replaceChildren();
    const head = document.createElement('div');
    head.className = 'ms-ac-head';
    head.textContent = ac.kind === '/' ? 'Commands' : 'Scopes and metrics';
    el.appendChild(head);
    ac.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'ms-ac-item';
      row.id = `ms-ac-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === ac.index));
      if (ac.kind === '/') {
        row.innerHTML = `<span class="ms-ac-cmd">${esc(it.cmd)}</span><span class="ms-ac-path">${esc(it.args)}</span><span class="ms-ac-value">${esc(it.desc)}</span>`;
      } else {
        const glyph = document.createElement('span');
        glyph.className = 'ms-prov';
        glyph.dataset.prov = it.prov || 'computed';
        glyph.textContent = it.prov ? provGlyph(it.prov) : '';
        glyph.setAttribute('aria-label', it.prov || '');
        const name = document.createElement('span');
        name.className = 'ms-ac-name';
        name.textContent = it.name;
        const path = document.createElement('span');
        path.className = 'ms-ac-path';
        path.textContent = `${it.path}${it.unit ? ` · ${it.unit}` : ''}${it.proto ? ` · ${it.proto}` : ''}`;
        const val = document.createElement('span');
        val.className = 'ms-ac-value';
        val.textContent = it.valueText || '';
        row.append(glyph, name, path, val);
      }
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        ac.index = i;
        this.acceptAc();
      });
      el.appendChild(row);
    });
    el.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-activedescendant', `ms-ac-${ac.index}`);
    el.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  /** @param {number} delta */
  moveAc(delta) {
    if (!this.ac) return;
    const n = this.ac.items.length;
    this.ac.index = (this.ac.index + delta + n) % n;
    this.renderAc();
  }

  acceptAc() {
    const ac = this.ac;
    if (!ac) return;
    const it = ac.items[ac.index];
    const { value, selectionStart } = this.input;
    let insert;
    let start;
    if (ac.kind === '/') {
      insert = `${it.cmd} `;
      start = 0;
    } else {
      insert = `@${it.path} `;
      start = ac.start;
    }
    this.input.value = value.slice(0, start) + insert + value.slice(selectionStart);
    const pos = start + insert.length;
    this.input.setSelectionRange(pos, pos);
    this.closeAc();
    this.onInput();
    this.closeAc();
  }

  closeAc() {
    this.ac = null;
    this.acEl.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  // ------------------------------------------------------------------ replies & peek card

  /** @param {{message: any, kind: string}} p */
  onMessage(p) {
    const m = p.message;
    if (!m || m.role !== 'assistant' || !m.done || p.kind !== 'update') return;
    const live = document.getElementById('sr-live');
    if (live) live.textContent = `Reply: ${m.plainText || ''}`.slice(0, 400);
    const chatVisible = this.ws.visibleAreasOfType('chat').length > 0;
    if (!chatVisible) this.showPeek(m);
  }

  /** @param {any} m */
  showPeek(m) {
    const peek = this.peek;
    peek.replaceChildren();
    const head = document.createElement('div');
    head.className = 'ms-peek-head';
    head.innerHTML = '<span class="codicon codicon-comment-discussion" aria-hidden="true"></span><span class="ms-grow">Reply</span>';
    const close = document.createElement('button');
    close.className = 'ms-icon-btn is-small';
    close.setAttribute('aria-label', 'Dismiss reply');
    close.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
    close.addEventListener('click', () => this.hidePeek());
    head.appendChild(close);
    const body = document.createElement('div');
    body.className = 'ms-peek-body';
    const engine = this.env.engine;
    if (engine && m.template) renderTemplateInto(body, m.template, { engine, graph: engine.graph, scenarioId: this.services.scenarios?.activeId });
    else body.textContent = m.plainText || '';
    const foot = document.createElement('div');
    foot.className = 'ms-peek-foot';
    const open = document.createElement('button');
    open.className = 'ms-btn is-small';
    open.textContent = 'Open in area…';
    open.addEventListener('click', () => {
      const areas = this.ws.activeAreas();
      this.menus.show(areas.map((a) => ({
        label: `${getEditor(a.leaf.editorType)?.label || a.leaf.editorType} area`,
        icon: getEditor(a.leaf.editorType)?.icon,
        run: () => { this.ws.setAreaType(a.id, 'chat'); this.hidePeek(); },
      })), open, { label: 'Switch which area to Chat?' });
    });
    foot.appendChild(open);
    peek.append(head, body, foot);
    peek.hidden = false;
    this._boundPeek = body;
  }

  hidePeek() {
    this.peek.hidden = true;
    this._boundPeek = null;
  }

  dispose() {
    this.d.dispose();
  }
}
