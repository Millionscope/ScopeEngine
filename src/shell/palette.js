/**
 * Command palette (F3 / Ctrl+Shift+P) and quick open (Ctrl+P).
 * Sources: commands, editor types (switch the target area), workspaces, scopes and metrics.
 * Prefixes: ">" commands only, "@" scopes only. Fuzzy subsequence matching with highlights.
 * @module shell/palette
 */
import { DisposableStore, listen } from '../core/disposable.js';
import { formatKey } from '../core/commands.js';
import { listEditors } from '../editors/registry.js';
import { provGlyph } from '../theme/tokens.js';

/**
 * @typedef {Object} PaletteItem
 * @property {string} group
 * @property {string} label
 * @property {string=} detail
 * @property {string=} icon
 * @property {string=} key
 * @property {string=} glyph
 * @property {string=} prov
 * @property {() => void} run
 * @property {number=} score
 * @property {number[]=} hits
 */

/**
 * Fuzzy subsequence score (higher is better) and matched indices; null if no match.
 * @param {string} query @param {string} text
 * @returns {{score:number, hits:number[]}|null}
 */
export function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const hits = Array.from({ length: q.length }, (_, i) => direct + i);
    const wordStart = direct === 0 || /[\s.:_\-/(]/.test(t[direct - 1]);
    return { score: 1000 - direct * 2 + (wordStart ? 200 : 0) - t.length * 0.1, hits };
  }
  const hits = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    hits.push(found);
    score += found === prev + 1 ? 15 : 1;
    if (found === 0 || /[\s.:_\-/(]/.test(t[found - 1])) score += 10;
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.1, hits };
}

/** @param {string} text @param {number[]} hits */
function highlight(text, hits) {
  const frag = document.createDocumentFragment();
  const set = new Set(hits);
  let buf = '';
  let inHit = false;
  const flush = () => {
    if (!buf) return;
    if (inHit) {
      const m = document.createElement('mark');
      m.textContent = buf;
      frag.appendChild(m);
    } else frag.appendChild(document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== inHit) { flush(); inHit = h; }
    buf += text[i];
  }
  flush();
  return frag;
}

export class Palette {
  /**
   * @param {{ env: any, ws: import('../workspace/workspaces.js').WorkspaceManager }} deps
   */
  constructor({ env, ws }) {
    this.env = env;
    this.ws = ws;
    this.commands = env.commands;
    /** @type {DisposableStore|null} */
    this.d = null;
    this.isOpen = false;
    /** @type {string[]} recently run command ids */
    this.recent = [];
  }

  /** @param {'all'|'scopes'|'commands'} [mode] @param {string} [initial] */
  open(mode = 'all', initial = '') {
    this.close();
    this.isOpen = true;
    const d = (this.d = new DisposableStore());
    this.prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    this.target = this.ws.targetArea();

    const scrim = document.createElement('div');
    scrim.className = 'ms-palette-scrim';
    const box = document.createElement('div');
    box.className = 'ms-palette';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', mode === 'scopes' ? 'Quick open scope' : 'Command palette');
    const row = document.createElement('div');
    row.className = 'ms-palette-input-row';
    const input = document.createElement('input');
    input.className = 'ms-input ms-palette-input';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'ms-palette-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.placeholder = mode === 'scopes'
      ? 'Go to scope or metric by name, prototype or unit'
      : 'Type a command, editor type, workspace, or @scope';
    input.value = initial || (mode === 'commands' ? '>' : '');
    row.appendChild(input);
    const list = document.createElement('div');
    list.className = 'ms-palette-list';
    list.id = 'ms-palette-list';
    list.setAttribute('role', 'listbox');
    box.append(row, list);
    const overlay = document.getElementById('overlay-root') || document.body;
    overlay.append(scrim, box);
    this.box = box;
    this.scrim = scrim;

    /** @type {PaletteItem[]} */
    let items = [];
    let index = 0;

    const render = () => {
      const raw = input.value;
      items = this.query(raw, mode);
      index = Math.min(index, Math.max(0, items.length - 1));
      list.replaceChildren();
      if (!items.length) {
        const e = document.createElement('div');
        e.className = 'ms-palette-empty';
        e.textContent = 'No matching results';
        list.appendChild(e);
        input.removeAttribute('aria-activedescendant');
        return;
      }
      let lastGroup = '';
      items.forEach((it, i) => {
        if (it.group !== lastGroup) {
          lastGroup = it.group;
          const g = document.createElement('div');
          g.className = 'ms-palette-group';
          g.setAttribute('role', 'presentation');
          g.textContent = it.group;
          list.appendChild(g);
        }
        const r = document.createElement('div');
        r.className = 'ms-palette-item';
        r.id = `ms-pal-${i}`;
        r.setAttribute('role', 'option');
        r.setAttribute('aria-selected', String(i === index));
        if (it.glyph) {
          const gl = document.createElement('span');
          gl.className = 'ms-prov';
          gl.dataset.prov = it.prov || 'computed';
          gl.textContent = it.glyph;
          gl.setAttribute('aria-label', it.prov || '');
          r.appendChild(gl);
        } else {
          const ic = document.createElement('span');
          ic.className = `codicon codicon-${it.icon || 'symbol-misc'}`;
          ic.setAttribute('aria-hidden', 'true');
          r.appendChild(ic);
        }
        const l = document.createElement('span');
        l.className = 'ms-pal-label';
        l.appendChild(highlight(it.label, it.hits || []));
        r.appendChild(l);
        const det = document.createElement('span');
        det.className = 'ms-pal-detail';
        det.textContent = it.detail || '';
        r.appendChild(det);
        if (it.key) {
          const k = document.createElement('span');
          k.className = 'ms-kbd';
          k.textContent = it.key;
          r.appendChild(k);
        }
        r.addEventListener('pointerdown', (e) => { e.preventDefault(); index = i; accept(); });
        r.addEventListener('pointermove', () => {
          if (index === i) return;
          list.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
          r.setAttribute('aria-selected', 'true');
          index = i;
        });
        list.appendChild(r);
      });
      input.setAttribute('aria-activedescendant', `ms-pal-${index}`);
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    };

    const accept = () => {
      const it = items[index];
      if (!it) return;
      this.close(false);
      try { it.run(); } catch (err) { console.error('[palette]', err); }
    };

    d.add(listen(input, 'input', () => { index = 0; render(); }));
    d.add(listen(input, 'keydown', (ev) => {
      const e = /** @type {KeyboardEvent} */ (ev);
      if (e.key === 'ArrowDown') { index = (index + 1) % Math.max(1, items.length); render(); }
      else if (e.key === 'ArrowUp') { index = (index - 1 + items.length) % Math.max(1, items.length); render(); }
      else if (e.key === 'PageDown') { index = Math.min(items.length - 1, index + 10); render(); }
      else if (e.key === 'PageUp') { index = Math.max(0, index - 10); render(); }
      else if (e.key === 'Enter') accept();
      else if (e.key === 'Escape') this.close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    }));
    d.add(listen(scrim, 'pointerdown', () => this.close()));
    render();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /**
   * @param {string} raw @param {'all'|'scopes'|'commands'} mode
   * @returns {PaletteItem[]}
   */
  query(raw, mode) {
    let q = raw.trim();
    let only = mode;
    if (q.startsWith('>')) { only = 'commands'; q = q.slice(1).trim(); }
    else if (q.startsWith('@')) { only = 'scopes'; q = q.slice(1).trim(); }
    /** @type {PaletteItem[]} */
    let out = [];
    const ctx = this.commands.context();

    if (only === 'all' || only === 'commands') {
      for (const c of this.commands.list()) {
        if (!this.commands.isEnabled(c.id, ctx)) continue;
        out.push({
          group: 'Commands',
          label: c.category ? `${c.category}: ${c.title}` : c.title,
          icon: c.icon || 'symbol-event',
          key: this.commands.keyLabel(c.id),
          run: () => { this._remember(c.id); this.commands.executeWith(c.id, { areaId: this.target?.id || ctx.areaId, area: this.target || ctx.area }); },
          recent: this.recent.indexOf(c.id),
        });
      }
    }
    if (only === 'all') {
      for (const e of listEditors()) {
        out.push({
          group: 'Editor types',
          label: `Switch area to ${e.label}`,
          detail: this.target ? `replaces the ${this._label(this.target.leaf.editorType)} area` : '',
          icon: e.icon,
          key: e.shortcut ? formatKey(e.shortcut) : '',
          run: () => { if (this.target) this.ws.setAreaType(this.target.id, e.id); },
        });
      }
      for (const w of this.ws.workspaces) {
        out.push({ group: 'Workspaces', label: `Go to workspace ${w.name}`, icon: w.icon, run: () => this.ws.switchTo(w.id) });
      }
    }
    const gq = this.env.services.graphQuery;
    if ((only === 'all' || only === 'scopes') && gq && (q || only === 'scopes')) {
      for (const r of gq.search(q, { limit: only === 'scopes' ? 50 : 12 })) {
        out.push({
          group: 'Scopes and metrics',
          label: r.path,
          detail: `${r.kindLabel || r.prov || ''}${r.valueText ? ` · ${r.valueText}` : ''}${r.unit ? ` ${r.unit}` : ''}${r.proto ? ` · ${r.proto}` : ''}`,
          glyph: r.prov ? provGlyph(r.prov) : undefined,
          prov: r.prov,
          icon: r.isScope ? 'symbol-class' : 'symbol-field',
          run: () => {
            this.env.services.selection?.select([r.id], { source: 'palette' });
            this.commands.execute('view.reveal', r.isScope ? 'outliner' : 'inspector', r.id, { quiet: true });
          },
          preScored: r.score,
        });
      }
    }

    if (q) {
      const scored = [];
      for (const it of out) {
        if (it.preScored != null) { scored.push({ ...it, score: it.preScored, hits: fuzzy(q, it.label)?.hits || [] }); continue; }
        const m = fuzzy(q, it.label);
        if (m) scored.push({ ...it, score: m.score, hits: m.hits });
      }
      const groupOrder = { Commands: 0, 'Scopes and metrics': 1, 'Editor types': 2, Workspaces: 3 };
      scored.sort((a, b) => (b.score - a.score) || (groupOrder[a.group] - groupOrder[b.group]));
      // regroup while keeping best-first within groups
      const groups = new Map();
      for (const it of scored) {
        if (!groups.has(it.group)) groups.set(it.group, []);
        groups.get(it.group).push(it);
      }
      out = [...groups.values()].flat().slice(0, 80);
    } else {
      out.sort((a, b) => {
        const ra = a.recent ?? -1;
        const rb = b.recent ?? -1;
        if (a.group === b.group && (ra >= 0 || rb >= 0)) return (rb >= 0 ? rb : -1) - (ra >= 0 ? ra : -1);
        return 0;
      });
      out = out.slice(0, 120);
    }
    return out;
  }

  /** @param {string} id */
  _remember(id) {
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, 8);
  }

  /** @param {string} type */
  _label(type) {
    return listEditors().find((e) => e.id === type)?.label || type;
  }

  /** @param {boolean} [restoreFocus] */
  close(restoreFocus = true) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.d?.dispose();
    this.d = null;
    this.box?.remove();
    this.scrim?.remove();
    if (restoreFocus && this.prevFocus?.isConnected) this.prevFocus.focus({ preventScroll: true });
  }
}
