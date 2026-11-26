/**
 * Simulation adapter (mock of POST /sims): runs N seeded simulations progressively and reports
 * distributions across runs (ensemble fan chart, outcome probabilities, per-run action logs,
 * agent field). Inputs are read from the live graph, so a different rent or a new Landlord
 * posterior changes the ensemble. No DOM.
 * @module services/sim
 */
import { uid } from '../core/ids.js';
import { AGENTS, agentField, simulateRun } from '../mock/sim-runs.js';

/**
 * @typedef {Object} SimResult
 * @property {string} runId
 * @property {number} runs
 * @property {number} steps
 * @property {number} seed
 * @property {Float64Array[]} cash          per run, length steps + 1
 * @property {{p10: number[], p50: number[], p90: number[]}} fan
 * @property {Array<{id: string, label: string, p: number, count: number}>} outcomes
 * @property {any[]} runsMeta
 * @property {number} tokens               mock token estimate (mostly cached prefixes)
 * @property {boolean} done
 */

export class SimService {
  /**
   * @param {{events: import('../core/events.js').EventBus, getEngine: () => import('../model/engine.js').JsEngine, store: import('../core/store.js').Store}} deps
   */
  constructor({ events, getEngine, store }) {
    this.events = events;
    this.getEngine = getEngine;
    this.store = store;
    this.agents = AGENTS;
    this.config = { world: 'Lease negotiation and rival response after opening Location B', steps: 24, runs: 100, seed: 7, fieldCount: 2400 };
    /** @type {SimResult|null} */
    this.result = null;
    this.running = false;
    this._abort = null;
  }

  /** Inputs drawn from the live graph. */
  inputs() {
    const e = this.getEngine();
    const v = (id, fallback) => {
      const st = e.stats(id);
      const x = st ? (st.deterministic ? e.value(id) : st.p50) : NaN;
      return Number.isFinite(x) ? x : fallback;
    };
    const flex = e.stats('sc_landlord.flexibility');
    const cut = e.stats('sc_rival1_owner.price_cut_prob');
    const cash = e.stats('sc_bakery.monthly_cash');
    return {
      monthlyCash: v('sc_bakery.monthly_cash', 3000),
      sdCash: cash && !cash.deterministic ? cash.sd * 0.6 : 2500,
      startCash: v('sc_projection.start_cash', 100000),
      flexibility: flex ? flex.mean : 0.5,
      priceCutProb: cut ? cut.mean : 0.25,
      season: Array.from({ length: 12 }, (_, i) => v(`sc_month_${i + 1}.season`, 1)),
      rent: v('sc_7Q2f.rent', 7000),
      contributionB: v('sc_7Q2f.contribution_b', 900) * 30.4375,
      payment: v('sc_loan.payment', 2850),
      dscrThreshold: v('sc_officer.dscr_threshold', 1.25),
    };
  }

  /**
   * Run an ensemble progressively (chunks of runs), emitting sim:progress.
   * @param {{runs?: number, steps?: number, seed?: number}} [cfg]
   */
  async run(cfg = {}) {
    this.stop();
    const c = { ...this.config, ...cfg };
    this.config = c;
    const runId = uid('sim');
    const abort = { aborted: false };
    this._abort = abort;
    this.running = true;
    const inputs = this.inputs();
    /** @type {SimResult} */
    const res = {
      runId, runs: c.runs, steps: c.steps, seed: c.seed, cash: [], fan: { p10: [], p50: [], p90: [] },
      outcomes: [], runsMeta: [], tokens: Math.round(c.runs * c.steps * 2 * 1250), done: false, inputs,
    };
    this.result = res;
    this.store.set('status.message', `Simulation: 0/${c.runs} runs`);
    this.events.emit('sim:progress', { runId, phase: 'start', done: 0, total: c.runs, result: res });
    for (let i = 0; i < c.runs; i++) {
      if (abort.aborted) break;
      const out = simulateRun({ seed: c.seed, run: i, steps: c.steps, ...inputs });
      res.cash.push(out.cash);
      res.runsMeta.push({ run: i, renegotiatedAt: out.renegotiatedAt, rivalCutAt: out.rivalCutAt, reviewAt: out.reviewAt, breachAt: out.breachAt, logSize: out.log.length });
      if ((i + 1) % 10 === 0 || i === c.runs - 1) {
        this._summarize(res);
        this.store.set('status.message', `Simulation: ${i + 1}/${c.runs} runs`);
        this.events.emit('sim:progress', { runId, phase: 'progress', done: i + 1, total: c.runs, result: res });
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    res.done = !abort.aborted;
    this.running = false;
    this.store.set('status.message', '');
    this.store.set('status.tokens', { count: res.tokens, local: false, touched: true, kind: 'simulation (mostly cached prefixes)' });
    this.events.emit('sim:progress', { runId, phase: 'done', done: res.cash.length, total: c.runs, result: res });
    return res;
  }

  stop() {
    if (this._abort) this._abort.aborted = true;
    this._abort = null;
  }

  /** @param {SimResult} res */
  _summarize(res) {
    const n = res.cash.length;
    const steps = res.steps;
    const p10 = [];
    const p50 = [];
    const p90 = [];
    const col = new Float64Array(n);
    for (let t = 0; t <= steps; t++) {
      for (let i = 0; i < n; i++) col[i] = res.cash[i][t];
      const s = Float64Array.from(col).sort();
      const q = (p) => s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
      p10.push(q(0.1));
      p50.push(q(0.5));
      p90.push(q(0.9));
    }
    res.fan = { p10, p50, p90 };
    const count = (f) => res.runsMeta.filter(f).length;
    res.outcomes = [
      { id: 'reneg6', label: 'lease renegotiated before month 6', count: count((m) => m.renegotiatedAt > 0 && m.renegotiatedAt < 6) },
      { id: 'cut12', label: 'Rival1 cuts prices within 12 months', count: count((m) => m.rivalCutAt > 0 && m.rivalCutAt <= 12) },
      { id: 'review', label: 'loan covenant review in two years', count: count((m) => m.reviewAt > 0) },
      { id: 'breach', label: 'cash buffer breached at some point', count: count((m) => m.breachAt > 0) },
    ].map((o) => ({ ...o, p: o.count / Math.max(1, n) }));
  }

  /** Replay one run's action log. @param {number} run */
  runLog(run) {
    if (!this.result) return [];
    const c = this.config;
    return simulateRun({ seed: c.seed, run, steps: c.steps, ...this.result.inputs }).log;
  }

  /** Agent field for a run (L0/L1 customers). @param {number} run */
  agentField(run) {
    if (!this.result) return null;
    const meta = this.result.runsMeta[run];
    return agentField({ seed: this.config.seed, run, steps: this.config.steps, count: this.config.fieldCount, rivalCutAt: meta ? meta.rivalCutAt : -1 });
  }
}
