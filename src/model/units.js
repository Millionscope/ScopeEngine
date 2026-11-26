/**
 * Units are part of types. A unit is a scale factor plus a dimension vector over base
 * dimensions (USD, s, m, kg and count dimensions such as loaf, person). Conversions go only
 * through registered factors (convert()), never bare constants.
 *
 *   'USD/month' -> { f: 1/2629800, d: { USD: 1, s: -1 } }
 *
 * Addition requires identical units (same dimensions AND scale): USD/day - USD/month is a unit
 * mismatch even though both are currency per time; the fix is convert(x, USD/month).
 * No DOM; runnable in a worker.
 * @module model/units
 */

/** @typedef {{ f: number, d: Record<string, number>, text: string, poly?: boolean, isText?: boolean }} Unit */

const DAY = 86400;
const YEAR = 365.25 * DAY;
const MONTH = YEAR / 12; // 30.4375 days
const WEEK = 7 * DAY;

/** Registered unit atoms: name -> [factor, dims]. */
const ATOMS = {
  // dimensionless
  '1': [1, {}], prob: [1, {}], ratio: [1, {}], score: [1, {}], share: [1, {}], index: [1, {}],
  '%': [0.01, {}], pct: [0.01, {}], bool: [1, {}],
  // currency
  USD: [1, { USD: 1 }], kUSD: [1000, { USD: 1 }], '$': [1, { USD: 1 }],
  // time
  s: [1, { s: 1 }], min: [60, { s: 1 }], hour: [3600, { s: 1 }], h: [3600, { s: 1 }],
  day: [DAY, { s: 1 }], week: [WEEK, { s: 1 }], month: [MONTH, { s: 1 }], year: [YEAR, { s: 1 }],
  step: [MONTH, { s: 1 }],
  // length / area / mass
  m: [1, { m: 1 }], km: [1000, { m: 1 }], m2: [1, { m: 2 }], sqft: [0.09290304, { m: 2 }], kg: [1, { kg: 1 }],
  // counts (each its own dimension so loaves never add to people)
  loaf: [1, { loaf: 1 }], person: [1, { person: 1 }], customer: [1, { person: 1 }],
  visit: [1, { visit: 1 }], item: [1, { item: 1 }], unit: [1, { item: 1 }], agent: [1, { agent: 1 }],
  scope: [1, { scope: 1 }],
};

export const TIME = { DAY, WEEK, MONTH, YEAR };

/** @type {Map<string, Unit>} */
const cache = new Map();

/**
 * Parse a unit string: 'USD/month', 'USD/m2/month', '1/year', 'loaf/day', 'hour/week',
 * 'score[0,1]', 'text', '' (dimensionless). '*' or '·' multiply; '^n' or trailing digits raise.
 * @param {string|null|undefined} text
 * @returns {Unit}
 */
export function parseUnit(text) {
  const raw = (text ?? '').trim();
  const hit = cache.get(raw);
  if (hit) return hit;
  let u;
  if (raw === 'text' || raw === 'string') u = { f: 1, d: {}, text: 'text', isText: true };
  else {
    const clean = raw.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
    if (!clean) u = { f: 1, d: {}, text: raw || '1' };
    else {
      const parts = clean.split('/');
      let f = 1;
      /** @type {Record<string, number>} */
      const d = {};
      parts.forEach((part, i) => {
        const sign = i === 0 ? 1 : -1;
        for (const factor of part.split(/[*·]/)) {
          if (!factor) continue;
          const m = /^(.+?)(?:\^(-?\d+))?$/.exec(factor);
          let name = m ? m[1] : factor;
          let exp = m && m[2] ? Number(m[2]) : 1;
          if (!(name in ATOMS)) {
            const m2 = /^([A-Za-z$%]+)([23])$/.exec(name);
            if (m2 && m2[1] in ATOMS && !(name in ATOMS)) { name = m2[1]; exp *= Number(m2[2]); }
          }
          const atom = ATOMS[name];
          if (!atom) throw new UnitError(`unknown unit "${factor}" in "${raw}"`, `register it in model/units.js or use one of: ${Object.keys(ATOMS).slice(0, 18).join(', ')}…`);
          f *= atom[0] ** (exp * sign);
          for (const [k, v] of Object.entries(atom[1])) d[k] = (d[k] || 0) + v * exp * sign;
        }
      });
      for (const k of Object.keys(d)) if (d[k] === 0) delete d[k];
      u = { f, d, text: raw };
    }
  }
  cache.set(raw, u);
  return u;
}

export class UnitError extends Error {
  /** @param {string} message @param {string} [hint] */
  constructor(message, hint) {
    super(message);
    this.name = 'UnitError';
    this.hint = hint;
  }
}

/** A unit-polymorphic literal (numbers adopt the other operand's unit in + - and comparisons). */
export const POLY = Object.freeze({ f: 1, d: {}, text: '', poly: true });
export const DIMLESS = Object.freeze({ f: 1, d: {}, text: '1' });

/** @param {Unit} a @param {Unit} b */
export function sameDims(a, b) {
  const ka = Object.keys(a.d);
  const kb = Object.keys(b.d);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a.d[k] !== b.d[k]) return false;
  return true;
}

/** Same dimensions and same scale. @param {Unit} a @param {Unit} b */
export function sameUnit(a, b) {
  if (a.poly || b.poly) return true;
  if (!!a.isText !== !!b.isText) return false;
  return sameDims(a, b) && Math.abs(a.f - b.f) <= 1e-12 * Math.max(Math.abs(a.f), Math.abs(b.f));
}

export function isDimensionless(u) {
  return Object.keys(u.d).length === 0 && !u.isText;
}

/** @param {Unit} a @param {Unit} b @returns {Unit} */
export function mulUnit(a, b) {
  if (a.poly) return b.poly ? POLY : b;
  if (b.poly) return a;
  const d = { ...a.d };
  for (const [k, v] of Object.entries(b.d)) {
    d[k] = (d[k] || 0) + v;
    if (d[k] === 0) delete d[k];
  }
  return { f: a.f * b.f, d, text: joinText(a.text, '*', b.text) };
}

/** @param {Unit} a @param {Unit} b @returns {Unit} */
export function divUnit(a, b) {
  if (b.poly) return a;
  const inv = { f: 1 / b.f, d: Object.fromEntries(Object.entries(b.d).map(([k, v]) => [k, -v])), text: `1/${b.text}` };
  if (a.poly) return inv;
  return { ...mulUnit(a, inv), text: joinText(a.text, '/', b.text) };
}

/** @param {Unit} a @param {number} n @returns {Unit} */
export function powUnit(a, n) {
  if (a.poly || isDimensionless(a)) return a.poly ? POLY : DIMLESS;
  const d = Object.fromEntries(Object.entries(a.d).map(([k, v]) => [k, v * n]));
  return { f: a.f ** n, d, text: `${a.text}^${n}` };
}

/** @param {string} a @param {string} op @param {string} b */
function joinText(a, op, b) {
  if (!a || a === '1') return op === '/' ? `1/${b}` : b;
  if (!b || b === '1') return a;
  const wrap = (s) => (/[/*]/.test(s) ? `(${s})` : s);
  return `${a}${op}${op === '/' ? wrap(b) : b}`;
}

/**
 * Factor to multiply a value in `from` to express it in `to`. Throws on dimension mismatch.
 * @param {string|Unit} from @param {string|Unit} to
 */
export function convertFactor(from, to) {
  const a = typeof from === 'string' ? parseUnit(from) : from;
  const b = typeof to === 'string' ? parseUnit(to) : to;
  if (!sameDims(a, b)) {
    throw new UnitError(`cannot convert ${a.text || '1'} to ${b.text || '1'}: dimensions differ (${dimString(a)} vs ${dimString(b)})`,
      'convert() only changes scale; fix the formula so both sides measure the same quantity');
  }
  return a.f / b.f;
}

/** @param {number} value @param {string} from @param {string} to */
export function convert(value, from, to) {
  return value * convertFactor(from, to);
}

/** Human dimension vector: 'USD·s⁻¹'. @param {Unit} u */
export function dimString(u) {
  const parts = Object.entries(u.d).map(([k, v]) => (v === 1 ? k : `${k}^${v}`));
  return parts.length ? parts.join('·') : 'dimensionless';
}

/** Display text for a unit ('1' for dimensionless). @param {Unit} u */
export function unitText(u) {
  if (u.poly) return '';
  return u.text || (isDimensionless(u) ? '1' : dimString(u));
}

/**
 * Units of the annuity payment: annuity(P: currency, r: 1/time, t: time) -> currency/month.
 * @param {Unit} p @param {Unit} r @param {Unit} t
 * @returns {Unit}
 */
export function annuityUnit(p, r, t) {
  const curr = parseUnit('USD');
  const perTime = parseUnit('1/year');
  const time = parseUnit('year');
  if (!p.poly && !sameDims(p, curr)) throw new UnitError(`annuity principal must be currency, got ${unitText(p)}`);
  if (!r.poly && !sameDims(r, perTime)) throw new UnitError(`annuity rate must be 1/time, got ${unitText(r)}`, 'use 1/year');
  if (!t.poly && !sameDims(t, time)) throw new UnitError(`annuity term must be a time, got ${unitText(t)}`, 'use year');
  return parseUnit('USD/month');
}

export const KNOWN_UNITS = Object.keys(ATOMS);
