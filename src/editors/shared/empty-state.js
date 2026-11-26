/**
 * Consistent empty states with a suggested action.
 * @module editors/shared/empty-state
 */

/**
 * @param {{icon?: string, title: string, text?: string, action?: {label: string, run: () => void}}} opts
 * @returns {HTMLElement}
 */
export function emptyState({ icon = 'info', title, text = '', action }) {
  const el = document.createElement('div');
  el.className = 'ms-empty';
  const i = document.createElement('span');
  i.className = `codicon codicon-${icon}`;
  i.setAttribute('aria-hidden', 'true');
  const t = document.createElement('div');
  t.className = 'ms-empty-title';
  t.textContent = title;
  el.append(i, t);
  if (text) {
    const p = document.createElement('div');
    p.className = 'ms-empty-text';
    p.textContent = text;
    el.append(p);
  }
  if (action) {
    const b = document.createElement('button');
    b.className = 'ms-btn is-secondary is-small';
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    el.append(b);
  }
  return el;
}
