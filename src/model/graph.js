/**
 * ScopeGraph: scopes (typed nodes with prototypes, children, metrics, relations, constraints)
 * and metric nodes (Scope IR), plus the index the engine runs on: resolved references,
 * forward/reverse dependency lists, topological order, shapes, paths and a content hash.
 *
 * Reference resolution for "@ref" in a formula of scope S:
 *   @name            metric of S, else of the nearest ancestor that has it (lexical scoping)
 *   @child.name      child scope key of S or of an ancestor, then descend (any depth)
 *   @sc_<id>.name    absolute scope id
 *   @/Path.to.name   absolute path from the root
 * Aggregates over children: ["agg", "sum"|"mean"|"max"|"min"|"count", scopeRef|".", proto|"*", metric]
 * No DOM; runnable in a worker.
 * @module model/graph
 */
import { hash64, slug, stableStringify } from '../core/ids.js';
import { parseUnit } from './units.js';
import { isRefString, mapRefs, resolvedDeps, validateExpr } from './expr.js';

/** @typedef {import('./types.js').Scope} Scope */
/** @typedef {import('./types.js').IRNode} IRNode */

export class GraphError extends Error {
  /** @param {string} code @param {string} message @param {string} [hint] @param {any} [data] */
  constructor(code, message, hint, data) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.data = data;
  }
}

export class ScopeGraph {
  /**
   * @param {{prototypes?: Record<string, any>, graphId?: string, seed?: number, version?: number}} [opts]
   */
  constructor(opts = {}) {
    this.prototypes = opts.prototypes || {};
    this.graphId = opts.graphId || 'g_demo';
    this.seed = opts.seed ?? 1234;
    this.version = opts.version ?? 1;
    /** @type {Map<string, Scope>} */
    this.scopes = new Map();
    /** @type {Map<string, IRNode>} */
    this.nodes = new Map();
    /** @type {string|null} */
    this.rootId = null;

    // ---- index (rebuilt by reindex) ----
    /** @type {IRNode[]} */
    this.list = [];
    /** @type {Map<string, number>} */
    this.index = new Map();
    /** @type {Int32Array[]} */
    this.depIdx = [];
    /** @type {number[][]} */
    this.rev = [];
    this.topo = new Int32Array(0);
    this.rank = new Int32Array(0);
    /** @type {Map<string, any>} resolved expressions by node id */
    this.resolved = new Map();
    /** @type {Map<string, {scope: string, label: string, expr: any, severity: string, deps: string[]}>} */
    this.constraints = new Map();
    /** @type {Array<{code: string, message: string, hint?: string, nodeId?: string}>} */
    this.errors = [];
    /** @type {Map<string, string>} */
    this.paths = new Map();
    /** @type {Map<string, {id: string, proto: string, name: string, version: number, metricNames: string[], scopeIds: string[]}>} */
    this.shapes = new Map();
    /** @type {Map<string, string>} scope id -> shape id */
    this.shapeOfScope = new Map();
    this.structureVersion = 0;
    /** @type {Map<string, Set<string>>} deps that come from aggregates over children (never dangling) */
    this.aggDeps = new Map();
    /** @type {Map<string, string>} */
    this.nodeHash = new Map();
    this._hashA = 0;
    this._hashB = 0;
  }

  // ------------------------------------------------------------------ construction

  /**
   * @param {{graphId?: string, seed?: number, version?: number, rootId: string, scopes: Scope[], nodes: IRNode[]}} ir
   * @param {{prototypes?: Record<string, any>}} [opts]
   */
  static fromIR(ir, opts = {}) {
    const g = new ScopeGraph({ prototypes: opts.prototypes, graphId: ir.graphId, seed: ir.seed, version: ir.version });
    for (const s of ir.scopes) g.scopes.set(s.id, normalizeScope(s));
    for (const n of ir.nodes) g.nodes.set(n.id, structuredClone(n));
    g.rootId = ir.rootId;
    g.reindex();
    return g;
  }

  toIR() {
    return {
      graphId: this.graphId,
      seed: this.seed,
      version: this.version,
      rootId: this.rootId,
      scopes: [...this.scopes.values()].map((s) => structuredClone(s)),
      nodes: [...this.nodes.values()].map((n) => structuredClone(n)),
    };
  }

  get versionLabel() { return `v${this.version}`; }

  /** Full content hash (16 hex). */
  get hash() {
    return (this._hashA >>> 0).toString(16).padStart(8, '0') + (this._hashB >>> 0).toString(16).padStart(8, '0');
  }

  /** "b3:9c0e" */
  get shortHash() { return `b3:${this.hash.slice(0, 4)}`; }

  // ------------------------------------------------------------------ mutation primitives (used by delta.js)

  /** @param {Scope} scope */
  addScope(scope) {
    const s = normalizeScope(scope);
    if (this.scopes.has(s.id)) throw new GraphError('duplicate_scope', `scope ${s.id} already exists`);
    this.scopes.set(s.id, s);
    if (s.parent) {
      const p = this.scopes.get(s.parent);
      if (!p) throw new GraphError('parent_missing', `parent scope ${s.parent} not found`);
      if (!p.children.includes(s.id)) p.children.push(s.id);
    } else if (!this.rootId) this.rootId = s.id;
    return s;
  }

  /** @param {IRNode} node */
  addNode(node) {
    if (this.nodes.has(node.id)) throw new GraphError('duplicate_node', `metric ${node.id} already exists`);
    const s = this.scopes.get(node.scope);
    if (!s) throw new GraphError('parent_missing', `scope ${node.scope} not found for ${node.id}`);
    this.nodes.set(node.id, node);
    if (!s.metrics.includes(node.id)) s.metrics.push(node.id);
    return node;
  }

  /** Remove a metric node (no dangling check; delta.js checks first). @param {string} id */
  removeNode(id) {
    const n = this.nodes.get(id);
    if (!n) return null;
    this.nodes.delete(id);
    const s = this.scopes.get(n.scope);
    if (s) s.metrics = s.metrics.filter((m) => m !== id);
    return n;
  }

  /**
   * Remove a scope subtree and return a snapshot for restore.
   * @param {string} scopeId
   */
  removeScope(scopeId) {
    const ids = this.descendants(scopeId, true);
    const snapshot = { scopes: [], nodes: [], parent: this.scopes.get(scopeId)?.parent ?? null, index: -1 };
    const parent = snapshot.parent ? this.scopes.get(snapshot.parent) : null;
    if (parent) {
      snapshot.index = parent.children.indexOf(scopeId);
      parent.children = parent.children.filter((c) => c !== scopeId);
    }
    for (const sid of ids) {
      const s = this.scopes.get(sid);
      if (!s) continue;
      snapshot.scopes.push(structuredClone(s));
      for (const m of s.metrics) {
        const n = this.nodes.get(m);
        if (n) snapshot.nodes.push(structuredClone(n));
        this.nodes.delete(m);
      }
      this.scopes.delete(sid);
    }
    // drop relations pointing into the removed subtree
    const removed = new Set(ids);
    for (const s of this.scopes.values()) {
      if (s.relations.some((r) => removed.has(r.target))) {
        snapshot.relationsFrom = snapshot.relationsFrom || [];
        snapshot.relationsFrom.push({ scope: s.id, relations: structuredClone(s.relations) });
        s.relations = s.relations.filter((r) => !removed.has(r.target));
      }
    }
    return snapshot;
  }

  /** Restore a snapshot from removeScope(). @param {any} snapshot */
  restoreScope(snapshot) {
    for (const s of snapshot.scopes) this.scopes.set(s.id, structuredClone(s));
    for (const n of snapshot.nodes) this.nodes.set(n.id, structuredClone(n));
    const rootScope = snapshot.scopes[0];
    if (snapshot.parent) {
      const p = this.scopes.get(snapshot.parent);
      if (p && !p.children.includes(rootScope.id)) {
        if (snapshot.index >= 0 && snapshot.index <= p.children.length) p.children.splice(snapshot.index, 0, rootScope.id);
        else p.children.push(rootScope.id);
      }
    }
    for (const rf of snapshot.relationsFrom || []) {
      const s = this.scopes.get(rf.scope);
      if (s) s.relations = structuredClone(rf.relations);
    }
  }

  // ------------------------------------------------------------------ index

  /**
   * Resolve references, build dependency indexes, topological order, shapes, paths and hashes.
   * Records (does not throw) resolution and cycle errors in this.errors.
   */
  reindex() {
    this.errors = [];
    this.aggDeps.clear();
    this._buildPaths();
    // resolve formulas
    this.resolved.clear();
    for (const n of this.nodes.values()) {
      if (n.kind !== 'computed' || n.expr === undefined) {
        n.deps = [];
        continue;
      }
      const err = validateExpr(n.expr);
      if (err) {
        this.errors.push({ code: 'type_error', message: `${this.path(n.id)}: ${err}`, nodeId: n.id });
        n.deps = [];
        this.resolved.set(n.id, NaN);
        continue;
      }
      const r = this.resolveExpr(n.expr, n.scope, n.id);
      this.resolved.set(n.id, r);
      n.deps = [...resolvedDeps(r)];
    }
    // constraints
    this.constraints.clear();
    for (const s of this.scopes.values()) {
      for (const c of s.constraints) {
        const id = `${s.id}#${c.id}`;
        const r = this.resolveExpr(c.expr, s.id, id);
        this.constraints.set(id, { scope: s.id, label: c.label || c.id, expr: r, severity: c.severity || 'hard', deps: [...resolvedDeps(r)] });
      }
    }
    // dense index
    this.list = [...this.nodes.values()];
    this.index = new Map(this.list.map((n, i) => [n.id, i]));
    const N = this.list.length;
    this.depIdx = new Array(N);
    this.rev = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++) {
      const deps = this.list[i].deps || [];
      const arr = new Int32Array(deps.length);
      deps.forEach((d, k) => {
        const j = this.index.get(d);
        arr[k] = j ?? -1;
        if (j !== undefined) this.rev[j].push(i);
      });
      this.depIdx[i] = arr;
    }
    this._topo();
    this._shapes();
    this._rehashAll();
    this.structureVersion++;
  }

  _buildPaths() {
    this.paths.clear();
    const walk = (sid, prefix) => {
      const s = this.scopes.get(sid);
      if (!s) return;
      const p = prefix ? `${prefix}.${s.name}` : s.name;
      this.paths.set(sid, p);
      for (const m of s.metrics) {
        const n = this.nodes.get(m);
        if (n) this.paths.set(m, `${p}.${n.name}`);
      }
      for (const c of s.children) walk(c, p);
    };
    if (this.rootId) walk(this.rootId, '');
  }

  _topo() {
    const N = this.list.length;
    const indeg = new Int32Array(N);
    for (let i = 0; i < N; i++) for (const d of this.depIdx[i]) if (d >= 0) indeg[i]++;
    const order = new Int32Array(N);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < N; i++) if (indeg[i] === 0) order[tail++] = i;
    while (head < tail) {
      const i = order[head++];
      for (const j of this.rev[i]) if (--indeg[j] === 0) order[tail++] = j;
    }
    if (tail < N) {
      const stuck = [];
      for (let i = 0; i < N; i++) if (indeg[i] > 0) stuck.push(i);
      const cyc = this.findCycle(stuck.map((i) => this.list[i].id));
      this.errors.push({
        code: 'cycle',
        message: `cycle: ${cyc.map((id) => this.nodes.get(id)?.name || id).join(' -> ')}`,
        hint: 'declare a fixed-point block or remove one edge',
        nodeId: cyc[0],
      });
      for (const i of stuck) order[tail++] = i; // keep a total order; cyclic nodes evaluate to NaN
    }
    this.topo = order;
    this.rank = new Int32Array(N);
    for (let k = 0; k < N; k++) this.rank[order[k]] = k;
  }

  /** Find one cycle among candidate ids (DFS). @param {string[]} ids */
  findCycle(ids) {
    const set = new Set(ids);
    const color = new Map();
    const stack = [];
    let found = null;
    const dfs = (id) => {
      if (found) return;
      color.set(id, 1);
      stack.push(id);
      for (const d of this.nodes.get(id)?.deps || []) {
        if (!set.has(d)) continue;
        if (color.get(d) === 1) {
          found = [...stack.slice(stack.indexOf(d)), d];
          return;
        }
        if (!color.get(d)) dfs(d);
        if (found) return;
      }
      stack.pop();
      color.set(id, 2);
    };
    for (const id of ids) if (!color.get(id) && !found) dfs(id);
    return found || ids.slice(0, 3);
  }

  _shapes() {
    this.shapes.clear();
    this.shapeOfScope.clear();
    /** @type {Map<string, Map<string, string>>} proto -> signature -> shapeId */
    const byProto = new Map();
    for (const s of this.scopes.values()) {
      const protoName = this.protoName(s.proto);
      const names = s.metrics.map((m) => this.nodes.get(m)?.name).filter(Boolean).sort();
      const sig = names.join(',');
      let sigs = byProto.get(s.proto);
      if (!sigs) byProto.set(s.proto, (sigs = new Map()));
      let shapeId = sigs.get(sig);
      if (!shapeId) {
        const base = this.prototypes[s.proto]?.shapeVersion ?? 1;
        const version = base + sigs.size;
        shapeId = `${protoName}/v${version}`;
        sigs.set(sig, shapeId);
        this.shapes.set(shapeId, { id: shapeId, proto: s.proto, name: protoName, version, metricNames: /** @type {string[]} */ (names), scopeIds: [] });
      }
      this.shapes.get(shapeId)?.scopeIds.push(s.id);
      this.shapeOfScope.set(s.id, shapeId);
    }
  }

  _rehashAll() {
    this.nodeHash.clear();
    this._hashA = 0;
    this._hashB = 0;
    for (const n of this.nodes.values()) this._mixNode(n.id, true);
    for (const s of this.scopes.values()) {
      const h = hash64(stableStringify({ id: s.id, p: s.parent, proto: s.proto, rel: s.relations, c: s.constraints }));
      this._hashA ^= parseInt(h.slice(0, 8), 16);
      this._hashB ^= parseInt(h.slice(8), 16);
    }
  }

  /** Update the incremental hash after a node's content changed. @param {string} id */
  rehashNode(id) {
    this._mixNode(id, false);
  }

  /** @param {string} id @param {boolean} fresh */
  _mixNode(id, fresh) {
    if (!fresh) {
      const old = this.nodeHash.get(id);
      if (old) {
        this._hashA ^= parseInt(old.slice(0, 8), 16);
        this._hashB ^= parseInt(old.slice(8), 16);
      }
    }
    const n = this.nodes.get(id);
    if (!n) { this.nodeHash.delete(id); return; }
    const h = hash64(stableStringify({ id: n.id, k: n.kind, u: n.type?.unit, v: n.value, d: n.dist, e: n.expr }));
    n.hash = `b3:${h.slice(0, 4)}…`;
    this.nodeHash.set(id, h);
    this._hashA ^= parseInt(h.slice(0, 8), 16);
    this._hashB ^= parseInt(h.slice(8), 16);
  }

  // ------------------------------------------------------------------ reference resolution

  /**
   * Resolve an expression's references to node ids ({ref: id}); aggregates expand to children.
   * Unresolvable references become NaN constants and are recorded in this.errors.
   * @param {any} expr @param {string} scopeId @param {string} ownerId
   */
  resolveExpr(expr, scopeId, ownerId) {
    return mapRefs(expr, (ref) => {
      if (Array.isArray(ref) && ref[0] === 'agg') return this._resolveAgg(ref, scopeId, ownerId);
      const r = this.resolveRef(scopeId, /** @type {string} */ (ref));
      if ('error' in r) {
        this.errors.push({ code: 'unresolved', message: `${this.path(ownerId) || ownerId}: ${r.error}`, hint: r.hint, nodeId: ownerId });
        return NaN;
      }
      return { ref: r.id };
    });
  }

  /** @param {any[]} agg @param {string} scopeId @param {string} ownerId */
  _resolveAgg(agg, scopeId, ownerId) {
    const [, fn, scopeRef, protoFilter, metric] = agg;
    let target = scopeId;
    if (scopeRef && scopeRef !== '.') {
      const t = this._resolveScopePath(scopeId, String(scopeRef).split('.'));
      if (!t) {
        this.errors.push({ code: 'unresolved', message: `${this.path(ownerId)}: no child scope "${scopeRef}" for ${fn}()`, nodeId: ownerId });
        return NaN;
      }
      target = t;
    }
    const s = this.scopes.get(target);
    const refs = [];
    for (const c of s?.children || []) {
      const cs = this.scopes.get(c);
      if (!cs) continue;
      if (protoFilter !== '*' && !this.protoChainNames(cs.id).includes(protoFilter)) continue;
      const m = cs.metrics.find((id) => this.nodes.get(id)?.name === metric);
      if (m) refs.push({ ref: m });
    }
    let set = this.aggDeps.get(ownerId);
    if (!set) this.aggDeps.set(ownerId, (set = new Set()));
    for (const r of refs) set.add(r.ref);
    if (fn === 'count') return refs.length;
    if (!refs.length) return fn === 'sum' ? 0 : NaN;
    if (fn === 'sum' && refs.length === 1) return refs[0];
    return [fn, ...refs];
  }

  /**
   * @param {string} scopeId @param {string} ref '@name' | '@child.name' | '@sc_id.name' | '@/Path.name'
   * @returns {{id: string} | {error: string, hint?: string}}
   */
  resolveRef(scopeId, ref) {
    const raw = isRefString(ref) ? ref.slice(1) : ref;
    const parts = raw.split('.');
    const metric = parts.pop();
    if (!metric) return { error: `empty reference "${ref}"` };
    if (parts.length === 0) {
      // lexical: own scope, then ancestors
      let cur = this.scopes.get(scopeId);
      while (cur) {
        const hit = this._metricIn(cur.id, metric);
        if (hit) return { id: hit };
        cur = cur.parent ? this.scopes.get(cur.parent) : undefined;
      }
      return { error: `unknown name "${metric}"`, hint: this._suggest(metric) };
    }
    let start = null;
    if (parts[0].startsWith('/')) {
      parts[0] = parts[0].slice(1);
      const root = this.scopes.get(/** @type {string} */ (this.rootId));
      if (root && sameKey(parts[0], root)) { start = root.id; parts.shift(); }
      else start = this.rootId;
      const sid = this._walk(/** @type {string} */ (start), parts);
      if (!sid) return { error: `no scope at /${parts.join('.')}` };
      const hit = this._metricIn(sid, metric);
      return hit ? { id: hit } : { error: `no metric "${metric}" in ${this.path(sid)}` };
    }
    if (parts[0].startsWith('sc_') && this.scopes.has(parts[0])) {
      const sid = this._walk(parts[0], parts.slice(1));
      const hit = sid ? this._metricIn(sid, metric) : null;
      return hit ? { id: hit } : { error: `no metric "${metric}" in ${parts.join('.')}` };
    }
    const sid = this._resolveScopePath(scopeId, parts);
    if (!sid) return { error: `unknown scope "${parts.join('.')}"`, hint: 'reference a child scope by its key, e.g. @expansion.payment' };
    const hit = this._metricIn(sid, metric);
    return hit ? { id: hit } : { error: `no metric "${metric}" in ${this.path(sid)}`, hint: this._suggest(metric, sid) };
  }

  /** Resolve child-key path from a scope, walking up the ancestors for the first segment. */
  _resolveScopePath(scopeId, parts) {
    let cur = this.scopes.get(scopeId);
    while (cur) {
      // the scope itself may be named by the first part (e.g. "bakery.price" inside Bakery)
      if (sameKey(parts[0], cur)) {
        const sid = this._walk(cur.id, parts.slice(1));
        if (sid) return sid;
      }
      const sid = this._walk(cur.id, parts);
      if (sid) return sid;
      cur = cur.parent ? this.scopes.get(cur.parent) : undefined;
    }
    return null;
  }

  /** @param {string} fromId @param {string[]} parts */
  _walk(fromId, parts) {
    let cur = fromId;
    for (const p of parts) {
      const s = this.scopes.get(cur);
      const next = s?.children.find((c) => {
        const cs = this.scopes.get(c);
        return cs && sameKey(p, cs);
      });
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /** @param {string} scopeId @param {string} name */
  _metricIn(scopeId, name) {
    const s = this.scopes.get(scopeId);
    if (!s) return null;
    return s.metrics.find((m) => this.nodes.get(m)?.name === name) || null;
  }

  /** Did-you-mean suggestion. @param {string} name @param {string} [scopeId] */
  _suggest(name, scopeId) {
    const pool = scopeId ? (this.scopes.get(scopeId)?.metrics || []).map((m) => this.nodes.get(m)?.name || '') : [...this.nodes.values()].map((n) => n.name);
    let best = null;
    let bestD = Infinity;
    for (const cand of new Set(pool)) {
      const d = editDistance(name, cand);
      if (d < bestD) { bestD = d; best = cand; }
    }
    return best && bestD <= Math.max(2, name.length / 3) ? `did you mean "${best}"?` : undefined;
  }

  // ------------------------------------------------------------------ queries

  /** @param {string} id */
  node(id) { return this.nodes.get(id) || null; }
  /** @param {string} id */
  scope(id) { return this.scopes.get(id) || null; }
  /** @param {string} id */
  isScope(id) { return this.scopes.has(id); }
  /** @param {string} nodeId */
  scopeOf(nodeId) {
    const n = this.nodes.get(nodeId);
    return n ? this.scopes.get(n.scope) || null : this.scopes.get(nodeId) || null;
  }
  /** Scope id for any id (node -> its scope). @param {string} id */
  scopeIdOf(id) {
    if (this.scopes.has(id)) return id;
    return this.nodes.get(id)?.scope || null;
  }
  /** 'Bakery.LocationB.rent' @param {string} id */
  path(id) { return this.paths.get(id) || id; }
  /** Path without the root segment ('LocationB.rent'), or the root name. @param {string} id */
  label(id) {
    const p = this.path(id);
    const i = p.indexOf('.');
    return i > 0 && p.split('.').length > 2 ? p : p;
  }
  /** @param {string} id */
  unitOf(id) { return parseUnit(this.nodes.get(id)?.type?.unit || ''); }

  /** @param {string} protoId e.g. 'std.org.Location@1' -> 'Location' */
  protoName(protoId) {
    return this.prototypes[protoId]?.name || String(protoId).replace(/^.*\./, '').replace(/@.*$/, '');
  }

  /** Prototype chain names: ['Location', 'Business', 'Entity']. @param {string} scopeId */
  protoChainNames(scopeId) {
    const s = this.scopes.get(scopeId);
    if (!s) return [];
    const out = [];
    let p = s.proto;
    let guard = 0;
    while (p && guard++ < 16) {
      out.push(this.protoName(p));
      p = this.prototypes[p]?.parent || null;
    }
    return out;
  }

  /** @param {string} scopeId */
  protoChainIds(scopeId) {
    const s = this.scopes.get(scopeId);
    const out = [];
    let p = s?.proto;
    let guard = 0;
    while (p && guard++ < 16) {
      out.push(p);
      p = this.prototypes[p]?.parent || null;
    }
    return out;
  }

  /** @param {string} scopeId @param {boolean} [includeSelf] */
  descendants(scopeId, includeSelf = false) {
    const out = includeSelf ? [scopeId] : [];
    const stack = [...(this.scopes.get(scopeId)?.children || [])];
    while (stack.length) {
      const id = /** @type {string} */ (stack.pop());
      out.push(id);
      stack.push(...(this.scopes.get(id)?.children || []));
    }
    return out;
  }

  /** @param {string} scopeId */
  ancestors(scopeId) {
    const out = [];
    let cur = this.scopes.get(scopeId)?.parent;
    while (cur) {
      out.push(cur);
      cur = this.scopes.get(cur)?.parent;
    }
    return out;
  }

  /** All metric ids in a subtree. @param {string} scopeId */
  subtreeNodes(scopeId) {
    const out = [];
    for (const sid of this.descendants(scopeId, true)) out.push(...(this.scopes.get(sid)?.metrics || []));
    return out;
  }

  /** Direct dependents. @param {string} id */
  dependents(id) {
    const i = this.index.get(id);
    return i === undefined ? [] : this.rev[i].map((j) => this.list[j].id);
  }

  /** Transitive upstream (all ancestors in the dependency DAG). @param {string} id */
  upstream(id) {
    const out = new Set();
    const stack = [...(this.nodes.get(id)?.deps || [])];
    while (stack.length) {
      const d = /** @type {string} */ (stack.pop());
      if (out.has(d)) continue;
      out.add(d);
      stack.push(...(this.nodes.get(d)?.deps || []));
    }
    return out;
  }

  /** Transitive downstream cone (excluding the node). @param {string} id */
  downstream(id) {
    const out = new Set();
    const i0 = this.index.get(id);
    if (i0 === undefined) return out;
    const stack = [...this.rev[i0]];
    while (stack.length) {
      const j = /** @type {number} */ (stack.pop());
      const nid = this.list[j].id;
      if (out.has(nid)) continue;
      out.add(nid);
      stack.push(...this.rev[j]);
    }
    return out;
  }

  /** Leaf assumptions upstream of a node (input/observed/estimated). @param {string} id */
  inputsOf(id) {
    return [...this.upstream(id)].filter((d) => this.nodes.get(d)?.kind !== 'computed');
  }

  /** Editable kinds. @param {string} id */
  isEditable(id) {
    const k = this.nodes.get(id)?.kind;
    return k === 'input' || k === 'observed' || k === 'estimated';
  }

  /** Provenance class to display (computed nodes with proven claims show 'proven'). @param {string} id */
  displayProv(id) {
    const n = this.nodes.get(id);
    if (!n) return 'computed';
    if (n.kind === 'computed' && n.proven && n.proven.length) return 'proven';
    if (n.dist && n.dist.family === 'Mixture' && n.dist.contested) return 'contested';
    return n.kind;
  }

  /** @param {string} scopeId */
  shapeOf(scopeId) {
    const id = this.shapeOfScope.get(scopeId);
    return id ? this.shapes.get(id) || null : null;
  }

  /**
   * Resolve a binding path: 'bakery.monthly_cash.p50' -> { nodeId, stat }.
   * @param {string} path
   * @returns {{nodeId: string, stat: string}|null}
   */
  resolveBindingPath(path) {
    const STATS = new Set(['p10', 'p50', 'p90', 'mean', 'sd', 'min', 'max', 'value', 'median', 'p05', 'p95']);
    const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
    let stat = 'value';
    if (parts.length > 1 && STATS.has(parts[parts.length - 1])) stat = /** @type {string} */ (parts.pop());
    if (stat === 'median') stat = 'p50';
    if (parts[0]?.startsWith('sc_') && this.nodes.has(parts.join('.'))) return { nodeId: parts.join('.'), stat };
    const metric = parts.pop();
    if (!metric) return null;
    const root = this.rootId ? this.scopes.get(this.rootId) : null;
    let sid = null;
    if (root && parts.length && sameKey(parts[0], root)) sid = this._walk(root.id, parts.slice(1));
    if (!sid && parts.length) {
      // first segment anywhere (BFS)
      const queue = this.rootId ? [this.rootId] : [];
      while (queue.length && !sid) {
        const id = /** @type {string} */ (queue.shift());
        const s = this.scopes.get(id);
        if (s && sameKey(parts[0], s)) sid = this._walk(id, parts.slice(1));
        if (s) queue.push(...s.children);
      }
    }
    if (!parts.length) sid = this.rootId;
    if (!sid) return null;
    const hit = this._metricIn(sid, metric);
    return hit ? { nodeId: hit, stat } : null;
  }

  /**
   * One-line summary of a collapsed subtree:
   * "[Staff: 6 scopes, shape Person/v3, payroll 21.4k USD/month]"
   * @param {string} scopeId
   * @param {(id: string) => number} [valueOf]
   */
  summary(scopeId, valueOf) {
    const s = this.scopes.get(scopeId);
    if (!s) return '';
    const kids = s.children.map((c) => this.scopes.get(c)).filter(Boolean);
    const shapes = new Set(kids.map((k) => this.shapeOfScope.get(/** @type {Scope} */ (k).id)));
    const parts = [kids.length ? `${s.name}: ${kids.length} scope${kids.length === 1 ? '' : 's'}` : `${s.name}: ${s.metrics.length} metric${s.metrics.length === 1 ? '' : 's'}`];
    if (shapes.size === 1 && kids.length) parts.push(`shape ${[...shapes][0]}`);
    const headline = s.metrics.map((m) => this.nodes.get(m)).find((n) => n && n.headline);
    if (headline && valueOf) {
      const v = valueOf(headline.id);
      const unit = headline.type.unit && headline.type.unit !== '1' ? ` ${headline.type.unit}` : '';
      parts.push(`${headline.name} ${compact(v)}${unit}`);
    }
    return `[${parts.join(', ')}]`;
  }

  /**
   * Fuzzy search over scopes and metrics by name, path, prototype, unit or provenance.
   * @param {string} query
   * @param {{limit?: number, kinds?: string[], scopesOnly?: boolean, metricsOnly?: boolean}} [opts]
   * @returns {Array<{id: string, isScope: boolean, name: string, path: string, score: number}>}
   */
  search(query, opts = {}) {
    const q = query.trim().toLowerCase();
    const limit = opts.limit ?? 20;
    const out = [];
    const consider = (id, isScope, name, extra) => {
      const path = this.path(id).toLowerCase();
      const nm = name.toLowerCase();
      let score = 0;
      if (!q) score = 1;
      else if (nm === q) score = 1000;
      else if (nm.startsWith(q)) score = 700;
      else if (nm.includes(q)) score = 450;
      else if (path.includes(q)) score = 250;
      else if (extra.some((x) => x && x.toLowerCase().includes(q))) score = 150;
      else if (subseq(q, nm)) score = 80;
      else if (subseq(q.replace(/\s+/g, ''), path)) score = 40;
      if (!score) return;
      score -= path.length * 0.4;
      out.push({ id, isScope, name, path: this.path(id), score });
    };
    if (!opts.metricsOnly) {
      for (const s of this.scopes.values()) consider(s.id, true, s.name, [this.protoName(s.proto), s.key, this.shapeOfScope.get(s.id) || '']);
    }
    if (!opts.scopesOnly) {
      for (const n of this.nodes.values()) {
        if (opts.kinds && !opts.kinds.includes(n.kind)) continue;
        consider(n.id, false, n.name, [n.type?.unit, n.kind, n.label]);
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
}

// ---------------------------------------------------------------- helpers

/** @param {any} s @returns {Scope} */
function normalizeScope(s) {
  const c = structuredClone(s);
  c.key = c.key || slug(c.name);
  c.children = c.children || [];
  c.metrics = c.metrics || [];
  c.relations = c.relations || [];
  c.constraints = c.constraints || [];
  return c;
}

/** Case- and punctuation-insensitive key match against a scope's key or name. */
function sameKey(part, scope) {
  const p = slug(part);
  return p === slug(scope.key) || p === slug(scope.name);
}

/** @param {string} q @param {string} t */
function subseq(q, t) {
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length && q.length > 0;
}

/** @param {string} a @param {string} b */
export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** @param {number} v */
function compact(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v * 100) / 100);
}
