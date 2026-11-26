/**
 * Distributions are values. Every family exposes quantile(u) so Monte Carlo can push stratified
 * (Latin hypercube) or copula-correlated uniforms through it; pdf/cdf/mean/sd for display.
 *
 * Families: Normal(mean, sd) · LogNormal(median, p90) · Beta(alpha, beta[, loc, scale]) ·
 * Uniform(min, max) · Triangular(min, mode, max) · Mixture(components, contested?) · Point(value)
 * No DOM.
 * @module model/distributions
 */

/**
 * @typedef {{family:'Normal', mean:number, sd:number}
 *  | {family:'LogNormal', median:number, p90:number}
 *  | {family:'Beta', alpha:number, beta:number, loc?:number, scale?:number}
 *  | {family:'Uniform', min:number, max:number}
 *  | {family:'Triangular', min:number, mode:number, max:number}
 *  | {family:'Mixture', components:Array<{w:number, dist:DistSpec, by?:string}>, contested?:boolean}
 *  | {family:'Point', value:number}} DistSpec
 */

/**
 * @typedef {Object} Dist
 * @property {DistSpec} spec
 * @property {(u:number) => number} quantile
 * @property {(x:number) => number} cdf
 * @property {(x:number) => number} pdf
 * @property {() => number} mean
 * @property {() => number} sd
 * @property {() => number} median
 */

export const Z90 = 1.2815515655446004;
const SQRT2 = Math.SQRT2;
const SQRT2PI = Math.sqrt(2 * Math.PI);

// ---------------------------------------------------------------- normal helpers

/** Standard normal CDF (erfc-based, ~1e-7). @param {number} z */
export function phi(z) {
  return 0.5 * erfc(-z / SQRT2);
}

/** @param {number} x */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Standard normal pdf. @param {number} z */
export function phiPdf(z) {
  return Math.exp(-0.5 * z * z) / SQRT2PI;
}

/** Inverse standard normal CDF (Acklam, with one Halley refinement). @param {number} p */
export function phiInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  let q;
  let x;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - plow) {
    q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = phi(x) - p;
  const u = e * SQRT2PI * Math.exp(0.5 * x * x);
  return x - u / (1 + 0.5 * x * u);
}

// ---------------------------------------------------------------- gamma / beta helpers

/** log Gamma (Lanczos). @param {number} x */
export function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp0 = x + 5.5;
  const tmp = tmp0 - (x + 0.5) * Math.log(tmp0);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// ---------------------------------------------------------------- tabulated inverse CDFs

/** @type {Map<string, {xs: Float64Array, cs: Float64Array}>} */
const tables = new Map();
const TABLE_N = 1025;

/**
 * Build (and cache) a monotone CDF table on [lo, hi] for numeric inversion.
 * @param {string} key @param {(x:number) => number} cdf @param {number} lo @param {number} hi
 */
function table(key, cdf, lo, hi) {
  let t = tables.get(key);
  if (t) return t;
  const xs = new Float64Array(TABLE_N);
  const cs = new Float64Array(TABLE_N);
  for (let i = 0; i < TABLE_N; i++) {
    const x = lo + ((hi - lo) * i) / (TABLE_N - 1);
    xs[i] = x;
    cs[i] = Math.min(1, Math.max(0, cdf(x)));
    if (i > 0 && cs[i] < cs[i - 1]) cs[i] = cs[i - 1];
  }
  t = { xs, cs };
  if (tables.size > 400) tables.clear();
  tables.set(key, t);
  return t;
}

/** @param {{xs: Float64Array, cs: Float64Array}} t @param {number} u */
function invert(t, u) {
  const { xs, cs } = t;
  if (u <= cs[0]) return xs[0];
  if (u >= cs[TABLE_N - 1]) return xs[TABLE_N - 1];
  let lo = 0;
  let hi = TABLE_N - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cs[mid] < u) lo = mid;
    else hi = mid;
  }
  const span = cs[hi] - cs[lo];
  const w = span > 0 ? (u - cs[lo]) / span : 0;
  return xs[lo] + w * (xs[hi] - xs[lo]);
}

// ---------------------------------------------------------------- families

/**
 * Validate a spec; returns an error message or null.
 * @param {DistSpec} s
 */
export function validateDist(s) {
  if (!s || typeof s !== 'object') return 'distribution missing';
  const fin = (...v) => v.every((x) => Number.isFinite(x));
  switch (s.family) {
    case 'Normal': return !fin(s.mean, s.sd) ? 'Normal needs finite mean and sd' : s.sd <= 0 ? 'Normal sd must be > 0' : null;
    case 'LogNormal': return !fin(s.median, s.p90) ? 'LogNormal needs finite median and p90' : s.median <= 0 ? 'LogNormal median must be > 0' : s.p90 <= s.median ? 'LogNormal p90 must exceed the median' : null;
    case 'Beta': return !fin(s.alpha, s.beta) ? 'Beta needs finite alpha and beta' : s.alpha <= 0 || s.beta <= 0 ? 'Beta alpha and beta must be > 0' : null;
    case 'Uniform': return !fin(s.min, s.max) ? 'Uniform needs finite bounds' : s.max <= s.min ? 'Uniform max must exceed min' : null;
    case 'Triangular': return !fin(s.min, s.mode, s.max) ? 'Triangular needs finite min/mode/max' : !(s.min <= s.mode && s.mode <= s.max && s.max > s.min) ? 'Triangular needs min <= mode <= max' : null;
    case 'Mixture': {
      if (!Array.isArray(s.components) || !s.components.length) return 'Mixture needs components';
      for (const c of s.components) {
        if (!(c.w > 0)) return 'Mixture weights must be > 0';
        const e = validateDist(c.dist);
        if (e) return e;
      }
      return null;
    }
    case 'Point': return fin(s.value) ? null : 'Point needs a finite value';
    default: return `unknown family ${/** @type {any} */ (s).family}`;
  }
}

/** @param {DistSpec} spec @returns {string} */
export function specKey(spec) {
  return JSON.stringify(spec);
}

/** @type {Map<string, Dist>} */
const distCache = new Map();

/**
 * @param {DistSpec} spec
 * @returns {Dist}
 */
export function makeDist(spec) {
  const key = specKey(spec);
  const hit = distCache.get(key);
  if (hit) return hit;
  const d = build(spec);
  if (distCache.size > 2000) distCache.clear();
  distCache.set(key, d);
  return d;
}

/** @param {DistSpec} spec @returns {Dist} */
function build(spec) {
  switch (spec.family) {
    case 'Normal': {
      const { mean, sd } = spec;
      return {
        spec,
        quantile: (u) => mean + sd * phiInv(u),
        cdf: (x) => phi((x - mean) / sd),
        pdf: (x) => phiPdf((x - mean) / sd) / sd,
        mean: () => mean,
        sd: () => sd,
        median: () => mean,
      };
    }
    case 'LogNormal': {
      const mu = Math.log(spec.median);
      const sigma = Math.log(spec.p90 / spec.median) / Z90;
      return {
        spec,
        quantile: (u) => Math.exp(mu + sigma * phiInv(u)),
        cdf: (x) => (x <= 0 ? 0 : phi((Math.log(x) - mu) / sigma)),
        pdf: (x) => (x <= 0 ? 0 : phiPdf((Math.log(x) - mu) / sigma) / (x * sigma)),
        mean: () => Math.exp(mu + (sigma * sigma) / 2),
        sd: () => Math.sqrt((Math.exp(sigma * sigma) - 1) * Math.exp(2 * mu + sigma * sigma)),
        median: () => spec.median,
      };
    }
    case 'Beta': {
      const { alpha: a, beta: b } = spec;
      const loc = spec.loc ?? 0;
      const scale = spec.scale ?? 1;
      const lnB = lgamma(a) + lgamma(b) - lgamma(a + b);
      const t = table(`beta:${a}:${b}`, (x) => ibeta(x, a, b), 0, 1);
      const m = a / (a + b);
      const v = (a * b) / ((a + b) ** 2 * (a + b + 1));
      return {
        spec,
        quantile: (u) => loc + scale * invert(t, u),
        cdf: (x) => ibeta((x - loc) / scale, a, b),
        pdf: (x) => {
          const z = (x - loc) / scale;
          if (z <= 0 || z >= 1) return 0;
          return Math.exp((a - 1) * Math.log(z) + (b - 1) * Math.log(1 - z) - lnB) / scale;
        },
        mean: () => loc + scale * m,
        sd: () => scale * Math.sqrt(v),
        median: () => loc + scale * invert(t, 0.5),
      };
    }
    case 'Uniform': {
      const { min, max } = spec;
      return {
        spec,
        quantile: (u) => min + (max - min) * u,
        cdf: (x) => (x <= min ? 0 : x >= max ? 1 : (x - min) / (max - min)),
        pdf: (x) => (x < min || x > max ? 0 : 1 / (max - min)),
        mean: () => (min + max) / 2,
        sd: () => (max - min) / Math.sqrt(12),
        median: () => (min + max) / 2,
      };
    }
    case 'Triangular': {
      const { min: a, mode: c, max: b } = spec;
      const fc = (c - a) / (b - a);
      return {
        spec,
        quantile: (u) => (u < fc ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c))),
        cdf: (x) => (x <= a ? 0 : x >= b ? 1 : x <= c ? ((x - a) ** 2) / ((b - a) * (c - a)) : 1 - ((b - x) ** 2) / ((b - a) * (b - c))),
        pdf: (x) => (x < a || x > b ? 0 : x < c ? (2 * (x - a)) / ((b - a) * (c - a)) : (2 * (b - x)) / ((b - a) * (b - c))),
        mean: () => (a + b + c) / 3,
        sd: () => Math.sqrt((a * a + b * b + c * c - a * b - a * c - b * c) / 18),
        median: () => (fc >= 0.5 ? a + Math.sqrt(((b - a) * (c - a)) / 2) : b - Math.sqrt(((b - a) * (b - c)) / 2)),
      };
    }
    case 'Mixture': {
      const total = spec.components.reduce((s, c) => s + c.w, 0);
      const comps = spec.components.map((c) => ({ w: c.w / total, d: makeDist(c.dist) }));
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of comps) {
        lo = Math.min(lo, c.d.quantile(0.0005));
        hi = Math.max(hi, c.d.quantile(0.9995));
      }
      const cdf = (x) => comps.reduce((s, c) => s + c.w * c.d.cdf(x), 0);
      const t = table(`mix:${specKey(spec)}`, cdf, lo, hi);
      const mean = comps.reduce((s, c) => s + c.w * c.d.mean(), 0);
      const second = comps.reduce((s, c) => s + c.w * (c.d.sd() ** 2 + c.d.mean() ** 2), 0);
      return {
        spec,
        quantile: (u) => invert(t, u),
        cdf,
        pdf: (x) => comps.reduce((s, c) => s + c.w * c.d.pdf(x), 0),
        mean: () => mean,
        sd: () => Math.sqrt(Math.max(0, second - mean * mean)),
        median: () => invert(t, 0.5),
      };
    }
    case 'Point':
    default: {
      const v = /** @type {any} */ (spec).value ?? 0;
      return { spec, quantile: () => v, cdf: (x) => (x < v ? 0 : 1), pdf: () => 0, mean: () => v, sd: () => 0, median: () => v };
    }
  }
}

/** Nominal point value of a distribution (median; mean for symmetric families). @param {DistSpec} spec */
export function nominal(spec) {
  const d = makeDist(spec);
  return spec.family === 'Normal' || spec.family === 'Uniform' ? d.mean() : d.median();
}

/** Plausible range for sliders and sensitivity: [q(lo), q(hi)]. @param {DistSpec} spec */
export function range(spec, lo = 0.01, hi = 0.99) {
  const d = makeDist(spec);
  return [d.quantile(lo), d.quantile(hi)];
}

/** @param {number} v */
function n(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US').replace(/,/g, '_');
  if (a >= 100) return String(Math.round(v * 10) / 10);
  if (a >= 1) return String(Math.round(v * 100) / 100);
  return String(Number(v.toPrecision(3)));
}

/** ScopeLang-style description: 'LogNormal(median=310, p90=420)'. @param {DistSpec} s */
export function describe(s) {
  switch (s.family) {
    case 'Normal': return `Normal(mean=${n(s.mean)}, sd=${n(s.sd)})`;
    case 'LogNormal': return `LogNormal(median=${n(s.median)}, p90=${n(s.p90)})`;
    case 'Beta': return `Beta(${n(s.alpha)}, ${n(s.beta)})${s.scale && s.scale !== 1 ? ` * ${n(s.scale)}` : ''}${s.loc ? ` + ${n(s.loc)}` : ''}`;
    case 'Uniform': return `Uniform(${n(s.min)}, ${n(s.max)})`;
    case 'Triangular': return `Triangular(${n(s.min)}, ${n(s.mode)}, ${n(s.max)})`;
    case 'Mixture': return `Mixture(${s.components.map((c) => `${n(c.w)}: ${describe(c.dist)}`).join(', ')})${s.contested ? ' contested' : ''}`;
    case 'Point': return n(s.value);
    default: return '?';
  }
}

/** Parameter schema per family (for the distribution editor). */
export const FAMILY_PARAMS = {
  Normal: ['mean', 'sd'],
  LogNormal: ['median', 'p90'],
  Beta: ['alpha', 'beta'],
  Uniform: ['min', 'max'],
  Triangular: ['min', 'mode', 'max'],
};

/**
 * Convert a spec to another family keeping its center and spread roughly comparable.
 * @param {DistSpec} spec @param {string} family @returns {DistSpec}
 */
export function convertFamily(spec, family) {
  const d = makeDist(spec);
  const med = d.median();
  const p10 = d.quantile(0.1);
  const p90 = d.quantile(0.9);
  const sd = Math.max(1e-9, d.sd());
  switch (family) {
    case 'Normal': return { family: 'Normal', mean: d.mean(), sd };
    case 'LogNormal': return { family: 'LogNormal', median: Math.max(1e-9, med), p90: Math.max(med * 1.01, p90) };
    case 'Uniform': return { family: 'Uniform', min: p10, max: Math.max(p10 + 1e-9, p90) };
    case 'Triangular': return { family: 'Triangular', min: d.quantile(0.02), mode: med, max: d.quantile(0.98) };
    case 'Beta': {
      const m = Math.min(0.98, Math.max(0.02, d.mean()));
      const v = Math.min(m * (1 - m) * 0.9, Math.max(1e-5, sd * sd));
      const k = (m * (1 - m)) / v - 1;
      return { family: 'Beta', alpha: Math.max(0.1, m * k), beta: Math.max(0.1, (1 - m) * k) };
    }
    default: return spec;
  }
}

/**
 * Move a distribution so its center becomes `to` (multiplicative for positive families).
 * @param {any} spec @param {number} from @param {number} to
 */
export function shiftDist(spec, from, to) {
  const s = { ...spec };
  switch (spec.family) {
    case 'LogNormal': {
      const r = spec.p90 / spec.median;
      s.median = Math.max(1e-9, to);
      s.p90 = s.median * r;
      return s;
    }
    case 'Normal': s.mean = to; return s;
    case 'Uniform': { const d = to - from; s.min += d; s.max += d; return s; }
    case 'Triangular': { const d = to - from; s.min += d; s.mode += d; s.max += d; return s; }
    case 'Beta': {
      const k = spec.alpha + spec.beta;
      const m = Math.min(0.995, Math.max(0.005, to));
      s.alpha = m * k;
      s.beta = (1 - m) * k;
      return s;
    }
    case 'Mixture': {
      const ratio = from !== 0 ? to / from : 1;
      return { family: 'LogNormal', median: Math.max(1e-9, to), p90: Math.max(to * 1.01, makeDist(spec).quantile(0.9) * ratio) };
    }
    default: return { family: 'Point', value: to };
  }
}
