/**
 * Provenance mark: glyph + color + accessible label. Never color alone.
 * input ● · observed ◆ · estimated ~ · computed ƒ · proven ✓ · failed ✕ · contested ≈
 * @module editors/shared/prov-mark
 */
import { PROVENANCE } from '../../theme/tokens.js';

/**
 * @param {string} kind
 * @param {{title?: string}} [opts]
 * @returns {HTMLElement}
 */
export function provMark(kind, opts = {}) {
  const p = PROVENANCE[kind] || PROVENANCE.computed;
  const el = document.createElement('span');
  el.className = 'ms-prov';
  el.dataset.prov = kind in PROVENANCE ? kind : 'computed';
  el.textContent = p.glyph;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', p.label);
  el.title = opts.title || `${p.label}: ${p.description}`;
  return el;
}

/** Legend of the five classes (for empty states, headers). */
export function provLegend() {
  const el = document.createElement('span');
  el.className = 'ms-prov-legend';
  for (const k of ['input', 'observed', 'estimated', 'computed', 'proven']) {
    const item = document.createElement('span');
    item.append(provMark(k), document.createTextNode(PROVENANCE[k].label));
    el.appendChild(item);
  }
  return el;
}
