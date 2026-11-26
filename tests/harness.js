/**
 * Zero-dependency test harness: suite(name) returns a test() registrar; run() executes every
 * registered test in order (async allowed) and reports results. Used by tests/index.html.
 */

/** @type {Array<{suite: string, name: string, fn: () => any}>} */
const registry = [];

/** @param {string} suiteName */
export function suite(suiteName) {
  /** @param {string} name @param {() => any} fn */
  return (name, fn) => registry.push({ suite: suiteName, name, fn });
}

export class AssertionError extends Error {}

/** @param {any} v */
function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  try {
    const s = JSON.stringify(v);
    return s && s.length > 160 ? s.slice(0, 157) + '…' : String(s);
  } catch {
    return String(v);
  }
}

const pre = (msg) => (msg ? `${msg}: ` : '');

export const assert = {
  /** @param {any} v @param {string} [msg] */
  ok(v, msg) { if (!v) throw new AssertionError(`${pre(msg)}expected truthy, got ${show(v)}`); },
  /** @param {any} a @param {any} b @param {string} [msg] */
  equal(a, b, msg) { if (!Object.is(a, b)) throw new AssertionError(`${pre(msg)}expected ${show(b)}, got ${show(a)}`); },
  /** @param {any} a @param {any} b @param {string} [msg] */
  notEqual(a, b, msg) { if (Object.is(a, b)) throw new AssertionError(`${pre(msg)}expected a value other than ${show(b)}`); },
  /** @param {number} a @param {number} b @param {number} tol @param {string} [msg] */
  close(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new AssertionError(`${pre(msg)}expected ${b} ± ${tol}, got ${a}`); },
  /** @param {any} a @param {any} b @param {string} [msg] */
  deepEqual(a, b, msg) {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    if (x !== y) throw new AssertionError(`${pre(msg)}structures differ:\n  got      ${show(a)}\n  expected ${show(b)}`);
  },
  /** @param {string} s @param {RegExp} re @param {string} [msg] */
  match(s, re, msg) { if (!re.test(String(s))) throw new AssertionError(`${pre(msg)}${show(s)} does not match ${re}`); },
  /** @param {() => any} fn @param {RegExp} [re] @param {string} [msg] */
  throws(fn, re, msg) {
    try {
      fn();
    } catch (e) {
      if (re && !re.test(String(/** @type {Error} */ (e).message))) throw new AssertionError(`${pre(msg)}threw ${show(/** @type {Error} */ (e).message)}, expected ${re}`);
      return;
    }
    throw new AssertionError(`${pre(msg)}expected an exception`);
  },
};

/**
 * @param {(r: {suite: string, name: string, ok: boolean, ms: number, error?: string}) => void} [onResult]
 */
export async function run(onResult) {
  const results = [];
  for (const t of registry) {
    const t0 = performance.now();
    /** @type {{suite: string, name: string, ok: boolean, ms: number, error?: string}} */
    let r;
    try {
      await t.fn();
      r = { suite: t.suite, name: t.name, ok: true, ms: performance.now() - t0 };
    } catch (e) {
      const err = /** @type {Error} */ (e);
      r = { suite: t.suite, name: t.name, ok: false, ms: performance.now() - t0, error: err instanceof AssertionError ? err.message : `${err.name}: ${err.message}\n${err.stack || ''}` };
    }
    results.push(r);
    onResult?.(r);
  }
  return results;
}
