/**
 * Synthetic graph generator for stress tests (10k / 100k metric nodes). Adds "Synthetic" branches
 * of layered scopes whose formulas depend on the previous layer and a few real bakery metrics,
 * so recompute cones, sheets, outliners and the 3D space get realistic fan-in/fan-out.
 * Deterministic (no Math.random).
 * @module mock/generator
 */

/** Small deterministic PRNG (mulberry32). @param {number} seed */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} targetNodes number of metric nodes to add (approx.)
 * @param {string} rootId
 */
export function buildStressIR(targetNodes, rootId) {
  const rnd = mulberry(42);
  const scopes = [];
  const nodes = [];
  const topScopes = [];
  /** the synthetic cost ledger every observed unit_cost is extracted from (one series) */
  const ledger = { binds: [], series: [] };
  const METRICS_PER_SCOPE = 8;
  const SCOPES_PER_GROUP = 50;
  const nScopes = Math.max(1, Math.ceil(targetNodes / METRICS_PER_SCOPE));
  const nGroups = Math.ceil(nScopes / SCOPES_PER_GROUP);
  const regions = Math.max(1, Math.ceil(nGroups / 20));
  let made = 0;
  for (let r = 0; r < regions && made < nScopes; r++) {
    const regionId = `sc_syn_r${r}`;
    scopes.push({ id: regionId, key: `synthetic_${r}`, name: `Synthetic ${r + 1}`, proto: 'std.org.Collection@1', parent: rootId, children: [], metrics: [], relations: [], constraints: [], kind: 'group' });
    topScopes.push(regionId);
    const region = scopes[scopes.length - 1];
    for (let gi = 0; gi < 20 && made < nScopes; gi++) {
      const groupId = `${regionId}_g${gi}`;
      const group = { id: groupId, key: `cluster_${gi}`, name: `Cluster ${r + 1}.${gi + 1}`, proto: 'std.org.Collection@1', parent: regionId, children: [], metrics: [], relations: [], constraints: [], kind: 'group' };
      scopes.push(group);
      region.children.push(groupId);
      // group total
      const totalId = `${groupId}.total`;
      for (let si = 0; si < SCOPES_PER_GROUP && made < nScopes; si++, made++) {
        const sid = `${groupId}_s${si}`;
        const sc = { id: sid, key: `unit_${si}`, name: `Unit ${si + 1}`, proto: 'std.finance.Business@2', parent: groupId, children: [], metrics: [], relations: [], constraints: [], kind: 'business' };
        scopes.push(sc);
        group.children.push(sid);
        const add = (name, kind, unit, extra) => {
          const id = `${sid}.${name}`;
          nodes.push({ id, scope: sid, name, kind, type: { dtype: 'f64', unit }, deps: [], ...extra });
          sc.metrics.push(id);
        };
        const stochastic = si % 10 === 0;
        add('volume', stochastic ? 'estimated' : 'input', 'item/day', stochastic
          ? { dist: { family: 'LogNormal', median: 100 + rnd() * 50, p90: 170 + rnd() * 60 }, prov: { by: 'generator' } }
          : { value: Math.round(80 + rnd() * 120) });
        add('unit_price', 'input', 'USD/item', { value: Math.round((2 + rnd() * 6) * 100) / 100, range: [1, 10] });
        const cost = Math.round((1 + rnd() * 2) * 100) / 100;
        add('unit_cost', 'observed', 'USD/item', { value: cost, prov: { src: 'synthetic_cost_ledger.csv', page: 1, evidence: SYNTHETIC_EVIDENCE_ID } });
        ledger.binds.push(`${sid}.unit_cost`);
        ledger.series.push(cost);
        add('margin', 'computed', 'USD/day', { expr: ['mul', ['sub', '@unit_price', '@unit_cost'], '@volume'] });
        add('overhead', 'input', 'USD/month', { value: Math.round(500 + rnd() * 2500) });
        add('net', 'computed', 'USD/month', { expr: ['sub', ['convert', '@margin', 'USD/month'], '@overhead'], headline: true });
        add('price_index', 'computed', '1', { expr: ['div', '@unit_price', '@bakery.price'], });
        add('net_adj', 'computed', 'USD/month', { expr: si === 0 ? ['mul', '@net', '@price_index'] : ['add', ['mul', '@net', 0.9], ['mul', `@unit_${si - 1}.net`, 0.1]] });
      }
      nodes.push({ id: totalId, scope: groupId, name: 'total', kind: 'computed', type: { dtype: 'f64', unit: 'USD/month' }, deps: [], expr: ['agg', 'sum', '.', '*', 'net_adj'], headline: true });
      group.metrics.push(totalId);
    }
  }
  const evidence = {
    source: { id: 'src_synthetic_ledger', name: 'synthetic_cost_ledger.csv', type: 'CSV', date: '2026-11-01', pages: 1, title: `Synthetic unit-cost ledger (${ledger.binds.length.toLocaleString('en-US')} rows, stress test)`, found: true, synthetic: true },
    extraction: { id: SYNTHETIC_EVIDENCE_ID, source: 'src_synthetic_ledger', page: 1, span: `unit_cost column, ${ledger.binds.length.toLocaleString('en-US')} rows`, match: 'unit_cost', unit: 'USD/item', binds: ledger.binds, series: ledger.series, synthetic: true },
  };
  return { scopes, nodes, topScopes, evidence };
}

export const SYNTHETIC_EVIDENCE_ID = 'ev_synthetic_ledger';
