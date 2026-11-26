/**
 * Minimap for the Scope Graph sidebar (N region): the whole layout in miniature with the
 * current viewport as a rectangle. Click or drag to pan the main view. Colors from tokens.
 * @module editors/graph/minimap
 */
import { DisposableStore, listen } from '../../core/disposable.js';
import { token, provColor, alpha } from '../../theme/tokens.js';

export class Minimap {
  /**
   * @param {HTMLElement} host
   * @param {{onPan: (wx: number, wy: number) => void}} opts
   */
  constructor(host, opts) {
    this.d = new DisposableStore();
    this.onPan = opts.onPan;
    this.wrap = document.createElement('div');
    this.wrap.className = 'ms-graph-minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Minimap of the scope graph. Click or drag to move the view.');
    this.wrap.appendChild(this.canvas);
    host.appendChild(this.wrap);
    this.c2d = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    /** @type {import('./svg.js').Scene|null} */
    this.scene = null;
    /** @type {(id: string) => string} */
    this.provOf = () => 'computed';
    this.view = { x: 0, y: 0, k: 1, w: 1, h: 1 };
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    let dragging = false;
    const pan = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      this.onPan((mx - this.ox) / this.scale, (my - this.oy) / this.scale);
    };
    this.d.add(listen(this.canvas, 'pointerdown', (e) => {
      const pe = /** @type {PointerEvent} */ (e);
      dragging = true;
      this.canvas.setPointerCapture(pe.pointerId);
      pan(pe);
    }));
    this.d.add(listen(this.canvas, 'pointermove', (e) => { if (dragging) pan(e); }));
    this.d.add(listen(this.canvas, 'pointerup', () => { dragging = false; }));
    this.d.add(listen(this.canvas, 'pointercancel', () => { dragging = false; }));
  }

  get connected() { return this.wrap.isConnected && this.wrap.offsetParent !== null; }

  /** @param {import('./svg.js').Scene} scene @param {(id: string) => string} provOf */
  setScene(scene, provOf) {
    this.scene = scene;
    this.provOf = provOf;
  }

  /** @param {{x: number, y: number, k: number}} t @param {number} w @param {number} h */
  setView(t, w, h) {
    this.view = { ...t, w, h };
  }

  draw() {
    const sc = this.scene;
    if (!sc || !this.connected) return;
    const cw = Math.max(80, this.wrap.clientWidth || 200);
    const ch = Math.round(Math.max(70, Math.min(200, cw * (sc.height / Math.max(1, sc.width)))));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
      this.canvas.style.width = `${cw}px`;
      this.canvas.style.height = `${ch}px`;
    }
    const pad = 4;
    const s = Math.min((cw - pad * 2) / sc.width, (ch - pad * 2) / sc.height);
    this.scale = s;
    this.ox = (cw - sc.width * s) / 2;
    this.oy = (ch - sc.height * s) / 2;
    const c = this.c2d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    c.fillStyle = token('editor.background', '#1f1f1f');
    c.fillRect(0, 0, cw, ch);
    c.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.ox, dpr * this.oy);
    const border = token('widget.border', '#313131');
    c.lineWidth = 1 / s;
    c.strokeStyle = border;
    for (const f of sc.frames) {
      c.fillStyle = f.depth % 2 ? token('sideBar.background', '#181818') : token('editor.background', '#1f1f1f');
      c.fillRect(f.x, f.y, f.w, f.h);
      c.strokeRect(f.x, f.y, f.w, f.h);
    }
    const colors = new Map();
    for (const it of sc.items.values()) {
      const p = it.kind === 'proxy' ? 'proxy' : this.provOf(it.id);
      let col = colors.get(p);
      if (!col) { col = p === 'proxy' ? token('descriptionForeground', '#9d9d9d') : provColor(p); colors.set(p, col); }
      c.fillStyle = col;
      c.fillRect(it.x, it.y, it.w, it.h);
    }
    // viewport
    const v = this.view;
    const x = -v.x / v.k;
    const y = -v.y / v.k;
    const w = v.w / v.k;
    const h = v.h / v.k;
    const focus = token('focusBorder', '#0078d4');
    c.fillStyle = alpha(focus, 0.12);
    c.fillRect(x, y, w, h);
    c.lineWidth = 1.5 / s;
    c.strokeStyle = focus;
    c.strokeRect(x, y, w, h);
  }

  dispose() {
    this.d.dispose();
    this.wrap.remove();
    this.scene = null;
  }
}
