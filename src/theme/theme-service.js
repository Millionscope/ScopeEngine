/**
 * Applies a VS Code theme as CSS custom properties (exactly like VS Code webviews:
 * '.' -> '-', prefix --vscode-), adds MillionScope semantic tokens (--ms-*), and switches
 * dark / light / auto without reloading or losing state. Emits theme:changed.
 * @module theme/theme-service
 */
import { loadTheme } from './theme-loader.js';
import { cssVarName, invalidateTokenCache } from './tokens.js';
import { log } from '../core/log.js';

/** @typedef {'dark'|'light'|'auto'} ThemeMode */
/** @typedef {import('./theme-loader.js').LoadedTheme} LoadedTheme */

const STORAGE_KEY = 'millionscope.theme';

export class ThemeService {
  /** @param {import('../core/events.js').EventBus} events */
  constructor(events) {
    this.events = events;
    /** @type {ThemeMode} */
    this.mode = 'auto';
    /** @type {'dark'|'light'} */
    this.kind = 'dark';
    /** @type {LoadedTheme|null} */
    this.current = null;
    /** @type {Map<string, Promise<LoadedTheme>>} */
    this._cache = new Map();
    this._mql = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    this._onSystem = () => {
      if (this.mode === 'auto') this._applyKind(this._systemKind());
    };
    this._mql?.addEventListener('change', this._onSystem);
  }

  _systemKind() {
    return this._mql && !this._mql.matches ? 'light' : 'dark';
  }

  /** @param {'dark'|'light'} kind */
  _load(kind) {
    let p = this._cache.get(kind);
    if (!p) {
      p = loadTheme(kind);
      this._cache.set(kind, p);
      p.catch(() => this._cache.delete(kind));
    }
    return p;
  }

  /** Load the persisted (or given) mode and apply it. @param {ThemeMode} [mode] */
  async init(mode) {
    let m = mode;
    if (!m) {
      try { m = /** @type {ThemeMode} */ (localStorage.getItem(STORAGE_KEY)) || 'auto'; } catch { m = 'auto'; }
    }
    if (!['dark', 'light', 'auto'].includes(m)) m = 'auto';
    this.mode = m;
    await this._applyKind(m === 'auto' ? this._systemKind() : m);
    // warm the other theme so toggling is instant
    setTimeout(() => this._load(this.kind === 'dark' ? 'light' : 'dark').catch(() => {}), 1500);
  }

  /** @param {ThemeMode} mode */
  async setMode(mode) {
    this.mode = mode;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* private mode */ }
    await this._applyKind(mode === 'auto' ? this._systemKind() : mode);
  }

  /** Toggle between explicit dark and light. */
  toggle() {
    return this.setMode(this.kind === 'dark' ? 'light' : 'dark');
  }

  /** Cycle dark -> light -> auto -> dark. */
  cycle() {
    const next = this.mode === 'dark' ? 'light' : this.mode === 'light' ? 'auto' : 'dark';
    return this.setMode(next);
  }

  /** @param {'dark'|'light'} kind */
  async _applyKind(kind) {
    let theme;
    try {
      theme = await this._load(kind);
    } catch (err) {
      log.error('theme', `could not load ${kind} theme: ${err.message}`, { hint: 'serve the folder over HTTP (npx serve .) so themes/*.json can be fetched' });
      throw err;
    }
    this.current = theme;
    this.kind = kind;
    this._write(theme);
    invalidateTokenCache();
    log.info('theme', `applied ${theme.name} (${theme.themeKeys.length} theme keys, ${theme.fallbackKeys.length} fallbacks)`);
    this.events.emit('theme:changed', { kind, mode: this.mode, colors: theme.colors, name: theme.name });
  }

  /** @param {LoadedTheme} theme */
  _write(theme) {
    const lines = [];
    for (const [key, value] of Object.entries(theme.colors)) lines.push(`  ${cssVarName(key)}: ${value};`);
    for (const [prop, value] of Object.entries(theme.semantic)) lines.push(`  ${prop}: ${value};`);
    const css = `:root {\n  color-scheme: ${theme.kind};\n${lines.join('\n')}\n}\n`;
    let style = /** @type {HTMLStyleElement|null} */ (document.getElementById('theme-vars'));
    if (!style) {
      style = document.createElement('style');
      style.id = 'theme-vars';
      document.head.appendChild(style);
    }
    style.textContent = css;
    const root = document.documentElement;
    root.dataset.theme = theme.kind;
    root.style.colorScheme = theme.kind;
    document.getElementById('boot-style')?.remove();
  }

  /** Merged color for a VS Code key. @param {string} key */
  color(key) {
    return this.current?.colors[key] ?? '';
  }

  /** Label for UI: 'Dark', 'Light', 'Auto (Dark)'. */
  label() {
    const k = this.kind === 'dark' ? 'Dark' : 'Light';
    return this.mode === 'auto' ? `Auto (${k})` : k;
  }

  /** @param {(p:any) => void} fn */
  onChange(fn) {
    return this.events.on('theme:changed', fn);
  }

  dispose() {
    this._mql?.removeEventListener('change', this._onSystem);
  }
}
