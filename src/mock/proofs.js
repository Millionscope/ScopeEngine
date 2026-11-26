/**
 * Claims checked by the (mock) formal verifiers. Lean theorems are about real-number formulas;
 * floating-point error is bounded separately. SMT claims are re-checked live over the declared
 * input ranges, so moving an input outside its range turns a claim into "not proven".
 * Never "true": only proven or not proven.
 * Imported only by services/verify.js.
 * @module mock/proofs
 */

export const LEAN_MARGIN_POS = `import Mathlib

-- Exported from scope Bakery: gross margin is positive
-- whenever price exceeds unit cost and demand is positive.
theorem margin_pos (price unit_cost demand : ℝ)
    (h₁ : unit_cost < price) (h₂ : 0 < demand) :
    0 < (price - unit_cost) * demand := by
  have h₃ : 0 < price - unit_cost := sub_pos.mpr h₁
  exact mul_pos h₃ h₂`;

export const LEAN_CASH_BOUNDS = `import Mathlib

-- Exported from scope Bakery: monthly cash is bounded below by the
-- fixed outflows whenever both contributions are non-negative.
theorem cash_bounds
    (contrib_a contrib_b rent fixed rent_b util_b payroll_b cannib pay : ℝ)
    (ha : 0 ≤ contrib_a) (hb : 0 ≤ contrib_b) :
    -(rent + fixed + rent_b + util_b + payroll_b + cannib + pay)
      ≤ (contrib_a - rent - fixed)
        + (contrib_b - (rent_b + util_b + payroll_b + cannib)) - pay := by
  linarith`;

export const SMT_DEBT_RATIO = `; Exported from scope Bakery: debt_ratio < 0.6 over declared ranges
(declare-const principal Real)
(declare-const equity Real)
(assert (and (>= principal 120000.0) (<= principal 200000.0)))
(assert (and (>= equity 140000.0) (<= equity 220000.0)))
(define-fun debt_ratio () Real (/ principal (+ equity principal)))
; negate the claim; unsat means the claim holds for every input in range
(assert (not (< debt_ratio 0.6)))
(check-sat)   ; expected: unsat`;

export const SMT_PAYBACK = `; Exported from scope LocationB: payback_months < 60 over declared ranges
(declare-const net_cash Real)
(declare-const fit_out_cost Real)
(assert (and (>= fit_out_cost 80000.0) (<= fit_out_cost 140000.0)))
(assert (>= net_cash -6000.0))   ; from interval bounds on the contribution cone
(define-fun payback () Real (/ fit_out_cost (ite (> net_cash 500.0) net_cash 500.0)))
(assert (not (< payback 60.0)))
(check-sat)   ; sat: counterexample net_cash = 500, fit_out_cost = 80000 -> payback 160`;

/** @type {import('../model/certificate.js').Claim[]} */
export const CLAIMS = [
  {
    id: 'margin_pos',
    tool: 'lean',
    title: 'Gross margin is positive',
    statement: '0 < (price - unit_cost) * demand',
    latex: '0 < (\\text{price} - \\text{unit\\_cost}) \\cdot \\text{demand}',
    covers: ['sc_bakery.gross_margin', 'sc_bakery.price', 'sc_bakery.unit_cost', 'sc_bakery.demand'],
    hypotheses: [
      { label: 'h₁: unit_cost < price', a: 'sc_bakery.unit_cost', op: '<', b: 'sc_bakery.price' },
      { label: 'h₂: 0 < demand', a: 'sc_bakery.demand', op: '>', b: 0 },
    ],
    source: LEAN_MARGIN_POS,
    baseStatus: 'proven',
    floatNote: 'Proved over the reals. Floating-point error of the engine kernel for this formula is bounded by 2 ulp per operation (interval check with outward rounding).',
  },
  {
    id: 'cash_bounds',
    tool: 'lean',
    title: 'Monthly cash is bounded below by fixed outflows',
    statement: 'monthly_cash ≥ −(rent + fixed_costs + rent_B + utilities_B + payroll_B + cannibalized + payment)',
    latex: '\\text{monthly\\_cash} \\ge -\\left(\\text{rent} + \\text{fixed} + \\text{rent}_B + \\text{util}_B + \\text{payroll}_B + \\text{cannib} + \\text{payment}\\right)',
    covers: ['sc_bakery.monthly_cash', 'sc_bakery.net_existing', 'sc_7Q2f.net_cash', 'sc_loan.payment'],
    hypotheses: [
      { label: 'hₐ: 0 ≤ contribution', a: 'sc_bakery.contribution', op: '>=', b: 0 },
      { label: 'h_b: 0 ≤ contribution_b', a: 'sc_7Q2f.contribution_b', op: '>=', b: 0 },
    ],
    source: LEAN_CASH_BOUNDS,
    baseStatus: 'proven',
    floatNote: 'Linear arithmetic over the reals; the engine evaluates the same sums in IEEE-754 double precision.',
  },
  {
    id: 'debt_ratio_lt_0_6',
    tool: 'smt',
    title: 'Debt ratio stays below 0.6',
    statement: 'debt_ratio < 0.6 for principal ∈ [120k, 200k], equity ∈ [140k, 220k]',
    latex: '\\frac{\\text{principal}}{\\text{equity} + \\text{principal}} < 0.6',
    covers: ['sc_bakery.debt_ratio', 'sc_loan.principal', 'sc_bakery.equity'],
    target: 'sc_bakery.debt_ratio',
    op: '<',
    bound: 0.6,
    vars: ['sc_loan.principal', 'sc_bakery.equity'],
    source: SMT_DEBT_RATIO,
    floatNote: 'Z3 decides the claim over the reals; the bound is re-checked with interval arithmetic at the current inputs.',
  },
  {
    id: 'payback_lt_lease',
    tool: 'smt',
    title: 'Fit-out pays back within the lease term',
    statement: 'payback_months < 60 for all inputs in declared ranges',
    latex: '\\frac{\\text{fit\\_out\\_cost}}{\\max(\\text{net\\_cash}, 500)} < 60',
    covers: ['sc_7Q2f.payback_months', 'sc_7Q2f.net_cash'],
    target: 'sc_7Q2f.payback_months',
    op: '<',
    bound: 60,
    vars: ['sc_bakery.rent', 'sc_lease.base_rent', 'sc_bakery.price', 'sc_lease.max_discount'],
    source: SMT_PAYBACK,
    floatNote: 'A counterexample exists in the declared ranges, so the certificate lists this claim as not proven.',
  },
];

export const NOT_CHECKED = [
  'whether the competitor list is complete',
  'whether Harbor Street foot traffic holds after the road works (no source)',
  'whether the landlord will actually renegotiate (simulation, not assessment)',
];

export const SKEPTIC_NOTES = [
  'Checked for double counting between Market.pressure_total and LocationB.rival_pressure: none.',
  'Cannibalization modeled as a share of current contribution; sign checked.',
  'Flag: delivery-only competitors are not modeled.',
];

export const ESTIMATORS = [
  { name: 'ms-8b-v3', calibrationError: 0.04, backtests: 1240 },
  { name: 'swarm estimators (3, Delphi)', calibrationError: 0.05, backtests: 410 },
];
