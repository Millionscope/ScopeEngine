/**
 * Canvas renderer for large Scope Graph views (above ~2,000 visible items). Same scene, same
 * interactions as the SVG renderer: hover cone, selection, collapse by double-click, zoom and
 * pan, pulses. Draws only what intersects the viewport, batches edges per style, and drops
 * text and arrowheads when zoomed out. Hit testing uses a uniform grid. Colors are resolved
 * from theme tokens and refreshed on theme change. Draws only when the editor renders.
 * @module editors/graph/canvas
 */
import { token, provColor, alpha, FONT_UI, PROVENANCE } from '../../theme/tokens.js';
import { fitText } from './svg.js';

const CELL = 256;

export class CanvasScene {
  /**
   * @param {{host: HTMLElement, scheduler: import('../../core/scheduler.js').Scheduler, owner: any}} opts
   */
  constructor({ host, scheduler, owner }) {
    this.host = host;
    this.scheduler = scheduler;
    this.owner = owner;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ms-graph-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    this.c2d = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    /** @type {import('./svg.js').Scene|null} */
    this.scene = null;
    /** @type {(id: string) => import('./svg.js').ItemLabel} */
    this.labelOf = () => ({ name: '', value: '', prov: 'computed', stat: 'value', aria: '' });
    /** @type {Map<string, import('./svg.js').ItemLabel>} */
    this.labels = new Map();
    /** @type {Map<string, string[]>} */
    this.grid = new Map();
    this.t = { x: 0, y: 0, k: 1 };
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    /** @type {{id: string, cone: Set<string>, up: Set<string>}|null} */
    this.hover = null;
    /** @type {Set<string>} */
    this.sel = new Set();
    this.primary = null;
    /** @type {Map<string, number>} id -> pulse start time */
    this.pulses = new Map();
    /** @type {{dispose: () => void}|null} */
    this._pulseAnim = null;
    this.refreshPalette();
  }

  refreshPalette() {
    const prov = {};
    for (const k of Object.keys(PROVENANCE)) prov[k] = provColor(k);
    this.P = {
      bg: token('editor.background', '#1f1f1f'),
      fg: token('editor.foreground', '#cccccc'),
      muted: token('descriptionForeground', '#9d9d9d'),
      node: token('input.background', '#313131'),
      frame0: token('editor.background', '#1f1f1f'),
      frame1: token('sideBar.background', '#181818'),
      border: token('widget.border', '#313131'),
      focus: token('focusBorder', '#0078d4'),
      cone: token('--ms-cone', 'rgba(0,120,212,.35)'),
      coneStrong: token('--ms-cone-strong', 'rgba(0,120,212,.7)'),
      up: token('--ms-upstream', 'rgba(226,192,141,.3)'),
      prov,
    };
    this.P.edge = alpha(this.P.muted, 0.45);
    this.P.edgeDim = alpha(this.P.muted, 0.16);
  }

  /** @param {boolean} on */
  setVisible(on) {
    this.canvas.style.display = on ? '' : 'none';
  }

  /** @param {import('./svg.js').Scene} scene @param {(id: string) => import('./svg.js').ItemLabel} labelOf */
  build(scene, labelOf) {
    this.scene = scene;
    this.labelOf = labelOf;
    this.labels.clear();
    this.grid.clear();
    for (const it of scene.items.values()) {
      const x0 = Math.floor(it.x / CELL);
      const x1 = Math.floor((it.x + it.w) / CELL);
      const y0 = Math.floor(it.y / CELL);
      const y1 = Math.floor((it.y + it.h) / CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const key = `${gx},${gy}`;
          let cell = this.grid.get(key);
          if (!cell) { cell = []; this.grid.set(key, cell); }
          cell.push(it.id);
        }
      }
    }
    this.canvas.setAttribute('aria-label', `Scope graph drawn on canvas: ${scene.items.size.toLocaleString('en-US')} items in ${scene.frames.length.toLocaleString('en-US')} scopes. Use View as table for an accessible list.`);
  }

  /** @param {number} w @param {number} h */
  resize(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  /** @param {{x: number, y: number, k: number}} t */
  setTransform(t) { this.t = t; }

  /** @param {string} id */
  label(id) {
    let L = this.labels.get(id);
    if (!L) { L = this.labelOf(id); this.labels.set(id, L); }
    return L;
  }

  /** @param {Iterable<string>} ids */
  updateLabels(ids) {
    for (const id of ids) this.labels.delete(id);
  }

  /** @param {{id: string, cone: Set<string>, up: Set<string>}|null} h */
  setHover(h) { this.hover = h; }

  /** @param {Set<string>} ids @param {string|null} primary */
  setSelection(ids, primary) { this.sel = new Set(ids); this.primary = primary; }

  /** @param {string[]} ids */
  pulse(ids) {
    const now = performance.now();
    let n = 0;
    for (const id of ids) {
      if (!this.scene?.items.has(id) || n++ > 2000) continue;
      this.pulses.set(id, now);
    }
    if (!this.pulses.size || this._pulseAnim) return;
    this._pulseAnim = this.scheduler.animate(this.owner, () => {
      const t = performance.now();
      for (const [id, t0] of this.pulses) if (t - t0 > 900) this.pulses.delete(id);
      if (!this.pulses.size) this.cancelPulses();
      this.owner.invalidate();
    });
  }

  cancelPulses() {
    this._pulseAnim?.dispose();
    this._pulseAnim = null;
    this.pulses.clear();
  }

  /** Screen -> world. @param {number} px @param {number} py */
  toWorld(px, py) {
    return { x: (px - this.t.x) / this.t.k, y: (py - this.t.y) / this.t.k };
  }

  /** Item under a screen point. @param {number} px @param {number} py */
  hitItem(px, py) {
    const p = this.toWorld(px, py);
    const cell = this.grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`);
    if (!cell || !this.scene) return null;
    for (let i = cell.length - 1; i >= 0; i--) {
      const it = /** @type {import('./svg.js').SceneItem} */ (this.scene.items.get(cell[i]));
      if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) return it.id;
    }
    return null;
  }

  /** Innermost frame under a screen point (header band preferred). @param {number} px @param {number} py */
  hitFrame(px, py) {
    if (!this.scene) return null;
    const p = this.toWorld(px, py);
    let best = null;
    for (const f of this.scene.frames) {
      if (p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) {
        if (!best || f.depth >= best.depth) best = f;
      }
    }
    return best ? best.id : null;
  }

  draw() {
    const sc = this.scene;
    const c = this.c2d;
    const P = this.P;
    const { x: tx, y: ty, k } = this.t;
    const dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!sc) return;
    c.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    const vx0 = -tx / k;
    const vy0 = -ty / k;
    const vx1 = (this.w - tx) / k;
    const vy1 = (this.h - ty) / k;
    const vis = (x, y, w, h) => x + w >= vx0 && x <= vx1 && y + h >= vy0 && y <= vy1;
    const px = 1 / k; // one screen pixel in world units
    const detail = k >= 0.55;
    const hov = this.hover;

    // frames
    for (const f of sc.frames) {
      if (!vis(f.x, f.y, f.w, f.h)) continue;
      if (f.w * k < 3) continue;
      c.fillStyle = f.depth % 2 ? P.frame1 : P.frame0;
      c.fillRect(f.x, f.y, f.w, f.h);
      c.lineWidth = px;
      c.strokeStyle = P.border;
      c.strokeRect(f.x, f.y, f.w, f.h);
    }

    // edges, batched per style
    const batches = { base: new Path2D(), cone: new Path2D(), up: new Path2D() };
    let anyHover = false;
    for (const e of sc.edges) {
      const g = e.g;
      const minx = Math.min(g.x1, g.x2, g.c1x, g.c2x);
      const maxx = Math.max(g.x1, g.x2, g.c1x, g.c2x);
      const miny = Math.min(g.y1, g.y2, g.c1y, g.c2y);
      const maxy = Math.max(g.y1, g.y2, g.c1y, g.c2y);
      if (!vis(minx, miny, maxx - minx, maxy - miny)) continue;
      let b = batches.base;
      if (hov) {
        if ((e.a === hov.id || hov.cone.has(e.a)) && hov.cone.has(e.b)) { b = batches.cone; anyHover = true; }
        else if (hov.up.has(e.a) && (e.b === hov.id || hov.up.has(e.b))) { b = batches.up; anyHover = true; }
      }
      b.moveTo(g.x1, g.y1);
      if (k < 0.12) b.lineTo(g.x2, g.y2);
      else b.bezierCurveTo(g.c1x, g.c1y, g.c2x, g.c2y, g.x2, g.y2);
      if (k >= 0.6) {
        // arrowhead at the target
        const ang = Math.atan2(g.y2 - g.c2y, g.x2 - g.c2x);
        const s = 6;
        b.moveTo(g.x2, g.y2);
        b.lineTo(g.x2 - s * Math.cos(ang - 0.45), g.y2 - s * Math.sin(ang - 0.45));
        b.moveTo(g.x2, g.y2);
        b.lineTo(g.x2 - s * Math.cos(ang + 0.45), g.y2 - s * Math.sin(ang + 0.45));
      }
    }
    c.lineWidth = Math.max(px, 1.1);
    c.strokeStyle = hov ? P.edgeDim : P.edge;
    c.stroke(batches.base);
    if (anyHover) {
      c.lineWidth = Math.max(px * 1.5, 2.4);
      c.strokeStyle = P.up;
      c.stroke(batches.up);
      c.strokeStyle = P.coneStrong;
      c.stroke(batches.cone);
    }

    // items
    const now = this.pulses.size ? performance.now() : 0;
    c.textBaseline = 'alphabetic';
    for (const it of sc.items.values()) {
      if (!vis(it.x - 4, it.y - 4, it.w + 8, it.h + 8)) continue;
      const L = this.label(it.id);
      const isProxy = it.kind === 'proxy';
      let fill = P.node;
      if (hov) {
        if (hov.id === it.id) fill = P.coneStrong;
        else if (hov.cone.has(it.id)) fill = P.cone;
        else if (hov.up.has(it.id)) fill = P.up;
      }
      c.globalAlpha = hov && hov.id !== it.id && !hov.cone.has(it.id) && !hov.up.has(it.id) ? 0.45 : 1;
      c.fillStyle = P.node;
      c.fillRect(it.x, it.y, it.w, it.h);
      if (fill !== P.node) { c.fillStyle = fill; c.fillRect(it.x, it.y, it.w, it.h); }
      c.lineWidth = Math.max(px, isProxy ? 1 : 1.5);
      c.strokeStyle = isProxy ? P.border : (P.prov[L.prov] || P.prov.computed);
      if (isProxy) c.setLineDash([4 * Math.max(1, px), 3 * Math.max(1, px)]);
      c.strokeRect(it.x, it.y, it.w, it.h);
      if (isProxy) c.setLineDash([]);
      if (this.sel.has(it.id)) {
        c.lineWidth = Math.max(px * 2, 2);
        c.strokeStyle = P.focus;
        c.strokeRect(it.x - 3.5, it.y - 3.5, it.w + 7, it.h + 7);
      }
      if (now) {
        const t0 = this.pulses.get(it.id);
        if (t0 !== undefined) {
          const a = Math.max(0, 1 - (now - t0) / 900);
          c.globalAlpha = a;
          c.lineWidth = Math.max(px, 1 + 3 * a);
          c.strokeStyle = P.coneStrong;
          c.strokeRect(it.x - 4, it.y - 4, it.w + 8, it.h + 8);
        }
      }
      c.globalAlpha = 1;
      if (!detail) continue;
      c.fillStyle = isProxy ? P.fg : (P.prov[L.prov] || P.prov.computed);
      if (!isProxy) {
        c.font = `700 11px ${FONT_UI}`;
        c.fillText(PROVENANCE[L.prov]?.glyph || 'ƒ', it.x + 7, it.y + 13.5);
        c.fillStyle = P.fg;
        c.font = `12px ${FONT_UI}`;
        c.fillText(fitText(L.name, it.w - 25, 6.7), it.x + 19, it.y + 13.5);
        if (L.value) {
          c.fillStyle = P.muted;
          c.font = `11px ${FONT_UI}`;
          c.fillText(L.value, it.x + 19, it.y + 26.5);
        }
      } else {
        c.font = `600 12px ${FONT_UI}`;
        c.fillText(`▸ ${fitText(L.name, it.w - 30, 7)}`, it.x + 7, it.y + 15);
        c.fillStyle = P.muted;
        c.font = `10.5px ${FONT_UI}`;
        (L.lines || []).forEach((ln, i) => c.fillText(ln, it.x + 8, it.y + 29 + i * 12));
      }
    }

    // frame titles in screen space (constant size), only where the frame is wide enough
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.font = `600 11px ${FONT_UI}`;
    for (const f of sc.frames) {
      const sw = f.w * k;
      if (sw < 70 || !vis(f.x, f.y, f.w, f.h)) continue;
      const sx = f.x * k + tx;
      const sy = f.y * k + ty;
      if (sy + 14 < 0 || sy > this.h) continue;
      c.fillStyle = P.muted;
      c.fillText(fitText(`${f.depth ? '▾ ' : ''}${f.name} · ${f.proto}`, sw - 12, 6.8), sx + 6, sy + 14);
    }
  }

  dispose() {
    this.cancelPulses();
    this.canvas.remove();
    this.labels.clear();
    this.grid.clear();
    this.scene = null;
  }
}
