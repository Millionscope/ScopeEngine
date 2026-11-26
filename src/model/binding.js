/**
 * No free numbers: every numeral in assistant prose is a reference into the graph,
 * rendered by the engine:
 *
 *   "Opening Location B leaves median monthly cash at {{bakery.monthly_cash.p50 | usd}},
 *    with a {{bakery.p_cash_negative | pct}} chance of a negative month."
 *
 * Path: [scenarioId::]scope.path.metric[.stat]   stat: value|p10|p50|p90|mean|sd|min|max
 * Format: usd | usd2 | usdk | pct | pct1 | num | int | compact | unit | bare
 *
 * This module is pure (no DOM): parse, resolve, evaluate and render to text, plus the
 * post-check that finds unbound numerals. editors/shared/bound-value.js renders to DOM.
 * @module model/binding
 */
import { formatAs, isCurrency, isProbability } from './format.js';

/**
 * @typedef {{type: 'text', text: string}
 *  | {type: 'bind', raw: string, path: string, fmt: string|null, scenario: string|null, nodeId: string|null, stat: string, error?: string}} Segment
 */

const BIND_RE = /\{\{\s*([^}|]+?)\s*(?:\|\s*([\w]+)\s*)?\}\}/g;

/**
 * @param {string} text
 * @returns {Segment[]}
 */
export function parseTemplate(text) {
  /** @type {Segment[]} */
  const out = [];
  let last = 0;
  BIND_RE.lastIndex = 0;
  let m;
  while ((m = BIND_RE.exec(text))) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    let path = m[1].trim();
    let scenario = null;
    const sep = path.indexOf('::');
    if (sep > 0) {
      scenario = path.slice(0, sep).trim();
      path = path.slice(sep + 2).trim();
    }
    out.push({ type: 'bind', raw: m[0], path, fmt: m[2] || null, scenario, nodeId: null, stat: 'value' });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/**
 * Resolve binding paths against the graph (in place).
 * @param {Segment[]} segments
 * @param {import('./graph.js').ScopeGraph} graph
 */
export function resolveSegments(segments, graph) {
  for (const s of segments) {
    if (s.type !== 'bind') continue;
    const r = graph.resolveBindingPath(s.path);
    if (!r) {
      s.error = `unbound reference "${s.path}"`;
      s.nodeId = null;
    } else {
      s.nodeId = r.nodeId;
      s.stat = r.stat;
      s.error = undefined;
    }
  }
  return segments;
}

/**
 * Value of a node statistic in a view (engine or scenario overlay).
 * @param {any} view @param {string} nodeId @param {string} stat
 */
export function statValue(view, nodeId, stat) {
  if (!stat || stat === 'value') return view.value(nodeId);
  const s = view.stats(nodeId);
  if (!s) return NaN;
  return /** @type {any} */ (s)[stat] ?? view.value(nodeId);
}

/** Default format for a unit/stat. @param {string} unit */
export function defaultFmt(unit) {
  if (isCurrency(unit)) return 'usd';
  if (isProbability(unit)) return 'pct';
  return 'unit';
}

/**
 * Render a template to plain text with current values (copy-to-clipboard, screen readers).
 * @param {string} text
 * @param {{graph: import('./graph.js').ScopeGraph, viewFor: (scenarioId: string|null) => any}} ctx
 */
export function renderTemplateText(text, ctx) {
  const segs = resolveSegments(parseTemplate(text), ctx.graph);
  return segs.map((s) => {
    if (s.type === 'text') return s.text;
    if (!s.nodeId) return `[${s.path}?]`;
    const unit = ctx.graph.node(s.nodeId)?.type.unit || '';
    const v = statValue(ctx.viewFor(s.scenario), s.nodeId, s.stat);
    return formatAs(v, s.fmt || defaultFmt(unit), unit);
  }).join('');
}

/** Strip bindings (for numeral checks). @param {string} text */
export function stripBindings(text) {
  return text.replace(BIND_RE, (m) => ' '.repeat(m.length));
}

/**
 * Post-check: numerals in prose that are NOT bound to a scope. Allowed: list markers at line
 * start, dates (2026-11-26, "Nov 26"), quoted text ("…", `…`), identifiers containing digits
 * (p90, v41, L3).
 * @param {string} text
 * @returns {Array<{index: number, text: string}>}
 */
export function findFreeNumerals(text) {
  let s = stripBindings(text);
  // blank out quoted spans and code
  s = s.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  // dates
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => ' '.repeat(m.length));
  s = s.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\b/g, (m) => ' '.repeat(m.length));
  // list markers at line start
  s = s.replace(/^(\s*)\d+[.)](?=\s)/gm, (m) => ' '.repeat(m.length));
  const out = [];
  const re = /(?<![\w.$])[-+−]?\$?\d[\d,]*(?:\.\d+)?%?(?![\w])/g;
  let m;
  while ((m = re.exec(s))) out.push({ index: m.index, text: m[0] });
  return out;
}
