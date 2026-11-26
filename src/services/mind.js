/**
 * Mind adapter (mock of mind.infer(agent, observations)): Bayesian inverse planning over a
 * Mind Scope's hidden state. The posterior is computed on a grid (stand-in for the engine's
 * sequential Monte Carlo over particles), each observation's log Bayes factor (H1: θ > 0.5 vs
 * H0: θ ≤ 0.5) is the evidence trail, and the posterior is written back to the graph as an
 * estimated distribution (a ScopeDelta), so every downstream number recomputes.
 * Simulation, not assessment. No DOM.
 * @module services/mind
 */
import { MINDS } from '../mock/minds.js';
import { lgamma } from '../model/distributions.js';

const GRID = 401;

/** @param {number} x */
const logistic = (x) => 1 / (1 + Math.exp(-x));

/** @param {{slope: number, center: number, base?: number}} L @param {number} theta */
function likelihood(L, theta) {
  const base = L.base ?? 0.08;
  return base + (1 - 2 * base) * logistic(L.slope * 4 * (theta - L.center));
}

/** Beta pdf on the grid. @param {number} a @param {number} b */
function betaGrid(a, b) {
  const xs = new Float64Array(GRID);
  const ps = new Float64Array(GRID);
  const lnB = lgamma(a) + lgamma(b) - lgamma(a + b);
  for (let i = 0; i < GRID; i++) {
    const x = (i + 0.5) / GRID;
    xs[i] = x;
    ps[i] = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lnB);
  }
  return { xs, ps: normalize(ps) };
}

/** @param {Float64Array} ps */
function normalize(ps) {
  let s = 0;
  for (const p of ps) s += p;
  const out = new Float64Array(ps.length);
  for (let i = 0; i < ps.length; i++) out[i] = ps[i] / (s || 1);
  return out;
}

/** Method-of-moments Beta fit. @param {Float64Array} xs @param {Float64Array} ps */
function fitBeta(xs, ps) {
  let m = 0;
  for (let i = 0; i < xs.length; i++) m += xs[i] * ps[i];
  let v = 0;
  for (let i = 0; i < xs.length; i++) v += (xs[i] - m) ** 2 * ps[i];
  const k = Math.max(0.5, (m * (1 - m)) / Math.max(1e-6, v) - 1);
  return { alpha: Math.max(0.2, m * k), beta: Math.max(0.2, (1 - m) * k), mean: m, sd: Math.sqrt(v) };
}

export class MindService {
  /**
   * @param {{
   *   events: import('../core/events.js').EventBus,
   *   history: import('./history.js').HistoryService,
   *   getEngine: () => import('../model/engine.js').JsEngine,
   * }} deps
   */
  constructor({ events, history, getEngine }) {
    this.events = events;
    this.history = history;
    this.getEngine = getEngine;
    this.minds = MINDS;
    /** @type {Map<string, any>} last inference result per agent */
    this.results = new Map();
  }

  /** Profiles of the modeled parties (present in the current graph). */
  parties() {
    const g = this.getEngine().graph;
    return this.minds.filter((m) => g.scope(m.id));
  }

  /** @param {string} id */
  get(id) { return this.minds.find((m) => m.id === id) || null; }

  /** @param {string} name */
  byName(name) {
    const q = name.toLowerCase().replace(/^@/, '');
    return this.minds.find((m) => m.name.toLowerCase() === q || m.name.toLowerCase().startsWith(q) || m.id.endsWith(q)) || null;
  }

  /**
   * Infer the hidden state of an agent from its observations (all on record by default).
   * Writes the posterior to the graph unless `dryRun`.
   * @param {string} agentId @param {{observations?: string[], dryRun?: boolean}} [opts]
   */
  infer(agentId, opts = {}) {
    const m = this.get(agentId);
    if (!m) return null;
    const obs = m.observations.filter((o) => !opts.observations || opts.observations.includes(o.id));
    const { xs, ps: prior } = betaGrid(m.hidden.prior.alpha, m.hidden.prior.beta);
    let post = prior;
    const trail = [];
    for (const o of obs) {
      const lik = new Float64Array(GRID);
      for (let i = 0; i < GRID; i++) lik[i] = likelihood(o.likelihood, xs[i]);
      // P(o | H1) and P(o | H0) under the current posterior restricted to each hypothesis
      let h1 = 0; let h1w = 0; let h0 = 0; let h0w = 0;
      for (let i = 0; i < GRID; i++) {
        if (xs[i] > 0.5) { h1 += post[i] * lik[i]; h1w += post[i]; } else { h0 += post[i] * lik[i]; h0w += post[i]; }
      }
      const lbf = Math.log((h1 / (h1w || 1e-12)) / (h0 / (h0w || 1e-12)));
      const next = new Float64Array(GRID);
      for (let i = 0; i < GRID; i++) next[i] = post[i] * lik[i];
      post = normalize(next);
      const fit = fitBeta(xs, post);
      trail.push({ id: o.id, text: o.text, when: o.when, speech: !!o.speech, who: o.who, lbf, mean: fit.mean });
    }
    const priorFit = fitBeta(xs, prior);
    const postFit = fitBeta(xs, post);
    const result = {
      agentId,
      name: m.name,
      metricName: m.hidden.metricName,
      nodeId: m.hidden.nodeId,
      grid: Array.from(xs),
      prior: Array.from(prior),
      posterior: Array.from(post),
      priorMean: priorFit.mean,
      posteriorMean: postFit.mean,
      posteriorDist: { family: 'Beta', alpha: round(postFit.alpha), beta: round(postFit.beta) },
      trail,
      observations: obs.length,
      method: `inverse planning on a ${GRID}-point grid (stands in for sequential Monte Carlo over particles)`,
    };
    this.results.set(agentId, result);
    if (!opts.dryRun) {
      const res = this.history.apply([{ op: 'set', target: m.hidden.nodeId, dist: result.posteriorDist, prov: 'estimated', provDetail: { by: `mind.infer (${obs.length} observations)`, calib: 0.08 } }], { author: 'Mind sim', kind: 'model' });
      result.applied = !!res.ok;
      result.version = res.version;
    }
    this.events.emit('mind:inferred', { agentId, result });
    return result;
  }

  /** @param {string} name */
  inferByName(name) {
    const m = this.byName(name);
    if (!m) return null;
    return this.infer(m.id);
  }

  /**
   * Truthfulness of a claim: a probability with its reasons, never a verdict.
   * Combines the three reason probabilities in log-odds space (equal weights).
   * @param {string} agentId @param {string} claimId
   */
  truthfulness(agentId, claimId) {
    const m = this.get(agentId);
    const c = m?.claims.find((x) => x.id === claimId);
    if (!c) return null;
    const lo = (p) => Math.log(p / (1 - p));
    const z = c.reasons.reduce((s, r) => s + lo(r.p), 0) / c.reasons.length;
    const p = 1 / (1 + Math.exp(-z));
    return { claim: c, p, reasons: c.reasons, note: 'a probability with reasons, not a verdict' };
  }
}

/** @param {number} x */
function round(x) {
  return Math.round(x * 100) / 100;
}
