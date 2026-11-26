/**
 * Seeded multi-agent simulation (mock of POST /sims on a deterministic game master).
 * World: monthly steps after opening Location B. Agents: Bakery owner (L3), Landlord (L3),
 * Rival1 owner (L2), Loan officer (L2), Customers (L0 population, rendered as L1 points).
 * Each run is a pure function of (seed, run index, inputs), so any run can be replayed and any
 * step inspected. Imported only by services/sim.js.
 * @module mock/sim-runs
 */

/** mulberry32 PRNG. @param {number} seed */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. @param {() => number} r */
function normal(r) {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const AGENTS = [
  { id: 'bakery', name: 'Bakery owner', lod: 'L3', kind: 'protagonist' },
  { id: 'landlord', name: 'Landlord', lod: 'L3', kind: 'counterparty', scope: 'sc_landlord' },
  { id: 'rival1', name: 'Rival1 owner', lod: 'L2', kind: 'counterparty', scope: 'sc_rival1_owner' },
  { id: 'officer', name: 'Loan officer', lod: 'L2', kind: 'counterparty', scope: 'sc_officer' },
  { id: 'customers', name: 'Customers', lod: 'L0', kind: 'population', scope: 'sc_customers' },
];

const LINES = {
  landlordAsk: ['If you sign for seven years, I can take six percent off the base rent.', 'Six percent off is possible with a longer term. That is my best offer.', 'Let us talk about the rent once you have traded for a quarter.'],
  bakeryAsk: ['The unit has been empty since April. Could we discuss the base rent?', 'We can commit to a longer term if the rent reflects the vacancy.', 'Would you consider a discount in exchange for a seven-year lease?'],
  landlordRefuse: ['There is other interest in the unit; the rent stays as written.', 'I would rather keep the rent and offer the abatement already agreed.'],
  rivalCut: ['Two loaves for the price of one, this week only.', 'Our sourdough is now four dollars, every day.', 'Loyalty card: every sixth loaf free.'],
  officerReview: ['Before the next review I need the last quarter of POS data.', 'Coverage is below our threshold this quarter; we will check again next quarter.', 'Coverage looks fine; no action needed.'],
};

/**
 * Simulate one run.
 * @param {{
 *   seed: number, run: number, steps: number,
 *   monthlyCash: number, sdCash: number, startCash: number,
 *   flexibility: number, priceCutProb: number, season: number[],
 *   rent: number, contributionB: number, payment: number, dscrThreshold: number,
 * }} p
 */
export function simulateRun(p) {
  const r = prng((p.seed * 1000003) ^ (p.run * 7919 + 17));
  const cash = new Float64Array(p.steps + 1);
  cash[0] = p.startCash;
  /** @type {Array<{step: number, actor: string, action: string, speech?: string, outcome?: string}>} */
  const log = [];
  let renegotiatedAt = -1;
  let rivalCutAt = -1;
  let reviewAt = -1;
  let breachAt = -1;
  let discount = 0;
  let traffic = 1;
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  for (let t = 1; t <= p.steps; t++) {
    const ramp = Math.min(1, t / 4);
    // Bakery asks for a discount in month 2 and month 5 if not settled
    if ((t === 2 || t === 5) && renegotiatedAt < 0) {
      log.push({ step: t, actor: 'Bakery owner', action: 'asks for a rent discount', speech: pick(LINES.bakeryAsk) });
      const pAccept = 0.18 + 0.75 * p.flexibility * (t === 2 ? 0.8 : 1);
      if (r() < pAccept) {
        renegotiatedAt = t;
        discount = 0.06;
        log.push({ step: t, actor: 'Landlord', action: 'agrees to six percent off for a longer term', speech: pick(LINES.landlordAsk), outcome: 'renegotiated' });
      } else log.push({ step: t, actor: 'Landlord', action: 'declines', speech: pick(LINES.landlordRefuse) });
    }
    // Rival responds to the opening
    if (rivalCutAt < 0 && t >= 2 && r() < p.priceCutProb / 5) {
      rivalCutAt = t;
      traffic *= 0.93;
      log.push({ step: t, actor: 'Rival1 owner', action: 'cuts prices', speech: pick(LINES.rivalCut), outcome: 'price cut' });
    }
    const shock = normal(r) * p.sdCash;
    const seasonal = p.season[(t - 1) % 12] || 1;
    const rentSaving = discount * p.rent;
    const lostB = rivalCutAt > 0 ? (1 - traffic) * p.contributionB : 0;
    const flow = (p.monthlyCash - (1 - ramp) * p.contributionB * 0.85) * seasonal + rentSaving - lostB + shock;
    cash[t] = cash[t - 1] + flow;
    if (breachAt < 0 && cash[t] < 0) {
      breachAt = t;
      log.push({ step: t, actor: 'World', action: 'cash buffer breached', outcome: 'breach' });
    }
    // Quarterly covenant check by the loan officer
    if (t % 6 === 0) {
      const coverage = (flow + p.payment) / p.payment;
      if (coverage < p.dscrThreshold) {
        if (reviewAt < 0) reviewAt = t;
        log.push({ step: t, actor: 'Loan officer', action: `covenant review (coverage ${coverage.toFixed(2)})`, speech: LINES.officerReview[r() < 0.5 ? 0 : 1], outcome: 'review' });
      } else log.push({ step: t, actor: 'Loan officer', action: `covenant check passed (coverage ${coverage.toFixed(2)})`, speech: LINES.officerReview[2] });
    }
  }
  return { run: p.run, cash, log, renegotiatedAt, rivalCutAt, reviewAt, breachAt };
}

/**
 * Agent field for one run: L0/L1 customers as points with a state per step
 * (0 prospect, 1 customer at the current bakery, 2 customer at Location B, 3 lost to a rival).
 * @param {{seed: number, run: number, steps: number, count: number, rivalCutAt: number}} p
 */
export function agentField(p) {
  const r = prng((p.seed * 31337) ^ (p.run * 104729));
  const n = p.count;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // two neighborhoods: around the current bakery (left) and Harbor Street (right)
    const side = r() < 0.55 ? -1 : 1;
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 9;
    pos[i * 3] = side * 7 + Math.cos(a) * d;
    pos[i * 3 + 1] = (r() - 0.5) * 1.5;
    pos[i * 3 + 2] = Math.sin(a) * d;
  }
  const states = [];
  let cur = new Uint8Array(n);
  for (let i = 0; i < n; i++) cur[i] = pos[i * 3] < 0 && r() < 0.45 ? 1 : 0;
  states.push(cur);
  for (let t = 1; t <= p.steps; t++) {
    const next = Uint8Array.from(cur);
    const ramp = Math.min(1, t / 4);
    for (let i = 0; i < n; i++) {
      const nearB = pos[i * 3] > 0;
      const u = r();
      if (cur[i] === 0 && nearB && u < 0.05 * ramp) next[i] = 2;
      else if (cur[i] === 0 && !nearB && u < 0.01) next[i] = 1;
      else if ((cur[i] === 1 || cur[i] === 2) && p.rivalCutAt > 0 && t >= p.rivalCutAt && u < 0.012) next[i] = 3;
      else if (cur[i] === 3 && u < 0.01) next[i] = nearB ? 2 : 1;
    }
    states.push(next);
    cur = next;
  }
  return { count: n, positions: pos, states };
}
