/**
 * The demo question "Should our bakery open a second location?" as Scope IR.
 *
 *   Bakery : Business
 *   ├─ LocationB : Location (sc_7Q2f)          foot traffic, capture, ticket, rent, payroll
 *   │  ├─ Lease : Lease                        observed from lease.pdf
 *   │  ├─ Staff : Collection                   6 x Person (shape Person/v3)
 *   │  └─ Equipment : Collection               fit-out items
 *   ├─ expansion : Loan                        principal 180,000 · rate 0.085 · term 7
 *   ├─ Market : Market                         Rival1, Rival2 : Business (competes_with) · Customers L0
 *   ├─ Projection : Projection                 24 x Month (shape Month/v1)
 *   └─ Minds : Collection                      Landlord (L3), Rival1 owner (L2), Loan officer (L2)
 *
 * Consistent with mock/scopelang-source.js. Imported only by model/loader.js.
 * @module mock/bakery
 */

/** Tunable assumptions (kept together so the demo numbers are easy to audit). */
export const P = {
  price: 4.0,
  rent: 6500,
  unitCost: 1.35,
  demand: { median: 310, p90: 420 },
  packaging: 0.12,
  cardFeeRate: 0.026,
  waste: [4, 46],
  laborPerLoaf: 0.98,
  utilities: 1450,
  insurance: 380,
  marketing: 600,
  payrollA: 600,
  otherFixed: 450,
  equity: 140000,
  cashBuffer: 25000,
  footTraffic: { median: 2600, p90: 2850 },
  capture: [90, 1100],
  ticket: { median: 9.4, p90: 9.95 },
  marginRate: 0.58,
  utilitiesB: { mean: 1250, sd: 120 },
  cannibal: [3, 37],
  baseRentB: 7200,
  maxDiscount: 0.08,
  staff: [
    { key: 'baker_1', name: 'Baker 1', wage: 24.5, hours: 32 },
    { key: 'baker_2', name: 'Baker 2', wage: 22.0, hours: 30 },
    { key: 'counter_1', name: 'Counter 1', wage: 18.0, hours: 24 },
    { key: 'counter_2', name: 'Counter 2', wage: 17.5, hours: 24 },
    { key: 'counter_3', name: 'Counter 3', wage: 17.5, hours: 20 },
    { key: 'barista_1', name: 'Barista 1', wage: 18.5, hours: 24 },
  ],
  loan: { principal: 180000, rate: 0.085, term: 7 },
  season: [0.88, 0.9, 0.97, 1.0, 1.02, 0.98, 0.95, 0.94, 1.0, 1.04, 1.1, 1.22],
};

const LN = (median, p90) => ({ family: 'LogNormal', median, p90 });
const BETA = (a, b) => ({ family: 'Beta', alpha: a, beta: b });
const NORMAL = (mean, sd) => ({ family: 'Normal', mean, sd });

class IRBuilder {
  constructor() {
    /** @type {any[]} */ this.scopes = [];
    /** @type {any[]} */ this.nodes = [];
    /** @type {Map<string, any>} */ this.byId = new Map();
  }

  scope(spec) {
    const s = { children: [], metrics: [], relations: [], constraints: [], ...spec };
    s.key = s.key || s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    this.scopes.push(s);
    this.byId.set(s.id, s);
    if (s.parent) this.byId.get(s.parent).children.push(s.id);
    return s.id;
  }

  metric(scope, name, kind, unit, extra = {}) {
    const id = `${scope}.${name}`;
    const n = { id, scope, name, kind, type: { dtype: 'f64', unit }, deps: [], ...extra };
    this.nodes.push(n);
    this.byId.get(scope).metrics.push(id);
    return id;
  }

  input(scope, name, value, unit, extra = {}) { return this.metric(scope, name, 'input', unit, { value, ...extra }); }
  observed(scope, name, value, unit, prov, extra = {}) { return this.metric(scope, name, 'observed', unit, { value, prov, ...extra }); }
  estimate(scope, name, dist, unit, prov, extra = {}) { return this.metric(scope, name, 'estimated', unit, { dist, prov, ...extra }); }
  computed(scope, name, expr, unit, extra = {}) { return this.metric(scope, name, 'computed', unit, { expr, ...extra }); }

  constraint(scope, id, label, expr, severity = 'hard') {
    this.byId.get(scope).constraints.push({ id, label, expr, severity });
  }

  relate(scope, type, target, label) {
    this.byId.get(scope).relations.push({ type, target, label });
  }
}

const MS8B = { by: 'ms-8b-v3', calib: 0.04 };
const SWARM = { by: 'swarm:estimators (3)', calib: 0.05 };

/**
 * Build the demo IR.
 * @returns {{graphId: string, seed: number, version: number, rootId: string, scopes: any[], nodes: any[]}}
 */
export function buildBakeryIR() {
  const b = new IRBuilder();

  // ---------------------------------------------------------------- Bakery (existing location)
  const bakery = b.scope({ id: 'sc_bakery', key: 'bakery', name: 'Bakery', proto: 'std.finance.Business@2', parent: null, kind: 'business', description: 'The existing bakery and the business as a whole.' });
  b.input(bakery, 'price', P.price, 'USD/loaf', { range: [3, 6], label: 'Bread price' });
  b.input(bakery, 'rent', P.rent, 'USD/month', { range: [4000, 10000], label: 'Rent (current location)' });
  b.observed(bakery, 'unit_cost', P.unitCost, 'USD/loaf', { src: 'supplier_invoice_oct.pdf', page: 2, evidence: 'ev_unit_cost' }, { range: [1.15, 1.6] });
  b.estimate(bakery, 'demand', LN(P.demand.median, P.demand.p90), 'loaf/day', MS8B, { corr: { factor: 'local_demand', rho: 0.35 }, label: 'Bread demand (current location)' });
  b.computed(bakery, 'gross_margin', ['mul', ['sub', '@price', '@unit_cost'], '@demand'], 'USD/day');
  b.observed(bakery, 'packaging', P.packaging, 'USD/loaf', { src: 'supplier_invoice_oct.pdf', page: 3, evidence: 'ev_packaging' }, { range: [0.1, 0.15] });
  b.observed(bakery, 'card_fee_rate', P.cardFeeRate, '1', { src: 'processor_statement_sep.pdf', page: 1, evidence: 'ev_card_fee' }, { range: [0.022, 0.03] });
  b.estimate(bakery, 'waste_rate', BETA(...P.waste), '1', MS8B, { label: 'Unsold share' });
  b.input(bakery, 'labor_per_loaf', P.laborPerLoaf, 'USD/loaf', { range: [0.5, 1.1], label: 'Variable labor per loaf' });
  b.computed(bakery, 'variable_cost', ['mul', ['add', '@packaging', ['mul', '@waste_rate', '@unit_cost'], ['mul', '@card_fee_rate', '@price'], '@labor_per_loaf'], '@demand'], 'USD/day');
  b.computed(bakery, 'contribution', ['sub', '@gross_margin', '@variable_cost'], 'USD/day');
  b.observed(bakery, 'utilities', P.utilities, 'USD/month', { src: 'utility_bills_q3.pdf', page: 1, evidence: 'ev_utilities' }, { range: [1300, 1650] });
  b.input(bakery, 'insurance', P.insurance, 'USD/month', { range: [300, 500] });
  b.input(bakery, 'marketing', P.marketing, 'USD/month', { range: [0, 2000] });
  b.input(bakery, 'payroll', P.payrollA, 'USD/month', { range: [0, 2000], label: 'Fixed payroll (current location)' });
  b.input(bakery, 'other_fixed', P.otherFixed, 'USD/month', { range: [300, 700] });
  b.computed(bakery, 'fixed_costs', ['add', '@utilities', '@insurance', '@marketing', '@payroll', '@other_fixed'], 'USD/month');
  b.computed(bakery, 'net_existing', ['sub', ['sub', ['convert', '@contribution', 'USD/month'], '@rent'], '@fixed_costs'], 'USD/month', { label: 'Net cash, current location' });
  b.computed(bakery, 'monthly_cash', ['sub', ['add', '@net_existing', '@locationB.net_cash'], '@expansion.payment'], 'USD/month', { output: true, headline: true, label: 'Monthly cash with Location B' });
  b.computed(bakery, 'p_cash_negative', ['prob_lt', '@monthly_cash', 0], 'prob', { output: true, label: 'P(monthly cash < 0)' });
  b.computed(bakery, 'annual_cash', ['convert', '@monthly_cash', 'USD/year'], 'USD/year');
  b.input(bakery, 'equity', P.equity, 'USD', { range: [140000, 220000] });
  b.computed(bakery, 'debt_ratio', ['div', '@expansion.principal', ['add', '@equity', '@expansion.principal']], '1', { proven: ['debt_ratio_lt_0_6'] });
  b.computed(bakery, 'dscr', ['div', ['add', '@net_existing', '@locationB.net_cash'], '@expansion.payment'], '1', { label: 'Debt service coverage' });
  b.input(bakery, 'cash_buffer', P.cashBuffer, 'USD', { range: [0, 80000] });
  b.constraint(bakery, 'price_gt_cost', 'price > unit_cost', ['gt', '@price', '@unit_cost']);
  b.constraint(bakery, 'debt_ratio', 'debt_ratio < 0.6', ['lt', '@debt_ratio', 0.6]);

  // ---------------------------------------------------------------- Location B
  const locB = b.scope({ id: 'sc_7Q2f', key: 'locationB', name: 'LocationB', proto: 'std.org.Location@1', parent: bakery, kind: 'location', description: 'The proposed second location on Harbor Street.' });
  b.estimate(locB, 'foot_traffic', LN(P.footTraffic.median, P.footTraffic.p90), 'person/day', { by: 'ms-8b-v3', calib: 0.06, evidence: 'ev_foot_traffic' }, { corr: { factor: 'local_demand', rho: 0.35 } });
  b.estimate(locB, 'capture_rate', BETA(...P.capture), '1', SWARM, { label: 'Share of passers-by who buy' });
  b.estimate(locB, 'avg_ticket', LN(P.ticket.median, P.ticket.p90), 'USD/person', MS8B);
  b.observed(locB, 'margin_rate', P.marginRate, '1', { src: 'pos_margin_report_2025.csv', page: 1, evidence: 'ev_margin_rate' }, { range: [0.55, 0.61] });
  b.computed(locB, 'price_effect', ['exp', ['mul', '@market.customers.elasticity', ['log', ['div', '@price', '@market.customers.price_ref']]]], '1', { label: 'Price elasticity effect' });
  b.computed(locB, 'rival_pressure', ['mul', '@market.pressure_total', 1], '1');
  b.computed(locB, 'customers', ['mul', '@foot_traffic', '@capture_rate', '@price_effect', ['sub', 1, '@rival_pressure']], 'person/day');
  // the ticket is quoted at the reference price, so it scales with price (volume falls via price_effect)
  b.computed(locB, 'revenue_b', ['mul', '@customers', '@avg_ticket', ['div', '@price', '@market.customers.price_ref']], 'USD/day');
  b.computed(locB, 'contribution_b', ['mul', '@revenue_b', '@margin_rate'], 'USD/day');
  b.computed(locB, 'rent', ['mul', '@lease.base_rent', ['sub', 1, '@lease.negotiated_discount']], 'USD/month');
  b.estimate(locB, 'utilities_b', NORMAL(P.utilitiesB.mean, P.utilitiesB.sd), 'USD/month', MS8B);
  b.computed(locB, 'payroll_b', ['mul', '@staff.payroll', 1], 'USD/month');
  b.estimate(locB, 'cannibalization', {
    family: 'Mixture',
    contested: true,
    components: [{ w: 0.55, dist: BETA(2, 40), by: 'Estimator 1' }, { w: 0.45, dist: BETA(6, 34), by: 'Estimator 3' }],
  }, '1', { ...SWARM, note: 'Estimators disagree after the Delphi reveal; kept as a flagged mixture.' }, { label: 'Share of current demand moving to B' });
  b.computed(locB, 'cannibalized', ['convert', ['mul', '@bakery.contribution', '@cannibalization'], 'USD/month'], 'USD/month');
  b.computed(locB, 'net_cash', ['sub', ['convert', '@contribution_b', 'USD/month'], ['add', '@rent', '@utilities_b', '@payroll_b', '@cannibalized']], 'USD/month', { headline: true, label: 'Net cash, Location B' });
  b.computed(locB, 'fit_out_cost', ['agg', 'sum', 'equipment', '*', 'cost'], 'USD');
  b.input(locB, 'ramp_months', 4, 'month', { range: [1, 9] });
  b.computed(locB, 'payback_months', ['div', '@fit_out_cost', ['max', '@net_cash', 500]], 'month');
  b.computed(locB, 'occupancy_ratio', ['div', '@rent', ['convert', '@revenue_b', 'USD/month']], '1');
  b.constraint(locB, 'occupancy', 'occupancy_ratio < 0.18', ['lt', '@occupancy_ratio', 0.18], 'soft');

  // Lease (observed from lease.pdf)
  const lease = b.scope({ id: 'sc_lease', key: 'lease', name: 'Lease', proto: 'std.legal.Lease@1', parent: locB, kind: 'lease' });
  b.observed(lease, 'base_rent', P.baseRentB, 'USD/month', { src: 'lease.pdf', page: 3, evidence: 'ev_base_rent' }, { headline: true, range: [6800, 7600] });
  b.observed(lease, 'term_years', 5, 'year', { src: 'lease.pdf', page: 2, evidence: 'ev_lease_term' });
  b.observed(lease, 'escalation', 0.03, '1/year', { src: 'lease.pdf', page: 3, evidence: 'ev_escalation' });
  b.observed(lease, 'deposit', 21600, 'USD', { src: 'lease.pdf', page: 4, evidence: 'ev_deposit' });
  b.observed(lease, 'free_months', 2, 'month', { src: 'lease.pdf', page: 3, evidence: 'ev_free_months' });
  b.input(lease, 'max_discount', P.maxDiscount, '1', { range: [0, 0.15], label: 'Negotiation room' });
  b.computed(lease, 'negotiated_discount', ['mul', '@minds.landlord.flexibility', '@max_discount'], '1');

  // Staff[6] : Person (shape Person/v3)
  const staff = b.scope({ id: 'sc_staff', key: 'staff', name: 'Staff', proto: 'std.org.Collection@1', parent: locB, kind: 'group' });
  b.input(staff, 'benefits_rate', 0.12, '1', { range: [0.09, 0.16] });
  b.computed(staff, 'staff_count', ['agg', 'count', '.', 'Person', 'wage'], 'scope');
  b.computed(staff, 'payroll', ['agg', 'sum', '.', 'Person', 'monthly_cost'], 'USD/month', { headline: true });
  b.computed(staff, 'avg_wage', ['agg', 'mean', '.', 'Person', 'wage'], 'USD/hour');
  b.constraint(staff, 'staff_count', 'staff_count >= 2', ['ge', '@staff_count', 2]);
  P.staff.forEach((p, i) => {
    const sid = b.scope({ id: `sc_staff_${i + 1}`, key: p.key, name: p.name, proto: 'std.org.Person@3', parent: staff, kind: 'person' });
    b.input(sid, 'wage', p.wage, 'USD/hour', { range: [Math.round(p.wage * 0.92 * 4) / 4, Math.round(p.wage * 1.12 * 4) / 4] });
    b.input(sid, 'hours', p.hours, 'hour/week', { range: [Math.round(p.hours * 0.8), Math.round(p.hours * 1.2)] });
    b.computed(sid, 'monthly_cost', ['convert', ['mul', '@wage', '@hours', ['add', 1, '@benefits_rate']], 'USD/month'], 'USD/month', { headline: true });
  });

  // Equipment (fit-out)
  const equip = b.scope({ id: 'sc_equipment', key: 'equipment', name: 'Equipment', proto: 'std.org.Collection@1', parent: locB, kind: 'group' });
  const items = [
    ['build_out', 'Build-out', LN(52000, 66000), 15],
    ['oven', 'Deck oven', LN(21000, 24500), 10],
    ['mixer', 'Spiral mixer', LN(6400, 7300), 10],
    ['proofer', 'Proofer', LN(4800, 5600), 8],
    ['display', 'Display case', LN(7200, 8600), 8],
    ['pos', 'POS & espresso', LN(9800, 11900), 5],
  ];
  for (const [key, name, dist, life] of items) {
    const sid = b.scope({ id: `sc_eq_${key}`, key, name, proto: 'std.ops.Equipment@1', parent: equip, kind: 'equipment' });
    b.estimate(sid, 'cost', dist, 'USD', { by: 'quotes + ms-8b-v3', calib: 0.03, evidence: key === 'oven' ? 'ev_oven_quote' : undefined });
    b.input(sid, 'lifetime', life, 'year');
    b.computed(sid, 'depreciation', ['convert', ['div', '@cost', '@lifetime'], 'USD/month'], 'USD/month');
  }

  // ---------------------------------------------------------------- Loan (expansion)
  const loan = b.scope({ id: 'sc_loan', key: 'expansion', name: 'expansion', proto: 'std.finance.Loan@1', parent: bakery, kind: 'loan', description: 'Expansion loan offered by the bank.' });
  b.input(loan, 'principal', P.loan.principal, 'USD', { range: [120000, 200000] });
  b.input(loan, 'rate', P.loan.rate, '1/year', { range: [0.06, 0.11] });
  b.input(loan, 'term', P.loan.term, 'year', { range: [3, 10] });
  b.computed(loan, 'payment', ['annuity', '@principal', '@rate', '@term'], 'USD/month', { headline: true });
  b.computed(loan, 'total_interest', ['sub', ['mul', ['convert', '@payment', 'USD/year'], '@term'], '@principal'], 'USD');

  // ---------------------------------------------------------------- Market
  const market = b.scope({ id: 'sc_market', key: 'market', name: 'Market', proto: 'std.market.Market@1', parent: bakery, kind: 'market' });
  b.computed(market, 'pressure_total', ['agg', 'sum', '.', 'Business', 'pressure'], '1', { headline: true, label: 'Competitive pressure near B' });
  b.computed(market, 'rival_count', ['agg', 'count', '.', 'Business', 'pressure'], 'scope');
  const rivals = [
    ['sc_rival1', 'rival1', 'Rival1', 4.25, BETA(3, 17), 0.6, 'rival1_menu.html'],
    ['sc_rival2', 'rival2', 'Rival2', 3.95, BETA(2, 18), 1.4, 'rival2_listing.html'],
  ];
  for (const [id, key, name, price, share, dist, src] of rivals) {
    const sid = b.scope({ id, key, name, proto: 'std.finance.Business@2', parent: market, kind: 'business' });
    b.observed(sid, 'price', price, 'USD/loaf', { src, page: 1, evidence: `ev_${key}_price` });
    b.estimate(sid, 'share', share, '1', SWARM);
    b.input(sid, 'distance_km', dist, 'km', { range: [0.1, 5] });
    b.input(sid, 'ref_distance', 1, 'km');
    b.computed(sid, 'proximity', ['div', '@ref_distance', ['add', '@ref_distance', '@distance_km']], '1');
    b.computed(sid, 'pressure', ['mul', '@share', '@proximity'], '1', { headline: true });
    b.relate(sid, 'competes_with', locB, 'competes with Location B');
  }
  const cust = b.scope({ id: 'sc_customers', key: 'customers', name: 'Customers', proto: 'std.market.Population@1', parent: market, kind: 'population', lod: 'L0', description: '48,000 nearby residents modeled as one demand curve (L0).' });
  b.input(cust, 'population', 48000, 'person');
  b.estimate(cust, 'elasticity', NORMAL(-1.2, 0.15), '1', MS8B, { label: 'Price elasticity of demand' });
  b.observed(cust, 'price_ref', 4.0, 'USD/loaf', { src: 'market_survey_2025.pdf', page: 7, evidence: 'ev_price_ref' }, { range: [3.9, 4.1] });
  b.estimate(cust, 'visit_rate', BETA(2, 60), 'visit/person/day', MS8B);
  b.computed(cust, 'potential_visits', ['mul', '@population', '@visit_rate'], 'visit/day', { headline: true });

  // ---------------------------------------------------------------- Projection (24 months)
  const proj = b.scope({ id: 'sc_projection', key: 'projection', name: 'Projection', proto: 'std.time.Projection@1', parent: bakery, kind: 'projection', description: 'First 24 months after opening, with ramp-up, rent abatement and seasonality.' });
  b.input(proj, 'dt', 1, 'month');
  b.computed(proj, 'start_cash', ['sub', '@bakery.cash_buffer', ['sub', '@locationB.fit_out_cost', '@expansion.principal']], 'USD');
  for (let m = 1; m <= 24; m++) {
    const sid = b.scope({ id: `sc_month_${m}`, key: `month_${m}`, name: `Month ${m}`, proto: 'std.time.Month@1', parent: proj, kind: 'month' });
    b.input(sid, 'm', m, 'month');
    b.observed(sid, 'season', P.season[(m - 1) % 12], '1', { src: 'pos_history_2023_2025.csv', page: 1, evidence: 'ev_seasonality' });
    b.computed(sid, 'ramp', ['min', 1, ['div', '@m', '@locationB.ramp_months']], '1');
    b.computed(sid, 'inflow', ['mul', ['convert', ['add', '@bakery.contribution', ['mul', '@locationB.contribution_b', '@ramp']], 'USD/month'], '@season'], 'USD/month');
    b.computed(sid, 'outflow', ['add', '@bakery.rent', '@bakery.fixed_costs', ['if', ['le', '@m', '@locationB.lease.free_months'], 0, '@locationB.rent'], '@locationB.utilities_b', '@locationB.payroll_b', ['mul', '@locationB.cannibalized', '@ramp'], '@expansion.payment'], 'USD/month');
    b.computed(sid, 'cash', ['sub', '@inflow', '@outflow'], 'USD/month', { headline: true });
    b.computed(sid, 'cumulative', ['add', m === 1 ? '@projection.start_cash' : `@month_${m - 1}.cumulative`, ['mul', '@cash', '@projection.dt']], 'USD');
  }
  b.computed(proj, 'min_cumulative', ['min', ...Array.from({ length: 24 }, (_, i) => `@month_${i + 1}.cumulative`)], 'USD', { headline: true });
  b.computed(proj, 'p_buffer_breach', ['prob_lt', '@min_cumulative', 0], 'prob', { output: true, label: 'P(cash buffer breached in 24 months)' });
  b.computed(proj, 'year1_cash', ['sub', '@month_12.cumulative', '@start_cash'], 'USD');

  // ---------------------------------------------------------------- Minds
  const minds = b.scope({ id: 'sc_minds', key: 'minds', name: 'Minds', proto: 'std.org.Collection@1', parent: bakery, kind: 'group', description: 'Modeled parties. Simulation, not assessment.' });
  const landlord = b.scope({ id: 'sc_landlord', key: 'landlord', name: 'Landlord', proto: 'std.social.Mind@1', parent: minds, kind: 'mind', lod: 'L3', realPerson: true, description: 'Owner of the Harbor Street unit.' });
  b.estimate(landlord, 'flexibility', BETA(2, 2), '1', { by: 'mind.infer (prior)', calib: 0.08 }, { label: 'Willingness to discount rent (hidden)' });
  b.input(landlord, 'goal_income', 0.6, '1');
  b.input(landlord, 'goal_tenant_quality', 0.25, '1');
  b.input(landlord, 'goal_property_value', 0.15, '1');
  b.estimate(landlord, 'risk_tolerance', BETA(3, 5), '1', MS8B);
  b.estimate(landlord, 'honesty_prior', BETA(5, 2), '1', MS8B);
  b.observed(landlord, 'vacancy_months', 7, 'month', { src: 'listing_history.html', page: 1, evidence: 'ev_vacancy' });
  b.estimate(landlord, 'belief_credit_risk', BETA(2, 8), '1', MS8B, { label: 'Belief: bakery default risk' });
  b.estimate(landlord, 'model_walkaway', BETA(3, 7), '1', MS8B, { label: 'Model of Bakery: walks away (depth 1)' });
  b.estimate(landlord, 'model_model_flex', BETA(4, 4), '1', MS8B, { label: 'Model of Bakery\'s model of Landlord flexibility (depth 2)' });
  b.estimate(landlord, 'trust_bakery', BETA(6, 3), '1', MS8B);
  b.input(landlord, 'affect_valence', 0.2, '1');
  b.input(landlord, 'affect_arousal', 0.4, '1');

  const owner = b.scope({ id: 'sc_rival1_owner', key: 'rival1_owner', name: 'Rival1 owner', proto: 'std.social.Mind@1', parent: minds, kind: 'mind', lod: 'L2', realPerson: true });
  b.estimate(owner, 'price_cut_prob', BETA(2, 6), '1', MS8B, { label: 'Cuts prices if B opens' });
  b.input(owner, 'goal_share', 0.55, '1');
  b.input(owner, 'goal_margin', 0.45, '1');
  b.estimate(owner, 'aggressiveness', BETA(3, 4), '1', MS8B);
  b.estimate(owner, 'belief_bakery_quality', BETA(5, 3), '1', MS8B);
  b.estimate(owner, 'trust_bakery', BETA(2, 5), '1', MS8B);
  b.input(owner, 'affect_valence', -0.1, '1');
  b.input(owner, 'affect_arousal', 0.55, '1');

  const officer = b.scope({ id: 'sc_officer', key: 'loan_officer', name: 'Loan officer', proto: 'std.social.Mind@1', parent: minds, kind: 'mind', lod: 'L2', realPerson: true });
  b.estimate(officer, 'approval_prob', BETA(7, 3), '1', MS8B);
  b.input(officer, 'goal_risk', 0.7, '1');
  b.input(officer, 'goal_volume', 0.3, '1');
  b.observed(officer, 'dscr_threshold', 1.25, '1', { src: 'bank_policy_2025.pdf', page: 12, evidence: 'ev_dscr_policy' });
  b.estimate(officer, 'trust_bakery', BETA(5, 3), '1', MS8B);
  b.input(officer, 'affect_valence', 0.1, '1');
  b.input(officer, 'affect_arousal', 0.25, '1');

  b.relate(locB, 'leases_from', landlord, 'leases from Landlord');
  b.relate(officer, 'lends_to', bakery, 'lends to Bakery');
  b.relate(landlord, 'models', bakery, 'models Bakery (depth 2)');
  b.relate(owner, 'models', bakery, 'models Bakery');
  b.relate(landlord, 'trusts', officer, 'trusts the bank');

  return { graphId: 'g_bakery_second_location', seed: 1234, version: 41, rootId: bakery, scopes: b.scopes, nodes: b.nodes };
}

/** Key outputs, in display order. */
export const KEY_OUTPUTS = ['sc_bakery.monthly_cash', 'sc_bakery.p_cash_negative', 'sc_7Q2f.net_cash', 'sc_projection.p_buffer_breach', 'sc_loan.payment', 'sc_bakery.dscr'];
export const DEFAULT_OUTPUT = 'sc_bakery.monthly_cash';
