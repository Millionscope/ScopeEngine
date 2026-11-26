/**
 * ScopeLang view helpers (pure, no DOM): block fold ranges, the lines left visible by folds,
 * and the line <-> id map for the specification snippet.
 * @module editors/scopelang/view
 */

/** A line without its // comment and string literals (for brace counting). @param {string} line */
function codePart(line) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    out += ch;
  }
  return out;
}

/**
 * Fold ranges: a line that opens a block (more "{" than "}") folds through the line that
 * closes it. "use std.finance.{Business, Loan}" opens and closes on one line, so it is not a
 * block. Lines are 1-based.
 * @param {string[]} lines
 * @returns {Map<number, number>} start line -> end line
 */
export function foldRanges(lines) {
  /** @type {Map<number, number>} */
  const ends = new Map();
  /** @type {number[]} */
  const stack = [];
  lines.forEach((l, idx) => {
    let net = 0;
    for (const ch of codePart(l)) {
      if (ch === '{') net++;
      else if (ch === '}') net--;
    }
    if (net < 0) {
      for (let k = 0; k < -net; k++) {
        const s = stack.pop();
        if (s != null && idx > s) ends.set(s + 1, idx + 1);
      }
    } else {
      for (let k = 0; k < net; k++) stack.push(idx);
    }
  });
  return ends;
}

/**
 * Original line numbers left visible when the given block starts are folded. A folded block
 * keeps its header line and hides everything through its closing brace.
 * @param {number} total @param {Set<number>} folded @param {Map<number, number>} ends
 * @returns {number[]}
 */
export function visibleLines(total, folded, ends) {
  const out = [];
  for (let ln = 1; ln <= total; ln++) {
    out.push(ln);
    if (folded.has(ln) && ends.has(ln)) ln = /** @type {number} */ (ends.get(ln));
  }
  return out;
}

/** Index of a value in a sorted array, or -1. @param {number[]} arr @param {number} v */
export function indexOfSorted(arr, v) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === v) return mid;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Index of the last element <= v in a sorted array (or 0). @param {number[]} arr @param {number} v */
export function floorIndex(arr, v) {
  let lo = 0;
  let hi = arr.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** @param {any} s @param {string} key */
function sameKey(s, key) {
  const k = key.toLowerCase();
  return !!s && [s.key, s.name].some((x) => typeof x === 'string' && x.toLowerCase() === k);
}

const SCOPE_RE = /^\s*(scope|child|mind)\s+([A-Za-z_]\w*)\s*:/;
const DECL_RE = /^\s*(input|observed|estimate|estimated|computed)\s+([A-Za-z_]\w*)\s*:/;

/**
 * Map the specification snippet's declarations to the live graph by name: "scope Bakery" is
 * the root scope, "child expansion" its child with that key, "input price" the metric of that
 * name in the enclosing scope. Unmatched lines map to nothing.
 * @param {string} text @param {any} graph
 * @returns {{idAt: Map<number, string>, lineOf: Map<string, number>}}
 */
export function snippetMap(text, graph) {
  /** @type {Map<number, string>} */
  const idAt = new Map();
  /** @type {Map<string, number>} */
  const lineOf = new Map();
  /** @type {Array<string|null>} */
  const stack = [];
  const findScope = (key) => {
    const parent = stack.length ? stack[stack.length - 1] : undefined;
    if (parent) return graph.scope(parent)?.children.find((c) => sameKey(graph.scope(c), key)) || null;
    if (parent === null) return null;
    const root = graph.rootId ? graph.scope(graph.rootId) : null;
    if (sameKey(root, key)) return root.id;
    for (const s of graph.scopes.values()) if (sameKey(s, key)) return s.id;
    return null;
  };
  text.split('\n').forEach((l, i) => {
    const ln = i + 1;
    let m;
    if ((m = SCOPE_RE.exec(l))) {
      const sid = findScope(m[2]);
      stack.push(sid);
      if (sid) {
        idAt.set(ln, sid);
        if (!lineOf.has(sid)) lineOf.set(sid, ln);
      }
      return;
    }
    if ((m = DECL_RE.exec(l))) {
      const sid = stack.length ? stack[stack.length - 1] : null;
      const s = sid ? graph.scope(sid) : null;
      const id = s ? s.metrics.find((x) => graph.node(x)?.name === m[2]) : null;
      if (id) {
        idAt.set(ln, id);
        if (!lineOf.has(id)) lineOf.set(id, ln);
      }
      return;
    }
    if (/^\s*}\s*$/.test(codePart(l))) stack.pop();
  });
  return { idAt, lineOf };
}
