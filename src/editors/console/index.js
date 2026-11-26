/**
 * Console: the structured log (core/log.js ring buffer + live log:entry events), virtualized.
 * Compiler diagnostics with their actionable fixes, rejected deltas with reasons, engine
 * timings, theme and lazy-load events. Filter by level (with counts), source and text; click an
 * entry to select the related scope or metric. "Clear" hides older entries in this area only.
 * @module editors/console
 */
import { BaseEditor } from '../base-editor.js';
import { VirtualList } from '../shared/virtual-list.js';
import { loadCss } from '../../core/lazy.js';
import { log } from '../../core/log.js';

const LEVELS = /** @type {const} */ (['error', 'warn', 'info', 'debug']);
const LEVEL_ICON = { error: 'error', warn: 'warning', info: 'info', debug: 'debug-console' };
const LEVEL_LABEL = { error: 'Errors', warn: 'Warnings', info: 'Info', debug: 'Debug' };
const ROW_H = 22;

export default class ConsoleEditor extends BaseEditor {
  static id = 'console';
  static label = 'Console';
  static icon = 'terminal';
  static group = 'General';
  static needs = [];

  async mount(ctx, state) {
    await loadCss(new URL('./console.css', import.meta.url));
    this.state = {
      levels: Array.isArray(state.levels) ? state.levels : ['error', 'warn', 'info'],
      hiddenSources: Array.isArray(state.hiddenSources) ? state.hiddenSources : [],
      text: typeof state.text === 'string' ? state.text : '',
      follow: state.follow !== false,
      since: 0,
    };
    /** @type {import('../../core/log.js').LogEntry[]} */
    this.view = [];
    this.focusIndex = -1;

    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-con';
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'ms-ed-toolbar ms-con-toolbar';
    this.listHost = document.createElement('div');
    this.listHost.className = 'ms-con-list';
    this.detail = document.createElement('div');
    this.detail.className = 'ms-con-detail';
    this.detail.setAttribute('aria-live', 'polite');
    this.root.append(this.toolbar, this.listHost, this.detail);
    ctx.el.appendChild(this.root);

    this.vl = new VirtualList({
      container: this.listHost,
      rowHeight: ROW_H,
      renderRow: (i, row) => this.renderRow(i, row),
      schedule: (fn) => ctx.scheduler.beforeFrame(fn),
      role: 'log',
      label: 'Structured log',
    });
    this.disposables.add({ dispose: () => this.vl.dispose() });
    this.listen(this.vl.el, 'click', (e) => this.onClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.vl.el, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.vl.el, 'scroll', () => {
      // scrolling up pauses follow; reaching the end resumes it
      const el = this.vl.el;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 1.5;
      if (atEnd !== this.state.follow) {
        this.state.follow = atEnd;
        this.updateFollow();
      }
    }, { passive: true });

    this.on('log:entry', () => {
      this.pending = true;
      this.invalidate();
    });
    this.buildToolbar();
    this.rebuild();
    this.scrollToEnd();
  }

  getState() {
    const { levels, hiddenSources, text, follow } = this.state;
    return { levels, hiddenSources, text, follow };
  }

  // ------------------------------------------------------------------ data

  /** @param {import('../../core/log.js').LogEntry} e */
  matches(e) {
    if (e.seq <= this.state.since) return false;
    if (!this.state.levels.includes(e.level)) return false;
    if (this.state.hiddenSources.includes(e.source)) return false;
    const q = this.state.text.trim().toLowerCase();
    if (q && !`${e.source} ${e.message} ${e.hint || ''} ${e.nodeId || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }

  rebuild() {
    const all = log.entries();
    this.view = all.filter((e) => this.matches(e));
    this.counts = { error: 0, warn: 0, info: 0, debug: 0 };
    this.sources = new Map();
    for (const e of all) {
      if (e.seq <= this.state.since) continue;
      this.counts[e.level] = (this.counts[e.level] || 0) + 1;
      this.sources.set(e.source, (this.sources.get(e.source) || 0) + 1);
    }
    this.lastSeq = all.length ? all[all.length - 1].seq : 0;
    this.vl.setCount(this.view.length);
    this.updateCounts();
    this.renderDetail();
  }

  /** Append entries that arrived since the last frame (cheap path for live logging). */
  appendNew() {
    const all = log.entries();
    // ring buffer trimmed or cleared: rebuild
    if (!all.length || all[0].seq > (this.view[0]?.seq ?? Infinity) || all[all.length - 1].seq < this.lastSeq) return this.rebuild();
    let i = all.length - 1;
    while (i >= 0 && all[i].seq > this.lastSeq) i--;
    let added = 0;
    for (let k = i + 1; k < all.length; k++) {
      const e = all[k];
      this.counts[e.level] = (this.counts[e.level] || 0) + 1;
      this.sources.set(e.source, (this.sources.get(e.source) || 0) + 1);
      if (this.matches(e)) {
        this.view.push(e);
        added++;
      }
    }
    this.lastSeq = all.length ? all[all.length - 1].seq : this.lastSeq;
    if (added) this.vl.setCount(this.view.length);
    this.updateCounts();
    if (added && this.state.follow) this.scrollToEnd();
  }

  render() {
    if (this.pending) {
      this.pending = false;
      this.appendNew();
    }
  }

  scrollToEnd() {
    const el = this.vl.el;
    el.scrollTop = el.scrollHeight;
    this.vl.render();
  }

  // ------------------------------------------------------------------ toolbar

  buildToolbar() {
    this.levelBtns = {};
    const group = document.createElement('div');
    group.className = 'ms-con-levels';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Levels');
    for (const lv of LEVELS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ms-con-level is-${lv}`;
      b.innerHTML = `<span class="codicon codicon-${LEVEL_ICON[lv]}" aria-hidden="true"></span><span class="ms-con-count">0</span>`;
      b.title = `Show ${LEVEL_LABEL[lv].toLowerCase()}`;
      b.addEventListener('click', () => {
        const set = new Set(this.state.levels);
        if (set.has(lv)) set.delete(lv);
        else set.add(lv);
        this.state.levels = LEVELS.filter((l) => set.has(l));
        this.save();
        this.rebuild();
      });
      this.levelBtns[lv] = b;
      group.appendChild(b);
    }
    const src = document.createElement('button');
    src.className = 'ms-btn is-secondary is-small';
    src.setAttribute('aria-haspopup', 'menu');
    src.innerHTML = '<span class="codicon codicon-filter" aria-hidden="true"></span>';
    src.append(' Sources');
    src.addEventListener('click', () => {
      const items = [...this.sources.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([s, n]) => ({
        label: `${s}  (${n})`,
        checked: !this.state.hiddenSources.includes(s),
        run: () => {
          const set = new Set(this.state.hiddenSources);
          if (set.has(s)) set.delete(s);
          else set.add(s);
          this.state.hiddenSources = [...set];
          this.save();
          this.rebuild();
        },
      }));
      /** @type {any[]} */
      const all = items.length ? items : [{ label: 'No entries yet', disabled: true }];
      all.push({ separator: true }, { label: 'Show all sources', disabled: !this.state.hiddenSources.length, run: () => { this.state.hiddenSources = []; this.save(); this.rebuild(); } });
      /** @type {any} */ (this.ctx).ui.showMenu(all, src, { label: 'Sources' });
    });
    this.srcBtn = src;
    const search = document.createElement('input');
    search.className = 'ms-input is-small ms-con-search';
    search.type = 'search';
    search.placeholder = 'Filter';
    search.setAttribute('aria-label', 'Filter log text');
    search.value = this.state.text;
    search.addEventListener('input', () => {
      this.state.text = search.value;
      this.save();
      this.rebuild();
    });
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { search.value = ''; this.state.text = ''; this.rebuild(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.vl.el.focus(); }
    });
    this.search = search;
    const follow = document.createElement('button');
    follow.className = 'ms-icon-btn is-small';
    follow.setAttribute('aria-label', 'Follow new entries');
    follow.dataset.tooltip = 'Follow new entries';
    follow.innerHTML = '<span class="codicon codicon-fold-down" aria-hidden="true"></span>';
    follow.addEventListener('click', () => {
      this.state.follow = !this.state.follow;
      this.updateFollow();
      if (this.state.follow) this.scrollToEnd();
    });
    this.followBtn = follow;
    const clear = document.createElement('button');
    clear.className = 'ms-icon-btn is-small';
    clear.setAttribute('aria-label', 'Clear console');
    clear.dataset.tooltip = 'Clear (this area only)';
    clear.innerHTML = '<span class="codicon codicon-clear-all" aria-hidden="true"></span>';
    clear.addEventListener('click', () => {
      this.state.since = this.lastSeq;
      this.focusIndex = -1;
      this.rebuild();
    });
    const spacer = document.createElement('span');
    spacer.className = 'ms-con-spacer';
    this.toolbar.append(group, src, search, spacer, follow, clear);
    this.updateFollow();
  }

  updateCounts() {
    for (const lv of LEVELS) {
      const b = this.levelBtns[lv];
      const on = this.state.levels.includes(lv);
      b.setAttribute('aria-pressed', String(on));
      const n = this.counts[lv] || 0;
      /** @type {HTMLElement} */ (b.querySelector('.ms-con-count')).textContent = n > 999 ? `${Math.floor(n / 1000)}k` : String(n);
      b.setAttribute('aria-label', `${LEVEL_LABEL[lv]}: ${n}${on ? ', shown' : ', hidden'}`);
    }
    const hidden = this.state.hiddenSources.length;
    this.srcBtn.lastChild.textContent = hidden ? ` Sources (${hidden} hidden)` : ' Sources';
  }

  updateFollow() {
    this.followBtn.setAttribute('aria-pressed', String(this.state.follow));
  }

  focusSearch() { this.search?.focus(); }

  // ------------------------------------------------------------------ rows

  /** @param {number} i @param {HTMLElement} row */
  renderRow(i, row) {
    const e = this.view[i];
    if (!e) return;
    const g = /** @type {any} */ (this.ctx).engine.graph;
    row.className = `ms-vlist-row ms-con-row is-${e.level}${i === this.focusIndex ? ' is-focused' : ''}${e.nodeId ? ' has-node' : ''}`;
    row.id = `${this.ctx?.areaId}-con-${i}`;
    row.replaceChildren();
    const ic = document.createElement('span');
    ic.className = `codicon codicon-${LEVEL_ICON[e.level]} ms-con-ic`;
    ic.setAttribute('role', 'img');
    ic.setAttribute('aria-label', e.level);
    const time = document.createElement('span');
    time.className = 'ms-con-time';
    time.textContent = clockMs(e.time);
    const src = document.createElement('span');
    src.className = 'ms-con-src';
    src.textContent = e.source;
    const msg = document.createElement('span');
    msg.className = 'ms-con-msg';
    msg.textContent = e.message;
    if (e.hint) {
      const hint = document.createElement('span');
      hint.className = 'ms-con-hint';
      hint.textContent = ` → ${e.hint}`;
      msg.appendChild(hint);
    }
    row.append(ic, time, src, msg);
    if (e.nodeId) {
      const n = document.createElement('span');
      n.className = 'ms-con-node';
      const known = g.node(e.nodeId) || g.scope?.(e.nodeId);
      n.textContent = known ? g.path(e.nodeId).replace(/^Bakery\./, '') : e.nodeId;
      row.appendChild(n);
    }
    row.title = `${e.level.toUpperCase()} [${e.source}] ${new Date(e.time).toLocaleTimeString()}\n${e.message}${e.hint ? `\nFix: ${e.hint}` : ''}${e.nodeId ? `\nRelated: ${e.nodeId} (click to select)` : ''}`;
  }

  /** @param {MouseEvent} ev */
  onClick(ev) {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (ev.target).closest('.ms-con-row'));
    if (!row || row.dataset.index == null) return;
    this.focusRow(Number(row.dataset.index), true);
  }

  /** @param {number} i @param {boolean} selectNode */
  focusRow(i, selectNode) {
    this.focusIndex = i;
    this.vl.el.setAttribute('aria-activedescendant', `${this.ctx?.areaId}-con-${i}`);
    this.vl.refresh();
    this.renderDetail();
    const e = this.view[i];
    if (selectNode && e?.nodeId) {
      const g = /** @type {any} */ (this.ctx).engine.graph;
      if (g.node(e.nodeId) || g.scope?.(e.nodeId)) this.select([e.nodeId]);
    }
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const n = this.view.length;
    if (!n) return;
    let i = this.focusIndex < 0 ? n - 1 : this.focusIndex;
    if (e.key === 'ArrowDown') i = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else if (e.key === 'PageDown') i = Math.min(n - 1, i + 10);
    else if (e.key === 'PageUp') i = Math.max(0, i - 10);
    else if (e.key === 'Enter') {
      e.preventDefault();
      this.focusRow(i, true);
      return;
    } else return;
    e.preventDefault();
    this.state.follow = i === n - 1;
    this.updateFollow();
    this.vl.scrollToIndex(i);
    this.focusRow(i, false);
  }

  renderDetail() {
    const e = this.view[this.focusIndex];
    this.detail.replaceChildren();
    if (!e) {
      const shown = this.view.length;
      const total = Object.values(this.counts || {}).reduce((a, b) => a + b, 0);
      this.detail.textContent = `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} entries shown${this.state.follow ? ' · following new entries' : ''}`;
      this.detail.classList.add('is-summary');
      return;
    }
    this.detail.classList.remove('is-summary');
    const head = document.createElement('div');
    head.className = 'ms-con-dhead';
    head.textContent = `${e.level.toUpperCase()} · ${e.source} · ${new Date(e.time).toLocaleTimeString()}`;
    const msg = document.createElement('div');
    msg.className = 'ms-con-dmsg';
    msg.textContent = e.message;
    this.detail.append(head, msg);
    if (e.hint) {
      const hint = document.createElement('div');
      hint.className = 'ms-con-dhint';
      hint.textContent = `Fix: ${e.hint}`;
      this.detail.appendChild(hint);
    }
    if (e.nodeId) {
      const g = /** @type {any} */ (this.ctx).engine.graph;
      const b = document.createElement('button');
      b.className = 'ms-chip';
      b.innerHTML = '<span class="codicon codicon-symbol-field" aria-hidden="true"></span>';
      b.append(` ${g.node(e.nodeId) || g.scope?.(e.nodeId) ? g.path(e.nodeId) : e.nodeId}`);
      b.addEventListener('click', () => this.select([e.nodeId]));
      this.detail.appendChild(b);
    }
  }

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}

/** @param {number} t */
function clockMs(t) {
  const d = new Date(t);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
