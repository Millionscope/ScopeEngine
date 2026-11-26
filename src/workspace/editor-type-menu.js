/**
 * Blender-style editor-type menu: a popover grid with one column per group, each item an icon,
 * a label and a shortcut hint. Type-ahead search at the top; arrow keys move in 2-D; Enter
 * picks; Esc closes and returns focus to the opener.
 * @module workspace/editor-type-menu
 */
import { DisposableStore, listen } from '../core/disposable.js';
import { byGroup } from '../editors/registry.js';
import { formatKey } from '../core/commands.js';

/**
 * @param {{
 *   anchor: HTMLElement,
 *   current: string,
 *   onPick: (type: string) => void,
 *   onClose?: () => void,
 * }} opts
 * @returns {{ close: () => void, el: HTMLElement }}
 */
export function openEditorTypeMenu({ anchor, current, onPick, onClose }) {
  const d = new DisposableStore();
  const root = document.createElement('div');
  root.className = 'ms-etm';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Editor type');

  const search = document.createElement('input');
  search.className = 'ms-input ms-etm-search';
  search.type = 'search';
  search.placeholder = 'Search editor types…';
  search.setAttribute('aria-label', 'Search editor types');
  root.appendChild(search);

  const grid = document.createElement('div');
  grid.className = 'ms-etm-grid';
  grid.setAttribute('role', 'menu');
  root.appendChild(grid);

  /** @type {HTMLElement[][]} */
  const columns = [];
  for (const { group, items } of byGroup()) {
    const col = document.createElement('div');
    col.className = 'ms-etm-col';
    col.setAttribute('role', 'group');
    col.setAttribute('aria-label', group);
    const head = document.createElement('div');
    head.className = 'ms-etm-group';
    head.textContent = group;
    col.appendChild(head);
    /** @type {HTMLElement[]} */
    const colItems = [];
    for (const entry of items) {
      const it = document.createElement('div');
      it.className = 'ms-etm-item' + (entry.id === current ? ' is-current' : '');
      it.setAttribute('role', 'menuitemradio');
      it.setAttribute('aria-checked', String(entry.id === current));
      it.tabIndex = -1;
      it.dataset.type = entry.id;
      it.dataset.label = entry.label.toLowerCase();
      const icon = document.createElement('span');
      icon.className = `codicon codicon-${entry.icon}`;
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'ms-etm-label';
      label.textContent = entry.label;
      it.append(icon, label);
      if (entry.shortcut) {
        const key = document.createElement('span');
        key.className = 'ms-etm-key';
        key.textContent = formatKey(entry.shortcut);
        it.appendChild(key);
        it.setAttribute('aria-keyshortcuts', entry.shortcut.replace(/\+/g, '+'));
      }
      d.add(listen(it, 'click', () => pick(entry.id)));
      d.add(listen(it, 'pointermove', () => focusItem(it)));
      col.appendChild(it);
      colItems.push(it);
    }
    columns.push(colItems);
    grid.appendChild(col);
  }

  const overlay = document.getElementById('overlay-root') || document.body;
  overlay.appendChild(root);

  // position below the anchor, flip above if needed, clamp to viewport
  const ar = anchor.getBoundingClientRect();
  const mr = root.getBoundingClientRect();
  let left = Math.min(Math.max(8, ar.left), window.innerWidth - mr.width - 8);
  let top = ar.bottom + 2;
  if (top + mr.height > window.innerHeight - 8) top = Math.max(8, ar.top - mr.height - 2);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const visible = (it) => !it.classList.contains('is-filtered');
  /** @type {HTMLElement|null} */
  let focused = null;
  const focusItem = (it) => {
    if (!it) return;
    focused?.classList.remove('is-focused');
    focused = it;
    it.classList.add('is-focused');
    it.focus({ preventScroll: true });
  };
  const pos = (it) => {
    for (let c = 0; c < columns.length; c++) {
      const r = columns[c].indexOf(it);
      if (r >= 0) return { c, r };
    }
    return { c: 0, r: 0 };
  };
  const flat = () => columns.flat().filter(visible);

  const move = (dc, dr) => {
    const items = flat();
    if (!items.length) return;
    if (!focused || !visible(focused)) return focusItem(items[0]);
    const { c, r } = pos(focused);
    if (dr !== 0) {
      const order = items;
      const i = order.indexOf(focused);
      return focusItem(order[(i + dr + order.length) % order.length]);
    }
    for (let step = 1; step <= columns.length; step++) {
      const nc = (c + dc * step + columns.length * 4) % columns.length;
      const col = columns[nc].filter(visible);
      if (col.length) return focusItem(col[Math.min(r, col.length - 1)]);
    }
  };

  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    for (const it of columns.flat()) {
      const match = !q || it.dataset.label.includes(q) || it.dataset.type.includes(q);
      it.classList.toggle('is-filtered', !match);
    }
    const first = flat()[0];
    if (first) {
      focused?.classList.remove('is-focused');
      focused = first;
      first.classList.add('is-focused');
    }
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    d.dispose();
    root.remove();
    anchor.setAttribute('aria-expanded', 'false');
    onClose?.();
  };
  const pick = (type) => {
    close();
    anchor.focus({ preventScroll: true });
    onPick(type);
  };

  d.add(listen(search, 'input', applyFilter));
  d.add(listen(root, 'keydown', (ev) => {
    const e = /** @type {KeyboardEvent} */ (ev);
    const inSearch = e.target === search;
    switch (e.key) {
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); anchor.focus({ preventScroll: true }); return;
      case 'ArrowDown': e.preventDefault(); move(0, 1); return;
      case 'ArrowUp': e.preventDefault(); move(0, -1); return;
      case 'ArrowRight': if (!inSearch) { e.preventDefault(); move(1, 0); } return;
      case 'ArrowLeft': if (!inSearch) { e.preventDefault(); move(-1, 0); } return;
      case 'Home': if (!inSearch) { e.preventDefault(); focusItem(flat()[0]); } return;
      case 'End': if (!inSearch) { e.preventDefault(); const f = flat(); focusItem(f[f.length - 1]); } return;
      case 'Enter':
      case ' ':
        if (e.key === ' ' && inSearch) return;
        e.preventDefault();
        if (focused && visible(focused)) pick(/** @type {string} */ (focused.dataset.type));
        else if (flat()[0]) pick(/** @type {string} */ (flat()[0].dataset.type));
        return;
      case 'Tab': e.preventDefault(); (inSearch ? focusItem(focused || flat()[0]) : search.focus()); return;
      default:
        if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          search.focus();
        }
    }
    e.stopPropagation();
  }));
  // outside click closes
  setTimeout(() => {
    if (closed) return;
    d.add(listen(window, 'pointerdown', (e) => {
      if (!root.contains(/** @type {Node} */ (e.target)) && e.target !== anchor) close();
    }, true));
    d.add(listen(window, 'blur', close));
    d.add(listen(window, 'resize', close));
  }, 0);

  const cur = columns.flat().find((it) => it.dataset.type === current) || columns.flat()[0];
  focusItem(cur);
  return { close, el: root };
}
