/**
 * ScopeDelta: the edit protocol for every change from the user, the model or a swarm agent.
 * Each delta names its target by stable id and the version it expects. Batches apply
 * all-or-nothing; stale or invalid deltas fail closed with an actionable message, and every
 * applied delta returns its inverse (for undo).
 *
 * Ops: set · add_scope · remove_scope · add_metric · remove_metric · rewire · link · unlink ·
 *      fork · delete_scenario · rename · restore_scope (internal, for undo)
 * No DOM.
 * @module model/delta
 */
import { slug, stableId } from '../core/ids.js';
import { parseUnit, sameUnit, sameDims, convertFactor, unitText } from './units.js';
import { validateDist, nominal, describe } from './distributions.js';
import { validateExpr, inferUnit, resolvedDeps, toScopeLang } from './expr.js';
import { unitValue } from './format.js';

/** @typedef {import('./types.js').ScopeDelta} ScopeDelta */
/** @typedef {import('./types.js').DeltaError} DeltaError */

/** @param {string} code @param {string} message @param {string} [hint] @returns {DeltaError} */
const err = (code, message, hint) => ({ code, message, hint });

/**
 * Apply a batch. On any failure, everything already applied in this batch is rolled back.
 * @param {import('./graph.js').ScopeGraph} graph
 * @param {import('./scenarios.js').ScenarioStore} scenarios
 * @param {ScopeDelta[]} deltas
 */
export function applyDeltas(graph, scenarios, deltas) {
  const applied = [];
  const changed = new Set();
  let structural = false;
  let scenarioChanged = false;
  const summaries = [];
  const inverses = [];
  for (const d of deltas) {
    const v = validateDelta(graph, scenarios, d);
    if (v.length) {
      for (const inv of applied.reverse()) applyOne(graph, scenarios, inv, true);
      if (structural) graph.reindex();
      return { ok: false, errors: v.map((e) => ({ ...e, delta: d })), changedNodes: new Set(), structural: false, scenarioChanged: false, summaries: [], inverses: [] };
    }
    const r = applyOne(graph, scenarios, d, false);
    applied.push(r.inverse);
    inverses.unshift(r.inverse);
    summaries.push(r.summary);
    for (const id of r.changed) changed.add(id);
    if (r.structural) {
      structural = true;
      graph.reindex(); // later deltas in the batch may reference new scopes
    }
    if (r.scenario) scenarioChanged = true;
  }
  return { ok: true, errors: [], changedNodes: changed, structural, scenarioChanged, summaries, inverses };
}

/**
 * Validate one delta against the current state.
 * @param {import('./graph.js').ScopeGraph} graph
 * @param {import('./scenarios.js').ScenarioStore} scenarios
 * @param {ScopeDelta} d
 * @returns {DeltaError[]}
 */
export function validateDelta(graph, scenarios, d) {
  if (!d || typeof d !== 'object' || !d.op) return [err('invalid', 'delta must be an object with an op')];
  if (d.expect && d.expect !== graph.versionLabel && !d.restore) {
    return [err('stale_version', `delta expects ${d.expect} but the graph is at ${graph.versionLabel}`, `rebase on ${graph.versionLabel} and resend (the target may have changed)`)];
  }
  switch (d.op) {
    case 'set': return validateSet(graph, scenarios, d);
    case 'add_scope': {
      if (!d.parent || !graph.scope(d.parent)) return [err('parent_missing', `parent scope ${d.parent} not found`, 'add the parent first or pick an existing scope')];
      if (!d.proto || !graph.prototypes[d.proto]) return [err('unknown_prototype', `prototype ${d.proto} is not in the prototype library`, `use one of ${Object.keys(graph.prototypes).slice(0, 6).join(', ')}…`)];
      if (!d.name || !String(d.name).trim()) return [err('invalid_value', 'add_scope needs a name')];
      const p = /** @type {any} */ (graph.scope(d.parent));
      if (p.children.some((c) => slug(graph.scope(c)?.name || '') === slug(d.name || ''))) {
        return [err('name_collision', `${graph.path(p.id)} already has a child named "${d.name}"`, 'choose another name')];
      }
      if (d.id && graph.scope(d.id)) return [err('name_collision', `scope id ${d.id} already exists`)];
      return [];
    }
    case 'remove_scope': {
      const s = d.target ? graph.scope(d.target) : null;
      if (!s) return [err('unknown_target', `no scope ${d.target}`)];
      if (s.id === graph.rootId) return [err('not_editable', 'the root scope cannot be removed')];
      if (d.force) return [];
      const inside = new Set(graph.subtreeNodes(s.id));
      const dangling = [];
      for (const n of graph.nodes.values()) {
        if (inside.has(n.id)) continue;
        const agg = graph.aggDeps.get(n.id);
        for (const dep of n.deps || []) if (inside.has(dep) && !(agg && agg.has(dep))) dangling.push(`${graph.path(n.id)} -> ${graph.path(dep)}`);
      }
      if (dangling.length) return [err('dangling_refs', `removal leaves dangling references: ${dangling.slice(0, 3).join(', ')}${dangling.length > 3 ? ` and ${dangling.length - 3} more` : ''}`, 'rewire them first')];
      return [];
    }
    case 'add_metric': {
      const s = d.scope ? graph.scope(/** @type {string} */ (d.scope)) : null;
      if (!s) return [err('unknown_target', `no scope ${d.scope}`)];
      if (!d.name || !/^[A-Za-z_][\w]*$/.test(d.name)) return [err('invalid_value', `metric name "${d.name}" must be an identifier`)];
      if (s.metrics.some((m) => graph.node(m)?.name === d.name)) {
        return [err('name_collision', `"${d.name}" collides on shape ${graph.shapeOfScope.get(s.id) || s.proto}`, 'pick another name or set the existing metric')];
      }
      try { parseUnit(/** @type {any} */ (d).unit || ''); } catch (e) { return [err('unit_mismatch', /** @type {Error} */ (e).message, /** @type {any} */ (e).hint)]; }
      if (/** @type {any} */ (d).expr !== undefined) return validateFormula(graph, s.id, `${s.id}.${d.name}`, /** @type {any} */ (d).expr, /** @type {any} */ (d).unit || '');
      if (d.dist) { const e = validateDist(d.dist); if (e) return [err('invalid_value', e)]; }
      return [];
    }
    case 'remove_metric': {
      const n = d.target ? graph.node(d.target) : null;
      if (!n) return [err('unknown_target', `no metric ${d.target}`)];
      if (!d.force) {
        const deps = graph.dependents(n.id);
        if (deps.length) return [err('dangling_refs', `removing ${graph.path(n.id)} leaves dangling references from ${deps.slice(0, 3).map((x) => graph.path(x)).join(', ')}`, 'rewire them first')];
      }
      return [];
    }
    case 'rewire': {
      const n = d.target ? graph.node(d.target) : null;
      if (!n) return [err('unknown_target', `no metric ${d.target}`, suggest(graph, d.target))];
      if (n.kind !== 'computed') return [err('not_editable', `${graph.path(n.id)} is ${n.kind}; rewire replaces formulas of computed metrics`, 'use set to change its value')];
      return validateFormula(graph, n.scope, n.id, d.expr, n.type.unit, true);
    }
    case 'link':
    case 'unlink': {
      const a = /** @type {any} */ (d).source ? graph.scope(/** @type {any} */ (d).source) : null;
      const b = d.target ? graph.scope(d.target) : null;
      if (!a || !b) return [err('unknown_target', `${d.op} needs existing source and target scopes`)];
      const rel = /** @type {any} */ (d).rel;
      if (d.op === 'link') {
        const rules = graph.prototypes.__relations || {};
        const rule = rules[rel];
        if (!rule) return [err('relation_not_allowed', `unknown relation "${rel}"`, `use one of ${Object.keys(rules).join(', ')}`)];
        const ca = graph.protoChainNames(a.id);
        const cb = graph.protoChainNames(b.id);
        if (!ca.includes(rule[0]) || !cb.includes(rule[1])) {
          return [err('relation_not_allowed', `relation ${rel} is not allowed between ${ca[0]} and ${cb[0]}`, `${rel} links a ${rule[0]} to a ${rule[1]}`)];
        }
      } else if (!a.relations.some((r) => r.type === rel && r.target === b.id)) {
        return [err('unknown_target', `${graph.path(a.id)} has no ${rel} relation to ${graph.path(b.id)}`)];
      }
      return [];
    }
    case 'fork': {
      const parent = /** @type {any} */ (d).parent || 'base';
      if (!scenarios.has(parent)) return [err('base_missing', `base scenario ${parent} not found`, 'fork from base or an existing scenario')];
      for (const o of /** @type {any} */ (d).overrides || []) {
        const n = graph.node(o.target);
        if (!n) return [err('unknown_target', `override target ${o.target} not found`)];
        if (n.kind === 'computed') return [err('not_editable', `scenario overrides must target inputs, observed or estimated metrics; ${graph.path(n.id)} is computed`)];
      }
      return [];
    }
    case 'delete_scenario': return scenarios.has(/** @type {any} */ (d).id) && /** @type {any} */ (d).id !== 'base' ? [] : [err('unknown_target', `no scenario ${/** @type {any} */ (d).id}`)];
    case 'rename': {
      const s = d.target ? graph.scope(d.target) : null;
      if (!s) return [err('unknown_target', `no scope ${d.target}`)];
      const name = String(d.name || '').trim();
      if (!name) return [err('invalid_value', 'name cannot be empty')];
      const parent = s.parent ? graph.scope(s.parent) : null;
      if (parent && parent.children.some((c) => c !== s.id && slug(graph.scope(c)?.name || '') === slug(name))) return [err('name_collision', `${graph.path(parent.id)} already has a child named "${name}"`)];
      return [];
    }
    case 'restore_scope': return [];
    default: return [err('invalid', `unknown op "${d.op}"`)];
  }
}

/** @param {any} graph @param {any} scenarios @param {ScopeDelta} d */
function validateSet(graph, scenarios, d) {
  const n = d.target ? graph.node(d.target) : null;
  if (!n) return [err('unknown_target', `no metric ${d.target}`, suggest(graph, d.target))];
  if (d.scenario && d.scenario !== 'base' && !scenarios.has(d.scenario)) return [err('base_missing', `scenario ${d.scenario} not found`)];
  if (n.kind === 'computed' && !d.restore) {
    const ins = (n.deps || []).slice(0, 4).map((x) => graph.node(x)?.name).join(', ');
    return [err('not_editable', `${graph.path(n.id)} is computed; edit its inputs (${ins}) or rewire its formula`, 'computed values cannot be set directly')];
  }
  if (d.value !== undefined && d.value !== null && !Number.isFinite(d.value)) return [err('invalid_value', `value for ${graph.path(n.id)} must be a finite number`)];
  if (d.unit) {
    let from;
    try { from = parseUnit(d.unit); } catch (e) { return [err('unit_mismatch', /** @type {Error} */ (e).message)]; }
    const to = parseUnit(n.type.unit);
    if (!sameUnit(from, to)) {
      if (sameDims(from, to) && d.value !== undefined) {
        const conv = /** @type {number} */ (d.value) * convertFactor(from, to);
        return [err('unit_mismatch', `value is in ${unitText(from)} but ${graph.path(n.id)} is ${unitText(to)}`, `send ${unitValue(conv, n.type.unit)} or convert(${d.value}, ${unitText(to)})`)];
      }
      return [err('unit_mismatch', `value is in ${unitText(from)} but ${graph.path(n.id)} is ${unitText(to)}`, 'the quantities have different dimensions')];
    }
  }
  if (d.dist) {
    const e = validateDist(d.dist);
    if (e) return [err('invalid_value', `${graph.path(n.id)}: ${e}`)];
  }
  if (d.value === undefined && d.dist === undefined && !d.restore) return [err('invalid_value', 'set needs a value or a dist')];
  return [];
}

/**
 * Check a formula: structure, references, units, cycles.
 * @param {import('./graph.js').ScopeGraph} graph
 */
function validateFormula(graph, scopeId, nodeId, expr, unit, checkCycle = false) {
  const se = validateExpr(expr);
  if (se) return [err('type_error', `${graph.path(nodeId) || nodeId}: ${se}`)];
  const before = graph.errors.length;
  const r = graph.resolveExpr(expr, scopeId, nodeId);
  const newErrs = graph.errors.splice(before);
  if (newErrs.length) return newErrs.map((e) => err('unknown_target', e.message, e.hint));
  try {
    const u = inferUnit(r, (id) => graph.unitOf(id), (id) => graph.path(id), graph.path(nodeId) || nodeId);
    const want = parseUnit(unit || '');
    if (!u.poly && !sameUnit(u, want)) {
      const hint = sameDims(u, want) ? `wrap the formula in convert(..., ${unitText(want)})` : `the formula yields ${unitText(u)}, not ${unitText(want)}`;
      return [err('unit_mismatch', `unit mismatch in ${nodeId}: formula is ${unitText(u)} but the metric is ${unitText(want)}`, hint)];
    }
  } catch (e) {
    return [err('unit_mismatch', /** @type {Error} */ (e).message, /** @type {any} */ (e).hint)];
  }
  if (checkCycle) {
    const down = graph.downstream(nodeId);
    for (const dep of resolvedDeps(r)) {
      if (dep === nodeId || down.has(dep)) {
        const path = cyclePath(graph, nodeId, dep);
        return [err('cycle', `rewire rejected: creates cycle ${path.map((x) => graph.node(x)?.name || x).join(' -> ')}`, 'declare a fixed-point block or remove one edge')];
      }
    }
  }
  return [];
}

/** Path nodeId -> ... -> dep through dependents, then back to nodeId. */
function cyclePath(graph, from, to) {
  if (from === to) return [from, from];
  const prev = new Map();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const nxt of graph.dependents(cur)) {
      if (seen.has(nxt)) continue;
      seen.add(nxt);
      prev.set(nxt, cur);
      queue.push(nxt);
    }
  }
  const path = [to];
  let c = to;
  while (prev.has(c)) { c = prev.get(c); path.unshift(c); }
  path.push(from);
  return path;
}

/** @param {any} graph @param {string|undefined} target */
function suggest(graph, target) {
  if (!target) return undefined;
  const name = String(target).split('.').pop() || '';
  const hits = graph.search(name, { limit: 1, metricsOnly: true });
  return hits.length ? `did you mean ${hits[0].path}?` : undefined;
}

/**
 * Apply one validated delta. Returns its inverse and what changed.
 * @param {import('./graph.js').ScopeGraph} graph
 * @param {import('./scenarios.js').ScenarioStore} scenarios
 * @param {any} d
 * @param {boolean} rollingBack
 */
function applyOne(graph, scenarios, d, rollingBack) {
  void rollingBack;
  switch (d.op) {
    case 'set': {
      const n = /** @type {any} */ (graph.node(d.target));
      if (d.scenario && d.scenario !== 'base') {
        const sc = /** @type {any} */ (scenarios.get(d.scenario));
        const prev = sc.overrides.get(d.target);
        scenarios.setOverride(d.scenario, d.target, d.clear ? null : { value: d.value, dist: d.dist || undefined });
        return {
          inverse: { op: 'set', scenario: d.scenario, target: d.target, value: prev?.value, dist: prev?.dist, clear: !prev, restore: true },
          changed: [], structural: false, scenario: true,
          summary: `set ${graph.path(n.id)} = ${d.dist ? describe(d.dist) : unitValue(d.value, n.type.unit)} in scenario "${sc.name}"`,
        };
      }
      const inverse = { op: 'set', target: n.id, value: n.value, dist: n.dist ?? null, kind: n.kind, provDetail: n.prov ? structuredClone(n.prov) : undefined, restore: true };
      const oldText = n.dist && n.dist.family !== 'Point' ? describe(n.dist) : unitValue(n.value, n.type.unit);
      if (d.restore) {
        n.kind = d.kind || n.kind;
        n.prov = d.provDetail ? structuredClone(d.provDetail) : undefined;
      } else if (d.prov === 'input' && n.kind !== 'input') {
        n.prov = { ...(n.prov || {}), overriddenFrom: n.kind, originalValue: n.value, originalDist: n.dist };
        n.kind = 'input';
      } else if (d.prov === 'estimated' && n.kind === 'estimated') {
        n.prov = { ...(n.prov || {}), ...(d.provDetail || {}) };
      } else if (d.prov === 'observed' && d.provDetail) {
        n.kind = 'observed';
        n.prov = structuredClone(d.provDetail);
      }
      if ('dist' in d) n.dist = d.dist ? structuredClone(d.dist) : undefined;
      if (d.value !== undefined && d.value !== null) n.value = d.value;
      else if (d.dist) n.value = nominal(d.dist);
      const newText = n.dist && n.dist.family !== 'Point' ? describe(n.dist) : unitValue(n.value, n.type.unit);
      return {
        inverse, changed: [n.id], structural: false, scenario: false,
        summary: `set ${graph.path(n.id)} = ${newText} (was ${oldText})${inverse.kind !== n.kind ? `; ${inverse.kind} → ${n.kind}` : ''}`,
      };
    }
    case 'add_scope': {
      const id = d.id || uniqueScopeId(graph, d.parent, d.name);
      instantiate(graph, { id, parent: d.parent, proto: d.proto, name: d.name, key: d.key, metrics: d.metrics, relations: d.relations, lod: d.lod, kind: d.kind });
      return {
        inverse: { op: 'remove_scope', target: id, force: true },
        changed: graph.subtreeNodes(id), structural: true, scenario: false,
        summary: `add_scope ${graph.path(d.parent)}.${d.name} : ${graph.protoName(d.proto)}`,
        newId: id,
      };
    }
    case 'remove_scope': {
      const path = graph.path(d.target);
      const snapshot = graph.removeScope(d.target);
      return { inverse: { op: 'restore_scope', snapshot }, changed: [], structural: true, scenario: false, summary: `remove_scope ${path}` };
    }
    case 'restore_scope': {
      graph.restoreScope(d.snapshot);
      const id = d.snapshot.scopes[0].id;
      return { inverse: { op: 'remove_scope', target: id, force: true }, changed: d.snapshot.nodes.map((n) => n.id), structural: true, scenario: false, summary: `restore ${d.snapshot.scopes[0].name}` };
    }
    case 'add_metric': {
      const s = /** @type {any} */ (graph.scope(d.scope));
      const id = `${s.id}.${d.name}`;
      const node = { id, scope: s.id, name: d.name, kind: d.kind || (d.expr !== undefined ? 'computed' : 'input'), type: { dtype: 'f64', unit: d.unit || '' }, deps: [] };
      if (d.expr !== undefined) node.expr = d.expr;
      if (d.value !== undefined) node.value = d.value;
      if (d.dist) { node.dist = d.dist; if (node.value === undefined) node.value = nominal(d.dist); }
      if (d.prov) node.prov = d.prov;
      if (d.range) node.range = d.range;
      graph.addNode(/** @type {any} */ (node));
      return { inverse: { op: 'remove_metric', target: id, force: true }, changed: [id], structural: true, scenario: false, summary: `add_metric ${graph.path(s.id)}.${d.name}: ${d.unit || '1'}${d.expr !== undefined ? ` = ${toScopeLang(d.expr)}` : ''}` };
    }
    case 'remove_metric': {
      const n = /** @type {any} */ (graph.node(d.target));
      const snap = structuredClone(n);
      const path = graph.path(n.id);
      graph.removeNode(n.id);
      return { inverse: { op: 'add_metric', scope: snap.scope, name: snap.name, kind: snap.kind, unit: snap.type.unit, value: snap.value, dist: snap.dist, expr: snap.expr, prov: snap.prov, range: snap.range }, changed: [], structural: true, scenario: false, summary: `remove_metric ${path}` };
    }
    case 'rewire': {
      const n = /** @type {any} */ (graph.node(d.target));
      const old = n.expr;
      n.expr = structuredClone(d.expr);
      return { inverse: { op: 'rewire', target: n.id, expr: old, restore: true }, changed: [n.id], structural: true, scenario: false, summary: `rewire ${graph.path(n.id)} = ${toScopeLang(d.expr)}` };
    }
    case 'link': {
      const s = /** @type {any} */ (graph.scope(d.source));
      s.relations.push({ type: d.rel, target: d.target, label: d.label });
      return { inverse: { op: 'unlink', source: d.source, rel: d.rel, target: d.target }, changed: [], structural: true, scenario: false, summary: `link ${graph.path(d.source)} ${d.rel} → ${graph.path(d.target)}` };
    }
    case 'unlink': {
      const s = /** @type {any} */ (graph.scope(d.source));
      const i = s.relations.findIndex((r) => r.type === d.rel && r.target === d.target);
      const [rel] = s.relations.splice(i, 1);
      return { inverse: { op: 'link', source: d.source, rel: d.rel, target: d.target, label: rel?.label }, changed: [], structural: true, scenario: false, summary: `unlink ${graph.path(d.source)} ${d.rel} → ${graph.path(d.target)}` };
    }
    case 'fork': {
      const sc = scenarios.create({ id: d.id, name: d.name, parentId: d.parent || 'base', overrides: d.overrides || [], createdBy: d.author || 'user', note: d.note, baseVersion: graph.versionLabel });
      return { inverse: { op: 'delete_scenario', id: sc.id }, changed: [], structural: false, scenario: true, summary: `fork scenario "${d.name}" from ${d.parent && d.parent !== 'base' ? scenarios.get(d.parent)?.name : 'base'} with ${(d.overrides || []).length} override(s)`, newId: sc.id };
    }
    case 'delete_scenario': {
      const sc = /** @type {any} */ (scenarios.remove(d.id));
      return {
        inverse: { op: 'fork', id: sc.id, name: sc.name, parent: sc.parentId, overrides: [...sc.overrides].map(([target, v]) => ({ target, ...v })), note: sc.note },
        changed: [], structural: false, scenario: true, summary: `delete scenario "${sc.name}"`,
      };
    }
    case 'rename': {
      const s = /** @type {any} */ (graph.scope(d.target));
      const old = s.name;
      s.name = String(d.name).trim();
      return { inverse: { op: 'rename', target: s.id, name: old }, changed: [], structural: true, scenario: false, summary: `rename ${old} → ${s.name}` };
    }
    default: throw new Error(`applyOne: unsupported op ${d.op}`);
  }
}

/** @param {any} graph @param {string} parent @param {string} name */
function uniqueScopeId(graph, parent, name) {
  let id = stableId('sc', `${parent}/${name}`);
  let i = 1;
  while (graph.scope(id)) id = stableId('sc', `${parent}/${name}/${i++}`);
  return id;
}

/**
 * Create a scope from a prototype: inherited metrics (base first, derived override), defaults,
 * constraints, plus explicit metric overrides.
 * @param {import('./graph.js').ScopeGraph} graph
 * @param {{id: string, parent: string, proto: string, name: string, key?: string, metrics?: Record<string, any>, relations?: any[], lod?: string, kind?: string}} spec
 */
export function instantiate(graph, spec) {
  const chain = [];
  let p = spec.proto;
  let guard = 0;
  while (p && guard++ < 16) {
    chain.unshift(graph.prototypes[p]);
    p = graph.prototypes[p]?.parent || null;
  }
  /** @type {Record<string, any>} */
  const metrics = {};
  const constraints = [];
  for (const proto of chain) {
    if (!proto) continue;
    for (const [name, m] of Object.entries(proto.metrics || {})) metrics[name] = { ...metrics[name], ...structuredClone(m) };
    for (const c of proto.constraints || []) constraints.push(structuredClone(c));
  }
  for (const [name, m] of Object.entries(spec.metrics || {})) metrics[name] = { ...(metrics[name] || {}), ...structuredClone(m) };
  const last = chain[chain.length - 1] || {};
  graph.addScope({
    id: spec.id,
    key: spec.key || slug(spec.name),
    name: spec.name,
    proto: spec.proto,
    parent: spec.parent,
    children: [],
    metrics: [],
    relations: structuredClone(spec.relations || []),
    constraints,
    lod: /** @type {any} */ (spec.lod || last.lod),
    kind: spec.kind || last.kind,
  });
  for (const [name, m] of Object.entries(metrics)) {
    const node = {
      id: `${spec.id}.${name}`,
      scope: spec.id,
      name,
      kind: m.kind || (m.expr !== undefined ? 'computed' : m.dist ? 'estimated' : 'input'),
      type: { dtype: 'f64', unit: m.unit || '' },
      deps: [],
    };
    for (const k of ['value', 'dist', 'expr', 'range', 'prov', 'label', 'corr', 'headline', 'description']) if (m[k] !== undefined) node[k] = structuredClone(m[k]);
    if (node.dist && node.value === undefined) node.value = nominal(node.dist);
    graph.addNode(/** @type {any} */ (node));
  }
}
