/**
 * JSDoc type definitions for the model layer (no runtime code).
 * These mirror the Scope IR and ScopeDelta shapes of the production API so the prototype can
 * migrate to TypeScript (or to the WASM engine) without restructuring.
 * @module model/types
 */

/** @typedef {'input'|'observed'|'estimated'|'computed'|'proven'} Provenance */

/** @typedef {{ dtype: 'f64'|'i64'|'bool'|'text', unit: string }} MetricType */

/** @typedef {import('./distributions.js').DistSpec} Distribution */

/**
 * Per-value provenance detail.
 * @typedef {Object} ProvDetail
 * @property {string=} src            source document id ('lease.pdf')
 * @property {number=} page
 * @property {string=} span           quoted text containing the value
 * @property {string=} evidence       evidence record id
 * @property {string=} by             estimator ('ms-8b', 'swarm:estimators')
 * @property {number=} calib          calibration error of the estimator on backtests
 * @property {string=} overriddenFrom original class when a user overrode it
 * @property {any=} originalValue
 * @property {string=} note
 */

/**
 * A metric node (Scope IR).
 * @typedef {Object} IRNode
 * @property {string} id              'sc_bakery.gross_margin'
 * @property {string} scope           'sc_bakery'
 * @property {string} name            'gross_margin'
 * @property {'input'|'observed'|'estimated'|'computed'} kind
 * @property {MetricType} type
 * @property {number=} value          point value (input / observed; nominal for estimates)
 * @property {Distribution=} dist     uncertainty (estimated, or inputs given as ranges)
 * @property {any=} expr              IR expression (computed)
 * @property {string[]} deps          resolved dependency ids (filled by the indexer)
 * @property {string=} hash           'b3:7d1c…'
 * @property {ProvDetail=} prov
 * @property {[number, number]=} range declared plausible range (sliders, sensitivity, proofs)
 * @property {string=} label          human label
 * @property {string=} description
 * @property {{factor: string, rho: number}=} corr  shared latent factor (Gaussian copula)
 * @property {string[]=} proven       claim ids proven about this metric
 * @property {boolean=} headline      shown in collapsed-subtree summaries
 * @property {boolean=} output        a key output of the answer
 */

/**
 * @typedef {Object} Relation
 * @property {string} type            'competes_with' | 'leases_from' | 'lends_to' | 'trusts' | ...
 * @property {string} target          scope id
 * @property {string=} label
 * @property {Record<string, string>=} metrics   relation metrics (name -> node id), e.g. trust
 */

/**
 * @typedef {Object} Constraint
 * @property {string} id
 * @property {string} label           'price > unit_cost'
 * @property {any} expr
 * @property {'hard'|'soft'=} severity
 */

/**
 * @typedef {Object} Scope
 * @property {string} id              'sc_7Q2f' or 'sc_bakery'
 * @property {string} key             identifier-safe local name
 * @property {string} name            display name
 * @property {string} proto           prototype id 'std.org.Location@1'
 * @property {string|null} parent
 * @property {string[]} children
 * @property {string[]} metrics       node ids
 * @property {Relation[]} relations
 * @property {Constraint[]} constraints
 * @property {'L0'|'L1'|'L2'|'L3'=} lod   level of detail (agents)
 * @property {string=} kind           presentation hint: business, location, person, mind, group, month, loan, market, population
 * @property {string=} description
 * @property {boolean=} realPerson    Mind Scope of a real, identifiable person (simulation, not assessment)
 */

/**
 * @typedef {Object} ScopeDelta
 * @property {'set'|'add_scope'|'remove_scope'|'add_metric'|'remove_metric'|'rewire'|'link'|'unlink'|'fork'|'restore_scope'|'delete_scenario'|'rename'} op
 * @property {string=} target
 * @property {string=} expect         expected graph version ('v41'); stale deltas fail closed
 * @property {number=} value
 * @property {Distribution=} dist
 * @property {Provenance=} prov
 * @property {string=} unit           unit of `value` if not the metric's unit
 * @property {string=} scenario       apply to a scenario overlay instead of the base graph
 * @property {string=} parent
 * @property {string=} proto
 * @property {string=} name
 * @property {any=} expr
 * @property {any=} overrides
 * @property {any=} snapshot
 */

/**
 * @typedef {Object} DeltaError
 * @property {string} code            stale_version | unknown_target | unit_mismatch | not_editable | cycle | type_error | name_collision | parent_missing | dangling_refs | relation_not_allowed | base_missing | invalid_value
 * @property {string} message
 * @property {string=} hint           actionable fix
 */

/**
 * @typedef {Object} Stats
 * @property {number} p10
 * @property {number} p50
 * @property {number} p90
 * @property {number} mean
 * @property {number} sd
 * @property {number} min
 * @property {number} max
 * @property {number} n
 * @property {boolean} deterministic
 * @property {number=} p05
 * @property {number=} p95
 */

/**
 * @typedef {Object} RecomputeResult
 * @property {boolean} ok
 * @property {string} version
 * @property {string[]} changed
 * @property {number} ms              point recompute time
 * @property {number} mcMs            Monte Carlo time
 * @property {number} nodes           nodes in the recomputed cone
 * @property {boolean} structural
 * @property {DeltaError[]=} errors
 */

/**
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {string|null} parentId
 * @property {string} baseVersion
 * @property {Map<string, {value?: number, dist?: Distribution}>} overrides
 * @property {number} rev
 * @property {number} color           series slot (0-based, fixed per scenario)
 * @property {string} createdBy
 * @property {string=} note
 */

/**
 * @typedef {Object} CertificateLevel
 * @property {number} level
 * @property {string} name
 * @property {string} tool
 * @property {string} catches
 * @property {'pass'|'fail'|'na'|'not_proven'|'proven'|'statistical'|'judgment'} status
 * @property {string} detail
 * @property {Array<{label: string, status: string, nodeId?: string}>} items
 */

/**
 * @typedef {Object} MindScope
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {'L0'|'L1'|'L2'|'L3'} lod
 * @property {boolean} realPerson
 * @property {Array<{name: string, weight: number}>} goals
 * @property {Array<{name: string, nodeId: string}>} traits
 * @property {string[]} knowledge     evidence ids (information partition)
 * @property {Array<{about: string, nodeId: string}>} beliefs
 * @property {any} nested             depth-2 nested beliefs
 * @property {Array<{target: string, trust: string, reciprocity?: string}>} relationships
 * @property {Array<{name: string, value: number, decay: number}>} affect
 */

export {};
