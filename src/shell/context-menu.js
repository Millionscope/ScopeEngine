/**
 * Generic menu widget (WAI-ARIA menu pattern): context menus, header menus, the area menu and
 * top-bar menus. Injected into lower layers as `ui.showMenu(items, anchor, opts)`.
 * Keyboard: Up/Down (skips disabled), Home/End, Enter/Space, Right opens a submenu, Left/Esc
 * closes it, letters jump by first character. Focus returns to the opener on close.
 * @module shell/context-menu
 */
import { DisposableStore, listen } from '../core/disposable.js';

/** @typedef {import('../workspace/area-menu.js').MenuItem & {command?: string, args?: any[]}} MenuItem */

export class MenuService {
  /** @param {{commands: import('../core/commands.js').CommandRegistry}} deps */
  constructor({ commands }) {
    this.commands = commands;
    /** @type {null | {close: () => void}} */
    this.root = null;
  }

  /**
   * Resolve command-backed items (label/key/checked/disabled from the command registry).
   * @param {MenuItem[]} items
   */
  _resolve(items) {
    const ctx = this.commands.context();
    return items.map((it) => {
      if (!it.command) return it;
      const cmd = this.commands.get(it.command);
      if (!cmd) return { ...it, disabled: true };
      return {
        ...it,
        label: it.label || cmd.title,
        icon: it.icon ?? cmd.icon,
        key: it.key ?? this.commands.keyLabel(it.command),
        checked: it.checked ?? (cmd.checked ? this.commands.isChecked(it.command, ctx) : undefined),
        disabled: it.disabled ?? !this.commands.isEnabled(it.command, ctx),
        run: it.run || (() => this.commands.execute(/** @type {string} */ (it.command), ...(it.args || []))),
      };
    });
  }

  /**
   * @param {MenuItem[]} items
   * @param {HTMLElement | {x:number, y:number}} anchor
   * @param {{label?: string, onClose?: () => void, submenuOf?: HTMLElement, parent?: any, minWidth?: number}} [opts]
   */
  show(items, anchor, opts = {}) {
    if (!opts.parent) this.root?.close();
    const d = new DisposableStore();
    const opener = /** @type {HTMLElement|null} */ (document.activeElement);
    const menu = document.createElement('div');
    menu.className = 'ms-menu';
    menu.setAttribute('role', 'menu');
    if (opts.label) menu.setAttribute('aria-label', opts.label);
    if (opts.minWidth) menu.style.minWidth = `${opts.minWidth}px`;
    const resolved = this._resolve(items);
    /** @type {HTMLElement[]} */
    const focusables = [];
    /** @type {null | {close: () => void}} */
    let child = null;
    let closed = false;

    const handle = {
      el: menu,
      close: () => {
        if (closed) return;
        closed = true;
        child?.close();
        d.dispose();
        menu.remove();
        if (!opts.parent) {
          if (this.root === handle) this.root = null;
          if (opener && opener.isConnected && !opts.submenuOf) opener.focus({ preventScroll: true });
        }
        opts.onClose?.();
      },
      closeAll: () => {
        if (opts.parent) opts.parent.closeAll();
        else handle.close();
      },
    };

    for (const it of resolved) {
      if (it.separator) {
        const s = document.createElement('div');
        s.className = 'ms-menu-sep';
        s.setAttribute('role', 'separator');
        menu.appendChild(s);
        continue;
      }
      if (it.header) {
        const h = document.createElement('div');
        h.className = 'ms-menu-header';
        h.setAttribute('role', 'presentation');
        h.textContent = it.header;
        menu.appendChild(h);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'ms-menu-item';
      row.tabIndex = -1;
      const hasSub = !!it.submenu;
      row.setAttribute('role', it.checked !== undefined && !hasSub ? 'menuitemcheckbox' : 'menuitem');
      if (it.checked !== undefined && !hasSub) row.setAttribute('aria-checked', String(!!it.checked));
      if (it.disabled) row.setAttribute('aria-disabled', 'true');
      if (it.title) row.title = it.title;
      if (hasSub) row.setAttribute('aria-haspopup', 'menu');
      const check = document.createElement('span');
      check.className = 'ms-menu-check';
      if (it.checked) check.innerHTML = '<span class="codicon codicon-check" aria-hidden="true"></span>';
      else if (it.icon) check.innerHTML = `<span class="codicon codicon-${it.icon}" aria-hidden="true"></span>`;
      const label = document.createElement('span');
      label.className = 'ms-menu-label';
      label.textContent = it.label || '';
      row.append(check, label);
      if (it.key) {
        const k = document.createElement('span');
        k.className = 'ms-menu-key';
        k.textContent = it.key;
        row.appendChild(k);
      }
      if (hasSub) {
        const c = document.createElement('span');
        c.className = 'codicon codicon-chevron-right ms-menu-sub';
        c.setAttribute('aria-hidden', 'true');
        row.appendChild(c);
      }
      const openSub = () => {
        if (it.disabled || !hasSub) return;
        child?.close();
        const subItems = typeof it.submenu === 'function' ? it.submenu() : /** @type {MenuItem[]} */ (it.submenu);
        if (!subItems.length) return;
        row.setAttribute('aria-expanded', 'true');
        child = this.show(subItems, row, { parent: handle, submenuOf: row, label: it.label, onClose: () => row.setAttribute('aria-expanded', 'false') });
      };
      const activate = () => {
        if (it.disabled) return;
        if (hasSub) { openSub(); return; }
        handle.closeAll();
        try { it.run?.(); } catch (err) { console.error('[menu] action failed', err); }
      };
      d.add(listen(row, 'click', (e) => { e.stopPropagation(); activate(); }));
      d.add(listen(row, 'pointerenter', () => {
        row.focus({ preventScroll: true });
        if (hasSub) openSub();
        else child?.close();
      }));
      /** @type {any} */ (row)._activate = activate;
      /** @type {any} */ (row)._openSub = openSub;
      menu.appendChild(row);
      focusables.push(row);
    }

    const overlay = document.getElementById('overlay-root') || document.body;
    overlay.appendChild(menu);
    this._position(menu, anchor, !!opts.submenuOf);

    const enabled = () => focusables.filter((f) => f.getAttribute('aria-disabled') !== 'true');
    const focusAt = (i) => {
      const list = enabled();
      if (!list.length) return;
      list[(i + list.length) % list.length].focus({ preventScroll: true });
    };
    const current = () => enabled().indexOf(/** @type {HTMLElement} */ (document.activeElement));

    d.add(listen(menu, 'keydown', (ev) => {
      const e = /** @type {KeyboardEvent} */ (ev);
      const cur = /** @type {any} */ (document.activeElement);
      switch (e.key) {
        case 'ArrowDown': focusAt(current() + 1); break;
        case 'ArrowUp': focusAt(current() < 0 ? -1 : current() - 1); break;
        case 'Home': focusAt(0); break;
        case 'End': focusAt(-1); break;
        case 'Enter': case ' ': cur?._activate?.(); break;
        case 'ArrowRight': cur?._openSub?.(); break;
        case 'ArrowLeft':
          if (opts.parent) { handle.close(); opts.submenuOf?.focus({ preventScroll: true }); }
          break;
        case 'Escape':
          handle.close();
          if (opts.submenuOf) opts.submenuOf.focus({ preventScroll: true });
          break;
        case 'Tab': handle.closeAll(); break;
        default:
          if (e.key.length === 1 && /\S/.test(e.key)) {
            const list = enabled();
            const start = current() + 1;
            for (let k = 0; k < list.length; k++) {
              const el = list[(start + k) % list.length];
              if ((el.textContent || '').trim().toLowerCase().startsWith(e.key.toLowerCase())) { el.focus(); break; }
            }
          } else return;
      }
      e.preventDefault();
      e.stopPropagation();
    }));

    if (!opts.parent) {
      this.root = handle;
      setTimeout(() => {
        if (closed) return;
        d.add(listen(window, 'pointerdown', (e) => {
          const t = /** @type {Node} */ (e.target);
          if (t instanceof Element && t.closest('.ms-menu')) return;
          handle.close();
        }, true));
        d.add(listen(window, 'blur', () => handle.close()));
        d.add(listen(window, 'resize', () => handle.close()));
      }, 0);
    }
    requestAnimationFrame(() => { if (!closed) focusAt(0); });
    return handle;
  }

  /**
   * @param {HTMLElement} menu @param {HTMLElement|{x:number,y:number}} anchor @param {boolean} isSub
   */
  _position(menu, anchor, isSub) {
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let x;
    let y;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      if (isSub) {
        x = r.right + 2;
        y = r.top - 4;
        if (x + mw > window.innerWidth - 4) x = r.left - mw - 2;
      } else {
        x = r.left;
        y = r.bottom + 2;
        if (y + mh > window.innerHeight - 4) y = r.top - mh - 2;
      }
    } else {
      x = anchor.x;
      y = anchor.y;
      if (y + mh > window.innerHeight - 4) y = Math.max(4, y - mh);
    }
    x = Math.max(4, Math.min(x, window.innerWidth - mw - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - mh - 4));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }
}
