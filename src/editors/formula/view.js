/**
 * Formula view helpers: equation TeX for a metric (clickable, provenance-colored variables), the
 * units row, the point-evaluation form built from bound values, and reference math.
 * @module editors/formula/view
 */
import { toLatex, inferUnit, isRefNode } from '../../model/expr.js';
import { sameUnit, unitText, TIME } from '../../model/units.js';
import { isCurrency, isProbability } from '../../model/format.js';
import { escTex } from './tex.js';

/** Provenance class to use for a variable's color macro. @param {any} graph @param {string} id */
export function provForTex(graph, id) {
  const p = graph.displayProv(id);
  if (p === 'contested') return 'estimated';
  if (p === 'failed') return 'computed';
  return p;
}

/**
 * Variable name relative to the equation's scope: "price" inside Bakery, "expansion.payment"
 * from elsewhere (like ScopeLang references).
 * @param {any} graph @param {string} id @param {string} scopeId
 */
export function nameFor(graph, id, scopeId) {
  const n = graph.node(id);
  if (!n) return id;
  if (n.scope === scopeId) return n.name;
  const s = graph.scope(n.scope);
  return `${s?.key || s?.name || n.scope}.${n.name}`;
}

/** Macro name for a provenance class. @param {string} prov */
function macro(prov) {
  return prov === 'input' ? 'inputv' : prov;
}

/**
 * "lhs = rhs" for a computed metric.
 * @param {any} graph @param {string} id @param {{htmlData?: boolean}} [opts]
 */
export function equationTex(graph, id, opts = {}) {
  const n = graph.node(id);
  const r = graph.resolved.get(id);
  const htmlData = opts.htmlData !== false;
  const lhsInner = `\\${macro(provForTex(graph, id))}{\\text{${escTex(n.name)}}}`;
  const lhs = htmlData ? `\\htmlData{node=${id}}{${lhsInner}}` : lhsInner;
  const nameOf = (x) => nameFor(graph, x, n.scope);
  // valueOf is passed explicitly: toLatex tests `opts.valueOf`, which every object inherits
  // from Object.prototype, so without it variables print as "[object Object]".
  const rhs = toLatex(r, { nameOf, valueOf: (x) => `\\text{${escTex(nameOf(x))}}`, provOf: (x) => provForTex(graph, x), htmlData });
  return `${lhs} = ${rhs}`;
}

/** Units row, e.g. USD/day = (USD/loaf − USD/loaf) · loaf/day. @param {any} graph @param {string} id */
export function unitsTex(graph, id) {
  const n = graph.node(id);
  const r = graph.resolved.get(id);
  const label = (x) => escTex(graph.node(x)?.type.unit || '1');
  const rhs = toLatex(r, { nameOf: (x) => x, provOf: (x) => provForTex(graph, x), valueOf: (x) => `\\text{${label(x)}}`, htmlData: false });
  return `\\text{${escTex(n.type.unit || '1')}} = ${rhs}`;
}

/**
 * Dimensional check of the formula against the declared unit.
 * @param {any} graph @param {string} id
 * @returns {{ok: boolean, text: string}}
 */
export function unitsCheck(graph, id) {
  const n = graph.node(id);
  try {
    const u = inferUnit(graph.resolved.get(id), (x) => graph.unitOf(x), (x) => graph.path(x), graph.path(id));
    const want = graph.unitOf(id);
    if (u.poly || sameUnit(u, want)) return { ok: true, text: `dimensionally consistent: ${n.type.unit || '1'}` };
    return { ok: false, text: `formula yields ${unitText(u)} but the metric is declared ${n.type.unit}` };
  } catch (err) {
    return { ok: false, text: `${/** @type {Error} */ (err).message}${/** @type {any} */ (err).hint ? `; ${/** @type {any} */ (err).hint}` : ''}` };
  }
}

/** Format used for a bound value in the point evaluation. @param {string} unit */
export function fmtFor(unit) {
  if (isCurrency(unit)) return 'usd';
  if (isProbability(unit)) return 'pct';
  return 'bare';
}

const PREC = { add: 1, sub: 1, sum: 1, mul: 2, div: 2, neg: 3, pow: 4 };
const OP_TEXT = { gt: '>', lt: '<', ge: '≥', le: '≤', eq: '=' };

/**
 * The resolved expression as DOM with bound values for every variable (point evaluation).
 * @param {any} e
 * @param {{ graph: any, bv: import('../shared/bound-value.js').BoundValues, stat?: string }} ctx
 * @returns {DocumentFragment}
 */
export function exprDom(e, ctx) {
  const frag = document.createDocumentFragment();
  const t = (s) => frag.appendChild(document.createTextNode(s));
  /** @param {any} x @param {number} parent */
  const walk = (x, parent) => {
    if (typeof x === 'number') {
      const s = document.createElement('span');
      s.className = 'ms-fx-const';
      s.textContent = Number.isInteger(x) && Math.abs(x) >= 1000 ? x.toLocaleString('en-US') : String(Number(x.toPrecision(6)));
      frag.appendChild(s);
      return;
    }
    if (isRefNode(x)) {
      const unit = ctx.graph.node(x.ref)?.type.unit || '';
      frag.appendChild(ctx.bv.create({ node: x.ref, stat: ctx.stat || 'value', fmt: fmtFor(unit) }));
      return;
    }
    if (!Array.isArray(x)) { t('?'); return; }
    const [op, ...a] = x;
    const prec = PREC[op] ?? 9;
    const wrap = prec < parent;
    if (wrap) t('(');
    const list = (sep, items, p) => items.forEach((y, i) => { if (i) t(sep); walk(y, p); });
    const fn = (name, items) => { t(`${name}(`); list(', ', items, 0); t(')'); };
    switch (op) {
      case 'add': case 'sum': if (!a.length) t('0'); else list(' + ', a, 1); break;
      case 'sub': walk(a[0], 1); t(' − '); walk(a[1], 2); break;
      case 'mul': list(' × ', a, 2); break;
      case 'div': walk(a[0], 2); t(' ÷ '); walk(a[1], 3); break;
      case 'neg': t('−'); walk(a[0], 3); break;
      case 'pow': {
        walk(a[0], 5);
        const sup = document.createElement('sup');
        sup.textContent = String(a[1]);
        frag.appendChild(sup);
        break;
      }
      case 'gt': case 'lt': case 'ge': case 'le': case 'eq': walk(a[0], 0); t(` ${OP_TEXT[op]} `); walk(a[1], 0); break;
      case 'and': list(' and ', a, 0); break;
      case 'or': list(' or ', a, 0); break;
      case 'not': t('not '); walk(a[0], 3); break;
      case 'if': t('if '); walk(a[0], 0); t(' then '); walk(a[1], 0); t(' else '); walk(a[2], 0); break;
      case 'convert': t('convert('); walk(a[0], 0); t(` → ${a[1]})`); break;
      case 'prob_lt': t('P('); walk(a[0], 0); t(' < '); walk(a[1], 0); t(')'); break;
      case 'prob_gt': t('P('); walk(a[0], 0); t(' > '); walk(a[1], 0); t(')'); break;
      case 'mean_of': t('E['); walk(a[0], 0); t(']'); break;
      case 'quantile': t(`Q${a[1]}(`); walk(a[0], 0); t(')'); break;
      case 'count': t(String(a.length)); break;
      default: fn(op, a);
    }
    if (wrap) t(')');
  };
  walk(e, 0);
  return frag;
}

/**
 * Reference math for the focused concept.
 * @param {any} graph @param {any} engine @param {string} id
 * @returns {Array<{title: string, tex: string, note?: string, bindings?: Array<{label: string, node: string, stat?: string}>}>}
 */
export function referenceItems(graph, engine, id) {
  const n = graph.node(id);
  if (!n) return [];
  const scope = graph.scope(n.scope);
  const r = graph.resolved.get(id);
  const stochastic = engine.stats(id) && !engine.stats(id).deterministic;
  const items = [];
  if (scope?.kind === 'mind') {
    items.push({
      title: 'Bayesian inverse planning',
      tex: 'P(\\theta \\mid o_{1:t}) \\propto P(\\theta) \\prod_{k=1}^{t} P_{\\mathrm{LM}}(o_k \\mid \\theta, s_k)',
      note: `θ is ${scope.name}'s hidden state (here ${n.name}); each observation oₖ is scored by the language model under a persona built from θ and the situation sₖ. Simulation, not assessment.`,
    });
    items.push({
      title: 'Evidence trail: log Bayes factor per observation',
      tex: '\\log \\mathrm{BF}_k = \\log \\frac{P(o_k \\mid \\theta > \\tfrac{1}{2},\\, o_{<k})}{P(o_k \\mid \\theta \\le \\tfrac{1}{2},\\, o_{<k})}',
      note: 'Positive values move the belief toward the hypothesis; the Minds editor shows them as a waterfall.',
    });
    items.push({
      title: 'Posterior written back to the graph',
      tex: `\\theta \\mid o_{1:t} \\sim \\mathrm{Beta}(\\hat\\alpha, \\hat\\beta)`,
      note: 'The posterior is stored as an estimated distribution; everything downstream recomputes.',
      bindings: stochastic ? [{ label: 'p10', node: id, stat: 'p10' }, { label: 'median', node: id, stat: 'p50' }, { label: 'p90', node: id, stat: 'p90' }] : [{ label: n.name, node: id }],
    });
    return items;
  }
  const isAnnuity = Array.isArray(r) && r[0] === 'annuity';
  if (isAnnuity || (scope?.kind === 'loan' && n.name === 'payment')) {
    const args = Array.isArray(r) ? r.slice(1).filter(isRefNode).map((x) => x.ref) : [];
    items.push({
      title: 'Annuity (level monthly payment)',
      tex: '\\text{payment} = \\frac{P\\, i}{1 - (1 + i)^{-n}}, \\qquad i = \\frac{r}{12}, \\quad n = 12\\, t',
      note: 'P principal, r annual rate, t term in years. With r = 0 the payment is P / n.',
      bindings: [
        ...(args[0] ? [{ label: 'P', node: args[0] }] : []),
        ...(args[1] ? [{ label: 'r', node: args[1] }] : []),
        ...(args[2] ? [{ label: 't', node: args[2] }] : []),
        { label: 'payment', node: id },
      ],
    });
    items.push({
      title: 'Total interest',
      tex: '\\text{interest} = 12\\, t \\cdot \\text{payment} - P',
    });
    return items;
  }
  items.push({
    title: 'Monte Carlo estimates',
    tex: '\\hat{q}_p = x_{(\\lceil pN \\rceil)}, \\qquad \\hat{P}(X < c) = \\frac{1}{N} \\sum_{k=1}^{N} \\mathbf{1}[x_k < c], \\qquad \\hat{\\mu} = \\frac{1}{N} \\sum_{k=1}^{N} x_k',
    note: `N = ${engine.n.toLocaleString('en-US')} samples per node, reproducible from the graph hash and seed.`,
    bindings: stochastic ? [{ label: 'p10', node: id, stat: 'p10' }, { label: 'p50', node: id, stat: 'p50' }, { label: 'p90', node: id, stat: 'p90' }, { label: 'mean', node: id, stat: 'mean' }] : [{ label: n.name, node: id }],
  });
  items.push({
    title: 'Common random numbers and Latin hypercube sampling',
    tex: 'u_{i,k} = h(\\mathrm{seed},\\, \\mathrm{node}_i,\\, k), \\qquad x_{i,k} = F_i^{-1}\\!\\left(\\frac{\\pi_i(k) + u_{i,k}}{N}\\right)',
    note: 'Draws are a pure function of the seed, the node id and the sample index, so a slider move never re-rolls the dice.',
  });
  items.push({
    title: 'First-order sensitivity (Sobol)',
    tex: 'S_i = \\frac{\\operatorname{Var}\\left(\\mathbb{E}[Y \\mid X_i]\\right)}{\\operatorname{Var}(Y)}',
    note: 'Estimated from the same samples; the Sensitivity editor ranks inputs by Sᵢ.',
  });
  if (JSON.stringify(r || '').includes('"convert"')) {
    items.push({
      title: 'Registered unit conversions',
      tex: `1\\,\\text{month} = \\frac{365.25}{12}\\,\\text{days} = ${(TIME.MONTH / TIME.DAY).toFixed(4)}\\,\\text{days}, \\qquad 1\\,\\text{week} = 7\\,\\text{days}`,
      note: 'convert() only rescales between units of the same dimension, through registered factors; bare constants are never used.',
    });
  }
  return items;
}
