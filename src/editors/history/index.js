/**
 * History: the version list (v1 … vN, newest first, virtualized), with author (user / model /
 * swarm role), op summary, token cost and time. Click a version for its changes; Ctrl/Cmd- or
 * Shift-click a second version for the net diff between them (added / removed / modified,
 * marked with the editorGutter colors). Undo / redo, "Restore this version" (applied as a NEW
 * version, history is never rewritten) and "Fork scenario from here" (a scenario whose
 * overrides reproduce that version's values). Reads services.history; listens to
 * history:changed.
 * @module editors/history
 */
import { BaseEditor } from '../base-editor.js';
import { VirtualList } from '../shared/virtual-list.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';

const KIND_ICON = { edit: 'edit', local: 'zap', undo: 'discard', redo: 'redo', restore: 'history', model: 'hubot', swarm: 'hubot' };
const ROW_H = 24;

export default class HistoryEditor extends BaseEditor {
  static id = 'history';
  static label = 'History';
  static icon = 'history';
  static group = 'General';
  static needs = [];

  async mount(ctx, state) {
    await loadCss(new URL('./history.css', import.meta.url));
    this.state = { filter: typeof state.filter === 'string' ? state.filter : '' };
    /** selected version labels: [a] or [a, b] */
    this.sel = [];
    this.focusIndex = 0;
    this.rows = [];

    this.root = document.createElement('div');
    this.root.className = 'ms-ed ms-hist';
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'ms-ed-toolbar ms-hist-toolbar';
    this.split = document.createElement('div');
    this.split.className = 'ms-hist-split';
    this.listHost = document.createElement('div');
    this.listHost.className = 'ms-hist-list';
    this.detail = document.createElement('div');
    this.detail.className = 'ms-hist-detail';
    this.detail.setAttribute('aria-live', 'polite');
    this.split.append(this.listHost, this.detail);
    this.root.append(this.toolbar, this.split);
    ctx.el.appendChild(this.root);

    const head = document.createElement('div');
    head.className = 'ms-hist-row ms-hist-headrow';
    head.setAttribute('aria-hidden', 'true');
    head.innerHTML = '<span></span><span>version</span><span>author</span><span>change</span><span class="num">tokens</span><span class="num">time</span>';
    this.listHost.appendChild(head);

    this.vl = new VirtualList({
      container: this.listHost,
      rowHeight: ROW_H,
      renderRow: (i, row) => this.renderRow(i, row),
      schedule: (fn) => ctx.scheduler.beforeFrame(fn),
      role: 'listbox',
      label: 'Graph versions, newest first',
    });
    this.vl.el.setAttribute('aria-multiselectable', 'true');
    this.disposables.add({ dispose: () => this.vl.dispose() });
    this.listen(this.vl.el, 'click', (e) => this.onListClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.vl.el, 'keydown', (e) => this.onListKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.detail, 'click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target).closest('[data-node]');
      if (t) this.select([/** @type {HTMLElement} */ (t).dataset.node]);
    });

    this.on('history:changed', () => { this.dirty = true; this.invalidate(); });
    this.on('delta:applied', () => { this.dirty = true; this.invalidate(); });
    this.buildToolbar();
    this.reload();
  }

  getState() { return { filter: this.state.filter }; }

  /** Rows (newest first) after the text filter. */
  reload() {
    const h = /** @type {any} */ (this.ctx).services.history;
    const all = h.versions();
    const current = h.version;
    const q = this.state.filter.trim().toLowerCase();
    this.current = current;
    this.rows = all.slice().reverse().filter((v) => !q || `${v.version} ${v.author} ${v.kind} ${(v.summaries || []).join(' ')}`.toLowerCase().includes(q));
    // drop selections that no longer exist
    const exists = new Set(all.map((v) => v.version));
    this.sel = this.sel.filter((v) => exists.has(v));
    this.focusIndex = Math.min(this.focusIndex, Math.max(0, this.rows.length - 1));
    this.vl.setCount(this.rows.length);
    this.updateToolbar();
    this.renderDetail();
  }

  // ------------------------------------------------------------------ toolbar

  buildToolbar() {
    const ctx = /** @type {any} */ (this.ctx);
    const mk = (icon, label, title, run) => {
      const b = document.createElement('button');
      b.className = 'ms-btn is-secondary is-small';
      b.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
      b.append(` ${label}`);
      b.title = title;
      b.addEventListener('click', run);
      return b;
    };
    this.undoBtn = mk('discard', 'Undo', 'Undo the last graph change (Ctrl+Z): applied as a new version', () => ctx.commands.execute('edit.undo'));
    this.redoBtn = mk('redo', 'Redo', 'Redo (Ctrl+Shift+Z)', () => ctx.commands.execute('edit.redo'));
    const search = document.createElement('input');
    search.className = 'ms-input is-small ms-hist-search';
    search.type = 'search';
    search.placeholder = 'Filter versions';
    search.setAttribute('aria-label', 'Filter versions by author, operation or text');
    search.value = this.state.filter;
    search.addEventListener('input', () => {
      this.state.filter = search.value;
      this.save();
      this.reload();
    });
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { search.value = ''; this.state.filter = ''; this.reload(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.vl.el.focus(); }
    });
    this.search = search;
    this.hint = document.createElement('span');
    this.hint.className = 'ms-small ms-muted ms-hist-hint';
    this.toolbar.append(this.undoBtn, this.redoBtn, search, this.hint);
  }

  updateToolbar() {
    const h = /** @type {any} */ (this.ctx).services.history;
    this.undoBtn.disabled = !h.canUndo();
    this.redoBtn.disabled = !h.canRedo();
    this.hint.textContent = this.sel.length === 2 ? `Comparing ${this.ordered()[0]} → ${this.ordered()[1]}` : 'Ctrl+click a second version to compare';
  }

  focusSearch() { this.search?.focus(); }

  // ------------------------------------------------------------------ list

  /** @param {number} i @param {HTMLElement} row */
  renderRow(i, row) {
    const v = this.rows[i];
    if (!v) return;
    const selected = this.sel.includes(v.version);
    row.className = `ms-vlist-row ms-hist-row${selected ? ' is-selected' : ''}${i === this.focusIndex ? ' is-focused' : ''}${v.version === this.current ? ' is-current' : ''}${v.kind === 'undo' || v.kind === 'restore' ? ' is-revert' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(selected));
    row.id = `${this.ctx?.areaId}-hist-${i}`;
    row.dataset.version = v.version;
    const author = v.author || 'user';
    const authorIcon = author === 'user' ? 'account' : author === 'swarm' || author === 'model' ? 'hubot' : 'person';
    const summary = (v.summaries || []).join('; ') || v.kind;
    const tokens = v.tokens || 0;
    row.replaceChildren();
    const cells = [
      icon(KIND_ICON[v.kind] || 'circle-small', v.kind),
      text('ms-hist-ver', v.version),
      (() => { const s = document.createElement('span'); s.className = 'ms-hist-author'; s.append(icon(authorIcon), ` ${author}`); return s; })(),
      text('ms-hist-sum', summary),
      text(`ms-hist-tok num${tokens ? '' : ' is-local'}`, tokens ? tokens.toLocaleString('en-US') : '0'),
      text('ms-hist-time num', clock(v.time)),
    ];
    if (v.version === this.current) {
      const cur = document.createElement('span');
      cur.className = 'ms-badge ms-hist-cur';
      cur.textContent = 'current';
      cells[1].appendChild(cur);
    }
    row.append(...cells);
    row.title = `${v.version} · ${author} · ${v.kind}\n${(v.summaries || []).join('\n')}\n${tokens ? `${tokens.toLocaleString('en-US')} mock tokens` : 'local · 0 tokens'} · ${new Date(v.time).toLocaleString()}`;
    row.setAttribute('aria-label', `${v.version}${v.version === this.current ? ' (current)' : ''}, ${author}, ${summary}, ${tokens} tokens`);
  }

  /** @param {MouseEvent} e */
  onListClick(e) {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.ms-hist-row'));
    if (!row || row.dataset.index == null) return;
    const i = Number(row.dataset.index);
    this.pick(i, e.ctrlKey || e.metaKey || e.shiftKey);
  }

  /** @param {number} i @param {boolean} second */
  pick(i, second) {
    const v = this.rows[i]?.version;
    if (!v) return;
    this.focusIndex = i;
    if (second && this.sel.length && this.sel[0] !== v) this.sel = [this.sel[0], v];
    else if (second && this.sel[0] === v) this.sel = this.sel.slice(1);
    else this.sel = [v];
    this.vl.el.setAttribute('aria-activedescendant', `${this.ctx?.areaId}-hist-${i}`);
    this.vl.refresh();
    this.updateToolbar();
    this.renderDetail();
  }

  /** @param {KeyboardEvent} e */
  onListKey(e) {
    const n = this.rows.length;
    if (!n) return;
    let i = this.focusIndex;
    if (e.key === 'ArrowDown') i = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else if (e.key === 'PageDown') i = Math.min(n - 1, i + 10);
    else if (e.key === 'PageUp') i = Math.max(0, i - 10);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.pick(i, e.key === ' ' || e.ctrlKey || e.metaKey || e.shiftKey);
      return;
    } else return;
    e.preventDefault();
    this.vl.scrollToIndex(i);
    this.pick(i, e.shiftKey);
  }

  /** Selected versions oldest first. */
  ordered() {
    const h = /** @type {any} */ (this.ctx).services.history;
    return this.sel.slice().sort((a, b) => h._index(a) - h._index(b));
  }

  // ------------------------------------------------------------------ detail / diff

  renderDetail() {
    const ctx = /** @type {any} */ (this.ctx);
    const h = ctx.services.history;
    this.detail.replaceChildren();
    if (!this.sel.length) {
      const total = h.versions().length;
      this.detail.appendChild(emptyState({ icon: 'history', title: `${total} version${total === 1 ? '' : 's'}`, text: 'Select a version to see its changes. Ctrl+click (or Shift+click) a second one to compare the two. Undo, redo and restore always add a new version.' }));
      return;
    }
    const [a, b] = this.ordered();
    const single = this.sel.length === 1;
    const entry = h.versions().find((v) => v.version === (single ? a : b));
    const prev = single ? (entry?.prevVersion || null) : a;
    const d = prev ? h.diff(prev, single ? a : b) : null;

    const head = document.createElement('div');
    head.className = 'ms-hist-dhead';
    const title = document.createElement('div');
    title.className = 'ms-hist-dtitle';
    if (single) {
      title.textContent = `${a}${a === this.current ? ' (current)' : ''}`;
      const meta = document.createElement('span');
      meta.className = 'ms-muted ms-small';
      meta.textContent = ` · ${entry?.author || 'user'} · ${entry?.kind || ''} · ${entry?.tokens ? `${entry.tokens.toLocaleString('en-US')} mock tokens` : 'local, 0 tokens'} · ${clock(entry?.time)}`;
      title.appendChild(meta);
    } else {
      title.textContent = `Diff ${a} → ${b}`;
      const meta = document.createElement('span');
      meta.className = 'ms-muted ms-small';
      meta.textContent = ` · ${d?.entries.length || 0} version${d?.entries.length === 1 ? '' : 's'} apart`;
      title.appendChild(meta);
    }
    const actions = document.createElement('div');
    actions.className = 'ms-row ms-hist-actions';
    const target = single ? a : b;
    const restore = button('history', 'Restore this version', `Apply the inverse of every later change as one new version; ${target} stays in history`, () => this.restore(target));
    restore.disabled = target === this.current;
    const fork = button('repo-forked', 'Fork scenario from here', `A scenario whose overrides reproduce the values of ${target}; your current inputs stay as they are`, () => this.fork(target));
    fork.disabled = target === this.current;
    actions.append(restore, fork);
    if (single && a !== this.current) actions.appendChild(button('diff', 'Compare with current', `Diff ${a} → ${this.current}`, () => { this.sel = [a, this.current]; this.vl.refresh(); this.updateToolbar(); this.renderDetail(); }));
    head.append(title, actions);
    this.detail.appendChild(head);

    if (single && entry && entry.seq === 0) {
      const p = document.createElement('p');
      p.className = 'ms-small ms-muted ms-hist-note';
      p.textContent = 'The initial model build (from the swarm). Later versions are recorded as deltas on top of it.';
      this.detail.appendChild(p);
    }
    if (single && entry?.deltas?.length) {
      this.detail.appendChild(section('Operations', entry.deltas.map((dl, i) => this.opRow(dl, entry.summaries?.[i]))));
    }
    if (!d) return;
    const g = ctx.engine.graph;
    const lists = [];
    if (d.modified.length) {
      lists.push(section(`Modified (${d.modified.length})`, d.modified.map((m) => {
        const r = document.createElement('div');
        r.className = 'ms-hist-change ms-diff-mod';
        const name = document.createElement('button');
        name.className = 'ms-hist-node';
        name.dataset.node = m.id;
        name.textContent = g.node(m.id) ? g.path(m.id) : m.id;
        name.title = 'Select';
        const before = document.createElement('del');
        before.textContent = m.before;
        const after = document.createElement('ins');
        after.textContent = m.after;
        r.append(name, before, document.createTextNode(' → '), after);
        return r;
      })));
    }
    if (d.added.length) lists.push(section(`Added (${d.added.length})`, d.added.map((x) => line('ms-diff-add', x.version, x.summary))));
    if (d.removed.length) lists.push(section(`Removed (${d.removed.length})`, d.removed.map((x) => line('ms-diff-del', x.version, x.summary))));
    if (d.other.length) lists.push(section(`Other operations (${d.other.length})`, d.other.map((x) => line('ms-diff-mod', x.version, x.summary))));
    if (!lists.length) {
      const p = document.createElement('p');
      p.className = 'ms-small ms-muted ms-hist-note';
      p.textContent = single ? 'No metric value changed in this version.' : 'No net change between these versions (for example an edit and its undo).';
      this.detail.appendChild(p);
    }
    for (const l of lists) this.detail.appendChild(l);
  }

  /** @param {any} dl @param {string|undefined} summary */
  opRow(dl, summary) {
    const r = document.createElement('div');
    const cls = dl.op === 'add_scope' || dl.op === 'add_metric' || dl.op === 'fork' || dl.op === 'restore_scope' ? 'ms-diff-add' : dl.op === 'remove_scope' || dl.op === 'remove_metric' || dl.op === 'delete_scenario' ? 'ms-diff-del' : 'ms-diff-mod';
    r.className = `ms-hist-change ${cls}`;
    const op = document.createElement('code');
    op.textContent = dl.op;
    // summaries usually start with the op name already ("set Bakery.rent = …")
    const text = summary && summary.startsWith(dl.op) ? summary.slice(dl.op.length).trimStart() : summary || '';
    r.append(op, ` ${text}`);
    if (dl.target && /** @type {any} */ (this.ctx).engine.graph.node(dl.target)) {
      r.dataset.node = dl.target;
      r.classList.add('is-link');
      r.title = 'Click to select the changed metric';
    }
    return r;
  }

  // ------------------------------------------------------------------ actions

  /** @param {string} version */
  restore(version) {
    const ctx = /** @type {any} */ (this.ctx);
    const res = ctx.services.history.restore(version);
    if (!res) ctx.services.notify.info(`Nothing to restore: ${version} is current.`);
    else if (!res.ok) ctx.services.notify.warn(`Could not restore ${version}: ${res.errors?.[0]?.message || 'rejected'}`, { detail: res.errors?.[0]?.hint });
    else {
      ctx.services.notify.success(`Restored the values and structure of ${version} as ${res.entry.version}. Nothing was deleted from history.`);
      this.sel = [res.entry.version];
    }
  }

  /** Fork a scenario whose overrides reproduce the values at `version`. @param {string} version */
  fork(version) {
    const ctx = /** @type {any} */ (this.ctx);
    const h = ctx.services.history;
    const g = ctx.engine.graph;
    const idx = h._index(version);
    const later = h.entries.slice(idx);
    /** @type {Map<string, {target: string, value?: number, dist?: any}>} */
    const ov = new Map();
    let structural = 0;
    // newest first, so the oldest inverse (the value as of `version`) wins
    for (let i = later.length - 1; i >= 0; i--) {
      for (const inv of later[i].inverses) {
        if (inv.op === 'set' && !inv.scenario && inv.target && g.node(inv.target)) {
          ov.set(inv.target, inv.dist ? { target: inv.target, dist: inv.dist } : { target: inv.target, value: inv.value });
        } else if (inv.op !== 'set' && inv.op !== 'fork' && inv.op !== 'delete_scenario') structural++;
      }
    }
    // metrics and scopes created after `version` did not exist then: no override for them
    const bornScopes = new Set();
    const bornMetrics = new Set();
    for (const e of later) {
      for (const inv of e.inverses) {
        if (inv.op === 'remove_scope') bornScopes.add(inv.target);
        else if (inv.op === 'remove_metric') bornMetrics.add(inv.target);
      }
    }
    const bornLater = (id) => {
      if (bornMetrics.has(id)) return true;
      for (let sid = g.node(id)?.scope, guard = 0; sid && guard < 64; sid = g.scopes.get(sid)?.parent, guard++) if (bornScopes.has(sid)) return true;
      return false;
    };
    // keep only metrics that existed then and whose value differs now
    for (const [id, o] of ov) {
      if (bornLater(id)) { ov.delete(id); continue; }
      const n = g.node(id);
      if (o.dist ? JSON.stringify(o.dist) === JSON.stringify(n.dist) : o.value === n.value && !n.dist) ov.delete(id);
    }
    if (!ov.size) {
      ctx.services.notify.info(structural ? `Values are the same as in ${version}; only structure changed since, which a scenario cannot hold. Use “Restore this version” instead.` : `Nothing differs from ${version}.`);
      return;
    }
    const r = ctx.services.scenarios.fork(`As of ${version}`, [...ov.values()], { parent: 'base', note: `values as of ${version}` });
    if (!r.ok) {
      ctx.services.notify.warn(`Could not fork: ${r.errors?.[0]?.message || 'rejected'}`, { detail: r.errors?.[0]?.hint });
      return;
    }
    ctx.services.notify.success(`Forked scenario “As of ${version}” with ${ov.size} override${ov.size === 1 ? '' : 's'}.${structural ? ` ${structural} structural change${structural === 1 ? ' is' : 's are'} not included (scenarios hold values only).` : ''}`, {
      actions: [{ label: 'Make active', run: () => ctx.services.scenarios.setActive(r.id) }, { label: 'Open Scenarios', run: () => ctx.commands.execute('view.reveal', 'scenarios') }],
    });
  }

  // ------------------------------------------------------------------ lifecycle

  render() {
    if (this.dirty) {
      this.dirty = false;
      this.reload();
    }
  }

  onStructure() { this.dirty = true; this.invalidate(); }

  dispose() {
    this.root?.remove();
    super.dispose();
  }
}

// ------------------------------------------------------------------ helpers

/** @param {string} name @param {string} [label] */
function icon(name, label) {
  const s = document.createElement('span');
  s.className = `codicon codicon-${name}`;
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
    s.title = label;
  } else s.setAttribute('aria-hidden', 'true');
  return s;
}

/** @param {string} cls @param {string} t */
function text(cls, t) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = t;
  return s;
}

/** @param {string} iconName @param {string} label @param {string} title @param {() => void} run */
function button(iconName, label, title, run) {
  const b = document.createElement('button');
  b.className = 'ms-btn is-secondary is-small';
  b.innerHTML = `<span class="codicon codicon-${iconName}" aria-hidden="true"></span>`;
  b.append(` ${label}`);
  b.title = title;
  b.addEventListener('click', run);
  return b;
}

/** @param {string} title @param {HTMLElement[]} children */
function section(title, children) {
  const s = document.createElement('div');
  s.className = 'ms-hist-section';
  const h = document.createElement('div');
  h.className = 'ms-hist-shead';
  h.textContent = title;
  s.append(h, ...children);
  return s;
}

/** @param {string} cls @param {string} version @param {string} summary */
function line(cls, version, summary) {
  const r = document.createElement('div');
  r.className = `ms-hist-change ${cls}`;
  const v = document.createElement('span');
  v.className = 'ms-hist-ver';
  v.textContent = version;
  r.append(v, ` ${summary}`);
  return r;
}

/** @param {number|undefined} t */
function clock(t) {
  if (!t) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
