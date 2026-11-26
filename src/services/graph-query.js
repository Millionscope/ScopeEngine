/**
 * Search over scopes and metrics for @mentions, quick open and the palette, enriched with
 * provenance, unit, prototype and the current value. No DOM.
 * @module services/graph-query
 */
import { unitValue } from '../model/format.js';

export class GraphQuery {
  /** @param {() => import('../model/engine.js').JsEngine} getEngine */
  constructor(getEngine) {
    this.getEngine = getEngine;
  }

  /**
   * @param {string} q @param {{limit?: number, editableOnly?: boolean}} [opts]
   */
  search(q, opts = {}) {
    const engine = this.getEngine();
    const g = engine?.graph;
    if (!g) return [];
    const raw = g.search(q.replace(/^@/, ''), { limit: (opts.limit || 20) * 2, kinds: opts.editableOnly ? ['input', 'observed', 'estimated'] : undefined, metricsOnly: !!opts.editableOnly });
    return raw.slice(0, opts.limit || 20).map((r) => {
      if (r.isScope) {
        const s = g.scope(r.id);
        return {
          ...r,
          prov: null,
          unit: '',
          proto: s ? g.protoChainNames(s.id).join(' → ') : '',
          kindLabel: 'scope',
          valueText: s ? `${s.metrics.length} metrics` : '',
        };
      }
      const n = /** @type {any} */ (g.node(r.id));
      const st = engine.stats(r.id);
      const v = st && !st.deterministic ? st.p50 : engine.value(r.id);
      return {
        ...r,
        prov: g.displayProv(r.id),
        unit: n.type.unit,
        proto: g.protoName(g.scope(n.scope)?.proto || ''),
        kindLabel: g.displayProv(r.id),
        valueText: Number.isFinite(v) ? unitValue(v, n.type.unit, { compact: true }) : '',
      };
    });
  }
}
