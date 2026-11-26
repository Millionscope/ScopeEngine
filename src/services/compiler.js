/**
 * Compiler adapter (mock of the ScopeLang compiler): source text for the live graph with a
 * line <-> id map, diagnostics (live errors plus rejected deltas on record), and pretty IR for
 * any node. No DOM.
 * @module services/compiler
 */
import { printScopeLang } from '../model/scopelang.js';
import { HEADER, DEMO_SNIPPET, BUILD_DIAGNOSTICS } from '../mock/scopelang-source.js';

export class CompilerService {
  /**
   * @param {{ getEngine: () => import('../model/engine.js').JsEngine, events: import('../core/events.js').EventBus }} deps
   */
  constructor({ getEngine, events }) {
    this.getEngine = getEngine;
    /** @type {Array<{nodeId: string, severity: 'error'|'warning'|'info', message: string}>} */
    this.rejected = [...BUILD_DIAGNOSTICS];
    this._cache = null;
    this._key = '';
    events.on('delta:rejected', (p) => {
      const d = p.deltas?.[0];
      const e = p.errors?.[0];
      if (!d || !e) return;
      const target = d.target || d.scope || d.parent;
      if (!target) return;
      this.rejected.unshift({ nodeId: target, severity: 'warning', message: `rejected (${p.author || 'user'}): ${e.message}${e.hint ? `; ${e.hint}` : ''}` });
      this.rejected = this.rejected.slice(0, 20);
    });
  }

  /** @returns {{text: string, lineOf: Map<string, number>, idAt: Map<number, string>}} */
  compiled() {
    const g = this.getEngine().graph;
    const key = `${g.versionLabel}:${g.structureVersion}:${g.hash}`;
    if (this._cache && this._key === key) return this._cache;
    this._cache = printScopeLang(g, { header: `${HEADER}\n// graph ${g.versionLabel} (${g.shortHash}…) · ${g.nodes.size} metrics · ${g.scopes.size} scopes` });
    this._key = key;
    return this._cache;
  }

  source() { return this.compiled().text; }
  demoSnippet() { return DEMO_SNIPPET; }

  /** @param {string} id */
  lineFor(id) {
    const c = this.compiled();
    return c.lineOf.get(id) ?? null;
  }

  /** @param {number} line */
  idAt(line) {
    return this.compiled().idAt.get(line) ?? null;
  }

  /** Diagnostics mapped to lines. */
  diagnostics() {
    const engine = this.getEngine();
    const c = this.compiled();
    const out = [];
    for (const e of [...engine.graph.errors, ...engine.errors]) {
      const line = e.nodeId ? c.lineOf.get(e.nodeId) : null;
      out.push({ line: line ?? 1, severity: 'error', message: `${e.message}${e.hint ? `; ${e.hint}` : ''}`, nodeId: e.nodeId });
    }
    for (const r of this.rejected) {
      const line = c.lineOf.get(r.nodeId);
      if (line) out.push({ line, severity: r.severity, message: r.message, nodeId: r.nodeId });
    }
    return out;
  }

  /** Pretty Scope IR for a node or scope id. @param {string} id */
  irFor(id) {
    const g = this.getEngine().graph;
    const n = g.node(id);
    if (n) {
      const ir = { id: n.id, scope: n.scope, kind: n.kind, type: n.type };
      if (n.expr !== undefined) ir.expr = n.expr;
      if (n.value !== undefined && n.kind !== 'computed') ir.value = n.value;
      if (n.dist) ir.dist = n.dist;
      ir.deps = n.deps;
      if (n.prov) ir.prov = n.prov;
      ir.hash = n.hash;
      return JSON.stringify(ir, null, 2);
    }
    const s = g.scope(id);
    if (!s) return '';
    return JSON.stringify({ id: s.id, key: s.key, name: s.name, proto: s.proto, parent: s.parent, children: s.children, metrics: s.metrics, relations: s.relations, constraints: s.constraints, shape: g.shapeOfScope.get(s.id) }, null, 2);
  }
}
