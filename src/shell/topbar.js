/**
 * Top bar: logo, menus (File / Edit / View / Graph / Help), workspace tabs (click, double-click
 * to rename, drag to reorder, right-click for duplicate/delete, + to add from a preset),
 * command center (opens the palette) and the theme toggle.
 * @module shell/topbar
 */
import { DisposableStore, listen } from '../core/disposable.js';
import { formatKey } from '../core/commands.js';
import { PRESETS } from '../workspace/presets.js';

/** @typedef {import('./context-menu.js').MenuItem} MenuItem */

/** @type {Record<string, MenuItem[]>} */
const MENUS = {
  File: [
    { command: 'chat.newQuestion' },
    { command: 'evidence.attach' },
    { separator: true },
    { command: 'export.scopelang' },
    { command: 'export.ir' },
    { separator: true },
    { command: 'layout.reset' },
    { command: 'data.clearLocal' },
  ],
  Edit: [
    { command: 'edit.undo' },
    { command: 'edit.redo' },
    { separator: true },
    { command: 'editor.rename' },
    { command: 'selection.clear' },
    { separator: true },
    { command: 'palette.open' },
    { command: 'palette.quickOpen' },
  ],
  View: [
    { command: 'theme.toggle' },
    { command: 'theme.auto' },
    { command: 'view.reducedMotion' },
    { separator: true },
    { command: 'area.maximize' },
    { command: 'area.fullscreen' },
    { command: 'area.toggleTools' },
    { command: 'area.toggleSidebar' },
    { separator: true },
    { command: 'workspace.prev' },
    { command: 'workspace.next' },
    { separator: true },
    { command: 'debug.overlay' },
  ],
  Graph: [
    { command: 'graph.recompute' },
    { command: 'certificate.replay' },
    { separator: true },
    { header: 'Monte Carlo samples' },
    { command: 'engine.samples', args: [200], label: '200 samples' },
    { command: 'engine.samples', args: [1000], label: '1,000 samples' },
    { command: 'engine.samples', args: [5000], label: '5,000 samples' },
    { separator: true },
    { command: 'debug.stress10k' },
    { command: 'debug.stress100k' },
    { command: 'graph.resetDemo' },
  ],
  Help: [
    { command: 'help.shortcuts' },
    { command: 'help.about' },
    { command: 'debug.cycleEditors' },
  ],
};

export class TopBar {
  /**
   * @param {{
   *   el: HTMLElement,
   *   ws: import('../workspace/workspaces.js').WorkspaceManager,
   *   commands: import('../core/commands.js').CommandRegistry,
   *   theme: import('../theme/theme-service.js').ThemeService,
   *   events: import('../core/events.js').EventBus,
   *   menus: import('./context-menu.js').MenuService,
   * }} deps
   */
  constructor({ el, ws, commands, theme, events, menus }) {
    this.el = el;
    this.ws = ws;
    this.commands = commands;
    this.theme = theme;
    this.menus = menus;
    this.d = new DisposableStore();
    this.tabD = new DisposableStore();
    el.setAttribute('role', 'banner');

    const logo = document.createElement('div');
    logo.className = 'ms-logo';
    logo.innerHTML = '<img class="ms-logo-mark" src="/public/logo.svg" alt="" aria-hidden="true"><span>Millionscope</span>';

    const menubar = document.createElement('nav');
    menubar.className = 'ms-menubar';
    menubar.setAttribute('aria-label', 'Application menu');
    for (const name of Object.keys(MENUS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ms-menubar-item';
      b.textContent = name;
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      if (name === 'Graph') b.dataset.collapse = '1';
      this.d.add(listen(b, 'click', () => {
        b.setAttribute('aria-expanded', 'true');
        this.menus.show(MENUS[name], b, { label: name, onClose: () => b.setAttribute('aria-expanded', 'false') });
      }));
      menubar.appendChild(b);
    }

    this.tabs = document.createElement('div');
    this.tabs.className = 'ms-ws-tabs';
    this.tabs.setAttribute('role', 'tablist');
    this.tabs.setAttribute('aria-label', 'Workspaces');

    this.addBtn = document.createElement('button');
    this.addBtn.type = 'button';
    this.addBtn.className = 'ms-icon-btn ms-ws-add';
    this.addBtn.setAttribute('aria-label', 'New workspace from preset');
    this.addBtn.dataset.tooltip = 'New workspace from preset';
    this.addBtn.innerHTML = '<span class="codicon codicon-add" aria-hidden="true"></span>';
    this.d.add(listen(this.addBtn, 'click', () => {
      this.menus.show(PRESETS.map((p) => ({ label: p.name, icon: p.icon, title: p.description, run: () => this.ws.addWorkspace(p.key) })), this.addBtn, { label: 'New workspace' });
    }));

    const center = document.createElement('div');
    center.className = 'ms-topbar-center';
    const cc = document.createElement('button');
    cc.type = 'button';
    cc.className = 'ms-command-center';
    cc.setAttribute('aria-label', 'Search scopes, commands and editor types');
    cc.innerHTML = `<span class="codicon codicon-search" aria-hidden="true"></span><span class="ms-ellipsis">Search scopes, commands, editors…</span><span class="ms-kbd">${formatKey('f3')}</span>`;
    this.d.add(listen(cc, 'click', () => this.commands.execute('palette.open')));
    center.appendChild(cc);

    const right = document.createElement('div');
    right.className = 'ms-topbar-right';
    this.themeBtn = document.createElement('button');
    this.themeBtn.type = 'button';
    this.themeBtn.className = 'ms-icon-btn';
    this.themeBtn.innerHTML = '<span class="codicon codicon-color-mode" aria-hidden="true"></span>';
    this.d.add(listen(this.themeBtn, 'click', () => this.commands.execute('theme.toggle')));
    const themeMenuBtn = document.createElement('button');
    themeMenuBtn.type = 'button';
    themeMenuBtn.className = 'ms-icon-btn is-small';
    themeMenuBtn.setAttribute('aria-label', 'Theme options');
    themeMenuBtn.dataset.tooltip = 'Theme: Dark, Light or Auto';
    themeMenuBtn.setAttribute('aria-haspopup', 'menu');
    themeMenuBtn.innerHTML = '<span class="codicon codicon-chevron-down" aria-hidden="true"></span>';
    this.d.add(listen(themeMenuBtn, 'click', () => {
      this.menus.show([
        { label: 'Dark', checked: this.theme.mode === 'dark', run: () => this.theme.setMode('dark') },
        { label: 'Light', checked: this.theme.mode === 'light', run: () => this.theme.setMode('light') },
        { label: 'Auto (follow system)', checked: this.theme.mode === 'auto', run: () => this.theme.setMode('auto') },
      ], themeMenuBtn, { label: 'Theme' });
    }));
    right.append(this.themeBtn, themeMenuBtn);

    el.append(logo, menubar, this.tabs, this.addBtn, center, right);

    this.d.add(events.on('workspace:changed', () => this.renderTabs()));
    this.d.add(events.on('layout:changed', (p) => {
      if (['rename-workspace', 'reorder', 'add-workspace', 'duplicate-workspace', 'remove-workspace', 'switch'].includes(p.reason)) this.renderTabs();
    }));
    this.d.add(events.on('theme:changed', () => this.renderTheme()));
    this.d.add(listen(window, 'blur', () => el.closest('.ms-app')?.classList.add('is-window-inactive')));
    this.d.add(listen(window, 'focus', () => el.closest('.ms-app')?.classList.remove('is-window-inactive')));
    this.renderTabs();
    this.renderTheme();
  }

  renderTheme() {
    const label = `Theme: ${this.theme.label()} (click to toggle)`;
    this.themeBtn.setAttribute('aria-label', label);
    this.themeBtn.dataset.tooltip = label;
  }

  renderTabs() {
    this.tabD.clear();
    this.tabs.replaceChildren();
    const ws = this.ws;
    ws.workspaces.forEach((w, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ms-ws-tab';
      tab.setAttribute('role', 'tab');
      const selected = w.id === ws.activeId;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.dataset.ws = w.id;
      tab.draggable = true;
      tab.innerHTML = `<span class="codicon codicon-${w.icon}" aria-hidden="true"></span>`;
      const label = document.createElement('span');
      label.textContent = w.name;
      tab.appendChild(label);
      this.tabD.add(listen(tab, 'click', () => ws.switchTo(w.id)));
      this.tabD.add(listen(tab, 'dblclick', () => this.beginRename(tab, w.id)));
      this.tabD.add(listen(tab, 'contextmenu', (e) => {
        e.preventDefault();
        const me = /** @type {MouseEvent} */ (e);
        this.menus.show([
          { label: 'Rename', icon: 'edit', run: () => this.beginRename(tab, w.id) },
          { label: 'Duplicate', icon: 'copy', run: () => ws.duplicateWorkspace(w.id) },
          { label: 'Delete', icon: 'trash', disabled: ws.workspaces.length <= 1, run: () => ws.removeWorkspace(w.id) },
          { separator: true },
          { label: 'New from preset', icon: 'add', submenu: PRESETS.map((p) => ({ label: p.name, icon: p.icon, run: () => ws.addWorkspace(p.key) })) },
        ], { x: me.clientX, y: me.clientY }, { label: `${w.name} workspace` });
      }));
      this.tabD.add(listen(tab, 'keydown', (ev) => {
        const e = /** @type {KeyboardEvent} */ (ev);
        const all = [...this.tabs.querySelectorAll('.ms-ws-tab')];
        const i = all.indexOf(tab);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = /** @type {HTMLElement} */ (all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]);
          next.focus();
        } else if (e.key === 'F2') {
          e.preventDefault();
          this.beginRename(tab, w.id);
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          /** @type {HTMLElement} */ (all[e.key === 'Home' ? 0 : all.length - 1]).focus();
        }
      }));
      // drag to reorder
      this.tabD.add(listen(tab, 'dragstart', (ev) => {
        const e = /** @type {DragEvent} */ (ev);
        e.dataTransfer?.setData('text/x-ms-workspace', w.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      }));
      this.tabD.add(listen(tab, 'dragover', (ev) => {
        const e = /** @type {DragEvent} */ (ev);
        if (!e.dataTransfer?.types.includes('text/x-ms-workspace')) return;
        e.preventDefault();
        const r = tab.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        tab.classList.toggle('is-drop-after', after);
        tab.classList.toggle('is-drop-before', !after);
      }));
      this.tabD.add(listen(tab, 'dragleave', () => tab.classList.remove('is-drop-after', 'is-drop-before')));
      this.tabD.add(listen(tab, 'drop', (ev) => {
        const e = /** @type {DragEvent} */ (ev);
        const id = e.dataTransfer?.getData('text/x-ms-workspace');
        tab.classList.remove('is-drop-after', 'is-drop-before');
        if (!id || id === w.id) return;
        e.preventDefault();
        const r = tab.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        ws.moveWorkspace(id, after ? index + 1 : index);
      }));
      this.tabs.appendChild(tab);
    });
    this.tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** @param {HTMLElement} tab @param {string} id */
  beginRename(tab, id) {
    const w = this.ws.get(id);
    if (!w) return;
    const input = document.createElement('input');
    input.className = 'ms-ws-tab-input';
    input.value = w.name;
    input.setAttribute('aria-label', 'Workspace name');
    tab.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) this.ws.renameWorkspace(id, input.value);
      this.renderTabs();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  dispose() {
    this.tabD.dispose();
    this.d.dispose();
  }
}
