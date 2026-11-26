/**
 * ScopeLang editor: the live graph as ScopeLang source (read-only), with line numbers, a
 * diagnostics gutter and folding of scope blocks. Clicking a declaration selects its scope or
 * metric; selecting one elsewhere reveals and highlights its line (unfolding as needed).
 * Header tools: "Live graph" / "Spec snippet" (the canonical example, matched to live metrics
 * by name) and "IR" (pretty Scope IR of the selected node). The N region lists problems.
 *
 * Large sources (stress graphs) render only a window of lines around the viewport.
 *
 * CodeMirror 6 seam: everything this view needs is the compiler service's text, its
 * line <-> id maps and diagnostics. Replacing the shared codeView with a CodeMirror
 * EditorView (a ScopeLang language mode, a lint gutter fed by compiler.diagnostics(), a
 * foldService over scope blocks, an update listener mapping the cursor line to
 * compiler.idAt() for selection, and a dispatch({selection}) for reveal) keeps this editor's
 * API and events unchanged; editing would then send deltas through the compiler.
 * @module editors/scopelang
 */
import { BaseEditor } from '../base-editor.js';
import { codeView } from '../shared/code-view.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { timeout } from '../../core/disposable.js';
import { foldRanges, visibleLines, indexOfSorted, floorIndex, snippetMap } from './view.js';

const ROW_H = 18; // .ms-code-line height in px
const PAD = 8; // .ms-code vertical padding in px
const WINDOW_AT = 2500; // above this many visible lines only a window is rendered
const OVERSCAN = 80; // extra rows rendered above and below the viewport
const DEBOUNCE_MS = 250;

/**
 * @typedef {Object} Doc
 * @property {string} key
 * @property {'live'|'snippet'} mode
 * @property {any=} compiled
 * @property {string[]} lines
 * @property {Map<number, string>} idAt
 * @property {Map<string, number>} lineOf
 * @property {Map<number, number>} ends
 * @property {Array<{line: number, severity: 'error'|'warning'|'info', message: string, nodeId?: string}>} diags
 * @property {string} diagSig
 */

/** @param {string} cls @param {string} [tag] */
function el(cls, tag = 'div') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export default class ScopeLangEditor extends BaseEditor {
  static id = 'scopelang';
  static label = 'ScopeLang';
  static icon = 'code';
  static group = 'Verify & Source';

  async mount(ctx, state) {
    await loadCss(new URL('./scopelang.css', import.meta.url));
    this.compiler = ctx.services.compiler;
    this.state = {
      mode: /** @type {'live'|'snippet'} */ (state.mode === 'snippet' ? 'snippet' : 'live'),
      showIR: !!state.showIR,
      /** folded scope ids (live) */
      folded: Array.isArray(state.folded) ? state.folded.filter((x) => typeof x === 'string') : [],
      /** folded block start lines (snippet) */
      foldedSnippet: Array.isArray(state.foldedSnippet) ? state.foldedSnippet.filter((x) => Number.isInteger(x)) : [],
    };
    const sel = ctx.services.selection.get();
    this.selected = new Set(sel.selected);
    /** @type {string|null} */
    this.primary = sel.primary;
    /** @type {string|null} */
    this.hovered = null;
    /** active (cursor) line, original numbering @type {number|null} */
    this.active = null;
    /** @type {{id?: string, line?: number, center: boolean}|null} */
    this.pendingReveal = sel.primary ? { id: sel.primary, center: true } : null;
    /** @type {Doc|null} */
    this.doc = null;
    /** @type {{visible: number[], windowed: boolean, from: number, to: number, foldSig: string, docKey: string, diagSig: string}|null} */
    this.view = null;
    this._seq = 0;
    /** @type {import('../../core/disposable.js').Disposable|null} */
    this._soon = null;
    this._irKey = '';
    this._sidebarSig = null;
    this.disposables.add({ dispose: () => this._soon?.dispose() });

    // DOM
    this.root = el('ms-ed ms-scopelang');
    this.banner = el('ms-sl-banner');
    this.banner.hidden = true;
    this.banner.setAttribute('role', 'note');
    const body = el('ms-sl-body');
    this.codeEl = el('ms-sl-code');
    this.codeEl.tabIndex = 0;
    this.codeEl.setAttribute('role', 'region');
    this.codeEl.setAttribute('aria-label', 'ScopeLang source, read-only');
    const hintId = `${ctx.areaId}-sl-hint`;
    const hint = el('ms-sr-only', 'span');
    hint.id = hintId;
    hint.textContent = 'Up and Down move the line cursor, Enter selects the scope or metric declared on that line, Left folds a block, Right unfolds it.';
    this.codeEl.setAttribute('aria-describedby', hintId);
    this.sizer = el('ms-sl-sizer');
    this.codeEl.appendChild(this.sizer);
    this.irEl = el('ms-sl-ir');
    this.irEl.hidden = true;
    this.irEl.setAttribute('aria-label', 'Scope IR');
    body.append(this.codeEl, this.irEl);
    this.foot = el('ms-ed-foot ms-sl-foot');
    this.live = el('ms-sr-only', 'span');
    this.live.setAttribute('aria-live', 'polite');
    this.root.append(this.banner, body, this.foot, hint, this.live);
    ctx.el.appendChild(this.root);

    // interaction (delegated: rows are re-created on every paint)
    this.listen(this.codeEl, 'click', (e) => this.onCodeClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.codeEl, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.codeEl, 'pointerover', (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest?.('.ms-code-line');
      const id = row ? this.doc?.idAt.get(Number(/** @type {HTMLElement} */ (row).dataset.line)) || null : null;
      if (id !== this._hoverOut) { this._hoverOut = id; this.hover(id); }
    });
    this.listen(this.codeEl, 'pointerleave', () => { if (this._hoverOut) { this._hoverOut = null; this.hover(null); } });
    this.listen(this.codeEl, 'scroll', () => this.onScroll(), { passive: true });
    this.on('delta:rejected', () => this.soon());

    this.render();
  }

  getState() {
    return {
      mode: this.state.mode,
      showIR: this.state.showIR,
      folded: this.state.folded.slice(0, 1000),
      foldedSnippet: this.state.foldedSnippet.slice(0, 200),
    };
  }

  // ------------------------------------------------------------------ header

  getHeaderTools() {
    const wrap = el('ms-row');
    const seg = el('ms-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Source shown');
    for (const [mode, label, tip] of [
      ['live', 'Live graph', 'ScopeLang printed from the live graph'],
      ['snippet', 'Spec snippet', 'The canonical example from the specification'],
    ]) {
      const b = el('', 'button');
      b.type = 'button';
      b.textContent = label;
      b.title = tip;
      b.setAttribute('aria-pressed', String(this.state?.mode === mode));
      b.addEventListener('click', () => this.setMode(/** @type {any} */ (mode)));
      seg.appendChild(b);
    }
    const ir = /** @type {HTMLButtonElement} */ (el('ms-icon-btn ms-toggle is-small ms-sl-irbtn', 'button'));
    ir.type = 'button';
    ir.innerHTML = '<span class="codicon codicon-json" aria-hidden="true"></span>';
    ir.appendChild(document.createTextNode('IR'));
    ir.setAttribute('aria-pressed', String(!!this.state?.showIR));
    ir.setAttribute('aria-label', 'Show the Scope IR of the selected node');
    ir.dataset.tooltip = 'Show IR (pretty JSON of the selected node)';
    ir.addEventListener('click', () => this.toggleIR());
    wrap.append(seg, ir);
    return [wrap];
  }

  getHeaderMenus() {
    return [{
      label: 'View',
      items: () => [
        { label: 'Fold All Child Scopes', icon: 'fold', run: () => this.foldAll(true) },
        { label: 'Unfold All', icon: 'unfold', run: () => this.foldAll(false) },
        { label: 'Reveal Selection', icon: 'target', disabled: !this.primary, run: () => { if (this.primary) { this.pendingReveal = { id: this.primary, center: true }; this.invalidate(); } } },
        { separator: true },
        { label: this.state.showIR ? 'Hide Scope IR' : 'Show Scope IR', icon: 'json', run: () => this.toggleIR() },
        { label: this.state.mode === 'live' ? 'Show Spec Snippet' : 'Show Live Graph', icon: 'arrow-swap', run: () => this.setMode(this.state.mode === 'live' ? 'snippet' : 'live') },
        { separator: true },
        { label: 'Copy Source', icon: 'copy', run: () => this.copy(this.doc ? this.doc.lines.join('\n') : '', 'ScopeLang source copied.') },
      ],
    }];
  }

  /** @param {'live'|'snippet'} mode */
  setMode(mode) {
    if (mode === this.state.mode) return;
    this.state.mode = mode;
    this.save();
    this.ctx?.refreshHeader();
    this.doc = null;
    this.view = null;
    this.active = null;
    this._irKey = '';
    this.codeEl.scrollTop = 0;
    if (this.primary) this.pendingReveal = { id: this.primary, center: true };
    this.invalidate();
  }

  toggleIR() {
    this.state.showIR = !this.state.showIR;
    this.save();
    this.ctx?.refreshHeader();
    this.invalidate();
  }

  /** @param {string} text @param {string} msg */
  async copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      this.ctx?.services.notify?.success?.(msg);
    } catch {
      this.ctx?.services.notify?.warn?.('Clipboard is not available here.');
    }
  }

  // ------------------------------------------------------------------ document

  /** Current source, line maps and diagnostics; reuses the previous object when unchanged. @returns {Doc} */
  currentDoc() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    if (this.state.mode === 'snippet') {
      const key = `snippet:${g.versionLabel}:${g.structureVersion}`;
      if (this.doc && this.doc.key === key) return this.doc;
      const text = this.compiler.demoSnippet();
      const lines = text.split('\n');
      const { idAt, lineOf } = snippetMap(text, g);
      return { key, mode: 'snippet', lines, idAt, lineOf, ends: foldRanges(lines), diags: [], diagSig: '' };
    }
    const c = this.compiler.compiled();
    const diags = this.compiler.diagnostics();
    const diagSig = diags.map((d) => `${d.line}:${d.severity}:${d.message}`).join('\n');
    if (this.doc && this.doc.compiled === c) {
      if (this.doc.diagSig === diagSig) return this.doc;
      return { ...this.doc, diags, diagSig };
    }
    const lines = c.text.split('\n');
    return { key: `live:${++this._seq}`, mode: 'live', compiled: c, lines, idAt: c.idAt, lineOf: c.lineOf, ends: foldRanges(lines), diags, diagSig };
  }

  /** Folded block start lines for a document. @param {Doc} doc */
  foldedLines(doc) {
    const out = new Set();
    if (doc.mode === 'snippet') {
      for (const l of this.state.foldedSnippet) if (doc.ends.has(l)) out.add(l);
    } else {
      for (const id of this.state.folded) {
        const l = doc.lineOf.get(id);
        if (l && doc.ends.has(l)) out.add(l);
      }
    }
    return out;
  }

  /** @param {number} line */
  toggleFold(line) {
    const doc = this.doc;
    if (!doc || !doc.ends.has(line)) return;
    let folding;
    if (doc.mode === 'snippet') {
      const i = this.state.foldedSnippet.indexOf(line);
      folding = i < 0;
      if (folding) this.state.foldedSnippet.push(line);
      else this.state.foldedSnippet.splice(i, 1);
    } else {
      const id = doc.idAt.get(line);
      if (!id) return;
      const i = this.state.folded.indexOf(id);
      folding = i < 0;
      if (folding) this.state.folded.push(id);
      else this.state.folded.splice(i, 1);
    }
    const end = /** @type {number} */ (doc.ends.get(line));
    if (folding && this.active && this.active > line && this.active <= end) this.active = line;
    this.save();
    this.invalidate();
  }

  /** @param {boolean} fold */
  foldAll(fold) {
    const doc = this.doc;
    if (!doc) return;
    if (!fold) {
      if (doc.mode === 'snippet') this.state.foldedSnippet = [];
      else this.state.folded = [];
    } else {
      const starts = [...doc.ends.keys()].sort((a, b) => a - b);
      const outer = starts[0];
      const inner = starts.filter((l) => l !== outer);
      if (doc.mode === 'snippet') this.state.foldedSnippet = inner;
      else this.state.folded = inner.map((l) => doc.idAt.get(l)).filter((x) => typeof x === 'string');
      if (this.active && inner.some((s) => this.active > s && this.active <= /** @type {number} */ (doc.ends.get(s)))) {
        this.active = inner.filter((s) => s <= /** @type {number} */ (this.active) && /** @type {number} */ (this.active) <= /** @type {number} */ (doc.ends.get(s)))[0] ?? this.active;
      }
    }
    this.save();
    this.invalidate();
  }

  /** Unfold every folded block that hides a line. @param {Doc} doc @param {number} line */
  unfoldAround(doc, line) {
    let changed = false;
    for (const s of this.foldedLines(doc)) {
      const end = /** @type {number} */ (doc.ends.get(s));
      if (s < line && line <= end) {
        if (doc.mode === 'snippet') this.state.foldedSnippet = this.state.foldedSnippet.filter((x) => x !== s);
        else {
          const id = doc.idAt.get(s);
          this.state.folded = this.state.folded.filter((x) => x !== id);
        }
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  // ------------------------------------------------------------------ rendering

  render() {
    const ctx = /** @type {any} */ (this.ctx);
    if (!this.compiler) {
      this.sizer.replaceChildren(emptyState({ icon: 'code', title: 'Compiler unavailable', text: 'The ScopeLang compiler service is not connected.' }));
      return;
    }
    const prev = this.doc;
    const doc = this.currentDoc();
    if (prev && doc !== prev && prev.mode === doc.mode && this.active != null && doc.key !== prev.key) {
      // keep the cursor on the same declaration when the text shifts
      const id = prev.idAt.get(this.active);
      const nl = id ? doc.lineOf.get(id) : undefined;
      this.active = nl ?? (id ? null : Math.min(this.active, doc.lines.length));
    }
    this.doc = doc;

    const reveal = this.pendingReveal;
    this.pendingReveal = null;
    if (reveal) {
      const line = reveal.line ?? (reveal.id ? doc.lineOf.get(reveal.id) : undefined);
      if (line) {
        this.unfoldAround(doc, line);
        this.active = line;
      }
    }

    const folded = this.foldedLines(doc);
    const foldSig = [...folded].sort((a, b) => a - b).join(',');
    let visible = this.view?.visible;
    if (!visible || !this.view || this.view.docKey !== doc.key || this.view.foldSig !== foldSig) {
      visible = visibleLines(doc.lines.length, folded, doc.ends);
    }
    const windowed = visible.length > WINDOW_AT;
    if (reveal && this.active != null && windowed) {
      const idx = indexOfSorted(visible, this.active);
      if (idx >= 0) this.scrollToOffset(PAD + idx * ROW_H, reveal.center);
    }
    let from = 0;
    let to = visible.length;
    if (windowed) {
      const h = this.codeEl.clientHeight || 600;
      const first = Math.max(0, Math.floor((this.codeEl.scrollTop - PAD) / ROW_H));
      from = Math.max(0, first - OVERSCAN);
      to = Math.min(visible.length, first + Math.ceil(h / ROW_H) + OVERSCAN);
    }
    const v = this.view;
    const repaint = !v || v.docKey !== doc.key || v.foldSig !== foldSig || v.diagSig !== doc.diagSig
      || v.windowed !== windowed || v.from !== from || v.to !== to;
    if (repaint) this.paint(doc, visible, folded, windowed, from, to);
    this.view = { visible, windowed, from, to, foldSig, docKey: doc.key, diagSig: doc.diagSig };
    this.decorate();
    if (reveal && this.active != null && !windowed) {
      const row = this.rowFor(this.active);
      if (row) this.scrollToOffset(this.offsetOf(row), reveal.center);
    }

    this.banner.hidden = doc.mode !== 'snippet';
    if (doc.mode === 'snippet' && !this.banner.childElementCount) this.buildBanner();
    this.renderIR();
    this.renderFoot();
    if (this._sidebarSig !== null && this._sidebarSig !== `${doc.key}|${doc.diagSig}`) ctx.refreshRegions?.();
  }

  /**
   * Render lines visible[from..to) with the shared code view, then map its local line numbers
   * back to source lines and add fold toggles for blocks.
   * @param {Doc} doc @param {number[]} visible @param {Set<number>} folded
   * @param {boolean} windowed @param {number} from @param {number} to
   */
  paint(doc, visible, folded, windowed, from, to) {
    const slice = visible.slice(from, to);
    const local = new Map(slice.map((ln, i) => [ln, i + 1]));
    const diagnostics = doc.diags
      .filter((d) => local.has(d.line))
      .map((d) => ({ line: /** @type {number} */ (local.get(d.line)), severity: d.severity, message: d.message }));
    const pre = codeView(slice.map((ln) => doc.lines[ln - 1]).join('\n'), {
      lang: 'scopelang',
      lineNumbers: true,
      diagnostics,
      foldable: false,
      label: doc.mode === 'snippet' ? 'ScopeLang specification snippet' : 'ScopeLang source of the live graph',
    });
    // the scroll container is the single tab stop and landmark
    pre.tabIndex = -1;
    pre.removeAttribute('role');
    pre.removeAttribute('aria-label');
    pre.classList.add('ms-sl-pre');
    if (windowed) {
      for (const d of pre.querySelectorAll('.ms-code-diag')) d.remove(); // fixed row heights
      pre.classList.add('is-windowed');
      pre.style.top = `${PAD + from * ROW_H}px`;
      this.sizer.style.height = `${PAD * 2 + visible.length * ROW_H}px`;
    } else {
      this.sizer.style.height = '';
    }
    for (const row of pre.querySelectorAll('.ms-code-line')) {
      const r = /** @type {HTMLElement} */ (row);
      const ln = slice[Number(r.dataset.line) - 1];
      r.dataset.line = String(ln);
      const num = r.querySelector('.ms-code-ln');
      if (num) num.textContent = String(ln);
      const end = doc.ends.get(ln);
      if (!end) continue;
      const isFolded = folded.has(ln);
      r.classList.add('is-foldable');
      const gutter = r.querySelector('.ms-code-gutter');
      if (gutter && !gutter.childElementCount) {
        const b = /** @type {HTMLButtonElement} */ (el(`ms-code-fold ms-sl-fold codicon codicon-chevron-${isFolded ? 'right' : 'down'}`, 'button'));
        b.type = 'button';
        b.tabIndex = -1;
        b.dataset.fold = String(ln);
        b.setAttribute('aria-label', `${isFolded ? 'Unfold' : 'Fold'} block at line ${ln}`);
        b.setAttribute('aria-expanded', String(!isFolded));
        gutter.appendChild(b);
      }
      if (isFolded) {
        const more = el('ms-code-folded', 'span');
        more.textContent = ` … ${end - ln - 1} lines }`;
        r.querySelector('.ms-code-text')?.appendChild(more);
      }
    }
    this.codeEl.style.setProperty('--ms-sl-digits', String(Math.max(3, String(doc.lines.length).length)));
    this.sizer.replaceChildren(pre);
  }

  /** Active / selected / hovered line classes. */
  decorate() {
    const doc = this.doc;
    if (!doc) return;
    for (const row of this.sizer.querySelectorAll('.ms-code-line')) {
      const r = /** @type {HTMLElement} */ (row);
      const ln = Number(r.dataset.line);
      const id = doc.idAt.get(ln);
      r.classList.toggle('is-active', ln === this.active);
      r.classList.toggle('is-selected', !!id && this.selected.has(id));
      r.classList.toggle('is-hovered', !!id && id === this.hovered);
      r.classList.toggle('has-id', !!id);
      if (id) r.title = `${/** @type {any} */ (this.ctx).engine.graph.path(id) || id} · click to select`;
    }
  }

  /** @param {number} line */
  rowFor(line) {
    return /** @type {HTMLElement|null} */ (this.sizer.querySelector(`.ms-code-line[data-line="${line}"]`));
  }

  /** Offset of a row from the top of the scrolled content. @param {HTMLElement} row */
  offsetOf(row) {
    return row.getBoundingClientRect().top - this.codeEl.getBoundingClientRect().top + this.codeEl.scrollTop;
  }

  /** Scroll so a row at this content offset is visible (or centered). @param {number} top @param {boolean} center */
  scrollToOffset(top, center) {
    const h = this.codeEl.clientHeight;
    if (!h) return;
    const cur = this.codeEl.scrollTop;
    if (center) {
      // center only when the line is off screen (or at its edges); otherwise leave the view alone
      if (top < cur + ROW_H || top + 2 * ROW_H > cur + h) this.codeEl.scrollTop = Math.max(0, top - h / 2 + ROW_H / 2);
    } else if (top < cur) this.codeEl.scrollTop = top;
    else if (top + ROW_H > cur + h) this.codeEl.scrollTop = top + ROW_H - h;
  }

  onScroll() {
    const v = this.view;
    if (!v?.windowed) return;
    const h = this.codeEl.clientHeight || 600;
    const first = Math.floor((this.codeEl.scrollTop - PAD) / ROW_H);
    const last = first + Math.ceil(h / ROW_H);
    if ((first - OVERSCAN / 2 < v.from && v.from > 0) || (last + OVERSCAN / 2 > v.to && v.to < v.visible.length)) this.invalidate();
  }

  buildBanner() {
    this.banner.replaceChildren();
    const icon = el('codicon codicon-book', 'span');
    icon.setAttribute('aria-hidden', 'true');
    const t = el('', 'span');
    t.textContent = 'Spec snippet: the canonical example from the specification, a simplified core of this graph. Declarations are matched to live metrics by name; click one to select it.';
    const b = /** @type {HTMLButtonElement} */ (el('ms-btn is-secondary is-small', 'button'));
    b.type = 'button';
    b.textContent = 'Show live graph';
    b.addEventListener('click', () => this.setMode('live'));
    this.banner.append(icon, t, b);
  }

  /** Scope IR for the selected node (falls back to the declaration at the cursor). */
  irTarget() {
    const g = /** @type {any} */ (this.ctx).engine.graph;
    if (this.primary && (g.node(this.primary) || g.scope(this.primary))) return this.primary;
    const a = this.active != null ? this.doc?.idAt.get(this.active) : null;
    return a || null;
  }

  renderIR() {
    const show = this.state.showIR;
    this.irEl.hidden = !show;
    this.root.classList.toggle('has-ir', show);
    if (!show) {
      if (this._irKey) { this.irEl.replaceChildren(); this._irKey = ''; }
      return;
    }
    const g = /** @type {any} */ (this.ctx).engine.graph;
    const id = this.irTarget();
    const key = `${id}|${g.hash}|${g.structureVersion}`;
    if (key === this._irKey) return;
    this._irKey = key;
    this.irEl.replaceChildren();
    const head = el('ms-sl-ir-head');
    const title = el('ms-sl-ir-title', 'span');
    title.textContent = 'Scope IR';
    const path = el('ms-sl-ir-path ms-ellipsis', 'span');
    path.textContent = id ? g.path(id) : '';
    head.append(title, path);
    if (!id) {
      this.irEl.append(head, emptyState({ icon: 'json', title: 'Nothing selected', text: 'Select a scope or metric (or click a declaration) to see its Scope IR.' }));
      return;
    }
    const json = this.compiler.irFor(id);
    const copy = /** @type {HTMLButtonElement} */ (el('ms-icon-btn is-small', 'button'));
    copy.type = 'button';
    copy.innerHTML = '<span class="codicon codicon-copy" aria-hidden="true"></span>';
    copy.setAttribute('aria-label', 'Copy Scope IR');
    copy.dataset.tooltip = 'Copy IR';
    copy.addEventListener('click', () => this.copy(json, 'Scope IR copied.'));
    head.appendChild(copy);
    const pre = codeView(json, { lang: 'json', lineNumbers: true, label: `Scope IR for ${g.path(id)}` });
    pre.classList.add('ms-sl-ir-code');
    this.irEl.append(head, pre);
  }

  renderFoot() {
    const doc = this.doc;
    if (!doc) return;
    const g = /** @type {any} */ (this.ctx).engine.graph;
    this.foot.replaceChildren();
    const pos = el('ms-sl-pos', 'span');
    const id = this.active != null ? doc.idAt.get(this.active) : null;
    pos.textContent = this.active != null ? `Ln ${this.active}${id ? ` · ${g.path(id)}` : ''}` : 'Ln –';
    pos.title = this.active != null ? pos.textContent : 'No line selected';
    const lines = el('ms-sl-count', 'span');
    lines.textContent = `${doc.lines.length.toLocaleString('en-US')} lines${this.view?.windowed ? ' (windowed)' : ''}`;
    this.foot.append(pos, lines);
    if (doc.mode === 'live') {
      const errors = doc.diags.filter((d) => d.severity === 'error').length;
      const warnings = doc.diags.filter((d) => d.severity === 'warning').length;
      const probs = el('ms-sl-problems', 'span');
      probs.title = 'Problems (open the N region for the list)';
      probs.innerHTML = `<span class="codicon codicon-error" aria-hidden="true"></span>${errors}<span class="codicon codicon-warning" aria-hidden="true"></span>${warnings}`;
      probs.setAttribute('aria-label', `${errors} errors, ${warnings} warnings`);
      const ver = el('ms-sl-ver', 'span');
      ver.textContent = `graph ${g.versionLabel} · ${g.shortHash}…`;
      this.foot.append(probs, ver);
    } else {
      const mapped = el('', 'span');
      mapped.textContent = `${doc.idAt.size} declarations matched to the live graph`;
      this.foot.append(mapped);
    }
    const sp = el('ms-spacer', 'span');
    const ro = el('ms-sl-ro', 'span');
    ro.textContent = 'read-only · CodeMirror 6 seam';
    ro.title = 'This read-only view sits behind the code-view seam; CodeMirror 6 can replace it without changing the editor API.';
    this.foot.append(sp, ro);
  }

  /** N region: problems. @param {HTMLElement} host */
  renderSidebar(host) {
    const doc = this.doc || (this.compiler ? this.currentDoc() : null);
    this._sidebarSig = doc ? `${doc.key}|${doc.diagSig}` : '';
    host.replaceChildren();
    const title = el('ms-sl-side-title');
    title.textContent = 'Problems';
    host.appendChild(title);
    if (!doc || !doc.diags.length) {
      const empty = el('ms-region-empty');
      empty.textContent = doc?.mode === 'snippet' ? 'The spec snippet has no diagnostics.' : 'No problems in the live source.';
      host.appendChild(empty);
      return;
    }
    const ul = el('ms-sl-problems-list', 'ul');
    ul.setAttribute('aria-label', 'Problems');
    for (const d of doc.diags) {
      const li = el('', 'li');
      const b = /** @type {HTMLButtonElement} */ (el('ms-sl-problem', 'button'));
      b.type = 'button';
      b.dataset.severity = d.severity;
      b.innerHTML = `<span class="codicon codicon-${d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info'}" aria-hidden="true"></span>`;
      const body = el('ms-sl-problem-body', 'span');
      const msg = el('ms-sl-problem-msg', 'span');
      msg.textContent = d.message;
      const where = el('ms-sl-problem-where', 'span');
      where.textContent = `Ln ${d.line}${d.nodeId ? ` · ${/** @type {any} */ (this.ctx).engine.graph.path(d.nodeId)}` : ''}`;
      body.append(msg, where);
      b.appendChild(body);
      b.setAttribute('aria-label', `${d.severity} at line ${d.line}: ${d.message}`);
      b.addEventListener('click', () => {
        this.pendingReveal = { line: d.line, center: true };
        if (d.nodeId && /** @type {any} */ (this.ctx).engine.graph.node(d.nodeId)) this.select([d.nodeId]);
        this.invalidate();
        this.codeEl.focus({ preventScroll: true });
      });
      li.appendChild(b);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }

  // ------------------------------------------------------------------ interaction

  /** @param {MouseEvent} e */
  onCodeClick(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const fold = /** @type {HTMLElement|null} */ (t.closest?.('.ms-sl-fold'));
    if (fold) {
      e.stopPropagation();
      this.toggleFold(Number(fold.dataset.fold));
      return;
    }
    const row = /** @type {HTMLElement|null} */ (t.closest?.('.ms-code-line'));
    if (!row || !this.doc) return;
    if (String(window.getSelection?.() || '').length) return; // let people select text
    const ln = Number(row.dataset.line);
    this.active = ln;
    const id = this.doc.idAt.get(ln);
    if (id) this.select([id], { mode: e.ctrlKey || e.metaKey ? 'toggle' : 'replace' });
    this.codeEl.focus({ preventScroll: true });
    this.decorate();
    this.renderIR();
    this.renderFoot();
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const doc = this.doc;
    const v = this.view?.visible;
    if (!doc || !v?.length) return;
    let idx = this.active != null ? floorIndex(v, this.active) : -1;
    const page = Math.max(1, Math.floor(this.codeEl.clientHeight / ROW_H) - 1);
    switch (e.key) {
      case 'ArrowDown': idx = Math.min(v.length - 1, idx + 1); break;
      case 'ArrowUp': idx = Math.max(0, idx - 1); break;
      case 'PageDown': idx = Math.min(v.length - 1, Math.max(0, idx) + page); break;
      case 'PageUp': idx = Math.max(0, idx - page); break;
      case 'Home': idx = 0; break;
      case 'End': idx = v.length - 1; break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const id = this.active != null ? doc.idAt.get(this.active) : null;
        if (id) this.select([id], { mode: e.ctrlKey || e.metaKey ? 'toggle' : 'replace' });
        return;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (this.active == null) return;
        const folded = this.foldedLines(doc);
        if (doc.ends.has(this.active) && !folded.has(this.active)) { this.toggleFold(this.active); return; }
        // move to the enclosing block's header
        for (let i = floorIndex(v, this.active) - 1; i >= 0; i--) {
          const end = doc.ends.get(v[i]);
          if (end && end >= this.active) { this.moveTo(v[i]); return; }
        }
        return;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (this.active != null && this.foldedLines(doc).has(this.active)) this.toggleFold(this.active);
        return;
      }
      default: return;
    }
    e.preventDefault();
    this.moveTo(v[Math.max(0, idx)]);
  }

  /** Move the cursor line (keyboard). @param {number} line */
  moveTo(line) {
    this.active = line;
    this.pendingReveal = { line, center: false };
    const id = this.doc?.idAt.get(line);
    const text = (this.doc?.lines[line - 1] || '').trim();
    this.live.textContent = `Line ${line}${id ? `, ${/** @type {any} */ (this.ctx).engine.graph.path(id)}` : ''}: ${text || 'blank'}`;
    this.invalidate();
  }

  /** Debounced re-check of the source (recompute bursts, rejected deltas). */
  soon() {
    this._soon?.dispose();
    this._soon = timeout(() => { this._soon = null; this.invalidate(); }, DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------ events

  onSelection(sel) {
    this.selected = new Set(sel.selected);
    this.primary = sel.primary;
    if (sel.primary && sel.source !== this.ctx?.areaId && sel.source !== 'local') this.pendingReveal = { id: sel.primary, center: true };
    this.invalidate();
  }

  onHover(id) {
    this.hovered = id;
    this.decorate();
  }

  onRecompute() {
    // literals in the source and the IR follow the graph; wait for bursts (drags) to settle
    this.soon();
  }

  onStructure() { this.invalidate(); }
  onTheme() { /* colors are CSS variables */ }
  onScenario() {}
  onFlags() {}

  resize() {
    if (this.view?.windowed) this.invalidate();
  }

  dispose() {
    this._soon?.dispose();
    this._soon = null;
    this.root?.remove();
    super.dispose();
  }
}
