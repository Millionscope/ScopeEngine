/**
 * Verifier adapter (mock of GET /graphs/{id}/certificate and the verify(level, claim) tool):
 * builds the certificate from the live graph, re-checks claims, and replays a graph from its
 * hash + seed to show identical results. Recomputes lazily after recompute bursts. No DOM.
 * @module services/verify
 */
import { buildCertificate } from '../model/certificate.js';
import { ScopeGraph } from '../model/graph.js';
import { JsEngine } from '../model/engine.js';
import { CLAIMS, NOT_CHECKED, SKEPTIC_NOTES, ESTIMATORS } from '../mock/proofs.js';

export class VerifyService {
  /**
   * @param {{
   *   events: import('../core/events.js').EventBus,
   *   store: import('../core/store.js').Store,
   *   getEngine: () => import('../model/engine.js').JsEngine,
   *   evidence: import('./evidence-service.js').EvidenceService,
   * }} deps
   */
  constructor({ events, store, getEngine, evidence }) {
    this.events = events;
    this.store = store;
    this.getEngine = getEngine;
    this.evidence = evidence;
    this.claims = CLAIMS;
    this._cert = null;
    this._key = '';
    this._timer = 0;
    events.on('graph:recomputed', () => this.schedule());
    events.on('evidence:changed', () => this.schedule());
  }

  /** Debounced refresh after recompute bursts (slider drags). */
  schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), 220);
  }

  /** Current certificate (cached per engine computeVersion). */
  certificate() {
    const engine = this.getEngine();
    const key = `${engine.computeVersion}:${engine.graph.versionLabel}:${engine.n}`;
    if (this._cert && this._key === key) return this._cert;
    this._cert = buildCertificate({
      graph: engine.graph,
      engine,
      answerId: 'a_7f3',
      claims: this.claims,
      evidence: this.evidence.forVerifier(),
      estimators: ESTIMATORS,
      notChecked: NOT_CHECKED,
      skeptic: SKEPTIC_NOTES,
      output: 'sc_bakery.monthly_cash',
    });
    this._key = key;
    return this._cert;
  }

  refresh() {
    clearTimeout(this._timer);
    const cert = this.certificate();
    this.store.set('status.cert', { failed: cert.failed.length, notProven: cert.notProven.length });
    this.events.emit('certificate:updated', { certificate: cert });
    return cert;
  }

  /** @param {string} id */
  claim(id) {
    return this.claims.find((c) => c.id === id) || null;
  }

  /** Status of a claim in the current certificate. @param {string} id */
  claimStatus(id) {
    const cert = this.certificate();
    const p = cert.proven.find((c) => c.id === id);
    if (p) return { status: 'proven', detail: p.detail };
    const n = cert.notProven.find((c) => c.id === id);
    if (n) return { status: 'not_proven', detail: n.detail };
    return { status: 'not_proven', detail: 'not checked' };
  }

  /**
   * Replay: rebuild the graph from its IR (content), a fresh engine with the same seed and
   * sample count, and compare every Monte Carlo sample of the key outputs bit for bit.
   */
  replay() {
    const engine = this.getEngine();
    const t0 = performance.now();
    const ir = engine.graph.toIR();
    const g2 = ScopeGraph.fromIR(ir, { prototypes: engine.graph.prototypes });
    const e2 = new JsEngine({ samples: engine.n });
    e2.load(g2);
    const outputs = ['sc_bakery.monthly_cash', 'sc_bakery.p_cash_negative', 'sc_7Q2f.net_cash', 'sc_projection.min_cumulative'];
    let compared = 0;
    let identical = true;
    for (const id of outputs) {
      const a = engine.sample(id);
      const b = e2.sample(id);
      if (!a || !b) {
        const va = engine.value(id);
        const vb = e2.value(id);
        compared++;
        if (!(va === vb || (Number.isNaN(va) && Number.isNaN(vb)))) identical = false;
        continue;
      }
      compared += a.length;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { identical = false; break; }
    }
    return { identical, compared, hash: g2.hash, sameHash: g2.hash === engine.graph.hash, seed: g2.seed, samples: e2.n, ms: performance.now() - t0 };
  }
}
