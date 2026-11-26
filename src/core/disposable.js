/**
 * Disposables: the single mechanism for releasing listeners, observers, timers and resources.
 * Every editor owns a DisposableStore and disposes it on unmount, so switching an area's
 * editor type never leaks.
 *
 * `leakCounters` backs the debug overlay ("live listeners" must return to baseline after
 * cycling an area through every editor type).
 * @module core/disposable
 */

/** @typedef {{ dispose(): void }} Disposable */

/** Live counts for the debug overlay. */
export const leakCounters = {
  /** DOM/bus listeners registered through listen() or EventBus.on() and not yet disposed. */
  listeners: 0,
  /** Live ResizeObserver/IntersectionObserver instances created via observeResize(). */
  observers: 0,
  /** Live intervals/timeouts created via interval()/timeout(). */
  timers: 0,
};

/**
 * Wrap a function as a disposable (idempotent).
 * @param {() => void} fn
 * @returns {Disposable}
 */
export function toDisposable(fn) {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
}

export const NONE = Object.freeze({ dispose() {} });

/** A bag of disposables released together. */
export class DisposableStore {
  constructor() {
    /** @type {Set<Disposable>} */
    this._items = new Set();
    this._disposed = false;
  }
  /**
   * @template {Disposable} T
   * @param {T} d
   * @returns {T}
   */
  add(d) {
    if (!d) return d;
    if (this._disposed) {
      d.dispose();
      return d;
    }
    this._items.add(d);
    return d;
  }
  /** @param {Disposable} d */
  delete(d) {
    if (this._items.delete(d)) d.dispose();
  }
  /** Dispose all items but keep the store usable. */
  clear() {
    const items = [...this._items];
    this._items.clear();
    for (const d of items) {
      try { d.dispose(); } catch (err) { console.error('[dispose]', err); }
    }
  }
  get isDisposed() { return this._disposed; }
  get size() { return this._items.size; }
  dispose() {
    if (this._disposed) return;
    this.clear();
    this._disposed = true;
  }
}

/**
 * addEventListener with automatic removal and leak accounting.
 * @param {EventTarget} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} handler
 * @param {AddEventListenerOptions|boolean} [options]
 * @returns {Disposable}
 */
export function listen(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  leakCounters.listeners++;
  return toDisposable(() => {
    target.removeEventListener(type, handler, options);
    leakCounters.listeners--;
  });
}

/**
 * ResizeObserver wrapper.
 * @param {Element} el
 * @param {(entry: ResizeObserverEntry) => void} cb
 * @returns {Disposable}
 */
export function observeResize(el, cb) {
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) cb(e);
  });
  ro.observe(el);
  leakCounters.observers++;
  return toDisposable(() => {
    ro.disconnect();
    leakCounters.observers--;
  });
}

/**
 * @param {() => void} fn
 * @param {number} ms
 * @returns {Disposable}
 */
export function interval(fn, ms) {
  const id = setInterval(fn, ms);
  leakCounters.timers++;
  return toDisposable(() => {
    clearInterval(id);
    leakCounters.timers--;
  });
}

/**
 * @param {() => void} fn
 * @param {number} ms
 * @returns {Disposable}
 */
export function timeout(fn, ms) {
  let cleared = false;
  leakCounters.timers++;
  const id = setTimeout(() => {
    if (!cleared) {
      cleared = true;
      leakCounters.timers--;
    }
    fn();
  }, ms);
  return toDisposable(() => {
    if (cleared) return;
    cleared = true;
    clearTimeout(id);
    leakCounters.timers--;
  });
}
