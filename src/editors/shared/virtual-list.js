/**
 * Windowed list: renders only visible rows (plus overscan) and recycles row elements, so
 * 100k rows scroll smoothly. Rendering is scheduled through the shared frame scheduler
 * (editors never call requestAnimationFrame directly).
 * @module editors/shared/virtual-list
 */

export class VirtualList {
  /**
   * @param {{
   *   container: HTMLElement,
   *   rowHeight?: number,
   *   overscan?: number,
   *   renderRow: (index: number, row: HTMLElement) => void,
   *   schedule: (fn: () => void) => void,
   *   role?: string,
   *   label?: string,
   *   minWidth?: number,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.rowHeight = opts.rowHeight || 22;
    this.overscan = opts.overscan ?? 8;
    this.count = 0;
    this.el = document.createElement('div');
    this.el.className = 'ms-vlist';
    this.el.tabIndex = 0;
    if (opts.role) this.el.setAttribute('role', opts.role);
    if (opts.label) this.el.setAttribute('aria-label', opts.label);
    this.sizer = document.createElement('div');
    this.sizer.className = 'ms-vlist-sizer';
    if (opts.minWidth) this.sizer.style.minWidth = `${opts.minWidth}px`;
    this.el.appendChild(this.sizer);
    /** @type {Map<number, HTMLElement>} */
    this.rows = new Map();
    /** @type {HTMLElement[]} */
    this.pool = [];
    this._queued = false;
    this._onScroll = () => this.schedule();
    this.el.addEventListener('scroll', this._onScroll, { passive: true });
    opts.container.appendChild(this.el);
  }

  schedule() {
    if (this._queued) return;
    this._queued = true;
    this.opts.schedule(() => {
      this._queued = false;
      this.render();
    });
  }

  /** @param {number} n */
  setCount(n) {
    this.count = n;
    this.sizer.style.height = `${n * this.rowHeight}px`;
    this.el.setAttribute('aria-rowcount', String(n));
    this.render(true);
  }

  /** Re-render visible rows (data changed). */
  refresh() {
    this.render(true);
  }

  /** @param {boolean} [force] */
  render(force = false) {
    const h = this.el.clientHeight || 400;
    const top = this.el.scrollTop;
    const first = Math.max(0, Math.floor(top / this.rowHeight) - this.overscan);
    const last = Math.min(this.count - 1, Math.ceil((top + h) / this.rowHeight) + this.overscan);
    // recycle rows outside the window
    for (const [i, row] of this.rows) {
      if (i < first || i > last || i >= this.count) {
        this.rows.delete(i);
        row.remove();
        this.pool.push(row);
      }
    }
    for (let i = first; i <= last; i++) {
      let row = this.rows.get(i);
      const fresh = !row;
      if (!row) {
        row = this.pool.pop() || document.createElement('div');
        row.className = 'ms-vlist-row';
        row.style.height = `${this.rowHeight}px`;
        this.rows.set(i, row);
        this.sizer.appendChild(row);
      }
      if (fresh || force) {
        row.style.transform = `translateY(${i * this.rowHeight}px)`;
        row.dataset.index = String(i);
        row.setAttribute('aria-rowindex', String(i + 1));
        this.opts.renderRow(i, row);
      }
    }
  }

  /** @param {number} i @param {'nearest'|'center'|'start'} [align] */
  scrollToIndex(i, align = 'nearest') {
    const y = i * this.rowHeight;
    const h = this.el.clientHeight;
    if (align === 'center') this.el.scrollTop = y - h / 2 + this.rowHeight / 2;
    else if (align === 'start') this.el.scrollTop = y;
    else if (y < this.el.scrollTop) this.el.scrollTop = y;
    else if (y + this.rowHeight > this.el.scrollTop + h) this.el.scrollTop = y + this.rowHeight - h;
    this.render();
  }

  /** @param {number} i */
  rowAt(i) { return this.rows.get(i) || null; }

  visibleRange() {
    const h = this.el.clientHeight || 400;
    return [Math.floor(this.el.scrollTop / this.rowHeight), Math.ceil((this.el.scrollTop + h) / this.rowHeight)];
  }

  dispose() {
    this.el.removeEventListener('scroll', this._onScroll);
    this.el.remove();
    this.rows.clear();
    this.pool = [];
  }
}
