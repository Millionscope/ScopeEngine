/**
 * VS Code-style status bar. Left: graph version + hash (-> History), engine, last recompute,
 * token cost of the last action (highlighted when local / 0 tokens), Monte Carlo samples
 * (click to change). Right: selection, scenario, swarm status, certificate badge, theme,
 * notifications. Every readout is driven by store paths under `status.*` and `ui.*`.
 * @module shell/statusbar
 */
import { DisposableStore, listen } from '../core/disposable.js';

/** @param {number} n */
const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');

export class StatusBar {
  /**
   * @param {{
   *   el: HTMLElement,
   *   store: import('../core/store.js').Store,
   *   commands: import('../core/commands.js').CommandRegistry,
   *   theme: import('../theme/theme-service.js').ThemeService,
   *   events: import('../core/events.js').EventBus,
   *   menus: import('./context-menu.js').MenuService,
   *   notify: import('../services/notify.js').NotifyService,
   *   services: any,
   * }} deps
   */
  constructor({ el, store, commands, theme, events, menus, notify, services }) {
    this.el = el;
    this.store = store;
    this.commands = commands;
    this.theme = theme;
    this.menus = menus;
    this.notify = notify;
    this.services = services;
    this.d = new DisposableStore();
    el.setAttribute('role', 'contentinfo');
    el.setAttribute('aria-label', 'Status bar');

    const left = document.createElement('div');
    left.className = 'ms-sb-group';
    const right = document.createElement('div');
    right.className = 'ms-sb-group is-right';

    this.version = this.item('button', 'git-commit', 'Graph version and content hash: open History');
    this.engine = this.item('span', 'server-process', 'Engine behind the EngineAdapter interface');
    this.engine.dataset.collapse = '1';
    this.recompute = this.item('span', 'zap', 'Last recompute: time and nodes recomputed');
    this.tokens = this.item('span', 'symbol-numeric', 'Model tokens used by the last action');
    this.mc = this.item('button', 'pulse', 'Monte Carlo samples (click to change)');
    this.message = this.item('span', '', '');
    this.message.dataset.collapse = '2';
    left.append(this.version, this.engine, this.recompute, this.tokens, this.mc, this.message);

    this.selection = this.item('button', 'target', 'Selection: open in Properties');
    this.selection.dataset.collapse = '1';
    this.scenario = this.item('button', 'repo-forked', 'Active scenario (click to switch)');
    this.swarm = this.item('button', 'hubot', 'Swarm status: open the Swarm blackboard');
    this.swarm.dataset.collapse = '1';
    this.cert = this.item('button', 'verified', 'Certificate: open the full certificate');
    this.themeItem = this.item('button', 'color-mode', 'Theme (click to cycle Dark, Light, Auto)');
    this.bell = this.item('button', 'bell', 'Notifications');
    right.append(this.selection, this.scenario, this.swarm, this.cert, this.themeItem, this.bell);

    el.append(left, right);

    this.d.add(listen(this.version, 'click', () => commands.execute('view.reveal', 'history')));
    this.d.add(listen(this.mc, 'click', () => {
      const cur = store.get('ui.mcSamples');
      menus.show([200, 1000, 5000].map((n) => ({ label: `${fmtInt(n)} samples`, checked: cur === n, run: () => commands.execute('engine.samples', n) })), this.mc, { label: 'Monte Carlo samples' });
    }));
    this.d.add(listen(this.selection, 'click', () => commands.execute('view.reveal', 'inspector')));
    this.d.add(listen(this.scenario, 'click', () => {
      const sc = services.scenarios;
      if (!sc) return;
      menus.show([
        ...sc.list().map((s) => ({ label: s.name, checked: s.id === sc.activeId, run: () => sc.setActive(s.id) })),
        { separator: true },
        { label: 'Open Scenarios…', icon: 'repo-forked', run: () => commands.execute('view.reveal', 'scenarios') },
      ], this.scenario, { label: 'Scenarios' });
    }));
    this.d.add(listen(this.swarm, 'click', () => commands.execute('view.reveal', 'swarm')));
    this.d.add(listen(this.cert, 'click', () => commands.execute('view.reveal', 'certificate')));
    this.d.add(listen(this.themeItem, 'click', () => theme.cycle()));
    this.d.add(listen(this.bell, 'click', () => this.showNotifications()));

    this.d.add(store.select('status', () => this.render()));
    this.d.add(store.select('ui', () => this.render()));
    this.d.add(events.on('theme:changed', () => this.render()));
    this.d.add(events.on('notify:toast', () => this.render()));
    this.render();
  }

  /** @param {'button'|'span'} tag @param {string} icon @param {string} tooltip */
  item(tag, icon, tooltip) {
    const el = document.createElement(tag);
    el.className = 'ms-sb-item';
    if (tag === 'button') /** @type {HTMLButtonElement} */ (el).type = 'button';
    if (tooltip) {
      el.dataset.tooltip = tooltip;
      if (tag === 'button') el.setAttribute('aria-label', tooltip);
    }
    if (icon) {
      const i = document.createElement('span');
      i.className = `codicon codicon-${icon}`;
      i.setAttribute('aria-hidden', 'true');
      el.appendChild(i);
    }
    const label = document.createElement('span');
    label.className = 'ms-sb-label';
    el.appendChild(label);
    return el;
  }

  /** @param {HTMLElement} item @param {string} text */
  setLabel(item, text) {
    const l = /** @type {HTMLElement} */ (item.querySelector('.ms-sb-label'));
    if (l.textContent !== text) l.textContent = text;
  }

  render() {
    const s = this.store.get('status') || {};
    const ui = this.store.get('ui') || {};

    this.setLabel(this.version, s.version ? `${s.version} · ${s.hash || ''}` : 'no graph');
    this.setLabel(this.engine, `engine: ${s.engine || 'js-mock'}`);

    const rc = s.recompute;
    this.setLabel(this.recompute, rc && rc.nodes != null ? `${rc.ms < 10 ? rc.ms.toFixed(1) : Math.round(rc.ms)} ms · ${fmtInt(rc.nodes)} nodes` : 'idle');
    this.recompute.dataset.tooltip = rc
      ? `Last recompute: ${rc.ms.toFixed(2)} ms point values${rc.mcMs != null ? `, ${rc.mcMs.toFixed(1)} ms Monte Carlo` : ''}, ${fmtInt(rc.nodes)} nodes in the downstream cone${rc.full ? ' (full graph)' : ''}`
      : 'No recompute yet';

    const tk = s.tokens || { count: 0, local: true };
    this.setLabel(this.tokens, tk.local ? '0 tokens' : `${fmtInt(tk.count)} tokens`);
    this.tokens.classList.toggle('is-highlight', !!tk.local && !!tk.touched);
    this.tokens.dataset.tooltip = tk.local
      ? 'The last change ran in the browser engine: zero model tokens'
      : `The last action called the (mock) model: ${fmtInt(tk.count)} tokens${tk.kind ? ` (${tk.kind})` : ''}`;

    this.setLabel(this.mc, `MC ${fmtInt(ui.mcSamples || 1000)}`);

    this.setLabel(this.message, s.message || '');
    this.message.hidden = !s.message;

    this.setLabel(this.selection, s.selection || 'nothing selected');
    this.setLabel(this.scenario, s.scenario || 'base');

    const sw = s.swarm || {};
    const swIcon = /** @type {HTMLElement} */ (this.swarm.firstElementChild);
    swIcon.className = sw.running ? 'codicon codicon-loading ms-spin' : 'codicon codicon-hubot';
    this.setLabel(this.swarm, sw.running ? `Swarm · ${sw.roles || 0} roles` : (sw.label || 'Swarm idle'));

    const c = s.cert;
    const certIcon = /** @type {HTMLElement} */ (this.cert.firstElementChild);
    if (c) {
      const bad = c.failed > 0;
      certIcon.className = `codicon codicon-${bad ? 'error' : c.notProven > 0 ? 'warning' : 'verified'}`;
      this.setLabel(this.cert, bad ? `${c.failed} failed` : c.notProven > 0 ? `✓ 0 failed · ${c.notProven} not proven` : '✓ 0 failed');
      this.cert.classList.toggle('is-error', bad);
      this.cert.classList.toggle('is-highlight', false);
    } else {
      certIcon.className = 'codicon codicon-verified';
      this.setLabel(this.cert, 'no certificate');
    }

    this.setLabel(this.themeItem, this.theme.label());
    const unread = this.notify.unread;
    this.setLabel(this.bell, unread ? String(unread) : '');
    this.bell.setAttribute('aria-label', unread ? `Notifications: ${unread} unread` : 'Notifications');
  }

  showNotifications() {
    const items = this.notify.history.slice(0, 12).map((t) => ({
      label: t.message.length > 70 ? t.message.slice(0, 69) + '…' : t.message,
      icon: t.level === 'error' ? 'error' : t.level === 'warn' ? 'warning' : t.level === 'success' ? 'pass' : 'info',
      title: t.detail || '',
      run: () => {},
    }));
    this.notify.markRead();
    this.render();
    this.menus.show(items.length ? items : [{ label: 'No notifications', disabled: true }], this.bell, { label: 'Notifications', minWidth: 320 });
  }

  dispose() {
    this.d.dispose();
  }
}
