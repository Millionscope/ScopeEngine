/**
 * Sensitivity: which assumptions drive an output.
 *
 *  - First-order Sobol indices S_i = Var(E[Y|X_i]) / Var(Y), estimated from one Monte Carlo run
 *    by binning X_i (correlation ratio) with a small-sample bias correction. Every upstream
 *    assumption varies: estimates over their distributions, inputs and observed values over
 *    their declared plausible ranges (Uniform), so a fixed input such as rent still ranks.
 *  - Tornado swings: the output's point value with each assumption at its low / high end
 *    (p10/p90 of its distribution, or the declared range), others at nominal.
 *  - Value of information (estimated inputs): the expected drop in output variance if the
 *    input were known exactly (its first-order effect), reported as an sd reduction.
 * Results are cached per (engine computeVersion, output, samples). No DOM.
 * @module model/sensitivity
 */
import { makeDist } from './distributions.js';

/**
 * @typedef {Object} SensitivityItem
 * @property {string} id
 * @property {string} name
 * @property {string} path
 * @property {string} prov
 * @property {string} unit
 * @property {number} sobol            first-order index (0..1)
 * @property {number} low              output with this input at its low end
 * @property {number} high             output with this input at its high end
 * @property {number} lowInput
 * @property {number} highInput
 * @property {number} swing            |high - low|
 * @property {number|null} voi         sd reduction of the output if known exactly (estimates only)
 * @property {string} rangeSource      'distribution' | 'declared range' | '±20%'
 */

/**
 * @typedef {Object} SensitivityResult
 * @property {string} output
 * @property {SensitivityItem[]} items  sorted by sobol, descending
 * @property {number} sdY
 * @property {number} base             output point value
 * @property {number} n
 * @property {number} ms
 */

/** @param {any} node */
export function analysisRange(node) {
  if (node.dist && node.dist.family !== 'Point') {
    const d = makeDist(node.dist);
    return { lo: d.quantile(0.1), hi: d.quantile(0.9), dist: node.dist, source: 'distribution' };
  }
  if (Array.isArray(node.range) && node.range[1] > node.range[0]) {
    return { lo: node.range[0], hi: node.range[1], dist: { family: 'Uniform', min: node.range[0], max: node.range[1] }, source: 'declared range' };
  }
  const v = Number(node.value);
  if (!Number.isFinite(v) || v === 0) return null;
  const lo = v * 0.8;
  const hi = v * 1.2;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi), dist: { family: 'Uniform', min: Math.min(lo, hi), max: Math.max(lo, hi) }, source: '±20%' };
}

/**
 * @param {import('./engine.js').JsEngine} engine
 * @param {string} outputId
 * @param {{bins?: number, maxInputs?: number, scenarioId?: string|null, varyDecisions?: boolean}} [opts]
 * @returns {SensitivityResult}
 */
export function sensitivity(engine, outputId, opts = {}) {
  const scen = opts.scenarioId && opts.scenarioId !== 'base' ? opts.scenarioId : null;
  const key = `${engine.computeVersion}:${outputId}:${engine.n}:${scen || 'base'}:${scen ? engine.scenarios.rev : 0}`;
  engine._sensCache = engine._sensCache || new Map();
  const hit = engine._sensCache.get(key);
  if (hit) return hit;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const g = engine.graph;
  const inputs = g.inputsOf(outputId).filter((id) => {
    const n = g.node(id);
    return n && n.type?.unit !== 'text' && Number.isFinite(engine.value(id));
  });
  /** @type {Map<string, {value?: number, dist?: any}>} */
  const overrides = new Map(scen ? engine.scenarios.resolvedOverrides(scen) : []);
  const ranges = new Map();
  for (const id of inputs) {
    const node = g.node(id);
    const ov = overrides.get(id);
    // inside a scenario, an overridden input is analysed around its scenario value
    const eff = ov ? { ...node, value: ov.value ?? node.value, dist: ov.dist ?? (ov.value !== undefined ? undefined : node.dist) } : node;
    const r = analysisRange(eff);
    if (!r) continue;
    ranges.set(id, r);
    // decision inputs (price, rent, ...) are choices, not uncertainties: they stay at their values
    // in the variance decomposition and are ranked by their one-at-a-time swing instead
    if (node.kind === 'input' && !opts.varyDecisions) continue;
    if (!(eff.dist && eff.dist.family !== 'Point')) overrides.set(id, { dist: r.dist, value: eff.value });
    else if (ov) overrides.set(id, { dist: eff.dist, value: eff.value });
  }
  const view = engine.evaluate(overrides, { mc: true });
  const Y = view.sample(outputId);
  const base = scen ? engine.view(scen).value(outputId) : engine.value(outputId);
  const n = Y ? Y.length : 0;
  let meanY = 0;
  let varY = 0;
  if (Y) {
    for (let k = 0; k < n; k++) meanY += Y[k];
    meanY /= n;
    for (let k = 0; k < n; k++) varY += (Y[k] - meanY) ** 2;
    varY /= Math.max(1, n - 1);
  }
  const bins = opts.bins || 20;
  // Standardized regression coefficients over all varying inputs (adjusts for chance
  // correlations between independent draws); equals first-order Sobol for near-linear models.
  const varying = [...ranges.keys()].filter((id) => view.sample(id));
  const reg = Y && varY > 0 ? regression(varying.map((id) => /** @type {Float64Array} */ (view.sample(id))), Y) : null;
  const linear = !!reg && reg.r2 >= 0.6;
  /** @type {SensitivityItem[]} */
  const items = [];
  for (const [id, r] of ranges) {
    const node = g.node(id);
    const X = view.sample(id);
    let sobol = 0;
    let cr = 0;
    if (X && Y && varY > 0) cr = correlationRatio(X, Y, meanY, varY, bins);
    const j = varying.indexOf(id);
    sobol = linear && j >= 0 ? Math.min(1, reg.beta[j] ** 2) : cr;
    const baseOv = scen ? engine.scenarios.resolvedOverrides(scen) : new Map();
    const low = engine.pointUnder(new Map([...baseOv, [id, { value: r.lo }]]), outputId);
    const high = engine.pointUnder(new Map([...baseOv, [id, { value: r.hi }]]), outputId);
    const sdY = Math.sqrt(varY);
    items.push({
      id,
      name: node.name,
      path: g.path(id),
      prov: g.displayProv(id),
      unit: node.type?.unit || '',
      sobol,
      low,
      high,
      lowInput: r.lo,
      highInput: r.hi,
      swing: Math.abs(high - low),
      decision: node.kind === 'input' && !opts.varyDecisions,
      voi: node.kind === 'estimated' ? sdY * (1 - Math.sqrt(Math.max(0, 1 - sobol))) : null,
      rangeSource: r.source,
      correlationRatio: cr,
    });
  }
  items.sort((a, b) => b.sobol - a.sobol || b.swing - a.swing);
  const res = {
    output: outputId,
    items,
    sdY: Math.sqrt(varY),
    base,
    n,
    method: linear ? 'standardized regression (≈ first-order Sobol, R² ' + reg.r2.toFixed(2) + ')' : 'correlation ratio (binned first-order Sobol)',
    r2: reg ? reg.r2 : null,
    ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
  if (engine._sensCache.size > 32) engine._sensCache.clear();
  engine._sensCache.set(key, res);
  return res;
}

/**
 * Multiple linear regression of Y on the columns of X, all standardized.
 * Returns standardized coefficients (beta) and R^2. Gaussian elimination with partial pivoting
 * and a tiny ridge term; k is small (tens of inputs), n is the sample count.
 * @param {Float64Array[]} cols @param {Float64Array} Y
 */
export function regression(cols, Y) {
  const k = cols.length;
  const n = Y.length;
  if (!k) return { beta: [], r2: 0 };
  const std = (a) => {
    let m = 0;
    for (let i = 0; i < n; i++) m += a[i];
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (a[i] - m) ** 2;
    const sd = Math.sqrt(v / n) || 1;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (a[i] - m) / sd;
    return out;
  };
  const Z = cols.map(std);
  const y = std(Y);
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let a = 0; a < k; a++) {
    const za = Z[a];
    for (let b = a; b < k; b++) {
      const zb = Z[b];
      let s = 0;
      for (let i = 0; i < n; i++) s += za[i] * zb[i];
      A[a][b] = s / n;
      A[b][a] = s / n;
    }
    let sy = 0;
    for (let i = 0; i < n; i++) sy += za[i] * y[i];
    A[a][k] = sy / n;
    A[a][a] += 1e-9;
  }
  const rxy = A.map((row) => row[k]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (p !== c) { const t = A[c]; A[c] = A[p]; A[p] = t; }
    const piv = A[c][c] || 1e-12;
    for (let r = c + 1; r < k; r++) {
      const f = A[r][c] / piv;
      if (!f) continue;
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  const beta = new Array(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = A[r][k];
    for (let j = r + 1; j < k; j++) s -= A[r][j] * beta[j];
    beta[r] = s / (A[r][r] || 1e-12);
  }
  let r2 = 0;
  for (let j = 0; j < k; j++) r2 += beta[j] * rxy[j];
  return { beta, r2: Math.max(0, Math.min(1, r2)) };
}

/**
 * Var(E[Y|X]) / Var(Y) by equal-count bins over sorted X, bias-corrected.
 * @param {Float64Array} X @param {Float64Array} Y @param {number} meanY @param {number} varY @param {number} bins
 */
export function correlationRatio(X, Y, meanY, varY, bins) {
  const n = X.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => X[a] - X[b]);
  const m = Math.max(2, Math.floor(n / bins));
  const nb = Math.floor(n / m);
  let between = 0;
  for (let b = 0; b < nb; b++) {
    const start = b * m;
    const end = b === nb - 1 ? n : start + m;
    let s = 0;
    for (let k = start; k < end; k++) s += Y[idx[k]];
    const mb = s / (end - start);
    between += (end - start) * (mb - meanY) ** 2;
  }
  between /= n;
  const bias = (varY * (nb - 1)) / n;
  return Math.max(0, Math.min(1, (between - bias) / varY));
}
