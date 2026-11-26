/**
 * Lightweight tokenizer-based code view (ScopeLang, Lean 4, SMT-LIB, JSON) with line numbers,
 * a diagnostics gutter, folding of { } blocks and clickable lines. Kept behind this seam so it
 * can be replaced by CodeMirror 6 later.
 * @module editors/shared/code-view
 */

const SCOPE_KW = new Set(['scope', 'use', 'child', 'relation', 'mind', 'of', 'goal', 'weight', 'knows', 'step', 'constraint', 'convert', 'if', 'then', 'else', 'agg', 'sum', 'mean', 'count', 'min', 'max']);
const SCOPE_PROV = { input: 'input', observed: 'observed', estimate: 'estimated', estimated: 'estimated', computed: 'computed', proven: 'proven' };
const LEAN_KW = new Set(['import', 'theorem', 'lemma', 'def', 'by', 'have', 'exact', 'intro', 'fun', 'let', 'show', 'calc', 'linarith', 'nlinarith', 'simp', 'apply', 'rw', 'at', 'with', 'Real', 'ℝ']);
const SMT_KW = new Set(['declare-const', 'declare-fun', 'define-fun', 'assert', 'check-sat', 'get-model', 'not', 'and', 'or', 'ite', 'Real', 'Int', 'Bool']);

/**
 * Tokenize one line.
 * @param {string} line @param {'scopelang'|'lean'|'smt'|'json'|'text'} lang
 * @returns {Array<{t: string, c: string}>}
 */
export function tokenizeLine(line, lang) {
  /** @type {Array<{t: string, c: string}>} */
  const out = [];
  let i = 0;
  const push = (t, c) => { if (t) out.push({ t, c }); };
  const commentStart = lang === 'lean' ? '--' : lang === 'smt' ? ';' : lang === 'json' ? null : '//';
  while (i < line.length) {
    const rest = line.slice(i);
    if (commentStart && rest.startsWith(commentStart)) { push(rest, 'com'); break; }
    let m;
    if ((m = /^\s+/.exec(rest))) { push(m[0], ''); i += m[0].length; continue; }
    if ((m = /^"(?:[^"\\]|\\.)*"?/.exec(rest))) {
      const isKey = lang === 'json' && /^\s*:/.test(rest.slice(m[0].length));
      push(m[0], isKey ? 'ident' : 'str');
      i += m[0].length;
      continue;
    }
    if (lang === 'scopelang' && (m = /^@[A-Za-z_]\w*/.exec(rest))) { push(m[0], 'ann'); i += m[0].length; continue; }
    if ((m = /^[-+]?\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?/i.exec(rest))) { push(m[0], 'num'); i += m[0].length; continue; }
    if (lang === 'smt' && (m = /^[A-Za-z_][\w\-.]*/.exec(rest))) { push(m[0], SMT_KW.has(m[0]) ? 'kw' : 'ident'); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_À-ɏΑ-ωℝ][\wÀ-ɏΑ-ω₀-₉'.]*/.exec(rest))) {
      const w = m[0];
      if (lang === 'scopelang') {
        if (SCOPE_PROV[w]) push(w, `prov-${SCOPE_PROV[w]}`);
        else if (SCOPE_KW.has(w)) push(w, 'kw');
        else if (/^[A-Z]/.test(w) && /:\s*$/.test(line.slice(0, i)) === false && /^(USD|kUSD|loaf|person|day|month|year|week|hour|km|m2|prob|score|scope|visit|item|text)\b/.test(w)) push(w, 'unit');
        else if (/^[A-Z]/.test(w)) push(w, 'type');
        else if (/^(USD|loaf|person|day|month|year|week|hour|km|prob|scope|visit|item)$/.test(w)) push(w, 'unit');
        else push(w, 'ident');
      } else if (lang === 'lean') push(w, LEAN_KW.has(w) ? 'kw' : /^[A-Z]/.test(w) ? 'type' : 'ident');
      else if (lang === 'json') push(w, /^(true|false|null)$/.test(w) ? 'kw' : 'ident');
      else push(w, 'ident');
      i += w.length;
      continue;
    }
    push(line[i], 'op');
    i++;
  }
  // ScopeLang: unit after the type colon (name: USD/month = …)
  if (lang === 'scopelang') {
    const colon = out.findIndex((tk) => tk.t === ':');
    if (colon > 0) {
      for (let k = colon + 1; k < out.length; k++) {
        const tk = out[k];
        if (tk.t === '=' || tk.t === '~') break;
        if (tk.c === 'ident' || tk.c === 'type' || tk.c === 'num' || (tk.c === 'op' && tk.t === '/')) tk.c = tk.c === 'num' ? 'unit' : 'unit';
      }
    }
  }
  return out;
}

/**
 * @typedef {Object} CodeViewOptions
 * @property {'scopelang'|'lean'|'smt'|'json'|'text'} lang
 * @property {boolean=} lineNumbers
 * @property {number=} activeLine             1-based
 * @property {(line: number, e: MouseEvent) => void=} onLineClick
 * @property {Array<{line: number, severity: 'error'|'warning'|'info', message: string}>=} diagnostics
 * @property {boolean=} foldable
 * @property {Set<number>=} folded           1-based lines whose block is folded
 * @property {(line: number) => void=} onToggleFold
 * @property {string=} label
 */

/**
 * Render code into a <pre class="ms-code">.
 * @param {string} text @param {CodeViewOptions} opts
 * @returns {HTMLElement}
 */
export function codeView(text, opts) {
  const pre = document.createElement('pre');
  pre.className = 'ms-code';
  pre.setAttribute('role', 'region');
  pre.setAttribute('aria-label', opts.label || `${opts.lang} source`);
  pre.tabIndex = 0;
  const lines = text.split('\n');
  const diag = new Map();
  for (const d of opts.diagnostics || []) {
    if (!diag.has(d.line)) diag.set(d.line, []);
    diag.get(d.line).push(d);
  }
  // fold ranges: line with "{" -> matching "}"
  const foldEnd = new Map();
  if (opts.foldable) {
    const stack = [];
    lines.forEach((l, idx) => {
      // net braces per line: "use std.finance.{Business, Loan}" opens and closes on one line
      const net = (l.match(/{/g) || []).length - (l.match(/}/g) || []).length;
      for (let k = 0; k < -net; k++) {
        const start = stack.pop();
        if (start != null && idx > start) foldEnd.set(start + 1, idx + 1);
      }
      for (let k = 0; k < net; k++) stack.push(idx);
    });
  }
  let skipUntil = 0;
  lines.forEach((l, idx) => {
    const ln = idx + 1;
    if (ln <= skipUntil) return;
    const row = document.createElement('div');
    row.className = 'ms-code-line' + (opts.activeLine === ln ? ' is-active' : '');
    row.dataset.line = String(ln);
    const ds = diag.get(ln);
    if (ds) row.classList.add(`has-${ds.some((d) => d.severity === 'error') ? 'error' : 'warning'}`);
    if (opts.lineNumbers !== false) {
      const num = document.createElement('span');
      num.className = 'ms-code-ln';
      num.textContent = String(ln);
      row.appendChild(num);
    }
    const gutter = document.createElement('span');
    gutter.className = 'ms-code-gutter';
    if (ds) {
      const sev = ds.some((d) => d.severity === 'error') ? 'error' : 'warning';
      gutter.innerHTML = `<span class="codicon codicon-${sev}" aria-hidden="true"></span>`;
      gutter.title = ds.map((d) => d.message).join('\n');
      gutter.setAttribute('aria-label', `${sev}: ${ds.map((d) => d.message).join('; ')}`);
    } else if (foldEnd.has(ln)) {
      const folded = opts.folded?.has(ln);
      const b = document.createElement('button');
      b.className = `ms-code-fold codicon codicon-chevron-${folded ? 'right' : 'down'}`;
      b.setAttribute('aria-label', folded ? `Expand block at line ${ln}` : `Fold block at line ${ln}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); opts.onToggleFold?.(ln); });
      gutter.appendChild(b);
    }
    row.appendChild(gutter);
    const txt = document.createElement('span');
    txt.className = 'ms-code-text';
    for (const tk of tokenizeLine(l, opts.lang)) {
      if (!tk.c) { txt.appendChild(document.createTextNode(tk.t)); continue; }
      const s = document.createElement('span');
      s.className = `ms-tok-${tk.c}`;
      s.textContent = tk.t;
      txt.appendChild(s);
    }
    if (opts.folded?.has(ln) && foldEnd.has(ln)) {
      const more = document.createElement('span');
      more.className = 'ms-code-folded';
      more.textContent = ` … ${foldEnd.get(ln) - ln - 1} lines }`;
      txt.appendChild(more);
      skipUntil = foldEnd.get(ln);
    }
    row.appendChild(txt);
    if (opts.onLineClick) row.addEventListener('click', (e) => opts.onLineClick?.(ln, e));
    pre.appendChild(row);
    if (ds) {
      for (const d of ds) {
        const msg = document.createElement('div');
        msg.className = `ms-code-diag is-${d.severity}`;
        msg.setAttribute('role', d.severity === 'error' ? 'alert' : 'note');
        msg.textContent = d.message;
        pre.appendChild(msg);
      }
    }
  });
  return pre;
}
