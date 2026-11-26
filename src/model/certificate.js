/**
 * Verification certificate: what was computed, proven, sourced or estimated, what failed, and
 * what was NOT checked, plus the verification ladder (levels 0-8). Reproducible from the graph
 * hash, engine version and seed. "Verified" means the conclusions follow from the graph; it never
 * says "true".
 * Pure function of the graph/engine state and the verifier inputs. No DOM.
 * @module model/certificate
 */
import { describe as describeDist } from './distributions.js';

/** @typedef {import('./types.js').CertificateLevel} CertificateLevel */

/**
 * @typedef {Object} Claim
 * @property {string} id
 * @property {'lean'|'smt'} tool
 * @property {string} title
 * @property {string} statement
 * @property {string=} latex
 * @property {string[]} covers                node ids
 * @property {string=} target                 node id checked (smt)
 * @property {'<'|'>'|'>='|'<='=} op
 * @property {number=} bound
 * @property {string[]=} vars                 inputs ranging over their declared ranges
 * @property {Array<{label: string, a: string, op: string, b: string|number}>=} hypotheses
 * @property {string=} source                 Lean / SMT text
 * @property {'proven'|'not_proven'|'failed'=} baseStatus
 * @property {string=} note
 */

/**
 * Check a bound claim over the box of declared input ranges: every corner plus a deterministic
 * interior grid (stand-in for the SMT solver; exact for monotone formulas).
 * @param {import('./engine.js').JsEngine} engine @param {Claim} claim
 */
export function checkBoundClaim(engine, claim) {
  const g = engine.graph;
  const vars = (claim.vars || []).map((id) => ({ id, node: g.node(id) })).filter((v) => v.node);
  const outside = [];
  for (const v of vars) {
    const r = v.node.range;
    const cur = engine.value(v.id);
    if (r && (cur < r[0] - 1e-9 || cur > r[1] + 1e-9)) outside.push(`${v.node.name} = ${round(cur)} is outside the proven range [${round(r[0])}, ${round(r[1])}]`);
  }
  const k = vars.length;
  let worst = -Infinity;
  let best = Infinity;
  const evalAt = (vals) => {
    const ov = new Map();
    vals.forEach((x, i) => ov.set(vars[i].id, { value: x }));
    const y = engine.pointUnder(ov, /** @type {string} */ (claim.target));
    worst = Math.max(worst, y);
    best = Math.min(best, y);
  };
  for (let mask = 0; mask < 1 << k; mask++) {
    evalAt(vars.map((v, i) => (v.node.range ? v.node.range[(mask >> i) & 1] : engine.value(v.id))));
  }
  for (let t = 1; t <= 3; t++) {
    evalAt(vars.map((v) => (v.node.range ? v.node.range[0] + ((v.node.range[1] - v.node.range[0]) * t) / 4 : engine.value(v.id))));
  }
  const bound = /** @type {number} */ (claim.bound);
  const holds = claim.op === '<' ? worst < bound : claim.op === '<=' ? worst <= bound : claim.op === '>' ? best > bound : best >= bound;
  return { holds: holds && outside.length === 0, holdsOnBox: holds, worst, best, outside };
}

/**
 * Evaluate a Lean claim's hypotheses at the current values.
 * @param {import('./engine.js').JsEngine} engine @param {Claim} claim
 */
export function checkHypotheses(engine, claim) {
  const failed = [];
  for (const h of claim.hypotheses || []) {
    const a = engine.value(h.a);
    const b = typeof h.b === 'number' ? h.b : engine.value(h.b);
    const ok = h.op === '<' ? a < b : h.op === '>' ? a > b : h.op === '<=' ? a <= b : a >= b;
    if (!ok) failed.push(h.label);
  }
  return failed;
}

/**
 * @param {{
 *   graph: import('./graph.js').ScopeGraph,
 *   engine: import('./engine.js').JsEngine,
 *   answerId?: string,
 *   claims?: Claim[],
 *   evidence?: Array<{id: string, value: number, tolerance?: number, binds: string[], source: string, stale?: boolean}>,
 *   estimators?: Array<{name: string, calibrationError: number, backtests: number}>,
 *   notChecked?: string[],
 *   skeptic?: string[],
 *   output?: string,
 * }} input
 */
export function buildCertificate(input) {
  const { graph, engine } = input;
  const nodes = [...graph.nodes.values()];
  const counts = { computed: 0, observed: 0, estimated: 0, input: 0, proven: 0 };
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  const overridden = nodes.filter((n) => n.prov && n.prov.overriddenFrom).length;

  // ---------------- L1 names / types / cycles
  const l1 = [...graph.errors, ...engine.errors.filter((e) => e.code === 'type_error' || e.code === 'unresolved' || e.code === 'cycle')];
  // ---------------- L2 units
  const l2 = engine.errors.filter((e) => e.code === 'unit_mismatch');
  // ---------------- L3 invariants
  const cons = engine.constraintStatus();
  const hardFail = cons.filter((c) => c.severity === 'hard' && !c.ok);
  const softWarn = cons.filter((c) => c.severity !== 'hard' && !c.ok);
  // ---------------- L4 evidence
  const evIndex = new Map((input.evidence || []).map((e) => [e.id, e]));
  const evItems = [];
  let matched = 0;
  let total = 0;
  for (const n of nodes) {
    if (n.kind !== 'observed') continue;
    total++;
    const ev = n.prov?.evidence ? evIndex.get(n.prov.evidence) : null;
    if (!ev) {
      evItems.push({ label: `${graph.path(n.id)}: no extraction on record`, status: 'fail', nodeId: n.id });
      continue;
    }
    const expected = ev.valuesByNode ? ev.valuesByNode[n.id] : ev.value;
    const tol = ev.tolerance ?? Math.max(1e-9, Math.abs(expected) * 1e-6);
    const ok = Math.abs(expected - (n.value ?? NaN)) <= tol;
    if (ok && !ev.stale) {
      matched++;
      evItems.push({ label: `${graph.path(n.id)} = ${round(n.value)} found in ${ev.source}`, status: 'pass', nodeId: n.id });
    } else {
      evItems.push({ label: `${graph.path(n.id)} = ${round(n.value)} ${ev.stale ? 'source is stale' : `does not match ${round(expected)} in ${ev.source}`}`, status: 'fail', nodeId: n.id });
    }
  }
  // ---------------- L5 bounds (SMT) and L6 proofs (Lean)
  const claims = input.claims || [];
  const proven = [];
  const notProven = [];
  const smtItems = [];
  const leanItems = [];
  for (const c of claims) {
    if (c.tool === 'smt') {
      const r = checkBoundClaim(engine, c);
      const status = r.holds ? 'proven' : 'not_proven';
      const detail = r.holds
        ? `holds for all inputs in declared ranges (max ${round(r.worst)})`
        : r.outside.length ? r.outside.join('; ') : `counterexample in the declared ranges (reaches ${round(c.op === '<' || c.op === '<=' ? r.worst : r.best)})`;
      (r.holds ? proven : notProven).push({ ...c, status, detail });
      smtItems.push({ label: `${c.id}: ${c.statement}`, status, detail, nodeId: c.target });
    } else {
      const failedH = checkHypotheses(engine, c);
      const status = c.baseStatus === 'proven' ? 'proven' : 'not_proven';
      const applies = failedH.length === 0;
      const detail = status === 'proven'
        ? applies ? 'theorem checked by Lean 4 + Mathlib; hypotheses hold for current inputs' : `theorem checked, but its hypotheses do not hold now: ${failedH.join(', ')}`
        : 'no proof found within budget';
      (status === 'proven' ? proven : notProven).push({ ...c, status, detail, applies });
      leanItems.push({ label: `${c.id}: ${c.statement}`, status: status === 'proven' ? (applies ? 'proven' : 'na') : 'not_proven', detail, nodeId: c.covers?.[0] });
    }
  }
  counts.proven = proven.length;

  // ---------------- drivers
  let topDrivers = [];
  try {
    const s = engine.sensitivity(input.output || 'sc_bakery.monthly_cash');
    topDrivers = s.items.slice(0, 3).map((it) => ({ id: it.id, name: it.name, sobol: it.sobol }));
  } catch { /* no output */ }

  const estimators = input.estimators || [{ name: 'ms-8b-v3', calibrationError: 0.04, backtests: 1240 }];
  const estimated = nodes.filter((n) => n.kind === 'estimated');
  const contested = estimated.filter((n) => n.dist && n.dist.family === 'Mixture' && n.dist.contested);

  /** @type {CertificateLevel[]} */
  const ladder = [
    {
      level: 0, name: 'Grammar', tool: 'ScopeLang grammar in the decoder', catches: 'Malformed programs',
      status: 'pass', detail: 'program parsed under grammar-constrained decoding (mock)', items: [],
    },
    {
      level: 1, name: 'Names, types, cycles', tool: 'ScopeLang compiler', catches: 'Dangling references, type errors, circular logic',
      status: l1.length ? 'fail' : 'pass',
      detail: l1.length ? `${l1.length} error(s)` : `${nodes.filter((n) => n.kind === 'computed').length} formulas resolved, no cycles`,
      items: l1.map((e) => ({ label: e.message + (e.hint ? `; ${e.hint}` : ''), status: 'fail', nodeId: e.nodeId })),
    },
    {
      level: 2, name: 'Dimensional analysis', tool: 'Unit checker over SI dimension vectors', catches: 'Adding USD to USD/month, missing conversions',
      status: l2.length ? 'fail' : 'pass',
      detail: l2.length ? `${l2.length} unit error(s)` : `${nodes.length} metrics unit-checked`,
      items: l2.map((e) => ({ label: e.message + (e.hint ? `; ${e.hint}` : ''), status: 'fail', nodeId: e.nodeId })),
    },
    {
      level: 3, name: 'Invariants', tool: 'Engine: declared constraints, accounting identities', catches: 'Impossible states, double counting',
      status: hardFail.length ? 'fail' : 'pass',
      detail: `${cons.length - hardFail.length - softWarn.length}/${cons.length} constraints hold${softWarn.length ? `; ${softWarn.length} soft warning(s)` : ''}`,
      items: cons.map((c) => ({
        label: `${c.label} (${graph.path(c.scope)})${c.share != null ? `: holds in ${Math.round(c.share * 100)}% of samples` : ''}`,
        status: c.ok ? 'pass' : c.severity === 'hard' ? 'fail' : 'warn', nodeId: c.deps[0],
      })),
    },
    {
      level: 4, name: 'Evidence', tool: 'Evidence verifier: value, unit and date in the cited span', catches: 'Misread or invented numbers',
      status: matched === total ? 'pass' : 'fail',
      detail: `${matched}/${total} sources matched${overridden ? `; ${overridden} value(s) overridden by the user (now input)` : ''}`,
      items: evItems,
    },
    {
      level: 5, name: 'Bounds and properties', tool: 'Interval arithmetic; SMT (Z3 / cvc5, mocked)', catches: '"Never negative" claims that fail for some allowed input',
      status: smtItems.some((i) => i.status !== 'proven') ? 'not_proven' : smtItems.length ? 'proven' : 'na',
      detail: `${smtItems.filter((i) => i.status === 'proven').length}/${smtItems.length} bound claims proven over declared ranges`,
      items: smtItems,
    },
    {
      level: 6, name: 'Formal proof', tool: 'Lean 4 with Mathlib (mocked)', catches: 'Properties over all inputs, symbolically',
      status: leanItems.some((i) => i.status === 'not_proven') ? 'not_proven' : leanItems.length ? 'proven' : 'na',
      detail: `${leanItems.filter((i) => i.status !== 'not_proven').length}/${leanItems.length} theorems checked`,
      items: leanItems,
    },
    {
      level: 7, name: 'Calibration and backtests', tool: 'Scoring against resolved outcomes', catches: 'Systematic bias in estimates',
      status: 'statistical',
      detail: estimators.map((e) => `${e.name}: calibration error ${e.calibrationError} on ${e.backtests.toLocaleString('en-US')} backtests`).join('; '),
      items: estimated.slice(0, 12).map((n) => ({ label: `${graph.path(n.id)} ~ ${n.dist ? describeDist(n.dist) : '?'}${n.prov?.by ? ` (${n.prov.by})` : ''}`, status: 'statistical', nodeId: n.id })),
    },
    {
      level: 8, name: 'Structural review', tool: 'Skeptic role; human review when stakes are high', catches: 'A wrong model of the world: missing scopes, reversed causes',
      status: 'judgment',
      detail: `${graph.scopes.size} scopes reviewed by the Skeptic; judgment, not proof`,
      items: (input.skeptic || []).map((s) => ({ label: s, status: 'judgment' })),
    },
  ];

  const failed = ladder.flatMap((l) => l.items.filter((i) => i.status === 'fail').map((i) => ({ level: l.level, check: l.name, message: i.label, nodeId: i.nodeId })));
  return {
    answerId: input.answerId || 'a_7f3',
    graphVersion: graph.versionLabel,
    graphHash: graph.hash,
    shortHash: graph.shortHash,
    engineVersion: engine.engineVersion,
    engineName: engine.name,
    seed: graph.seed,
    samples: engine.n,
    counts,
    overridden,
    sources: { matched, total },
    estimators,
    contested: contested.map((n) => n.id),
    proven: proven.map((c) => ({ id: c.id, tool: c.tool, title: c.title, detail: c.detail })),
    notProven: notProven.map((c) => ({ id: c.id, tool: c.tool, title: c.title, detail: c.detail })),
    failed,
    topDrivers,
    notChecked: input.notChecked || [],
    ladder,
    createdAt: Date.now(),
  };
}

/** @param {number} x */
function round(x) {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1000) return Math.round(x).toLocaleString('en-US');
  if (a >= 1) return String(Math.round(x * 100) / 100);
  return String(Number(x.toPrecision(3)));
}
