/**
 * Mind Scopes for the modeled parties. Values live in the graph (sc_landlord.*, …); this file
 * adds the structure the Minds editor shows: goals, traits, knowledge partition, beliefs,
 * nested models (depth 2), relationships, affect, observations with likelihood models for
 * inverse planning, and claims for the truthfulness panel.
 * All three are real, identifiable people: simulation, not assessment.
 * Imported only by services/mind.js.
 * @module mock/minds
 */

/**
 * Likelihood of an observation given the hidden state theta in [0, 1]:
 * logistic(slope * (theta - center)) for evidence that rises with theta; slope < 0 for
 * evidence that falls with theta. `base` keeps likelihoods away from 0 and 1.
 * @typedef {{slope: number, center: number, base?: number}} Likelihood
 */

export const MINDS = [
  {
    id: 'sc_landlord',
    name: 'Landlord',
    role: 'Owner of Unit 2, 18 Harbor Street',
    lod: 'L3',
    realPerson: true,
    goals: [
      { name: 'steady income', nodeId: 'sc_landlord.goal_income' },
      { name: 'tenant quality', nodeId: 'sc_landlord.goal_tenant_quality' },
      { name: 'property value', nodeId: 'sc_landlord.goal_property_value' },
    ],
    traits: [
      { name: 'risk tolerance', nodeId: 'sc_landlord.risk_tolerance' },
      { name: 'honesty prior', nodeId: 'sc_landlord.honesty_prior' },
    ],
    hidden: { name: 'flexibility on rent', metricName: 'flexibility', nodeId: 'sc_landlord.flexibility', prior: { alpha: 2, beta: 2 } },
    knowledge: ['ev_vacancy', 'ev_base_rent', 'ev_free_months', 'ev_escalation'],
    beliefs: [
      { about: 'Bakery default risk', nodeId: 'sc_landlord.belief_credit_risk', world: 'sc_bakery' },
    ],
    nested: {
      label: 'Landlord',
      children: [
        {
          label: 'models Bakery: walks away',
          nodeId: 'sc_landlord.model_walkaway',
          children: [{ label: 'models Bakery modeling Landlord: flexible', nodeId: 'sc_landlord.model_model_flex', children: [] }],
        },
        { label: 'believes: Bakery default risk', nodeId: 'sc_landlord.belief_credit_risk', children: [] },
      ],
    },
    relationships: [
      { target: 'sc_bakery', label: 'trust in Bakery', nodeId: 'sc_landlord.trust_bakery', reciprocity: 0.15 },
      { target: 'sc_officer', label: 'trusts the bank', value: 0.6, reciprocity: 0.05 },
    ],
    affect: [
      { name: 'valence', nodeId: 'sc_landlord.affect_valence', decay: 0.12 },
      { name: 'arousal', nodeId: 'sc_landlord.affect_arousal', decay: 0.25 },
    ],
    observations: [
      { id: 'o1', when: 'Apr–Nov', text: 'Unit has been listed for seven months; price reduced once', evidence: 'ev_vacancy', likelihood: { slope: 3.2, center: 0.3 } },
      { id: 'o2', when: 'Nov 14', text: 'Agent: “several other parties are interested in the unit”', speech: true, who: 'Landlord’s agent', likelihood: { slope: -1.4, center: 0.5 } },
      { id: 'o3', when: 'Nov 18', text: 'Offered two months of rent abatement without being asked', evidence: 'ev_free_months', likelihood: { slope: 3.6, center: 0.45 } },
      { id: 'o4', when: 'Nov 20', text: 'Declined to cap the annual escalation below three percent', evidence: 'ev_escalation', likelihood: { slope: -1.8, center: 0.55 } },
    ],
    claims: [
      {
        id: 'c_interest',
        who: 'Landlord’s agent',
        text: '“Several other parties are interested in the unit.”',
        reasons: [
          { kind: 'belief', text: 'Seven months on the market and a price cut make strong outside interest unlikely to be known to them.', p: 0.35 },
          { kind: 'incentive', text: 'Saying it helps either way: it strengthens their position whether or not it is true.', p: 0.5 },
          { kind: 'consistency', text: 'The unprompted abatement offer two days later is hard to square with several competing offers.', p: 0.3 },
        ],
      },
    ],
  },
  {
    id: 'sc_rival1_owner',
    name: 'Rival1 owner',
    role: 'Owner of Rival1, 0.6 km from Location B',
    lod: 'L2',
    realPerson: true,
    goals: [
      { name: 'market share', nodeId: 'sc_rival1_owner.goal_share' },
      { name: 'margin', nodeId: 'sc_rival1_owner.goal_margin' },
    ],
    traits: [{ name: 'aggressiveness', nodeId: 'sc_rival1_owner.aggressiveness' }],
    hidden: { name: 'price cut if B opens', metricName: 'price_cut_prob', nodeId: 'sc_rival1_owner.price_cut_prob', prior: { alpha: 2, beta: 6 } },
    knowledge: ['ev_rival1_price'],
    beliefs: [{ about: 'Bakery quality', nodeId: 'sc_rival1_owner.belief_bakery_quality', world: 'sc_bakery' }],
    nested: { label: 'Rival1 owner', children: [{ label: 'believes: Bakery quality', nodeId: 'sc_rival1_owner.belief_bakery_quality', children: [] }] },
    relationships: [{ target: 'sc_bakery', label: 'trust in Bakery', nodeId: 'sc_rival1_owner.trust_bakery', reciprocity: -0.2 }],
    affect: [
      { name: 'valence', nodeId: 'sc_rival1_owner.affect_valence', decay: 0.1 },
      { name: 'arousal', nodeId: 'sc_rival1_owner.affect_arousal', decay: 0.2 },
    ],
    observations: [
      { id: 'r1', when: 'Oct', text: 'Matched a competitor’s promotion within a week last spring', likelihood: { slope: 2.6, center: 0.3 } },
      { id: 'r2', when: 'Nov', text: 'Raised prices in September despite a new café nearby', likelihood: { slope: -2.0, center: 0.35 } },
    ],
    claims: [],
  },
  {
    id: 'sc_officer',
    name: 'Loan officer',
    role: 'Small-business lending, the bank',
    lod: 'L2',
    realPerson: true,
    goals: [
      { name: 'credit risk', nodeId: 'sc_officer.goal_risk' },
      { name: 'loan volume', nodeId: 'sc_officer.goal_volume' },
    ],
    traits: [],
    hidden: { name: 'approval', metricName: 'approval_prob', nodeId: 'sc_officer.approval_prob', prior: { alpha: 7, beta: 3 } },
    knowledge: ['ev_dscr_policy'],
    beliefs: [{ about: 'policy DSCR threshold', nodeId: 'sc_officer.dscr_threshold', world: 'sc_bakery' }],
    nested: { label: 'Loan officer', children: [{ label: 'believes: DSCR threshold', nodeId: 'sc_officer.dscr_threshold', children: [] }] },
    relationships: [{ target: 'sc_bakery', label: 'trust in Bakery', nodeId: 'sc_officer.trust_bakery', reciprocity: 0.1 }],
    affect: [
      { name: 'valence', nodeId: 'sc_officer.affect_valence', decay: 0.1 },
      { name: 'arousal', nodeId: 'sc_officer.affect_arousal', decay: 0.2 },
    ],
    observations: [
      { id: 'l1', when: 'Nov 2', text: 'Asked for two years of POS history before quoting a rate', likelihood: { slope: 1.2, center: 0.5 } },
      { id: 'l2', when: 'Nov 9', text: 'Quoted 8.5% with a seven-year term', likelihood: { slope: 2.4, center: 0.55 } },
    ],
    claims: [],
  },
];
