/**
 * Evidence: sources, extracted values with spans, match status, contested groups, and a mock
 * "attach evidence" that adds a document with a fake extraction. No DOM.
 * @module services/evidence-service
 */
import { uid } from '../core/ids.js';
import { SOURCES, EXTRACTIONS } from '../mock/evidence.js';

const ATTACHABLE = [
  { name: 'insurance_quote_2027.pdf', type: 'PDF', title: 'Business insurance renewal quote', span: 'Annual premium, general liability and property: $4,620.00 (payable monthly at $385.00)', match: '$385.00', value: 385, unit: 'USD/month', suggest: 'sc_bakery.insurance' },
  { name: 'marketing_plan.docx', type: 'DOC', title: 'Local marketing plan', span: 'Planned spend for launch quarter: $650.00 per month across social and print.', match: '$650.00', value: 650, unit: 'USD/month', suggest: 'sc_bakery.marketing' },
  { name: 'wage_survey_2026.pdf', type: 'PDF', title: 'Regional bakery wage survey', span: 'Median hourly wage, head baker: $24.50', match: '$24.50', value: 24.5, unit: 'USD/hour', suggest: 'sc_staff_1.wage' },
];

export class EvidenceService {
  /** @param {{events: import('../core/events.js').EventBus}} deps */
  constructor({ events }) {
    this.events = events;
    this.sources = SOURCES.map((s) => ({ ...s }));
    this.extractions = EXTRACTIONS.map((e) => ({ ...e }));
    this._attachIdx = 0;
  }

  /**
   * Follow a newly loaded graph: stress graphs bring a synthetic ledger (one source, one series
   * extraction) for their observed metrics; any other graph drops it again.
   * @param {any} graph
   */
  useGraph(graph) {
    this.sources = this.sources.filter((s) => !s.synthetic);
    this.extractions = this.extractions.filter((e) => !e.synthetic);
    const syn = graph?.syntheticEvidence;
    if (syn) {
      this.sources.push({ ...syn.source });
      this.extractions.push({ ...syn.extraction });
    }
    this.events.emit('evidence:changed', { sources: this.sources, reason: 'graph' });
  }

  list() { return this.sources; }
  /** @param {string} id */
  source(id) { return this.sources.find((s) => s.id === id) || null; }
  /** @param {string} id */
  extraction(id) { return this.extractions.find((e) => e.id === id) || null; }
  /** @param {string} sourceId */
  forSource(sourceId) { return this.extractions.filter((e) => e.source === sourceId); }
  /** @param {string} nodeId */
  forNode(nodeId) { return this.extractions.filter((e) => e.binds.includes(nodeId)); }

  /** Contested groups (several extractions bound to the same metric that disagree). */
  groups() {
    /** @type {Map<string, any[]>} */
    const m = new Map();
    for (const e of this.extractions) {
      if (!e.group) continue;
      if (!m.has(e.group)) m.set(e.group, []);
      m.get(e.group).push(e);
    }
    return [...m.entries()].map(([id, items]) => ({ id, items }));
  }

  /**
   * Match status of an extraction against the current graph.
   * @param {any} ex @param {import('../model/graph.js').ScopeGraph} graph
   */
  status(ex, graph) {
    const src = this.source(ex.source);
    if (ex.status === 'stale' || src?.stale) return 'stale';
    if (ex.status === 'supports') return 'supports';
    if (ex.status === 'unbound') return 'unbound';
    if (ex.series) return 'matched';
    const nodes = ex.binds.map((id) => graph.node(id)).filter(Boolean);
    if (!nodes.length) return 'unbound';
    const n = nodes[0];
    if (n.kind !== 'observed') return 'overridden';
    const tol = ex.tolerance ?? Math.max(1e-9, Math.abs(ex.value) * 1e-6);
    return Math.abs((n.value ?? NaN) - ex.value) <= tol ? 'matched' : 'mismatch';
  }

  /** Records for the evidence verifier (certificate level 4). */
  forVerifier() {
    return this.extractions
      .filter((e) => (e.value != null || e.series) && e.status !== 'supports' && e.status !== 'unbound')
      .map((e) => ({
        id: e.id,
        value: e.value,
        valuesByNode: e.series ? Object.fromEntries(e.binds.map((id, i) => [id, e.series[i % e.series.length]])) : undefined,
        tolerance: e.tolerance,
        binds: e.binds,
        source: this.source(e.source)?.name || e.source,
        stale: e.status === 'stale',
      }));
  }

  /**
   * Record a researcher finding (mock retrieval) so the evidence verifier can check it.
   * @param {{name: string, title: string, span: string, match: string, value: number, unit: string, nodeId: string}} f
   * @returns {string} extraction id
   */
  addFinding(f) {
    const sid = uid('src');
    this.sources.push({ id: sid, name: f.name, type: 'Web', date: new Date().toISOString().slice(0, 10), pages: 1, title: f.title, found: true });
    const id = uid('ev');
    this.extractions.push({ id, source: sid, page: 1, span: f.span, match: f.match, value: f.value, unit: f.unit, binds: [f.nodeId] });
    this.events.emit('evidence:changed', { sources: this.sources, added: sid });
    return id;
  }

  /** Mock attach: adds a document with one extracted value (unbound). */
  attach() {
    const a = ATTACHABLE[this._attachIdx % ATTACHABLE.length];
    this._attachIdx++;
    const id = uid('src');
    const today = new Date().toISOString().slice(0, 10);
    this.sources.push({ id, name: a.name, type: a.type, date: today, pages: 1, title: a.title, attached: true });
    const ex = { id: uid('ev'), source: id, page: 1, span: a.span, match: a.match, value: a.value, unit: a.unit, binds: [], suggest: a.suggest, status: 'unbound' };
    this.extractions.push(ex);
    this.events.emit('evidence:changed', { sources: this.sources, added: id });
    return { source: this.sources[this.sources.length - 1], extraction: ex };
  }

  /**
   * Bind an extraction to a metric: returns the delta that makes the metric observed.
   * @param {string} extractionId @param {string} nodeId @param {string} version
   */
  bindDelta(extractionId, nodeId, version) {
    const ex = this.extraction(extractionId);
    if (!ex) return null;
    const src = this.source(ex.source);
    return { op: 'set', target: nodeId, value: ex.value, prov: 'observed', provDetail: { src: src?.name, page: ex.page, evidence: ex.id }, expect: version };
  }

  /** Mark an extraction bound after the delta landed. @param {string} extractionId @param {string} nodeId */
  markBound(extractionId, nodeId) {
    const ex = this.extraction(extractionId);
    if (!ex) return;
    ex.binds = [nodeId];
    ex.status = undefined;
    this.events.emit('evidence:changed', { sources: this.sources });
  }
}
