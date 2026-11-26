/**
 * Blender corner action zones. Each area has 14x14 px zones in its top-left and top-right
 * corners:
 *  - drag from a corner INTO THE SAME AREA -> split along the drag axis at the pointer, with a
 *    live preview line; the new area copies the editor type and takes the corner's side;
 *  - drag INTO AN ADJACENT AREA that shares a full edge -> join preview (the area to be removed
 *    is darkened with an arrow); release joins;
 *  - Esc cancels. A press without a drag is forwarded as a click to what lies underneath.
 * @module workspace/corner-gestures
 */
import { DisposableStore, listen } from '../core/disposable.js';

const DRAG_THRESHOLD = 6;

/**
 * @typedef {Object} GestureHost
 * @property {(x:number, y:number) => any} areaAt              Area instance under a point (active workspace)
 * @property {(keepId:string, removeId:string) => {ok:boolean, reason?:string}} canJoin
 * @property {(areaId:string, dir:'row'|'col', ratio:number, newFirst:boolean) => void} split
 * @property {(keepId:string, removeId:string) => void} join
 */

export class CornerGestures {
  /** @param {GestureHost} host */
  constructor(host) {
    this.host = host;
    /** @type {null | {cancel: () => void}} */
    this.active = null;
  }

  /**
   * Add corner zones to an area. Returns a disposable that removes them.
   * @param {{el: HTMLElement, id: string}} area
   */
  attach(area) {
    const d = new DisposableStore();
    for (const corner of /** @type {const} */ (['tl', 'tr'])) {
      const z = document.createElement('div');
      z.className = `ms-corner is-${corner}`;
      z.setAttribute('aria-hidden', 'true');
      z.title = 'Drag inward to split; drag into a neighbor to join';
      area.el.appendChild(z);
      d.add(listen(z, 'pointerdown', (e) => this._start(/** @type {PointerEvent} */ (e), area, corner, z)));
      d.add({ dispose: () => z.remove() });
    }
    return d;
  }

  /**
   * @param {PointerEvent} e @param {{el: HTMLElement, id: string}} area @param {'tl'|'tr'} corner @param {HTMLElement} zone
   */
  _start(e, area, corner, zone) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.active?.cancel();
    const sx = e.clientX;
    const sy = e.clientY;
    const pid = e.pointerId;
    zone.setPointerCapture(pid);
    const d = new DisposableStore();
    let started = false;
    /** @type {null | {kind:'split', dir:'row'|'col', ratio:number, newFirst:boolean} | {kind:'join', targetId:string, ok:boolean}} */
    let action = null;

    const line = document.createElement('div');
    line.className = 'ms-gesture-line';
    const overlay = document.createElement('div');
    overlay.className = 'ms-join-overlay';
    const hint = document.createElement('div');
    hint.className = 'ms-gesture-hint';

    const cleanup = () => {
      d.dispose();
      line.remove();
      overlay.remove();
      hint.remove();
      document.body.classList.remove('is-gesturing');
      try { zone.releasePointerCapture(pid); } catch { /* noop */ }
      this.active = null;
    };
    this.active = { cancel: cleanup };

    const showHint = (text, x, y) => {
      hint.textContent = text;
      hint.style.left = `${x + 14}px`;
      hint.style.top = `${y + 14}px`;
      if (!hint.isConnected) document.body.appendChild(hint);
    };

    d.add(listen(zone, 'pointermove', (ev) => {
      const pe = /** @type {PointerEvent} */ (ev);
      const dx = pe.clientX - sx;
      const dy = pe.clientY - sy;
      if (!started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        started = true;
        document.body.classList.add('is-gesturing');
      }
      const under = this.host.areaAt(pe.clientX, pe.clientY);
      if (!under) {
        action = null;
        line.remove();
        overlay.remove();
        showHint('Release over an area', pe.clientX, pe.clientY);
        return;
      }
      if (under.id === area.id) {
        overlay.remove();
        const r = area.el.getBoundingClientRect();
        const dir = Math.abs(dx) >= Math.abs(dy) ? 'row' : 'col';
        let ratio;
        if (dir === 'row') {
          ratio = (pe.clientX - r.left) / r.width;
          line.className = 'ms-gesture-line is-vertical';
          line.style.left = `${pe.clientX - r.left}px`;
          line.style.top = '';
        } else {
          ratio = (pe.clientY - r.top) / r.height;
          line.className = 'ms-gesture-line is-horizontal';
          line.style.top = `${pe.clientY - r.top}px`;
          line.style.left = '';
        }
        ratio = Math.min(0.9, Math.max(0.1, ratio));
        const newFirst = dir === 'col' ? true : corner === 'tl';
        action = { kind: 'split', dir, ratio, newFirst };
        if (line.parentElement !== area.el) area.el.appendChild(line);
        showHint(dir === 'row' ? 'Split vertically' : 'Split horizontally', pe.clientX, pe.clientY);
      } else {
        line.remove();
        const chk = this.host.canJoin(area.id, under.id);
        overlay.className = chk.ok ? 'ms-join-overlay' : 'ms-join-overlay is-invalid';
        overlay.innerHTML = '';
        if (chk.ok) {
          const ar = area.el.getBoundingClientRect();
          const ur = under.el.getBoundingClientRect();
          const arrow = ur.left >= ar.right - 2 ? 'arrow-right' : ur.right <= ar.left + 2 ? 'arrow-left' : ur.top >= ar.bottom - 2 ? 'arrow-down' : 'arrow-up';
          const i = document.createElement('span');
          i.className = `codicon codicon-${arrow}`;
          overlay.appendChild(i);
        }
        if (overlay.parentElement !== under.el) under.el.appendChild(overlay);
        action = { kind: 'join', targetId: under.id, ok: chk.ok };
        showHint(chk.ok ? 'Join: this area will be replaced' : `Cannot join: ${chk.reason}`, pe.clientX, pe.clientY);
      }
    }));

    d.add(listen(zone, 'pointerup', (ev) => {
      const pe = /** @type {PointerEvent} */ (ev);
      const act = action;
      const wasDrag = started;
      cleanup();
      if (!wasDrag) {
        // a plain click on the corner: forward to whatever is underneath (e.g. the type button)
        zone.style.pointerEvents = 'none';
        const below = /** @type {HTMLElement|null} */ (document.elementFromPoint(pe.clientX, pe.clientY));
        zone.style.pointerEvents = '';
        below?.click();
        return;
      }
      if (!act) return;
      if (act.kind === 'split') this.host.split(area.id, act.dir, act.ratio, act.newFirst);
      else if (act.kind === 'join' && act.ok) this.host.join(area.id, act.targetId);
    }));

    d.add(listen(zone, 'pointercancel', cleanup));
    d.add(listen(window, 'keydown', (ev) => {
      if (/** @type {KeyboardEvent} */ (ev).key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cleanup();
      }
    }, true));
  }
}
