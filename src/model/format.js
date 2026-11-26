/**
 * Number formatting: usd, pct, number, unit-aware values and p10-p90 intervals.
 * Uses U+2212 for minus signs. All outputs are meant for tabular-nums contexts.
 * No DOM.
 * @module model/format
 */

const MINUS = '−';
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** @param {number} v @param {(a: number) => string} f */
function signed(v, f) {
  if (!Number.isFinite(v)) return '—';
  return v < 0 ? MINUS + f(-v) : f(v);
}

/** $3,140 · $4.50 · −$1,204 */
export function usd(v) {
  if (v === 0) return '$0';
  return signed(v, (a) => (a >= 100 ? `$${nf0.format(Math.round(a))}` : `$${nf2.format(a)}`));
}

/** Always two decimals: $4.00 */
export function usd2(v) {
  return signed(v, (a) => `$${nf2.format(a)}`);
}

/** $21.4k · $1.2M · $950 */
export function usdCompact(v) {
  return signed(v, (a) => (a >= 1e6 ? `$${nf1.format(a / 1e6)}M` : a >= 1e4 ? `$${nf1.format(a / 1e3)}k` : a >= 100 ? `$${nf0.format(a)}` : `$${nf2.format(a)}`));
}

/** 0.183 -> 18% · 0.004 -> 0.4% · 0.9995 -> >99.9% */
export function pct(p) {
  if (!Number.isFinite(p)) return '—';
  if (p <= 0) return '0%';
  if (p >= 1) return '100%';
  const v = p * 100;
  if (v < 0.1) return '<0.1%';
  if (v < 1) return `${nf1.format(v)}%`;
  if (v > 99.9) return '>99.9%';
  if (v > 99) return `${nf1.format(v)}%`;
  return `${nf0.format(Math.round(v))}%`;
}

/** Percent with one decimal (for rates like 8.5%). */
export function pct1(p) {
  if (!Number.isFinite(p)) return '—';
  return signed(p * 100, (a) => `${nf1.format(a)}%`);
}

/** Auto-precision number with thousands separators. */
export function num(v) {
  return signed(v, (a) => {
    if (a >= 1000) return nf0.format(Math.round(a));
    if (a >= 100) return nf1.format(a).replace(/\.0$/, '');
    if (a >= 10) return nf1.format(a);
    if (a >= 1) return nf2.format(a);
    if (a === 0) return '0';
    return String(Number(a.toPrecision(3)));
  });
}

export function int(v) {
  return signed(v, (a) => nf0.format(Math.round(a)));
}

/** Compact: 21.4k, 1.2M, 950 */
export function compact(v) {
  return signed(v, (a) => (a >= 1e6 ? `${nf1.format(a / 1e6)}M` : a >= 1e4 ? `${nf1.format(a / 1e3)}k` : num(a)));
}

/** @param {string} unit */
export function isCurrency(unit) {
  return /^(USD|kUSD|\$)\b/.test(unit || '');
}

/** @param {string} unit */
export function isProbability(unit) {
  return unit === 'prob' || unit === 'share' || unit === '%' || unit === 'pct';
}

/**
 * Unit-aware value: $6,500/month, 310 loaf/day, 8.5%/year, 18%.
 * @param {number} v @param {string} unit @param {{compact?: boolean, bare?: boolean}} [opts]
 */
export function unitValue(v, unit, opts = {}) {
  const u = unit || '';
  if (isCurrency(u)) {
    const rest = u.replace(/^(USD|kUSD|\$)/, '');
    const s = opts.compact ? usdCompact(v) : usd(v);
    return opts.bare ? s : `${s}${rest}`;
  }
  if (isProbability(u)) return pct(v);
  if (u === '1/year') return `${pct1(v)}/year`;
  if (u === '1' || u === '' || u === 'ratio' || u === 'score' || u === 'index') return num(v);
  const s = opts.compact ? compact(v) : num(v);
  return opts.bare ? s : `${s} ${u}`;
}

/**
 * Format by name (used by {{ path | fmt }} bindings).
 * @param {number} v @param {string} fmt @param {string} unit
 */
export function formatAs(v, fmt, unit) {
  switch (fmt) {
    case 'usd': return usd(v);
    case 'usd2': return usd2(v);
    case 'usdk': case 'usdCompact': return usdCompact(v);
    case 'pct': return pct(v);
    case 'pct1': return pct1(v);
    case 'num': return num(v);
    case 'int': return int(v);
    case 'compact': return compact(v);
    case 'unit': return unitValue(v, unit);
    case 'bare': return unitValue(v, unit, { bare: true });
    default: return unitValue(v, unit, { bare: true });
  }
}

/** p10–p90 interval: $1,200–$5,100 */
export function interval(lo, hi, unit, fmt) {
  const f = (x) => (fmt ? formatAs(x, fmt, unit) : unitValue(x, unit, { bare: true }));
  return `${f(lo)}–${f(hi)}`;
}

/** Signed change: +$420 / −3 pp */
export function delta(v, unit) {
  if (!Number.isFinite(v)) return '—';
  if (isProbability(unit)) return `${v >= 0 ? '+' : MINUS}${nf0.format(Math.abs(v * 100))} pp`;
  const s = unitValue(Math.abs(v), unit, { bare: true });
  return `${v >= 0 ? '+' : MINUS}${s}`;
}

/** Elapsed ms for status readouts. */
export function ms(v) {
  if (!Number.isFinite(v)) return '—';
  return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
}

/** Token counts: 3,412 tokens / ~3k tokens */
export function tokens(n, approx = false) {
  if (approx) return n >= 1000 ? `~${Math.round(n / 1000)}k tokens` : `~${n} tokens`;
  return `${nf0.format(n)} tokens`;
}
