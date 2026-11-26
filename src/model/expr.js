/**
 * IR expressions: ["mul", ["sub", "@price", "@unit_cost"], "@demand"].
 *
 * - refsOf / mapRefs: references ("@name", "@child.name", "@sc_id.name")
 * - validateExpr: known ops and arities
 * - inferUnit: dimensional analysis (fails closed with actionable messages)
 * - compile: generates two specialized functions per node from a whitelisted op set:
 *     point(v)              -> number            (v: Float64Array of point values)
 *     vector(S, v, n, out)  -> fills out[0..n)   (S[idx]: sample arrays; deterministic deps
 *                                                  are read once from v as scalars)
 *   Only numeric literals and array indices are emitted into generated code.
 * - toLatex / toScopeLang: printers for the Formula and ScopeLang editors.
 * No DOM.
 * @module model/expr
 */
import { parseUnit, POLY, DIMLESS, sameUnit, sameDims, mulUnit, divUnit, powUnit, isDimensionless, convertFactor, annuityUnit, unitText, UnitError } from './units.js';

/** @typedef {any[]|string|number} Expr */
/** A resolved reference produced by the graph indexer. */
/** @typedef {{ref: string}} RefNode */

export const OPS = {
  add: [2, Infinity], sub: [2, 2], mul: [2, Infinity], div: [2, 2], neg: [1, 1], pow: [2, 2],
  min: [1, Infinity], max: [1, Infinity], abs: [1, 1], exp: [1, 1], log: [1, 1], sqrt: [1, 1],
  clamp: [3, 3], round: [1, 1],
  gt: [2, 2], lt: [2, 2], ge: [2, 2], le: [2, 2], eq: [2, 2],
  and: [2, Infinity], or: [2, Infinity], not: [1, 1], if: [3, 3],
  convert: [2, 2], annuity: [3, 3],
  sum: [0, Infinity], mean: [1, Infinity], count: [0, Infinity],
  agg: [4, 4],
  prob_lt: [2, 2], prob_gt: [2, 2], quantile: [2, 2], mean_of: [1, 1],
};

/** Ops that reduce over Monte Carlo samples (allowed only at the top of a node). */
export const STAT_OPS = new Set(['prob_lt', 'prob_gt', 'quantile', 'mean_of']);

/** @param {any} e */
export const isRefString = (e) => typeof e === 'string' && e.startsWith('@');
/** @param {any} e */
export const isRefNode = (e) => e !== null && typeof e === 'object' && !Array.isArray(e) && typeof e.ref === 'string';

/**
 * Collect raw reference strings ('@price') from an unresolved expression.
 * @param {Expr} e @param {string[]} [out]
 */
export function refsOf(e, out = []) {
  if (isRefString(e)) out.push(/** @type {string} */ (e));
  else if (Array.isArray(e)) {
    if (e[0] === 'convert') refsOf(e[1], out);
    else if (e[0] === 'agg') { /* resolved by the graph */ }
    else for (let i = 1; i < e.length; i++) refsOf(e[i], out);
  } else if (isRefNode(e)) out.push(e.ref);
  return out;
}

/**
 * Replace references using fn(refString) -> replacement.
 * @param {Expr} e @param {(ref: string, parent: any[]|null) => any} fn
 * @returns {any}
 */
export function mapRefs(e, fn, parent = null) {
  if (isRefString(e)) return fn(/** @type {string} */ (e), parent);
  if (!Array.isArray(e)) return e;
  if (e[0] === 'convert') return ['convert', mapRefs(e[1], fn, e), e[2]];
  if (e[0] === 'agg') return fn(/** @type {any} */ (e), parent);
  return [e[0], ...e.slice(1).map((x) => mapRefs(x, fn, e))];
}

/** Ids referenced by a resolved expression. @param {any} e @param {Set<string>} [out] */
export function resolvedDeps(e, out = new Set()) {
  if (isRefNode(e)) out.add(e.ref);
  else if (Array.isArray(e)) {
    for (let i = 1; i < e.length; i++) {
      if (e[0] === 'convert' && i === 2) continue;
      resolvedDeps(e[i], out);
    }
  }
  return out;
}

/**
 * Structural validation of an unresolved expression. Returns an error message or null.
 * @param {Expr} e @param {boolean} [top]
 */
export function validateExpr(e, top = true) {
  if (typeof e === 'number') return Number.isFinite(e) ? null : `non-finite constant ${e}`;
  if (isRefString(e) || isRefNode(e)) return null;
  if (!Array.isArray(e) || typeof e[0] !== 'string') return `malformed expression ${JSON.stringify(e)}`;
  const op = e[0];
  const ar = OPS[op];
  if (!ar) return `unknown function "${op}"`;
  const n = e.length - 1;
  if (n < ar[0] || n > ar[1]) return `${op} expects ${ar[0] === ar[1] ? ar[0] : `${ar[0]}..${ar[1] === Infinity ? 'n' : ar[1]}`} arguments, got ${n}`;
  if (STAT_OPS.has(op) && !top) return `${op}() reduces over samples and must be the whole formula`;
  if (op === 'convert') {
    if (typeof e[2] !== 'string') return 'convert(x, unit) needs a unit as its second argument';
    try { parseUnit(e[2]); } catch (err) { return /** @type {Error} */ (err).message; }
    return validateExpr(e[1], false);
  }
  if (op === 'agg') return null;
  if (op === 'pow' && typeof e[2] !== 'number') return 'pow(x, n) needs a numeric exponent';
  for (let i = 1; i < e.length; i++) {
    const err = validateExpr(e[i], false);
    if (err) return err;
  }
  return null;
}

// ---------------------------------------------------------------- units

/**
 * Infer the unit of a resolved expression. Throws UnitError with an actionable hint.
 * @param {any} e
 * @param {(id: string) => import('./units.js').Unit} unitOf
 * @param {(id: string) => string} [nameOf]
 * @param {string} [where] node id for messages
 * @returns {import('./units.js').Unit}
 */
export function inferUnit(e, unitOf, nameOf = (x) => x, where = '') {
  if (typeof e === 'number') return POLY;
  if (isRefNode(e)) return unitOf(e.ref);
  if (!Array.isArray(e)) throw new UnitError(`malformed expression in ${where}`);
  const op = e[0];
  const args = e.slice(1);
  const U = (x) => inferUnit(x, unitOf, nameOf, where);
  const label = (x) => (isRefNode(x) ? nameOf(x.ref) : typeof x === 'number' ? String(x) : op);
  const same = (units, opName, exprs) => {
    let base = null;
    let baseIdx = -1;
    units.forEach((u, i) => {
      if (u.poly) return;
      if (!base) { base = u; baseIdx = i; return; }
      if (!sameUnit(base, u)) {
        const a = unitText(base);
        const b = unitText(u);
        const hint = sameDims(base, u)
          ? `wrap the ${baseIdx === 0 ? 'first' : 'earlier'} term in convert(..., ${b})`
          : `the terms measure different quantities (${a} vs ${b}); fix the formula`;
        throw new UnitError(`unit mismatch in ${where}: ${a} ${opName} ${b}`, hint);
      }
      void exprs;
    });
    return base || POLY;
  };
  switch (op) {
    case 'add': return same(args.map(U), '+', args);
    case 'sub': return same(args.map(U), '-', args);
    case 'min': case 'max': case 'sum': case 'mean': return same(args.map(U), op === 'sum' ? '+' : `vs`, args);
    case 'mul': return args.map(U).reduce((a, b) => mulUnit(a, b));
    case 'div': return divUnit(U(args[0]), U(args[1]));
    case 'neg': case 'abs': case 'round': return U(args[0]);
    case 'pow': return powUnit(U(args[0]), /** @type {number} */ (args[1]));
    case 'sqrt': {
      const u = U(args[0]);
      if (u.poly || isDimensionless(u)) return u.poly ? POLY : DIMLESS;
      return { f: Math.sqrt(u.f), d: Object.fromEntries(Object.entries(u.d).map(([k, v]) => [k, v / 2])), text: `sqrt(${unitText(u)})` };
    }
    case 'exp': case 'log': {
      const u = U(args[0]);
      if (!u.poly && !isDimensionless(u)) throw new UnitError(`${op}() needs a dimensionless argument in ${where}, got ${unitText(u)}`, 'divide by a reference value first');
      return DIMLESS;
    }
    case 'clamp': return same(args.map(U), 'clamped to', args);
    case 'gt': case 'lt': case 'ge': case 'le': case 'eq': same(args.map(U), op, args); return DIMLESS;
    case 'and': case 'or': case 'not': args.forEach(U); return DIMLESS;
    case 'if': U(args[0]); return same([U(args[1]), U(args[2])], 'or', args);
    case 'convert': {
      const from = U(args[0]);
      const to = parseUnit(args[1]);
      if (!from.poly) convertFactor(from, to);
      return to;
    }
    case 'annuity': return annuityUnit(U(args[0]), U(args[1]), U(args[2]));
    case 'count': return parseUnit('scope');
    case 'prob_lt': case 'prob_gt': same([U(args[0]), U(args[1])], op === 'prob_lt' ? '<' : '>', args); return parseUnit('prob');
    case 'quantile': return U(args[0]);
    case 'mean_of': return U(args[0]);
    default: throw new UnitError(`unknown function "${op}" in ${where}`);
  }
  // eslint-disable-next-line no-unreachable
  void label;
}

// ---------------------------------------------------------------- compilation

/** Runtime helpers available to generated code. */
const HELPERS = {
  /** Monthly payment for principal P, annual rate r, term t years. */
  annuity(P, r, t) {
    const n = t * 12;
    if (n <= 0) return NaN;
    const i = r / 12;
    if (Math.abs(i) < 1e-12) return P / n;
    return (P * i) / (1 - Math.pow(1 + i, -n));
  },
};

/** @param {number} x */
function lit(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '(-Infinity)';
  const s = String(x);
  return x < 0 ? `(${s})` : s;
}

/**
 * Compile a resolved expression.
 * @param {any} rexpr
 * @param {{
 *   idxOf: (id: string) => number,
 *   unitOf: (id: string) => import('./units.js').Unit,
 *   stochastic?: (id: string) => boolean,
 *   where?: string,
 * }} env
 * @returns {{ point: (v: Float64Array) => number, vector: null | ((S: Array<Float64Array|null>, v: Float64Array, n: number, out: Float64Array) => void), stat: null | {op: string, arg: any, param: number}, stochastic: boolean }}
 */
export function compile(rexpr, env) {
  if (Array.isArray(rexpr) && STAT_OPS.has(rexpr[0])) {
    // statistic over samples; the engine evaluates it from the argument's samples
    const param = typeof rexpr[2] === 'number' ? rexpr[2] : rexpr[0] === 'mean_of' ? 0 : NaN;
    return { point: () => NaN, vector: null, stat: { op: rexpr[0], arg: rexpr[1], param }, stochastic: false };
  }
  const stoch = env.stochastic || (() => false);
  /** @type {Map<number, string>} */
  const locals = new Map();
  let isStoch = false;
  const unitCache = new Map();
  const unitOfExpr = (e) => {
    if (unitCache.has(e)) return unitCache.get(e);
    const u = inferUnit(e, env.unitOf, (x) => x, env.where || '');
    unitCache.set(e, u);
    return u;
  };

  /** @param {any} e @param {boolean} vec @returns {string} */
  const gen = (e, vec) => {
    if (typeof e === 'number') return lit(e);
    if (isRefNode(e)) {
      const idx = env.idxOf(e.ref);
      if (idx < 0) throw new Error(`unresolved reference ${e.ref}`);
      if (!vec) return `v[${idx}]`;
      if (stoch(e.ref)) {
        isStoch = true;
        if (!locals.has(idx)) locals.set(idx, `S[${idx}]`);
        return `s${idx}[i]`;
      }
      if (!locals.has(idx)) locals.set(idx, `v[${idx}]`);
      return `d${idx}`;
    }
    if (!Array.isArray(e)) throw new Error(`malformed expression ${JSON.stringify(e)}`);
    const op = e[0];
    const a = e.slice(1);
    const g = (x) => gen(x, vec);
    switch (op) {
      case 'add': case 'sum': return a.length ? `(${a.map(g).join(' + ')})` : '0';
      case 'sub': return `(${g(a[0])} - ${g(a[1])})`;
      case 'mul': return `(${a.map(g).join(' * ')})`;
      case 'div': return `(${g(a[0])} / ${g(a[1])})`;
      case 'neg': return `(-${g(a[0])})`;
      case 'pow': return `Math.pow(${g(a[0])}, ${lit(a[1])})`;
      case 'min': return `Math.min(${a.map(g).join(', ')})`;
      case 'max': return `Math.max(${a.map(g).join(', ')})`;
      case 'abs': return `Math.abs(${g(a[0])})`;
      case 'exp': return `Math.exp(${g(a[0])})`;
      case 'log': return `Math.log(${g(a[0])})`;
      case 'sqrt': return `Math.sqrt(${g(a[0])})`;
      case 'round': return `Math.round(${g(a[0])})`;
      case 'clamp': return `Math.min(Math.max(${g(a[0])}, ${g(a[1])}), ${g(a[2])})`;
      case 'gt': return `(${g(a[0])} > ${g(a[1])} ? 1 : 0)`;
      case 'lt': return `(${g(a[0])} < ${g(a[1])} ? 1 : 0)`;
      case 'ge': return `(${g(a[0])} >= ${g(a[1])} ? 1 : 0)`;
      case 'le': return `(${g(a[0])} <= ${g(a[1])} ? 1 : 0)`;
      case 'eq': return `(${g(a[0])} === ${g(a[1])} ? 1 : 0)`;
      case 'and': return `((${a.map(g).join(') && (')}) ? 1 : 0)`;
      case 'or': return `((${a.map(g).join(') || (')}) ? 1 : 0)`;
      case 'not': return `(${g(a[0])} ? 0 : 1)`;
      case 'if': return `(${g(a[0])} ? ${g(a[1])} : ${g(a[2])})`;
      case 'mean': return `((${a.map(g).join(' + ')}) / ${a.length})`;
      case 'count': return lit(a.length);
      case 'convert': {
        const from = unitOfExpr(a[0]);
        const f = from.poly ? 1 : convertFactor(from, parseUnit(a[1]));
        return f === 1 ? g(a[0]) : `(${g(a[0])} * ${lit(f)})`;
      }
      case 'annuity': {
        const r = unitOfExpr(a[1]);
        const t = unitOfExpr(a[2]);
        const rf = r.poly ? 1 : convertFactor(r, parseUnit('1/year'));
        const tf = t.poly ? 1 : convertFactor(t, parseUnit('year'));
        return `H.annuity(${g(a[0])}, ${rf === 1 ? g(a[1]) : `(${g(a[1])} * ${lit(rf)})`}, ${tf === 1 ? g(a[2]) : `(${g(a[2])} * ${lit(tf)})`})`;
      }
      default: throw new Error(`cannot compile op "${op}"`);
    }
  };

  const pointBody = gen(rexpr, false);
  // eslint-disable-next-line no-new-func
  const point = /** @type {any} */ (new Function('H', `return function point(v) { return ${pointBody}; };`))(HELPERS);

  let vector = null;
  locals.clear();
  const vecBody = gen(rexpr, true);
  if (isStoch) {
    const decl = [...locals.entries()].map(([idx, src]) => (src.startsWith('S') ? `const s${idx} = S[${idx}];` : `const d${idx} = v[${idx}];`)).join('\n');
    // eslint-disable-next-line no-new-func
    vector = /** @type {any} */ (new Function('H', `return function vector(S, v, n, out) {\n${decl}\nfor (let i = 0; i < n; i++) out[i] = ${vecBody};\n};`))(HELPERS);
  }
  return { point, vector, stat: null, stochastic: isStoch };
}

/**
 * Interpreted evaluation (tests and one-off checks).
 * @param {any} e @param {(id: string) => number} get
 */
export function evaluate(e, get) {
  if (typeof e === 'number') return e;
  if (isRefNode(e)) return get(e.ref);
  const [op, ...a] = e;
  const ev = (x) => evaluate(x, get);
  switch (op) {
    case 'add': case 'sum': return a.reduce((s, x) => s + ev(x), 0);
    case 'sub': return ev(a[0]) - ev(a[1]);
    case 'mul': return a.reduce((s, x) => s * ev(x), 1);
    case 'div': return ev(a[0]) / ev(a[1]);
    case 'neg': return -ev(a[0]);
    case 'pow': return Math.pow(ev(a[0]), a[1]);
    case 'min': return Math.min(...a.map(ev));
    case 'max': return Math.max(...a.map(ev));
    case 'abs': return Math.abs(ev(a[0]));
    case 'gt': return ev(a[0]) > ev(a[1]) ? 1 : 0;
    case 'lt': return ev(a[0]) < ev(a[1]) ? 1 : 0;
    case 'ge': return ev(a[0]) >= ev(a[1]) ? 1 : 0;
    case 'le': return ev(a[0]) <= ev(a[1]) ? 1 : 0;
    case 'annuity': return HELPERS.annuity(ev(a[0]), ev(a[1]), ev(a[2]));
    default: throw new Error(`evaluate: unsupported op ${op}`);
  }
}

// ---------------------------------------------------------------- printers

const PREC = { add: 1, sub: 1, sum: 1, mul: 2, div: 2, neg: 3, pow: 4 };

/**
 * LaTeX for a resolved expression. Variables are wrapped in provenance macros
 * (\input{...}, \observed{...}, \estimated{...}, \computed{...}, \proven{...}) and optionally
 * in \htmlData{node=<id>}{...} so the Formula editor can make them clickable.
 * @param {any} e
 * @param {{ nameOf: (id: string) => string, provOf?: (id: string) => string, htmlData?: boolean, valueOf?: (id: string) => string }} opts
 * @returns {string}
 */
export function toLatex(e, opts) {
  const esc = (s) => String(s).replace(/\\/g, '\\textbackslash{}').replace(/([_#%&{}$])/g, '\\$1');
  const p = (x, parentPrec) => {
    const s = tex(x);
    const prec = Array.isArray(x) ? PREC[x[0]] ?? 9 : 9;
    return prec < parentPrec ? `\\left(${s}\\right)` : s;
  };
  /** @param {any} x @returns {string} */
  const tex = (x) => {
    if (typeof x === 'number') return fmtNum(x);
    if (isRefNode(x)) {
      const id = x.ref;
      // own property only: every object inherits Object.prototype.valueOf
      const name = Object.hasOwn(opts, 'valueOf') && opts.valueOf ? opts.valueOf(id) : `\\text{${esc(opts.nameOf(id))}}`;
      const prov = opts.provOf ? opts.provOf(id) : 'computed';
      const macro = `\\${prov === 'input' ? 'inputv' : prov}{${name}}`;
      return opts.htmlData ? `\\htmlData{node=${id}}{${macro}}` : macro;
    }
    if (!Array.isArray(x)) return '?';
    const [op, ...a] = x;
    switch (op) {
      case 'add': case 'sum': return a.length > 5 && op === 'sum' ? `\\sum_{k=1}^{${a.length}} ${p(a[0], 2)}_k` : a.map((y) => p(y, 1)).join(' + ');
      case 'sub': return `${p(a[0], 1)} - ${p(a[1], 2)}`;
      case 'mul': return a.map((y) => p(y, 2)).join(' \\cdot ');
      case 'div': return `\\frac{${tex(a[0])}}{${tex(a[1])}}`;
      case 'neg': return `-${p(a[0], 3)}`;
      case 'pow': return `{${p(a[0], 5)}}^{${fmtNum(a[1])}}`;
      case 'min': return `\\min\\left(${a.map(tex).join(',\\ ')}\\right)`;
      case 'max': return `\\max\\left(${a.map(tex).join(',\\ ')}\\right)`;
      case 'abs': return `\\left|${tex(a[0])}\\right|`;
      case 'exp': return `e^{${tex(a[0])}}`;
      case 'log': return `\\ln\\left(${tex(a[0])}\\right)`;
      case 'sqrt': return `\\sqrt{${tex(a[0])}}`;
      case 'round': return `\\operatorname{round}\\left(${tex(a[0])}\\right)`;
      case 'clamp': return `\\operatorname{clamp}\\left(${a.map(tex).join(',\\ ')}\\right)`;
      case 'gt': return `${tex(a[0])} > ${tex(a[1])}`;
      case 'lt': return `${tex(a[0])} < ${tex(a[1])}`;
      case 'ge': return `${tex(a[0])} \\ge ${tex(a[1])}`;
      case 'le': return `${tex(a[0])} \\le ${tex(a[1])}`;
      case 'eq': return `${tex(a[0])} = ${tex(a[1])}`;
      case 'and': return a.map(tex).join(' \\land ');
      case 'or': return a.map(tex).join(' \\lor ');
      case 'not': return `\\lnot ${tex(a[0])}`;
      case 'if': return `\\begin{cases} ${tex(a[1])} & \\text{if } ${tex(a[0])} \\\\ ${tex(a[2])} & \\text{otherwise} \\end{cases}`;
      case 'mean': return `\\frac{1}{${a.length}}\\left(${a.map(tex).join(' + ')}\\right)`;
      case 'count': return fmtNum(a.length);
      case 'convert': return `\\operatorname{convert}\\left(${tex(a[0])},\\ \\text{${esc(a[1])}}\\right)`;
      case 'annuity': return `\\operatorname{annuity}\\left(${a.map(tex).join(',\\ ')}\\right)`;
      case 'prob_lt': return `P\\left(${tex(a[0])} < ${tex(a[1])}\\right)`;
      case 'prob_gt': return `P\\left(${tex(a[0])} > ${tex(a[1])}\\right)`;
      case 'quantile': return `Q_{${fmtNum(a[1])}}\\left(${tex(a[0])}\\right)`;
      case 'mean_of': return `\\mathbb{E}\\left[${tex(a[0])}\\right]`;
      default: return `\\operatorname{${op}}`;
    }
  };
  return tex(e);
}

/** @param {number} x */
function fmtNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) >= 1000) return x.toLocaleString('en-US').replace(/,/g, '{,}');
  return String(Number(x.toPrecision(6)));
}

/**
 * ScopeLang text for an unresolved expression: (price - unit_cost) * demand.
 * @param {Expr} e
 * @returns {string}
 */
export function toScopeLang(e) {
  const p = (x, parent) => {
    const s = sl(x);
    const prec = Array.isArray(x) ? PREC[x[0]] ?? 9 : 9;
    return prec < parent ? `(${s})` : s;
  };
  /** @param {any} x @returns {string} */
  const sl = (x) => {
    if (typeof x === 'number') return Number.isInteger(x) && Math.abs(x) >= 10000 ? String(x).replace(/\B(?=(\d{3})+(?!\d))/g, '_') : String(x);
    if (isRefString(x)) return x.slice(1);
    if (isRefNode(x)) return x.ref;
    if (!Array.isArray(x)) return '?';
    const [op, ...a] = x;
    switch (op) {
      case 'add': return a.map((y) => p(y, 1)).join(' + ');
      case 'sub': return `${p(a[0], 1)} - ${p(a[1], 2)}`;
      case 'mul': return a.map((y) => p(y, 2)).join(' * ');
      case 'div': return `${p(a[0], 2)} / ${p(a[1], 3)}`;
      case 'neg': return `-${p(a[0], 3)}`;
      case 'pow': return `${p(a[0], 5)}^${a[1]}`;
      case 'gt': return `${sl(a[0])} > ${sl(a[1])}`;
      case 'lt': return `${sl(a[0])} < ${sl(a[1])}`;
      case 'ge': return `${sl(a[0])} >= ${sl(a[1])}`;
      case 'le': return `${sl(a[0])} <= ${sl(a[1])}`;
      case 'eq': return `${sl(a[0])} == ${sl(a[1])}`;
      case 'if': return `if ${sl(a[0])} then ${sl(a[1])} else ${sl(a[2])}`;
      case 'convert': return `convert(${sl(a[0])}, ${a[1]})`;
      case 'agg': return `${a[0]}(${a[1] === '.' ? '' : `${a[1]}.`}${a[2] === '*' ? 'children' : `children<${a[2]}>`}.${a[3]})`;
      default: return `${op}(${a.map(sl).join(', ')})`;
    }
  };
  return sl(e);
}

export { HELPERS };
