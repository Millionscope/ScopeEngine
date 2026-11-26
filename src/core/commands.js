/**
 * Command registry. Menus, the palette, the keymap and editors all trigger actions by id.
 * @module core/commands
 */
import { toDisposable } from './disposable.js';

/**
 * @typedef {Object} CommandContext
 * @property {string|null} workspaceId
 * @property {string|null} areaId          area under the pointer, else the active area (Blender rule)
 * @property {string|null} activeAreaId
 * @property {string|null} hoverAreaId
 * @property {string|null} editorType
 * @property {any} area                    Area instance (workspace layer) or null
 * @property {any} editor                  mounted editor instance or null
 * @property {string[]} selection
 * @property {Event=} event
 */

/**
 * @typedef {Object} Command
 * @property {string} id
 * @property {string} title
 * @property {string=} category              palette group: 'Area', 'Workspace', 'View', 'Graph', 'Chat', 'Debug'
 * @property {string=} icon                  codicon name
 * @property {string|string[]=} keybinding   e.g. 'ctrl+space' (registered with the keymap)
 * @property {(ctx: CommandContext, ...args:any[]) => any} run
 * @property {(ctx: CommandContext) => boolean=} when      enabled predicate
 * @property {(ctx: CommandContext) => boolean=} checked   toggle state for menus
 * @property {boolean=} hidden               hide from the palette
 */

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Human-readable key label: 'ctrl+shift+p' -> 'Ctrl+Shift+P' (or ⌘⇧P on macOS).
 * @param {string} key
 */
export function formatKey(key) {
  if (!key) return '';
  const names = {
    ctrl: IS_MAC ? '⌘' : 'Ctrl', shift: IS_MAC ? '⇧' : 'Shift', alt: IS_MAC ? '⌥' : 'Alt',
    space: 'Space', escape: 'Esc', enter: 'Enter', left: '←', right: '→', up: '↑', down: '↓',
    pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', delete: 'Del', backspace: '⌫',
  };
  const parts = key.split('+');
  const out = parts.map((p) => names[p] || (p.length === 1 ? p.toUpperCase() : p.toUpperCase()));
  return IS_MAC ? out.join('') : out.join('+');
}

export class CommandRegistry {
  constructor() {
    /** @type {Map<string, Command>} */
    this._cmds = new Map();
    /** @type {() => CommandContext} */
    this._ctxProvider = () => ({
      workspaceId: null, areaId: null, activeAreaId: null, hoverAreaId: null,
      editorType: null, area: null, editor: null, selection: [],
    });
    /** @type {((id:string, args:any[]) => void) | null} */
    this.onRun = null;
    /** @type {((id:string) => string[]) | null} keymap lookup for labels */
    this.keysFor = null;
  }

  /** @param {Command} cmd */
  register(cmd) {
    if (this._cmds.has(cmd.id)) console.warn(`[commands] duplicate command ${cmd.id}`);
    this._cmds.set(cmd.id, cmd);
    return toDisposable(() => {
      if (this._cmds.get(cmd.id) === cmd) this._cmds.delete(cmd.id);
    });
  }

  /** @param {Command[]} cmds */
  registerAll(cmds) {
    const ds = cmds.map((c) => this.register(c));
    return toDisposable(() => ds.forEach((d) => d.dispose()));
  }

  /** @param {string} id */
  get(id) { return this._cmds.get(id) || null; }
  has(id) { return this._cmds.has(id); }

  /** @param {{includeHidden?: boolean}} [opts] */
  list(opts = {}) {
    return [...this._cmds.values()].filter((c) => opts.includeHidden || !c.hidden);
  }

  /** @param {() => CommandContext} fn */
  setContextProvider(fn) { this._ctxProvider = fn; }

  /** @param {Partial<CommandContext>} [extra] @returns {CommandContext} */
  context(extra = {}) {
    return { ...this._ctxProvider(), ...extra };
  }

  /** @param {string} id @param {CommandContext} [ctx] */
  isEnabled(id, ctx) {
    const c = this._cmds.get(id);
    if (!c) return false;
    if (!c.when) return true;
    try { return !!c.when(ctx || this.context()); } catch { return false; }
  }

  /** @param {string} id @param {CommandContext} [ctx] */
  isChecked(id, ctx) {
    const c = this._cmds.get(id);
    if (!c || !c.checked) return false;
    try { return !!c.checked(ctx || this.context()); } catch { return false; }
  }

  /** First keybinding label for menus. @param {string} id */
  keyLabel(id) {
    const keys = this.keysFor ? this.keysFor(id) : [];
    return keys.length ? formatKey(keys[0]) : '';
  }

  /**
   * Run a command with the current context (or ctx overrides via executeWith).
   * @param {string} id @param {...any} args
   */
  execute(id, ...args) {
    return this.executeWith(id, {}, ...args);
  }

  /**
   * @param {string} id @param {Partial<CommandContext>} ctxOverrides @param {...any} args
   */
  executeWith(id, ctxOverrides, ...args) {
    const c = this._cmds.get(id);
    if (!c) {
      console.warn(`[commands] unknown command ${id}`);
      return undefined;
    }
    const ctx = this.context(ctxOverrides);
    if (c.when && !c.when(ctx)) return undefined;
    if (this.onRun) this.onRun(id, args);
    try {
      return c.run(ctx, ...args);
    } catch (err) {
      console.error(`[commands] ${id} failed`, err);
      throw err;
    }
  }
}
