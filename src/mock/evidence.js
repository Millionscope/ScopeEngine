/**
 * Evidence store mock: source documents and extracted values with their spans. The evidence
 * verifier (certificate level 4) checks that each observed value appears in its cited span.
 * Two foot-traffic sources disagree and are kept as a contested group.
 * Imported only by services/evidence-service.js.
 * @module mock/evidence
 */

export const SOURCES = [
  { id: 'src_lease', name: 'lease.pdf', type: 'PDF', date: '2026-10-02', pages: 12, title: 'Commercial lease, 18 Harbor Street, Unit 2' },
  { id: 'src_invoice', name: 'supplier_invoice_oct.pdf', type: 'PDF', date: '2026-10-31', pages: 3, title: 'Flour, dairy and packaging invoice (October)' },
  { id: 'src_processor', name: 'processor_statement_sep.pdf', type: 'PDF', date: '2026-10-05', pages: 2, title: 'Card processor statement (September)' },
  { id: 'src_utilities', name: 'utility_bills_q3.pdf', type: 'PDF', date: '2026-10-10', pages: 3, title: 'Electricity, gas and water bills (Q3)' },
  { id: 'src_pos_margin', name: 'pos_margin_report_2025.csv', type: 'CSV', date: '2026-01-04', pages: 1, title: 'POS margin report, café items' },
  { id: 'src_pos_history', name: 'pos_history_2023_2025.csv', type: 'CSV', date: '2026-01-04', pages: 1, title: 'POS sales history (36 months)' },
  { id: 'src_rival1', name: 'rival1_menu.html', type: 'Web', date: '2026-11-12', pages: 1, title: 'Rival1 online menu (snapshot)' },
  { id: 'src_rival2', name: 'rival2_listing.html', type: 'Web', date: '2026-11-12', pages: 1, title: 'Rival2 delivery listing (snapshot)' },
  { id: 'src_survey', name: 'market_survey_2025.pdf', type: 'PDF', date: '2025-09-30', pages: 24, title: 'District retail survey 2025' },
  { id: 'src_listing', name: 'listing_history.html', type: 'Web', date: '2026-11-15', pages: 1, title: 'Unit 2 listing history' },
  { id: 'src_bank', name: 'bank_policy_2025.pdf', type: 'PDF', date: '2025-06-01', pages: 30, title: 'Small business lending policy' },
  { id: 'src_quotes', name: 'equipment_quotes.pdf', type: 'PDF', date: '2026-10-21', pages: 4, title: 'Equipment quotes (oven, mixer, proofer)' },
  { id: 'src_ped', name: 'harbor_st_pedestrian_count.csv', type: 'CSV', date: '2026-11-08', pages: 1, title: 'Two-week pedestrian count, Harbor Street' },
  { id: 'src_city', name: 'city_footfall_2025.json', type: 'API', date: '2025-12-31', pages: 1, title: 'City footfall sensor, 2025 annual average', stale: true },
];

/**
 * Extracted values. `match` is the exact substring the verifier found in `span`.
 * status: matched | mismatch | stale | supports (backs an estimate, not an observed value)
 */
export const EXTRACTIONS = [
  { id: 'ev_base_rent', source: 'src_lease', page: 3, span: 'Base Rent shall be Seven Thousand Two Hundred Dollars ($7,200.00) per month, payable in advance on the first day of each month.', match: '$7,200.00', value: 7200, unit: 'USD/month', binds: ['sc_lease.base_rent'] },
  { id: 'ev_lease_term', source: 'src_lease', page: 2, span: 'The Term of this Lease shall be five (5) years commencing on the Commencement Date.', match: 'five (5) years', value: 5, unit: 'year', binds: ['sc_lease.term_years'] },
  { id: 'ev_escalation', source: 'src_lease', page: 3, span: 'Base Rent shall increase by three percent (3%) on each anniversary of the Commencement Date.', match: 'three percent (3%)', value: 0.03, unit: '1/year', binds: ['sc_lease.escalation'] },
  { id: 'ev_deposit', source: 'src_lease', page: 4, span: 'Tenant shall deposit with Landlord the sum of $21,600.00 as a Security Deposit.', match: '$21,600.00', value: 21600, unit: 'USD', binds: ['sc_lease.deposit'] },
  { id: 'ev_free_months', source: 'src_lease', page: 3, span: 'Tenant shall receive two (2) months of Base Rent abatement beginning on the Commencement Date.', match: 'two (2) months', value: 2, unit: 'month', binds: ['sc_lease.free_months'] },
  { id: 'ev_unit_cost', source: 'src_invoice', page: 2, span: 'Sourdough loaf, 800 g · 1,240 units @ $1.35 = $1,674.00', match: '$1.35', value: 1.35, unit: 'USD/loaf', binds: ['sc_bakery.unit_cost'] },
  { id: 'ev_packaging', source: 'src_invoice', page: 3, span: 'Kraft bread bags, printed · 4,000 @ $0.12 = $480.00', match: '$0.12', value: 0.12, unit: 'USD/loaf', binds: ['sc_bakery.packaging'] },
  { id: 'ev_card_fee', source: 'src_processor', page: 1, span: 'Effective rate for the period: 2.60% of card volume.', match: '2.60%', value: 0.026, unit: '1', binds: ['sc_bakery.card_fee_rate'] },
  { id: 'ev_utilities', source: 'src_utilities', page: 1, span: 'Average monthly total (Jul–Sep): $1,450.12', match: '$1,450.12', value: 1450, tolerance: 1, unit: 'USD/month', binds: ['sc_bakery.utilities'] },
  { id: 'ev_margin_rate', source: 'src_pos_margin', page: 1, span: 'Blended gross margin, café items: 58.0%', match: '58.0%', value: 0.58, unit: '1', binds: ['sc_7Q2f.margin_rate'] },
  { id: 'ev_seasonality', source: 'src_pos_history', page: 1, span: 'Seasonal index Jan–Dec: 0.88 0.90 0.97 1.00 1.02 0.98 0.95 0.94 1.00 1.04 1.10 1.22', match: '0.88 0.90 0.97', value: null, unit: '1', binds: Array.from({ length: 24 }, (_, i) => `sc_month_${i + 1}.season`), series: [0.88, 0.9, 0.97, 1.0, 1.02, 0.98, 0.95, 0.94, 1.0, 1.04, 1.1, 1.22] },
  { id: 'ev_rival1_price', source: 'src_rival1', page: 1, span: 'Country sourdough (800 g) … $4.25', match: '$4.25', value: 4.25, unit: 'USD/loaf', binds: ['sc_rival1.price'] },
  { id: 'ev_rival2_price', source: 'src_rival2', page: 1, span: 'Sourdough loaf · $3.95 · delivery available', match: '$3.95', value: 3.95, unit: 'USD/loaf', binds: ['sc_rival2.price'] },
  { id: 'ev_price_ref', source: 'src_survey', page: 7, span: 'The median price for an artisan loaf in the district was $4.00 (n = 31 bakeries).', match: '$4.00', value: 4.0, unit: 'USD/loaf', binds: ['sc_customers.price_ref'] },
  { id: 'ev_vacancy', source: 'src_listing', page: 1, span: 'Listed since April 2026 · 7 months on market · price reduced once', match: '7 months', value: 7, unit: 'month', binds: ['sc_landlord.vacancy_months'] },
  { id: 'ev_dscr_policy', source: 'src_bank', page: 12, span: 'Term loans require a minimum debt service coverage ratio of 1.25x on projected cash flow.', match: '1.25x', value: 1.25, unit: '1', binds: ['sc_officer.dscr_threshold'] },
  { id: 'ev_oven_quote', source: 'src_quotes', page: 1, span: 'Three-deck electric deck oven, installed and commissioned: $21,000.00', match: '$21,000.00', value: 21000, unit: 'USD', binds: ['sc_eq_oven.cost'], status: 'supports' },
  { id: 'ev_foot_traffic', source: 'src_ped', page: 1, span: 'Average weekday pedestrians passing Unit 2, 7am–7pm, two weeks: 2,604', match: '2,604', value: 2604, unit: 'person/day', binds: ['sc_7Q2f.foot_traffic'], status: 'supports', group: 'foot_traffic' },
  { id: 'ev_foot_traffic_city', source: 'src_city', page: 1, span: '"harbor_st_east": { "annual_avg_daily_footfall": 2240 }', match: '2240', value: 2240, unit: 'person/day', binds: ['sc_7Q2f.foot_traffic'], status: 'stale', group: 'foot_traffic', note: 'Conflicts with the 2026 pedestrian count; older and measured before the new tram stop opened. Kept as a contested source.' },
];
