/**
 * Splitter behavior: drag to resize (pointer capture, live, coalesced per frame), double-click
 * to equalize, arrow keys for keyboard resizing. role="separator" with aria-valuenow.
 * @module workspace/splitter
 */
import { DisposableStore, listen } from '../core/disposable.js';

/**
 * @param {HTMLElement} splitterEl
 * @param {{
 *   split: import('./area-tree.js').SplitNode,
 *   tree: import('./area-tree.js').AreaTree,
 *   splitEl: HTMLElement,
 *   paneA: HTMLElement,
 *   paneB: HTMLElement,
 *   labelA: () => string,
 *   labelB: () => string,
 *   scheduler: import('../core/scheduler.js').Scheduler,
 *   onChange: (final: boolean) => void,
 * }} opts
 */
export function attachSplitter(splitterEl, opts) {
  const { split, tree, splitEl, paneA, paneB, scheduler, onChange } = opts;
  const d = new DisposableStore();
  const isRow = split.dir === 'row';

  splitterEl.setAttribute('role', 'separator');
  splitterEl.setAttribute('aria-orientation', isRow ? 'vertical' : 'horizontal');
  splitterEl.setAttribute('aria-valuemin', '0');
  splitterEl.setAttribute('aria-valuemax', '100');
  splitterEl.tabIndex = 0;

  const extent = () => {
    const r = splitEl.getBoundingClientRect();
    return isRow ? r.width : r.height;
  };

  const apply = (ratio) => {
    split.ratio = ratio;
    paneA.style.flexGrow = String(ratio);
    paneB.style.flexGrow = String(1 - ratio);
    splitterEl.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    splitterEl.setAttribute('aria-valuetext', `${Math.round(ratio * 100)}% ${opts.labelA()}, ${Math.round((1 - ratio) * 100)}% ${opts.labelB()}`);
  };
  apply(split.ratio);
  splitterEl.setAttribute('aria-label', `Resize ${opts.labelA()} and ${opts.labelB()}`);

  const applyLive = scheduler.rafThrottle((ratio) => {
    apply(ratio);
    onChange(false);
  });

  let dragging = false;
  let pointerId = -1;

  d.add(listen(splitterEl, 'pointerdown', (ev) => {
    const e = /** @type {PointerEvent} */ (ev);
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    pointerId = e.pointerId;
    splitterEl.setPointerCapture(pointerId);
    splitterEl.classList.add('is-dragging');
    document.body.classList.add(isRow ? 'is-resizing-row' : 'is-resizing-col');
  }));

  d.add(listen(splitterEl, 'pointermove', (ev) => {
    if (!dragging) return;
    const e = /** @type {PointerEvent} */ (ev);
    const r = splitEl.getBoundingClientRect();
    const size = isRow ? r.width : r.height;
    const pos = isRow ? e.clientX - r.left : e.clientY - r.top;
    const ratio = tree.clampRatio(split, pos / Math.max(1, size - 1), size);
    applyLive(ratio);
  }));

  const end = () => {
    if (!dragging) return;
    dragging = false;
    try { splitterEl.releasePointerCapture(pointerId); } catch { /* already released */ }
    splitterEl.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-row', 'is-resizing-col');
    applyLive.flush();
    onChange(true);
  };
  d.add(listen(splitterEl, 'pointerup', end));
  d.add(listen(splitterEl, 'pointercancel', end));
  d.add(listen(splitterEl, 'lostpointercapture', end));

  d.add(listen(splitterEl, 'dblclick', () => {
    apply(tree.clampRatio(split, 0.5, extent()));
    onChange(true);
  }));

  d.add(listen(splitterEl, 'keydown', (ev) => {
    const e = /** @type {KeyboardEvent} */ (ev);
    const step = e.shiftKey ? 0.1 : 0.02;
    let delta = 0;
    if ((isRow && e.key === 'ArrowLeft') || (!isRow && e.key === 'ArrowUp')) delta = -step;
    else if ((isRow && e.key === 'ArrowRight') || (!isRow && e.key === 'ArrowDown')) delta = step;
    else if (e.key === 'Home') delta = -1;
    else if (e.key === 'End') delta = 1;
    else if (e.key === 'Enter') { apply(tree.clampRatio(split, 0.5, extent())); onChange(true); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    apply(tree.clampRatio(split, split.ratio + delta, extent()));
    onChange(true);
  }));

  return d;
}
