/**
 * Model loader: builds the demo ScopeGraph from mock IR (the only model module that imports
 * mock/). In production this is POST /graphs (question -> graph).
 * @module model/loader
 */
import { ScopeGraph } from './graph.js';
import { buildBakeryIR, KEY_OUTPUTS, DEFAULT_OUTPUT } from '../mock/bakery.js';
import { PROTOTYPES } from '../mock/prototypes.js';
import { buildStressIR } from '../mock/generator.js';

export { KEY_OUTPUTS, DEFAULT_OUTPUT, PROTOTYPES };

/** @returns {ScopeGraph} */
export function loadDemoGraph() {
  return ScopeGraph.fromIR(buildBakeryIR(), { prototypes: PROTOTYPES });
}

/**
 * Demo graph plus synthetic branches (stress tests: 10k / 100k metrics).
 * @param {number} targetNodes
 */
export function loadStressGraph(targetNodes) {
  const ir = buildBakeryIR();
  const extra = buildStressIR(targetNodes - ir.nodes.length, ir.rootId);
  ir.scopes.push(...extra.scopes);
  ir.nodes.push(...extra.nodes);
  const root = ir.scopes.find((s) => s.id === ir.rootId);
  root.children.push(...extra.topScopes);
  ir.graphId = `${ir.graphId}_stress_${targetNodes}`;
  const graph = ScopeGraph.fromIR(ir, { prototypes: PROTOTYPES });
  // the generator's synthetic ledger, so observed synthetic costs can be verified (level 4)
  /** @type {any} */ (graph).syntheticEvidence = extra.evidence;
  return graph;
}
