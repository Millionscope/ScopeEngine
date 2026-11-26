/**
 * The single requestAnimationFrame loop. Editors never call requestAnimationFrame directly:
 * they call invalidate() (-> scheduler.request(editor)), and the scheduler renders each dirty,
 * visible target at most once per frame. Animations (3D scenes, pulses) register with
 * animate() and only run while their owner is visible.
 * @module core/scheduler
 */
import { toDisposable, leakCounters } from './disposable.js';

/**
 * @typedef {Object} FrameInfo
 * @property {number} time        rAF timestamp (ms)
 * @property {number} dt          ms since previous frame (capped at 100)
 * @property {number} frame       frame counter
 * @property {boolean} reducedMotion
 */

/**
 * @typedef {Object} RenderTarget
 * @property {(info: FrameInfo) => void} renderFrame
 * @property {() => boolean=} isVisible
 */

export class Scheduler {
  constructor() {
    /** @type {Set<RenderTarget>} */
    this._pending = new Set();
    /** @type {Set<{owner: RenderTarget|null, cb: (info: FrameInfo) => void}>} */
    this._anims = new Set();
    /** @type {Array<() => void>} */
    this._after = [];
    /** @type {Array<(info: FrameInfo) => void>} */
    this._before = [];
    this._raf = 0;
    this._frame = 0;
    this._last = 0;
    this.reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    /** rolling stats for the debug overlay */
    this.stats = { fps: 0, frameMs: 0, renders: 0, frames: 0 };
    this._fpsWindow = [];
    this._tick = this._tick.bind(this);
  }

  _ensure() {
    if (!this._raf) this._raf = requestAnimationFrame(this._tick);
  }

  /** Schedule a render of `target` on the next frame (coalesced). @param {RenderTarget} target */
  request(target) {
    this._pending.add(target);
    this._ensure();
  }

  /** @param {RenderTarget} target */
  cancel(target) {
    this._pending.delete(target);
  }

  /**
   * Run cb every frame while the returned disposable is alive and owner (if any) is visible.
   * @param {RenderTarget|null} owner @param {(info: FrameInfo) => void} cb
   */
  animate(owner, cb) {
    const entry = { owner, cb };
    this._anims.add(entry);
    leakCounters.timers++;
    this._ensure();
    return toDisposable(() => {
      if (this._anims.delete(entry)) leakCounters.timers--;
    });
  }

  /** Run once before the next frame's renders. @param {(info: FrameInfo) => void} fn */
  beforeFrame(fn) {
    this._before.push(fn);
    this._ensure();
  }

  /** Run once after the next frame's renders. @param {() => void} fn */
  afterFrame(fn) {
    this._after.push(fn);
    this._ensure();
  }

  nextFrame() {
    return new Promise((resolve) => this.afterFrame(resolve));
  }

  /**
   * Coalesce calls to at most one per frame; the last arguments win.
   * @template {any[]} A
   * @param {(...args: A) => void} fn
   */
  rafThrottle(fn) {
    let args = null;
    let queued = false;
    const self = this;
    const run = () => {
      queued = false;
      const a = args;
      args = null;
      if (a) fn(...a);
    };
    const wrapped = /** @type {((...a: A) => void) & {cancel: () => void, flush: () => void}} */ (function (...a) {
      args = a;
      if (!queued) {
        queued = true;
        self.beforeFrame(run);
      }
    });
    wrapped.cancel = () => { args = null; };
    wrapped.flush = () => { if (args) run(); };
    return wrapped;
  }

  /**
   * Run when the browser is idle (or after `timeoutMs`).
   * @param {() => void} fn @param {number} [timeoutMs]
   */
  idle(fn, timeoutMs = 300) {
    let cancelled = false;
    let id;
    if (typeof requestIdleCallback === 'function') {
      id = requestIdleCallback(() => { if (!cancelled) fn(); }, { timeout: timeoutMs });
      return toDisposable(() => { cancelled = true; cancelIdleCallback(id); });
    }
    id = setTimeout(() => { if (!cancelled) fn(); }, 16);
    return toDisposable(() => { cancelled = true; clearTimeout(id); });
  }

  /** @param {number} time */
  _tick(time) {
    this._raf = 0;
    const t0 = performance.now();
    const dt = this._last ? Math.min(100, time - this._last) : 16;
    this._last = time;
    const info = { time, dt, frame: ++this._frame, reducedMotion: this.reducedMotion };

    const before = this._before;
    this._before = [];
    for (const fn of before) {
      try { fn(info); } catch (err) { console.error('[scheduler] beforeFrame', err); }
    }

    for (const a of [...this._anims]) {
      if (a.owner && a.owner.isVisible && !a.owner.isVisible()) continue;
      try { a.cb(info); } catch (err) { console.error('[scheduler] animation', err); }
    }

    const pending = [...this._pending];
    this._pending.clear();
    let renders = 0;
    for (const t of pending) {
      if (t.isVisible && !t.isVisible()) continue; // stays dirty; re-requested when shown
      try {
        t.renderFrame(info);
        renders++;
      } catch (err) {
        console.error('[scheduler] render failed', err);
      }
    }

    const after = this._after;
    this._after = [];
    for (const fn of after) {
      try { fn(); } catch (err) { console.error('[scheduler] afterFrame', err); }
    }

    const ms = performance.now() - t0;
    this.stats.frameMs = this.stats.frameMs * 0.9 + ms * 0.1;
    this.stats.renders = renders;
    this.stats.frames = this._frame;
    this._fpsWindow.push(time);
    while (this._fpsWindow.length && time - this._fpsWindow[0] > 1000) this._fpsWindow.shift();
    this.stats.fps = this._fpsWindow.length;

    if (this._pending.size || this._anims.size || this._before.length || this._after.length) this._ensure();
  }
}

/**
 * Trailing debounce with cancel().
 * @template {any[]} A
 * @param {(...args: A) => void} fn @param {number} ms
 */
export function debounce(fn, ms) {
  let id = 0;
  const wrapped = /** @type {((...a: A) => void) & {cancel: () => void}} */ (function (...a) {
    clearTimeout(id);
    id = setTimeout(() => fn(...a), ms);
  });
  wrapped.cancel = () => clearTimeout(id);
  return wrapped;
}

/**
 * Leading + trailing throttle with cancel().
 * @template {any[]} A
 * @param {(...args: A) => void} fn @param {number} ms
 */
export function throttle(fn, ms) {
  let last = 0;
  let id = 0;
  let lastArgs = null;
  const wrapped = /** @type {((...a: A) => void) & {cancel: () => void}} */ (function (...a) {
    const now = Date.now();
    lastArgs = a;
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else {
      clearTimeout(id);
      id = setTimeout(() => {
        last = Date.now();
        fn(...lastArgs);
      }, ms - (now - last));
    }
  });
  wrapped.cancel = () => clearTimeout(id);
  return wrapped;
}
