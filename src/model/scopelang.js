/**
 * ScopeLang printer: renders the live graph as ScopeLang source, with a map between source
 * lines and scope/metric ids (clicking a declaration selects it; selecting a metric reveals
 * its line). Pure; no DOM.
 * @module model/scopelang
 */
import { toScopeLang } from './expr.js';
import { describe } from './distributions.js';

const KW = { input: 'input', observed: 'observed', estimated: 'estimate', computed: 'computed' };

/** @param {number} v @param {string} unit */
export function fmtLiteral(v, unit) {
  if (!Number.isFinite(v)) return String(v);
  if (/^USD/.test(unit) && Math.abs(v) < 100 && !Number.isInteger(v)) return v.toFixed(2);
  if (Number.isInteger(v) && Math.abs(v) >= 1000) return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}

/**
 * @param {import('./graph.js').ScopeGraph} graph
 * @param {{header?: string}} [opts]
 * @returns {{text: string, lineOf: Map<string, number>, idAt: Map<number, string>}}
 */
export function printScopeLang(graph, opts = {}) {
  const lines = [];
  const lineOf = new Map();
  const idAt = new Map();
  const push = (s, id) => {
    lines.push(s);
    if (id) {
      lineOf.set(id, lines.length);
      idAt.set(lines.length, id);
    }
  };
  if (opts.header) for (const l of opts.header.split('\n')) push(l);
  // use statements from the prototypes in use
  const used = new Map();
  for (const s of graph.scopes.values()) {
    const p = String(s.proto);
    const pkg = p.replace(/\.[^.]+$/, '');
    const name = graph.protoName(p);
    if (!used.has(pkg)) used.set(pkg, new Set());
    used.get(pkg).add(name);
  }
  for (const [pkg, names] of [...used.entries()].sort()) push(`use ${pkg}.{${[...names].sort().join(', ')}}`);
  push('');

  const walk = (sid, depth, isChild) => {
    const s = graph.scope(sid);
    if (!s) return;
    const ind = '  '.repeat(depth);
    const proto = graph.protoName(s.proto);
    const head = s.kind === 'mind' ? 'mind' : isChild ? 'child' : 'scope';
    const lod = s.lod ? `  @lod(${s.lod})` : '';
    const real = s.realPerson ? '  @simulation_not_assessment' : '';
    push(`${ind}${head} ${identifier(s.key || s.name)} : ${proto}${lod}${real} {`, sid);
    const metrics = s.metrics.map((m) => graph.node(m)).filter(Boolean);
    const w = Math.max(0, ...metrics.map((n) => n.name.length + 1));
    const uw = Math.max(0, ...metrics.map((n) => (n.type.unit || '1').length));
    for (const n of metrics) {
      if (s.kind === 'mind' && n.name.startsWith('goal_') && n.kind === 'input') {
        push(`${ind}  goal ${n.name.slice(5)} weight ${fmtLiteral(n.value, '')}`, n.id);
        continue;
      }
      const kw = KW[n.kind].padEnd(8);
      const name = `${n.name}:`.padEnd(w + 1);
      const unit = (n.type.unit || '1').padEnd(uw);
      let rhs;
      if (n.kind === 'computed') rhs = `= ${toScopeLang(n.expr)}`;
      else if (n.dist && n.dist.family !== 'Point') rhs = `~ ${describe(n.dist)}`;
      else rhs = `= ${fmtLiteral(n.value, n.type.unit)}`;
      let ann = '';
      if (n.prov?.src && n.kind === 'observed') ann = `  @src("${n.prov.src}"${n.prov.page ? `, page=${n.prov.page}` : ''})`;
      else if (n.prov?.by && n.kind === 'estimated') ann = `  @by("${n.prov.by}")`;
      else if (n.prov?.overriddenFrom) ann = `  // overridden: was ${n.prov.overriddenFrom}`;
      if (n.corr) ann += `  @corr(${n.corr.factor}, rho=${n.corr.rho})`;
      push(`${ind}  ${kw} ${name} ${unit} ${rhs}${ann}`, n.id);
    }
    for (const c of s.constraints) push(`${ind}  constraint ${toScopeLang(c.expr)}${c.severity === 'soft' ? '  @soft' : ''}`);
    for (const r of s.relations) push(`${ind}  relation ${r.type} -> ${graph.path(r.target)}`);
    for (const c of s.children) {
      push('');
      walk(c, depth + 1, true);
    }
    push(`${ind}}`);
  };
  if (graph.rootId) walk(graph.rootId, 0, false);
  return { text: lines.join('\n'), lineOf, idAt };
}

/** @param {string} s */
function identifier(s) {
  return /^[A-Za-z_]\w*$/.test(s) ? s : `\`${s}\``;
}
