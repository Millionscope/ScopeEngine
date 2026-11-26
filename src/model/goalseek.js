/**
 * Goal seek: "find the price that keeps P(monthly_cash < 0) under 10%".
 * Bracketed root finding (bisection) on the Monte Carlo estimate, using common random numbers
 * (the engine's uniforms are keyed by node id and sample index, so every evaluation reuses the
 * same draws and the target is smooth in the decision variable). The answer is the smallest
 * change from the current value that meets the goal. Results are written as a new scenario by
 * the caller, never over the user's inputs. No DOM.
 * @module model/goalseek
 */

/**
 * @typedef {Object} GoalSeekSpec
 * @property {{id: string, stat: 'prob_lt'|'prob_gt'|'p10'|'p50'|'p90'|'mean', threshold?: number}} target
 * @property {{op: '<'|'>', value: number}} goal
 * @property {{id: string, lo?: number, hi?: number}} decision
 * @property {number=} tol           stop when the bracket is narrower than this
 * @property {number=} maxIter
 */

/**
 * @typedef {Object} GoalSeekResult
 * @property {boolean} ok
 * @property {number} value          decision value found
 * @property {number} current        current decision value
 * @property {number} achieved       target metric at `value`
 * @property {number} before         target metric at the current value
 * @property {number} iterations
 * @property {Array<{x: number, y: number}>} trace
 * @property {string} message
 */

/**
 * @param {import('./engine.js').JsEngine} engine
 * @param {GoalSeekSpec} spec
 * @returns {GoalSeekResult}
 */
export function goalSeek(engine, spec) {
  const g = engine.graph;
  const dnode = g.node(spec.decision.id);
  if (!dnode || dnode.kind === 'computed') {
    return fail(`decision variable ${spec.decision.id} must be an input, observed or estimated metric`);
  }
  const tnode = g.node(spec.target.id);
  if (!tnode) return fail(`unknown target ${spec.target.id}`);
  const x0 = engine.value(spec.decision.id);
  const range = dnode.range || [x0 * 0.5, x0 * 1.5];
  const lo0 = spec.decision.lo ?? range[0];
  const hi0 = spec.decision.hi ?? range[1];
  /** @type {Array<{x:number, y:number}>} */
  const trace = [];
  const measure = (x) => {
    const view = engine.evaluate(new Map([[spec.decision.id, { value: x }]]), { mc: true });
    let y;
    switch (spec.target.stat) {
      case 'prob_lt': y = view.prob(spec.target.id, '<', spec.target.threshold ?? 0); break;
      case 'prob_gt': y = view.prob(spec.target.id, '>', spec.target.threshold ?? 0); break;
      default: {
        const s = view.stats(spec.target.id);
        y = s ? /** @type {any} */ (s)[spec.target.stat] ?? s.p50 : NaN;
      }
    }
    trace.push({ x, y });
    return y;
  };
  const meets = (y) => (spec.goal.op === '<' ? y < spec.goal.value : y > spec.goal.value);
  const before = measure(x0);
  if (meets(before)) {
    return { ok: true, value: x0, current: x0, achieved: before, before, iterations: 0, trace, message: 'the current value already meets the goal' };
  }
  const yLo = measure(lo0);
  const yHi = measure(hi0);
  // choose the side that meets the goal and is closest to the current value
  const candidates = [];
  if (meets(yHi)) candidates.push({ a: x0, b: hi0 });
  if (meets(yLo)) candidates.push({ a: x0, b: lo0 });
  if (!candidates.length) {
    return { ok: false, value: NaN, current: x0, achieved: NaN, before, iterations: trace.length, trace, message: `no value of ${dnode.name} in [${round(lo0)}, ${round(hi0)}] meets the goal` };
  }
  candidates.sort((p, q) => Math.abs(p.b - x0) - Math.abs(q.b - x0));
  let { a, b } = candidates[0]; // a fails, b meets
  const tol = spec.tol ?? Math.abs(hi0 - lo0) / 2000;
  const maxIter = spec.maxIter ?? 40;
  let yb = measure(b);
  let it = 0;
  while (Math.abs(b - a) > tol && it < maxIter) {
    const mid = (a + b) / 2;
    const ym = measure(mid);
    if (meets(ym)) { b = mid; yb = ym; } else a = mid;
    it++;
  }
  return {
    ok: true,
    value: b,
    current: x0,
    achieved: yb,
    before,
    iterations: it,
    trace,
    message: `${dnode.name} = ${round(b)} meets the goal (bisection, ${it} steps, ${engine.n.toLocaleString('en-US')} samples with common random numbers)`,
  };

  /** @param {string} message @returns {GoalSeekResult} */
  function fail(message) {
    return { ok: false, value: NaN, current: NaN, achieved: NaN, before: NaN, iterations: 0, trace: [], message };
  }
}

/** @param {number} x */
function round(x) {
  return Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 1000) / 1000;
}
