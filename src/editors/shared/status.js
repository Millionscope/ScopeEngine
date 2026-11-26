/**
 * Status pill content: a codicon plus a word, in place of ✓ / ✕ / ⚠ text glyphs.
 * @module editors/shared/status
 */

/** data-status -> codicon */
const ICON = { pass: 'pass', proven: 'verified-filled', fail: 'error', warn: 'warning', not_proven: 'warning' };

/**
 * Sets `data-status` and renders `[icon] text` into `el` (text is never parsed as HTML).
 * @param {HTMLElement} el @param {string} status @param {string} text
 */
export function setStatus(el, status, text) {
  el.dataset.status = status;
  if (!ICON[status]) { el.replaceChildren(text); return; }
  const i = document.createElement('span');
  i.className = `codicon codicon-${ICON[status]}`;
  i.setAttribute('aria-hidden', 'true');
  el.replaceChildren(i, text);
}
