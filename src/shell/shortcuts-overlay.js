/**
 * Help > Keyboard Shortcuts overlay, generated from the live keymap.
 * @module shell/shortcuts-overlay
 */
import { DisposableStore, listen } from '../core/disposable.js';
import { formatKey } from '../core/commands.js';

const ORDER = ['Area', 'Workspace', 'View', 'Edit', 'Chat', 'Graph', 'Help', 'Debug'];

export class ShortcutsOverlay {
  /**
   * @param {{ keymap: import('../core/keymap.js').Keymap, commands: import('../core/commands.js').CommandRegistry }} deps
   */
  constructor({ keymap, commands }) {
    this.keymap = keymap;
    this.commands = commands;
    /** @type {DisposableStore|null} */
    this.d = null;
  }

  open() {
    if (this.d) return this.close();
    const d = (this.d = new DisposableStore());
    const prev = /** @type {HTMLElement|null} */ (document.activeElement);
    const scrim = document.createElement('div');
    scrim.className = 'ms-modal-scrim';
    const box = document.createElement('div');
    box.className = 'ms-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Keyboard shortcuts');
    const head = document.createElement('div');
    head.className = 'ms-modal-head';
    head.innerHTML = '<span class="codicon codicon-keyboard" aria-hidden="true"></span><span class="ms-grow">Keyboard shortcuts</span>';
    const close = document.createElement('button');
    close.className = 'ms-icon-btn';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
    head.appendChild(close);
    const body = document.createElement('div');
    body.className = 'ms-modal-body';
    const grid = document.createElement('div');
    grid.className = 'ms-shortcuts';

    /** @type {Map<string, Array<{title:string, keys:string[]}>>} */
    const groups = new Map();
    const seen = new Map();
    for (const b of this.keymap.all()) {
      const cmd = this.commands.get(b.command);
      if (!cmd) continue;
      const key = cmd.id;
      if (!seen.has(key)) {
        const entry = { title: cmd.title, keys: [] };
        seen.set(key, entry);
        const g = cmd.category || 'Other';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(entry);
      }
      seen.get(key).keys.push(b.key);
    }
    const extra = [
      ['Composer', 'Enter / Shift+Enter', 'Send / new line'],
      ['Composer', '↑ on empty input', 'Recall previous input'],
      ['Composer', '@ / "/"', 'Mention a scope / slash command'],
      ['Area', 'Drag area corner', 'Split (inward) or join (into a neighbor)'],
      ['Area', 'Double-click splitter', 'Equalize split'],
    ];
    const names = [...groups.keys()].sort((a, b) => (ORDER.indexOf(a) + 99) % 99 - (ORDER.indexOf(b) + 99) % 99);
    for (const g of names) {
      const h = document.createElement('h3');
      h.textContent = g;
      grid.appendChild(h);
      for (const e of groups.get(g) || []) grid.appendChild(this.row(e.title, e.keys.map(formatKey).join('  ·  ')));
      for (const [eg, keys, title] of extra) if (eg === g) grid.appendChild(this.row(title, keys));
    }
    const h = document.createElement('h3');
    h.textContent = 'Composer';
    grid.appendChild(h);
    for (const [eg, keys, title] of extra) if (eg === 'Composer') grid.appendChild(this.row(title, keys));
    body.appendChild(grid);
    box.append(head, body);
    scrim.appendChild(box);
    (document.getElementById('overlay-root') || document.body).appendChild(scrim);
    close.focus();
    const done = () => {
      this.close();
      prev?.focus?.({ preventScroll: true });
    };
    d.add(listen(close, 'click', done));
    d.add(listen(scrim, 'pointerdown', (e) => { if (e.target === scrim) done(); }));
    d.add(listen(box, 'keydown', (e) => { if (/** @type {KeyboardEvent} */ (e).key === 'Escape') { e.stopPropagation(); done(); } }));
    d.add({ dispose: () => scrim.remove() });
  }

  /** @param {string} title @param {string} keys */
  row(title, keys) {
    const r = document.createElement('div');
    r.className = 'ms-shortcut-row';
    const t = document.createElement('span');
    t.textContent = title;
    const k = document.createElement('span');
    k.className = 'ms-kbd';
    k.textContent = keys;
    r.append(t, k);
    return r;
  }

  close() {
    this.d?.dispose();
    this.d = null;
  }
}
