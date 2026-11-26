/**
 * Keybindings. Global shortcuts are resolved against the area under the mouse pointer
 * (Blender convention), falling back to the active area. Focused widgets get first refusal:
 * the keymap listens in the bubble phase and ignores events a widget already handled
 * (defaultPrevented), so list navigation, sliders and text fields keep their keys.
 * @module core/keymap
 */
import { listen, toDisposable } from './disposable.js';

/**
 * @typedef {Object} Binding
 * @property {string} key
 * @property {string} command
 * @property {any[]=} args
 * @property {boolean=} allowInInput   also fire while typing in a text field
 * @property {(ctx: import('./commands.js').CommandContext) => boolean=} when
 */

const CODE_KEYS = {
  Space: 'space', Escape: 'escape', Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  Delete: 'delete', Backspace: 'backspace', NumpadDecimal: '.', Period: '.', Slash: '/',
};

/**
 * Normalize a KeyboardEvent into 'ctrl+alt+shift+key'. Cmd counts as ctrl on macOS.
 * Letters and digits use the physical key (e.code) so Alt/Option combos work on every layout.
 * @param {KeyboardEvent} e
 * @returns {string|null}
 */
export function eventToKey(e) {
  const k = e.key;
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock' || k === 'Dead') return null;
  let base = null;
  let shiftImplied = false;
  if (/^Key[A-Z]$/.test(e.code)) base = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) base = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) base = k.toLowerCase();
  else if (e.code === 'NumpadDecimal') base = '.';
  else if (k && k.length === 1) {
    base = k === ' ' ? 'space' : k.toLowerCase();
    // '?' already encodes shift on most layouts
    if (k !== ' ' && k.toLowerCase() === k.toUpperCase()) shiftImplied = true;
  } else if (CODE_KEYS[e.code]) base = CODE_KEYS[e.code];
  else if (k) base = k.toLowerCase();
  if (!base) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey && !shiftImplied) mods.push('shift');
  return [...mods, base].join('+');
}

/** Canonical order for a binding string. @param {string} key */
export function normalizeKey(key) {
  const parts = key.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const order = ['ctrl', 'alt', 'shift'];
  const mods = order.filter((m) => parts.includes(m));
  const rest = parts.filter((p) => !order.includes(p));
  return [...mods, ...rest].join('+');
}

/** @param {EventTarget|null} t */
export function isTypingTarget(t) {
  const el = /** @type {HTMLElement|null} */ (t);
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (/** @type {HTMLInputElement} */ (el)).type;
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(type);
  }
  return false;
}

export class Keymap {
  /** @param {import('./commands.js').CommandRegistry} commands */
  constructor(commands) {
    this.commands = commands;
    /** @type {Map<string, Binding[]>} */
    this._map = new Map();
    this.enabled = true;
    commands.keysFor = (id) => this.keysFor(id);
  }

  /**
   * @param {string} key
   * @param {string} command
   * @param {Omit<Binding,'key'|'command'>} [opts]
   */
  bind(key, command, opts = {}) {
    const k = normalizeKey(key);
    const b = /** @type {Binding} */ ({ key: k, command, ...opts });
    const arr = this._map.get(k) || [];
    arr.push(b);
    this._map.set(k, arr);
    return toDisposable(() => {
      const list = this._map.get(k);
      if (!list) return;
      const i = list.indexOf(b);
      if (i >= 0) list.splice(i, 1);
    });
  }

  /** @param {string} commandId @returns {string[]} */
  keysFor(commandId) {
    const out = [];
    for (const [k, list] of this._map) if (list.some((b) => b.command === commandId)) out.push(k);
    return out;
  }

  /** All bindings (for the shortcuts overlay). */
  all() {
    const out = [];
    for (const list of this._map.values()) out.push(...list);
    return out;
  }

  /** @param {Window} win */
  attach(win) {
    return listen(win, 'keydown', (e) => this._onKey(/** @type {KeyboardEvent} */ (e)));
  }

  /** @param {KeyboardEvent} e */
  _onKey(e) {
    if (!this.enabled || e.defaultPrevented || e.isComposing) return;
    const key = eventToKey(e);
    if (!key) return;
    const list = this._map.get(key);
    if (!list || !list.length) return;
    const typing = isTypingTarget(e.target);
    const ctx = this.commands.context({ event: e });
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (typing && !b.allowInInput) continue;
      if (b.when && !b.when(ctx)) continue;
      if (!this.commands.isEnabled(b.command, ctx)) continue;
      e.preventDefault();
      e.stopPropagation();
      this.commands.executeWith(b.command, { event: e }, ...(b.args || []));
      return;
    }
  }
}
