/**
 * Timed swarm events for mock builds. Roles: Lead, Modeler, Researcher, Estimators (3),
 * Skeptic, Mind simulators, Explainer, plus the deterministic Verifier. Steps that carry a
 * `delta` are submitted through the real validator; one step per build is a plausible mistake
 * (a unit mismatch or dangling reference) that the verifier rejects with its actual message.
 * Imported only by services (chat / swarm adapters).
 * @module mock/swarm-script
 */

export const ROLES = ['Lead', 'Modeler', 'Researcher', 'Estimator 1', 'Estimator 2', 'Estimator 3', 'Skeptic', 'Mind sim', 'Explainer', 'Verifier'];

const LN = (median, p90) => ({ family: 'LogNormal', median, p90 });
const BETA = (a, b) => ({ family: 'Beta', alpha: a, beta: b });

/**
 * The build that produced the preloaded answer (replayed as history, nothing applied).
 * @returns {import('./conversation.js').BuildScript}
 */
export function initialBuild() {
  return {
    title: 'Build: Should our bakery open a second location?',
    tokens: 41280,
    historical: true,
    steps: [
      { role: 'Lead', kind: 'plan', text: 'Decompose: current bakery, Location B (lease, staff, fit-out), loan, market (2 rivals, customers L0), 24-month projection, counterparties (landlord, rival owner, loan officer).' },
      { role: 'Modeler', kind: 'propose', text: 'add_scope Bakery.LocationB : Location', op: 'add_scope', outcome: 'accepted', level: 2 },
      { role: 'Modeler', kind: 'propose', text: 'add_scope Bakery.expansion : Loan (payment = annuity inherited)', op: 'add_scope', outcome: 'accepted', level: 2 },
      { role: 'Modeler', kind: 'propose', text: 'add_scope LocationB.Staff[6] : Person (shape Person/v3)', op: 'add_scope', outcome: 'accepted', level: 2 },
      { role: 'Researcher', kind: 'research', text: 'lease.pdf p3: Base Rent $7,200.00 per month → Lease.base_rent (observed)', outcome: 'accepted', level: 4, nodeId: 'sc_lease.base_rent' },
      { role: 'Researcher', kind: 'research', text: 'supplier_invoice_oct.pdf p2: unit price $1.35 → Bakery.unit_cost (observed)', outcome: 'accepted', level: 4, nodeId: 'sc_bakery.unit_cost' },
      {
        role: 'Estimator 1', kind: 'estimate', text: 'Independent estimates for Bakery.demand (Delphi round 1)', nodeId: 'sc_bakery.demand',
        delphi: {
          metric: 'sc_bakery.demand', unit: 'loaf/day',
          round1: [{ role: 'Estimator 1', dist: LN(300, 410), weight: 0.36 }, { role: 'Estimator 2', dist: LN(330, 450), weight: 0.3 }, { role: 'Estimator 3', dist: LN(290, 395), weight: 0.34 }],
          round2: [{ role: 'Estimator 1', dist: LN(305, 415), weight: 0.36 }, { role: 'Estimator 2', dist: LN(320, 432), weight: 0.3 }, { role: 'Estimator 3', dist: LN(303, 412), weight: 0.34 }],
          final: LN(310, 420), contested: false,
        },
      },
      {
        role: 'Estimator 2', kind: 'estimate', text: 'Independent estimates for LocationB.cannibalization: spread stays wide after reveal', nodeId: 'sc_7Q2f.cannibalization',
        delphi: {
          metric: 'sc_7Q2f.cannibalization', unit: '1',
          round1: [{ role: 'Estimator 1', dist: BETA(2, 40), weight: 0.36 }, { role: 'Estimator 2', dist: BETA(4, 36), weight: 0.3 }, { role: 'Estimator 3', dist: BETA(7, 33), weight: 0.34 }],
          round2: [{ role: 'Estimator 1', dist: BETA(2, 40), weight: 0.36 }, { role: 'Estimator 2', dist: BETA(4, 36), weight: 0.3 }, { role: 'Estimator 3', dist: BETA(6, 34), weight: 0.34 }],
          final: null, contested: true,
        },
      },
      { role: 'Skeptic', kind: 'review', text: 'rewire LocationB.net_cash = contribution_b - rent', deltaKey: 'bad_unit', level: 2 },
      { role: 'Skeptic', kind: 'review', text: 'Checked for double counting between Market.pressure_total and LocationB.rival_pressure: none found.', outcome: 'accepted', level: 8 },
      { role: 'Mind sim', kind: 'estimate', text: 'Landlord flexibility prior Beta(2, 2); seven months of vacancy on record (evidence, not inference yet)', nodeId: 'sc_landlord.flexibility', outcome: 'accepted', level: 7 },
      { role: 'Explainer', kind: 'explain', text: 'Narrative written with bound numbers only (post-check: 0 free numerals).', outcome: 'accepted', level: 8 },
      { role: 'Verifier', kind: 'verify', text: 'Certificate a_7f3 issued: levels 0-4 pass, SMT 1/2 proven, Lean 2/2 checked, calibration statistical, structure judged.', outcome: 'accepted', level: 8 },
    ],
  };
}

/**
 * Build for "add a competitor named <name>".
 * @param {{name: string, parentId: string, distance: number, expect: () => string}} p
 */
export function competitorBuild(p) {
  const share = [
    { role: 'Estimator 1', dist: BETA(3, 19), weight: 0.36 },
    { role: 'Estimator 2', dist: BETA(4, 18), weight: 0.3 },
    { role: 'Estimator 3', dist: BETA(3, 15), weight: 0.34 },
  ];
  return {
    title: `Build: add competitor ${p.name}`,
    tokens: 3420,
    steps: [
      { role: 'Lead', kind: 'plan', text: `Add ${p.name} as a Business under Market; research distance; estimate share; re-run the cone.` },
      { role: 'Modeler', kind: 'propose', text: `add_scope Market.${p.name} : Business`, deltaKey: 'add', level: 2 },
      { role: 'Researcher', kind: 'research', text: `Listing found: ${p.name} is ${p.distance} km from Harbor Street → distance_km (observed, mock source)`, deltaKey: 'distance', level: 4 },
      { role: 'Estimator 1', kind: 'estimate', text: `Independent share estimates for ${p.name} (Delphi)`, delphi: { metric: null, unit: '1', round1: share, round2: share.map((s) => ({ ...s })), final: BETA(3, 17), contested: false }, deltaKey: 'share' },
      { role: 'Skeptic', kind: 'review', text: 'rewire LocationB.net_cash = contribution_b - rent', deltaKey: 'bad_unit', level: 2 },
      { role: 'Skeptic', kind: 'review', text: `No double counting: ${p.name}.pressure enters Market.pressure_total through the aggregate over children.`, outcome: 'accepted', level: 3 },
      { role: 'Explainer', kind: 'explain', text: 'Narrative with bound numbers (0 free numerals).', outcome: 'accepted', level: 8 },
      { role: 'Verifier', kind: 'verify', text: 'Certificate refreshed for the new graph version.', outcome: 'accepted', level: 8 },
    ],
  };
}

/**
 * Build for "remove the loan": the direct removal is rejected (dangling references), the
 * Modeler recovers with a scenario instead.
 */
export function removeLoanBuild() {
  return {
    title: 'Build: what if we skip the loan?',
    tokens: 2860,
    steps: [
      { role: 'Lead', kind: 'plan', text: 'Remove the expansion loan; fund the fit-out from cash instead.' },
      { role: 'Modeler', kind: 'propose', text: 'remove_scope Bakery.expansion', deltaKey: 'remove', level: 1 },
      { role: 'Modeler', kind: 'propose', text: 'Recover: fork scenario "No loan" with principal = 0 instead of deleting structure', deltaKey: 'fork', level: 1 },
      { role: 'Skeptic', kind: 'review', text: 'Without the loan, start_cash drops by the principal: check the 24-month buffer.', outcome: 'accepted', level: 8 },
      { role: 'Explainer', kind: 'explain', text: 'Narrative compares base and "No loan" with bound numbers.', outcome: 'accepted', level: 8 },
    ],
  };
}

/** Generic build for a new question (no structural change). @param {string} title @param {number} tokens */
export function questionBuild(title, tokens, extra = []) {
  return {
    title,
    tokens,
    steps: [
      { role: 'Lead', kind: 'plan', text: 'Read the scope view (focus scopes, 2-hop neighborhood, ranked by sensitivity).' },
      ...extra,
      { role: 'Explainer', kind: 'explain', text: 'Narrative with bound numbers (0 free numerals).', outcome: 'accepted', level: 8 },
      { role: 'Verifier', kind: 'verify', text: 'Certificate unchanged: no structural change.', outcome: 'accepted', level: 8 },
    ],
  };
}
