/**
 * Evidence view helpers: status vocabulary, source icons and quoted spans with the matched
 * value highlighted.
 * @module editors/evidence/view
 */

/** status -> label, pill style (editors.css .ms-status), description */
export const STATUS_INFO = {
  matched: { label: 'matched', pill: 'pass', description: 'The value, unit and date appear in the cited span.' },
  mismatch: { label: 'mismatch', pill: 'fail', description: 'The graph value does not match the cited span.' },
  stale: { label: 'stale', pill: 'warn', description: 'The source is older than conflicting evidence; kept, but not used as observed.' },
  supports: { label: 'supports estimate', pill: 'statistical', description: 'Backs an estimated distribution rather than an observed value.' },
  overridden: { label: 'overridden', pill: 'na', description: 'The user overrode the observed value; it is now an input.' },
  unbound: { label: 'unbound', pill: 'na', description: 'Extracted but not yet bound to a metric.' },
};

/** @param {string} type */
export function sourceIcon(type) {
  switch ((type || '').toUpperCase()) {
    case 'PDF': return 'file-pdf';
    case 'CSV': return 'database';
    case 'WEB': return 'globe';
    case 'API': return 'json';
    case 'DOC': return 'file-text';
    default: return 'file';
  }
}

/**
 * Quoted span with the matched value highlighted (text only; never HTML from the source).
 * @param {string} span @param {string} match
 */
export function quoteWithMatch(span, match) {
  const frag = document.createElement('span');
  const text = String(span || '');
  const i = match ? text.indexOf(match) : -1;
  if (i < 0) {
    frag.textContent = text;
    return frag;
  }
  const m = document.createElement('mark');
  m.className = 'ms-hit';
  m.textContent = match;
  frag.append(document.createTextNode(text.slice(0, i)), m, document.createTextNode(text.slice(i + match.length)));
  return frag;
}
