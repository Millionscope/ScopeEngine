/**
 * Prototype library (mock of the versioned std.* packages). A scope inherits default metrics,
 * formulas and constraints along its prototype chain; add_scope instantiates from here.
 * `shapeVersion` seeds shape ids (Person/v3). `__relations` lists allowed relation types as
 * [source prototype, target prototype].
 * @module mock/prototypes
 */

const beta = (alpha, b) => ({ family: 'Beta', alpha, beta: b });

export const PROTOTYPES = {
  'std.core.Entity@1': { name: 'Entity', parent: null, kind: 'entity', metrics: {} },

  'std.finance.Business@2': {
    name: 'Business',
    parent: 'std.core.Entity@1',
    kind: 'business',
    shapeVersion: 2,
    description: 'A business that competes for customers near a location.',
    metrics: {
      price: { kind: 'input', unit: 'USD/loaf', value: 4.1, range: [3, 6] },
      share: { kind: 'estimated', unit: '1', dist: beta(3, 17), prov: { by: 'swarm:estimators', calib: 0.05 } },
      distance_km: { kind: 'input', unit: 'km', value: 1, range: [0.1, 5] },
      ref_distance: { kind: 'input', unit: 'km', value: 1 },
      proximity: { kind: 'computed', unit: '1', expr: ['div', '@ref_distance', ['add', '@ref_distance', '@distance_km']] },
      pressure: { kind: 'computed', unit: '1', expr: ['mul', '@share', '@proximity'], headline: true },
    },
  },

  'std.org.Location@1': {
    name: 'Location',
    parent: 'std.finance.Business@2',
    kind: 'location',
    description: 'A trading location with its own lease, staff and demand.',
    metrics: {},
  },

  'std.finance.Loan@1': {
    name: 'Loan',
    parent: 'std.core.Entity@1',
    kind: 'loan',
    description: 'Amortizing loan; payment = annuity(principal, rate, term) is inherited.',
    metrics: {
      principal: { kind: 'input', unit: 'USD', value: 100000, range: [20000, 400000] },
      rate: { kind: 'input', unit: '1/year', value: 0.08, range: [0.04, 0.14] },
      term: { kind: 'input', unit: 'year', value: 5, range: [1, 15] },
      payment: { kind: 'computed', unit: 'USD/month', expr: ['annuity', '@principal', '@rate', '@term'], headline: true },
      total_interest: { kind: 'computed', unit: 'USD', expr: ['sub', ['mul', ['convert', '@payment', 'USD/year'], '@term'], '@principal'] },
    },
  },

  'std.legal.Lease@1': {
    name: 'Lease',
    parent: 'std.core.Entity@1',
    kind: 'lease',
    description: 'Commercial lease terms extracted from the signed document.',
    metrics: {},
  },

  'std.org.Collection@1': { name: 'Collection', parent: 'std.core.Entity@1', kind: 'group', metrics: {} },

  'std.org.Person@3': {
    name: 'Person',
    parent: 'std.core.Entity@1',
    kind: 'person',
    shapeVersion: 3,
    description: 'An employee; monthly cost includes benefits from the enclosing staff group.',
    metrics: {
      wage: { kind: 'input', unit: 'USD/hour', value: 18, range: [15, 32] },
      hours: { kind: 'input', unit: 'hour/week', value: 30, range: [8, 45] },
      monthly_cost: { kind: 'computed', unit: 'USD/month', expr: ['convert', ['mul', '@wage', '@hours', ['add', 1, '@benefits_rate']], 'USD/month'], headline: true },
    },
  },

  'std.market.Market@1': { name: 'Market', parent: 'std.core.Entity@1', kind: 'market', metrics: {} },

  'std.market.Population@1': {
    name: 'Population',
    parent: 'std.core.Entity@1',
    kind: 'population',
    lod: 'L0',
    description: 'A crowd modeled as one distribution scope (level of detail L0).',
    metrics: {},
  },

  'std.time.Projection@1': { name: 'Projection', parent: 'std.core.Entity@1', kind: 'projection', metrics: {} },
  'std.time.Month@1': { name: 'Month', parent: 'std.core.Entity@1', kind: 'month', shapeVersion: 1, metrics: {} },

  'std.ops.Equipment@1': {
    name: 'Equipment',
    parent: 'std.core.Entity@1',
    kind: 'equipment',
    metrics: {
      cost: { kind: 'estimated', unit: 'USD', dist: { family: 'LogNormal', median: 5000, p90: 6500 } },
      lifetime: { kind: 'input', unit: 'year', value: 8 },
      depreciation: { kind: 'computed', unit: 'USD/month', expr: ['convert', ['div', '@cost', '@lifetime'], 'USD/month'] },
    },
  },

  'std.social.Mind@1': {
    name: 'Mind',
    parent: 'std.core.Entity@1',
    kind: 'mind',
    lod: 'L2',
    description: 'A modeled party: goals, traits, knowledge, beliefs, nested models of others, relationships and affect. Simulation, not assessment.',
    metrics: {},
  },

  /** relation type -> [source prototype, target prototype] */
  __relations: {
    competes_with: ['Business', 'Business'],
    leases_from: ['Location', 'Mind'],
    lends_to: ['Mind', 'Business'],
    models: ['Mind', 'Entity'],
    trusts: ['Mind', 'Mind'],
    supplies: ['Business', 'Business'],
  },
};
