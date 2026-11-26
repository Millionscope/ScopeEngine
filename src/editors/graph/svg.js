/**
 * SVG renderer for the Scope Graph (up to ~2,000 visible items). Builds frames, edges and
 * items once per layout; afterwards only touches what changed: value labels, hover/selection
 * classes, the viewport transform and level-of-detail. Colors come from CSS variables
 * (graph.css), so theme switches need no work here. Events are delegated by the editor
 * (items carry data-item, frames data-frame).
 * @module editors/graph/svg
 */
import { PROVENANCE } from '../../theme/tokens.js';

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} tag @param {Record<string, string|number>} [attrs] @param {string} [text]
 * @returns {any}
 */
export function svgEl(tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Truncate to roughly fit `px` at ~`cw` px per character. @param {string} s @param {number} px @param {number} [cw] */
export function fitText(s, px, cw = 6.6) {
  const n = Math.max(2, Math.floor(px / cw));
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Wrap text into at most `lines` lines of `n` characters (word boundaries when possible).
 * @param {string} s @param {number} n @param {number} lines
 */
export function wrapText(s, n, lines) {
  const out = [];
  let rest = s.trim();
  while (rest && out.length < lines) {
    if (rest.length <= n) { out.push(rest); rest = ''; break; }
    let cut = rest.lastIndexOf(' ', n);
    if (cut < n * 0.5) cut = n;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && out.length) out[out.length - 1] = fitText(`${out[out.length - 1]} ${rest}`, n * 6.2, 6.2);
  return out;
}

/** Below this zoom, item text is hidden and frame titles are drawn at screen size. */
export const LOD_LOW = 0.5;

/**
 * @typedef {Object} SceneItem
 * @property {string} id
 * @property {'metric'|'proxy'} kind
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {string} frame
 */

/**
 * @typedef {Object} SceneFrame
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} depth
 * @property {string} name
 * @property {string} proto
 */

/**
 * @typedef {Object} SceneEdge
 * @property {string} a
 * @property {string} b
 * @property {number} count
 * @property {{x1: number, y1: number, c1x: number, c1y: number, c2x: number, c2y: number, x2: number, y2: number, d: string}} g
 */

/**
 * @typedef {Object} Scene
 * @property {'LR'|'TB'} dir
 * @property {number} width
 * @property {number} height
 * @property {Map<string, SceneItem>} items
 * @property {SceneFrame[]} frames            outermost first
 * @property {SceneEdge[]} edges
 * @property {Map<string, number[]>} outE      item id -> edge indexes
 * @property {Map<string, number[]>} inE
 */

/**
 * @typedef {Object} ItemLabel
 * @property {string} name
 * @property {string} value                    formatted value ('' when values are hidden)
 * @property {string} prov                     provenance class (metrics)
 * @property {string} stat                     'value' | 'p50'
 * @property {string} aria
 * @property {string=} proto                   proxies: prototype name
 * @property {string[]=} lines                 proxies: summary lines
 * @property {string=} title                   proxies: full summary
 */

export class SvgScene {
  /**
   * @param {{host: HTMLElement, areaId: string}} opts
   */
  constructor({ host, areaId }) {
    this.host = host;
    this.markerId = `ms-gm-${String(areaId).replace(/[^\w-]/g, '')}`;
    this.svg = svgEl('svg', { class: 'ms-graph-svg', role: 'group', 'aria-roledescription': 'scope graph' });
    const defs = svgEl('defs');
    for (const [suffix, cls] of [['', 'arrow'], ['-cone', 'arrow is-cone'], ['-up', 'arrow is-up']]) {
      const m = svgEl('marker', { id: this.markerId + suffix, viewBox: '0 0 8 8', refX: 7.2, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' });
      m.appendChild(svgEl('path', { d: 'M0,0.6 L7.4,4 L0,7.4 z', class: cls }));
      defs.appendChild(m);
    }
    this.vp = svgEl('g', { class: 'vp' });
    this.gFrames = svgEl('g', { class: 'frames' });
    this.gEdges = svgEl('g', { class: 'edges' });
    this.gItems = svgEl('g', { class: 'items' });
    this.gPulse = svgEl('g', { class: 'pulses', 'aria-hidden': 'true' });
    this.vp.append(this.gFrames, this.gEdges, this.gItems, this.gPulse);
    this.svg.append(defs, this.vp);
    host.appendChild(this.svg);
    /** @type {Map<string, any>} */
    this.itemEls = new Map();
    /** @type {Map<string, {value: any, name: any, lines: any[]}>} */
    this.textEls = new Map();
    /** @type {Map<string, any>} */
    this.frameHeads = new Map();
    /** @type {any[]} */
    this.edgeEls = [];
    /** @type {Scene|null} */
    this.scene = null;
    this._lod = false;
    this._k = 1;
    /** @type {Set<string>} */
    this._sel = new Set();
    /** @type {Set<any>} */
    this._hoverEls = new Set();
    /** @type {Set<Animation>} */
    this._anims = new Set();
    this.focusId = null;
  }

  /** @param {boolean} on */
  setVisible(on) {
    this.svg.style.display = on ? '' : 'none';
  }

  /**
   * Rebuild every element for a new layout.
   * @param {Scene} scene @param {(id: string) => ItemLabel} labelOf
   */
  build(scene, labelOf) {
    this.cancelPulses();
    this.scene = scene;
    this.itemEls.clear();
    this.textEls.clear();
    this.frameHeads.clear();
    this._hoverEls.clear();
    this._sel = new Set();
    const fF = document.createDocumentFragment();
    for (const f of scene.frames) {
      const g = svgEl('g', { class: 'frame', 'data-frame': f.id, 'data-depth': f.depth % 2 });
      g.appendChild(svgEl('rect', { class: 'frame-bg', x: f.x, y: f.y, width: f.w, height: f.h, rx: 6 }));
      if (f.depth > 0) {
        const head = svgEl('g', {
          class: 'frame-head', 'data-frame-head': f.id, tabindex: -1, role: 'button',
          'aria-label': `${f.name}, ${f.proto} scope. Press Enter to collapse.`,
          transform: `translate(${f.x + 8},${f.y + 16})`,
        });
        head.appendChild(svgEl('rect', { class: 'frame-head-hit', x: -6, y: -13, width: Math.max(40, f.w - 6), height: 20, rx: 3 }));
        head.appendChild(svgEl('text', { class: 'frame-toggle', x: 0, y: 0 }, '▾'));
        const t = svgEl('text', { class: 'frame-title', x: 13, y: 0 });
        t.appendChild(svgEl('tspan', { class: 'nm' }, fitText(f.name, f.w - 120, 7)));
        t.appendChild(svgEl('tspan', { class: 'pr', dx: 6 }, f.proto));
        head.appendChild(t);
        g.appendChild(head);
        this.frameHeads.set(f.id, { el: head, x: f.x + 8, y: f.y + 16, w: f.w });
      } else {
        const t = svgEl('text', { class: 'frame-title is-root', x: f.x + 10, y: f.y + 16 });
        t.appendChild(svgEl('tspan', { class: 'nm' }, f.name));
        t.appendChild(svgEl('tspan', { class: 'pr', dx: 6 }, f.proto));
        g.appendChild(t);
        this.frameHeads.set(f.id, { el: t, x: f.x + 10, y: f.y + 16, w: f.w, root: true });
      }
      fF.appendChild(g);
    }
    this.gFrames.replaceChildren(fF);

    const fE = document.createDocumentFragment();
    this.edgeEls = scene.edges.map((e, i) => {
      const p = svgEl('path', {
        class: 'edge', d: e.g.d, 'data-e': i,
        'marker-end': `url(#${this.markerId})`,
        'stroke-width': e.count > 1 ? Math.min(4, 1 + Math.log2(e.count) * 0.7).toFixed(2) : 1.1,
      });
      fE.appendChild(p);
      return p;
    });
    this.gEdges.replaceChildren(fE);

    const fI = document.createDocumentFragment();
    let first = true;
    for (const it of scene.items.values()) {
      const L = labelOf(it.id);
      const g = svgEl('g', {
        class: `item ${it.kind}`, 'data-item': it.id, transform: `translate(${it.x},${it.y})`,
        tabindex: first ? 0 : -1, role: 'button', 'aria-label': L.aria,
      });
      if (first) this.focusId = it.id;
      first = false;
      g.appendChild(svgEl('rect', { class: 'ring', x: -3.5, y: -3.5, width: it.w + 7, height: it.h + 7, rx: 8 }));
      g.appendChild(svgEl('rect', { class: 'bg', width: it.w, height: it.h, rx: 5 }));
      if (it.kind === 'metric') {
        g.classList.add('ms-bv');
        g.dataset.node = it.id;
        g.dataset.stat = L.stat;
        g.dataset.prov = L.prov;
        g.appendChild(svgEl('text', { class: 'glyph', x: 7, y: 13.5 }, PROVENANCE[L.prov]?.glyph || 'ƒ'));
        const name = svgEl('text', { class: 'name', x: 19, y: 13.5 }, fitText(L.name, it.w - 25, 6.7));
        const value = svgEl('text', { class: 'value', x: 19, y: 26.5 }, L.value);
        g.append(name, value);
        this.textEls.set(it.id, { value, name, lines: [] });
      } else {
        g.dataset.scope = it.id;
        g.appendChild(svgEl('title', {}, L.title || L.name));
        g.appendChild(svgEl('text', { class: 'toggle', x: 7, y: 15 }, '▸'));
        const name = svgEl('text', { class: 'pname', x: 19, y: 15 });
        name.appendChild(svgEl('tspan', { class: 'nm' }, fitText(L.name, it.w - 90, 7)));
        name.appendChild(svgEl('tspan', { class: 'pr', dx: 5 }, fitText(L.proto || '', 70, 6.2)));
        g.appendChild(name);
        const lines = (L.lines || []).map((ln, k) => {
          const t = svgEl('text', { class: 'sum', x: 8, y: 29 + k * 12 }, ln);
          g.appendChild(t);
          return t;
        });
        this.textEls.set(it.id, { value: null, name, lines });
      }
      this.itemEls.set(it.id, g);
      fI.appendChild(g);
    }
    this.gItems.replaceChildren(fI);
    this.gPulse.replaceChildren();
    this._lod = !this._lod; // force LOD refresh
    this.setTransform(this._t || { x: 0, y: 0, k: 1 });
  }

  /**
   * Apply the zoom transform (and level of detail).
   * @param {{x: number, y: number, k: number}} t
   */
  setTransform(t) {
    this._t = t;
    this._k = t.k;
    this.vp.setAttribute('transform', `translate(${t.x.toFixed(2)},${t.y.toFixed(2)}) scale(${t.k.toFixed(4)})`);
    const low = t.k < LOD_LOW;
    if (low !== this._lod) {
      this._lod = low;
      this.svg.classList.toggle('lod-low', low);
      if (!low) for (const h of this.frameHeads.values()) h.el.setAttribute('transform', h.root ? '' : `translate(${h.x},${h.y})`);
    }
    if (low) {
      // frame titles at constant screen size so the overview stays labeled
      const s = Math.min(1 / t.k, 6);
      for (const h of this.frameHeads.values()) {
        if (h.root) h.el.setAttribute('transform', `translate(${h.x},${h.y}) scale(${s.toFixed(3)}) translate(${-h.x},${-h.y})`);
        else h.el.setAttribute('transform', `translate(${h.x},${h.y}) scale(${s.toFixed(3)})`);
      }
    }
  }

  /**
   * Update value labels (and proxy summaries) of the given items only.
   * @param {Iterable<string>} ids @param {(id: string) => ItemLabel} labelOf
   */
  updateLabels(ids, labelOf) {
    for (const id of ids) {
      const t = this.textEls.get(id);
      const g = this.itemEls.get(id);
      if (!t || !g) continue;
      const L = labelOf(id);
      if (t.value) {
        if (t.value.textContent !== L.value) t.value.textContent = L.value;
        if (g.dataset.stat !== L.stat) g.dataset.stat = L.stat;
        if (g.dataset.prov !== L.prov) {
          g.dataset.prov = L.prov;
          const glyph = g.querySelector('.glyph');
          if (glyph) glyph.textContent = PROVENANCE[L.prov]?.glyph || 'ƒ';
        }
      } else {
        (L.lines || []).forEach((ln, k) => { if (t.lines[k] && t.lines[k].textContent !== ln) t.lines[k].textContent = ln; });
        const title = g.querySelector('title');
        if (title && L.title) title.textContent = L.title;
      }
      g.setAttribute('aria-label', L.aria);
    }
  }

  /** @param {string} scenarioId|null */
  setScenario(scenarioId) {
    for (const g of this.itemEls.values()) {
      if (!g.dataset.node) continue;
      if (scenarioId && scenarioId !== 'base') g.dataset.scenario = scenarioId;
      else delete g.dataset.scenario;
    }
  }

  /**
   * Hover highlight: the hovered item, its downstream cone and its upstream.
   * @param {{id: string, cone: Set<string>, up: Set<string>}|null} h
   */
  setHover(h) {
    for (const e of this._hoverEls) e.classList.remove('is-hover', 'in-cone', 'in-up', 'e-cone', 'e-up');
    for (const e of this._hoverEls) {
      if (e.tagName === 'path') e.setAttribute('marker-end', `url(#${this.markerId})`);
    }
    this._hoverEls.clear();
    this.svg.classList.toggle('has-hover', !!h);
    if (!h || !this.scene) return;
    const add = (el, cls) => { if (el) { el.classList.add(cls); this._hoverEls.add(el); } };
    add(this.itemEls.get(h.id), 'is-hover');
    for (const id of h.cone) add(this.itemEls.get(id), 'in-cone');
    for (const id of h.up) add(this.itemEls.get(id), 'in-up');
    this.scene.edges.forEach((e, i) => {
      const el = this.edgeEls[i];
      if ((e.a === h.id || h.cone.has(e.a)) && h.cone.has(e.b)) {
        add(el, 'e-cone');
        el.setAttribute('marker-end', `url(#${this.markerId}-cone)`);
      } else if (h.up.has(e.a) && (e.b === h.id || h.up.has(e.b))) {
        add(el, 'e-up');
        el.setAttribute('marker-end', `url(#${this.markerId}-up)`);
      }
    });
  }

  /**
   * @param {Set<string>} ids visible item ids to mark selected @param {string|null} primary
   */
  setSelection(ids, primary) {
    for (const id of this._sel) {
      const g = this.itemEls.get(id);
      if (g) { g.classList.remove('is-sel', 'is-primary'); g.removeAttribute('aria-current'); }
    }
    this._sel = new Set();
    for (const id of ids) {
      const g = this.itemEls.get(id);
      if (!g) continue;
      g.classList.add('is-sel');
      if (id === primary) { g.classList.add('is-primary'); g.setAttribute('aria-current', 'true'); }
      this._sel.add(id);
    }
  }

  /**
   * Brief ring on items whose values changed (Web Animations: no rAF of our own, cancelled on
   * dispose). Callers skip this under reduced motion.
   * @param {string[]} ids
   */
  pulse(ids) {
    if (!this.scene) return;
    let n = 0;
    for (const id of ids) {
      const it = this.scene.items.get(id);
      if (!it || n++ > 400) continue;
      const r = svgEl('rect', { class: 'pulse', x: it.x - 4, y: it.y - 4, width: it.w + 8, height: it.h + 8, rx: 9 });
      this.gPulse.appendChild(r);
      if (typeof r.animate !== 'function') { r.remove(); continue; }
      const a = r.animate([{ opacity: 0.95, strokeWidth: '4px' }, { opacity: 0, strokeWidth: '1px' }], { duration: 900, easing: 'ease-out' });
      this._anims.add(a);
      const done = () => { this._anims.delete(a); r.remove(); };
      a.onfinish = done;
      a.oncancel = done;
    }
  }

  cancelPulses() {
    for (const a of [...this._anims]) a.cancel();
    this._anims.clear();
    this.gPulse.replaceChildren();
  }

  /**
   * Roving tabindex: make `id` the single tab stop and optionally focus it.
   * @param {string} id @param {boolean} [focus]
   */
  setFocusItem(id, focus = false) {
    const el = this.itemEls.get(id) || this.frameHeads.get(id)?.el;
    if (!el) return;
    const prev = this.focusId ? (this.itemEls.get(this.focusId) || this.frameHeads.get(this.focusId)?.el) : null;
    if (prev && prev !== el) prev.setAttribute('tabindex', '-1');
    el.setAttribute('tabindex', '0');
    this.focusId = id;
    if (focus) el.focus({ preventScroll: true });
  }

  dispose() {
    this.cancelPulses();
    this.svg.remove();
    this.itemEls.clear();
    this.textEls.clear();
    this.frameHeads.clear();
    this.edgeEls = [];
    this.scene = null;
  }
}
