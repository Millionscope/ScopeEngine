/**
 * Mermaid source generators for the Diagram editor. Each returns the source text plus maps
 * from Mermaid ids to graph ids so the editor can make rendered nodes selectable. All label
 * text is escaped with Mermaid entity codes (the shared theme adapter runs Mermaid with
 * securityLevel 'loose', so nothing user-named may reach it as markup). Ids are sanitized to
 * [A-Za-z0-9_] and made unique. No DOM.
 * @module editors/diagram/sources
 */
import { PROVENANCE } from '../../theme/tokens.js';
import { unitValue } from '../../model/format.js';

/**
 * @typedef {Object} DiagramSource
 * @property {string} src
 * @property {string} title
 * @property {string} subtitle
 * @property {Map<string, string[]>} nodes        Mermaid id -> graph ids it stands for
 * @property {Array<string|null>} messages         sequence diagrams: graph id per message, in order
 * @property {number[]=} messageLines              lines per message (Mermaid draws one text per line)
 * @property {number} count
 * @property {string=} empty
 */

export const KINDS = [
  { id: 'proto', label: 'Prototype chain', type: 'classDiagram' },
  { id: 'scope', label: 'Scope subgraph', type: 'flowchart' },
  { id: 'lifecycle', label: 'Request lifecycle', type: 'sequenceDiagram' },
  { id: 'swarm', label: 'Swarm build', type: 'sequenceDiagram' },
  { id: 'ladder', label: 'Verification ladder', type: 'flowchart' },
];

/** Max metric nodes drawn in the scope subgraph. */
export const SCOPE_MAX = 60;

/**
 * Escape free text for a Mermaid label or message (entity codes; no markup survives).
 * @param {string} s
 */
export function esc(s) {
  // one pass, so the entity codes we emit are never escaped again
  return String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/[#";<>&{}[\]|`]/g, (c) => (c === '"' ? '#quot;' : c === '<' ? '#lt;' : c === '>' ? '#gt;' : `#${c.charCodeAt(0)};`));
}

/**
 * Escape and wrap text into lines of about `n` characters joined by <br/> (sequence messages
 * and notes, so Mermaid does not size the participant gaps to one very long line).
 * @param {string} s @param {number} [n] @param {number} [maxLines]
 */
export function wrapEsc(s, n = 34, maxLines = 3) {
  const words = String(s ?? '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > n) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, n - 1)}…`;
  }
  return lines.map(esc).join('<br/>');
}

/** graph.summary() text without brackets, an empty "0 scopes" or a dimensionless unit. @param {string} sum */
export function cleanSummary(sum) {
  return String(sum).replace(/^\[|\]$/g, '').replace(/: 0 scopes, /, ': ').replace(/ 1$/, '');
}

/** Mermaid keywords that cannot be used as bare ids. */
const RESERVED = new Set(['end', 'graph', 'flowchart', 'subgraph', 'class', 'classdef', 'click', 'style', 'linkstyle', 'direction', 'default', 'note', 'participant', 'actor', 'loop', 'alt', 'opt', 'par', 'rect', 'critical', 'break', 'and', 'else', 'activate', 'deactivate', 'autonumber', 'box', 'link', 'links', 'title', 'over', 'left', 'right', 'of', 'as', 'properties', 'details', 'call', 'href', 'namespace']);

/** Id factory: sanitized, unique within one diagram. */
export function idMaker(prefix = 'n') {
  const used = new Map();
  /** @type {Map<string, string>} */
  const byKey = new Map();
  /** @param {string} key */
  return (key) => {
    const hit = byKey.get(key);
    if (hit) return hit;
    let base = String(key).replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'x';
    if (/^\d/.test(base) || RESERVED.has(base.toLowerCase())) base = `${prefix}_${base}`;
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    const id = n ? `${base}_${n}` : base;
    byKey.set(key, id);
    return id;
  };
}

/** @param {Map<string, string[]>} m @param {string} k @param {string} v */
function addMap(m, k, v) {
  const a = m.get(k);
  if (a) { if (!a.includes(v)) a.push(v); } else m.set(k, [v]);
}

/** @param {number} n @param {number} max */
function clip(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Displayed number for a metric: median for stochastic nodes. @param {any} view @param {string} id */
function shown(view, id) {
  const st = view.stats(id);
  return st && !st.deterministic ? st.p50 : view.value(id);
}

/** @param {any} g @param {any} view @param {string} id */
function valueText(g, view, id) {
  const n = g.node(id);
  const v = shown(view, id);
  if (!n || n.type?.dtype === 'text' || !Number.isFinite(v)) return '—';
  return unitValue(v, n.type?.unit || '', { compact: true });
}

// ---------------------------------------------------------------- prototype chain (classDiagram)

/**
 * The selected scope's prototype chain as a class diagram: the scope as an instance, each
 * prototype with the metrics it declares, inheritance arrows up the chain, and how many other
 * scopes share each prototype.
 * @param {any} g ScopeGraph @param {any} view @param {string} scopeId
 * @returns {DiagramSource}
 */
export function protoChain(g, view, scopeId) {
  const s = g.scope(scopeId);
  const nodes = new Map();
  if (!s) return { src: '', title: 'Prototype chain', subtitle: '', nodes, messages: [], count: 0, empty: 'Select a scope to see its prototype chain.' };
  const id = idMaker('c');
  const chain = g.protoChainIds(scopeId);
  const lines = ['classDiagram', `  accTitle: ${esc(`Prototype chain of ${g.path(scopeId)}`)}`, `  accDescr: ${esc(`${s.name} inherits from ${g.protoChainNames(scopeId).join(', then ')}`)}`];
  const inst = id(`scope_${s.name}`);
  addMap(nodes, inst, scopeId);
  lines.push(`  class ${inst}["${esc(s.name)}"] {`, '    <<scope>>');
  for (const m of s.metrics.slice(0, 14)) {
    const n = g.node(m);
    if (!n) continue;
    lines.push(`    ${esc(`${PROVENANCE[g.displayProv(m)]?.glyph || ''} ${n.name} = ${valueText(g, view, m)}`)}`);
  }
  if (s.metrics.length > 14) lines.push(`    ${esc(`… ${s.metrics.length - 14} more`)}`);
  lines.push('  }');
  let prev = inst;
  for (const pid of chain) {
    const p = g.prototypes[pid] || {};
    const cid = id(`proto_${p.name || g.protoName(pid)}`);
    const shared = [...g.scopes.values()].filter((x) => x.proto === pid).map((x) => x.id);
    for (const sid of shared) addMap(nodes, cid, sid);
    lines.push(`  class ${cid}["${esc(p.name || g.protoName(pid))}"] {`, `    <<${esc(pid.replace(/^std\./, ''))}>>`);
    const ms = Object.entries(p.metrics || {});
    for (const [name, def] of ms.slice(0, 10)) {
      const k = /** @type {any} */ (def);
      const unit = k.unit && k.unit !== '1' ? ` : ${k.unit}` : '';
      lines.push(`    ${esc(`${PROVENANCE[k.kind]?.glyph || ''} ${name}${unit}`)}`);
    }
    if (ms.length > 10) lines.push(`    ${esc(`… ${ms.length - 10} more`)}`);
    if (!ms.length) lines.push(`    ${esc('no own metrics')}`);
    lines.push(`    ${esc(`${shared.length} scope${shared.length === 1 ? '' : 's'} use it`)}`);
    lines.push('  }');
    lines.push(`  ${cid} <|-- ${prev}`);
    prev = cid;
  }
  return {
    src: lines.join('\n'),
    title: `Prototype chain of ${s.name}`,
    subtitle: [s.name, ...g.protoChainNames(scopeId)].join(' → '),
    nodes,
    messages: [],
    count: chain.length + 1,
  };
}

// ---------------------------------------------------------------- scope subgraph (flowchart)

/**
 * A scope's metrics with their dependency edges. Child scopes are drawn as subgraphs while the
 * budget allows (max SCOPE_MAX metric nodes), otherwise as one summary node each. Inputs from
 * outside the scope appear as dashed context nodes. Provenance = glyph + classDef color.
 * @param {any} g @param {any} view @param {string} scopeId @param {string} provClasses mermaidProvClasses()
 * @returns {DiagramSource}
 */
export function scopeSubgraph(g, view, scopeId, provClasses) {
  const s = g.scope(scopeId);
  const nodes = new Map();
  if (!s) return { src: '', title: 'Scope subgraph', subtitle: '', nodes, messages: [], count: 0, empty: 'Select a scope or metric.' };
  const id = idMaker('n');
  /** @type {Set<string>} metrics drawn */
  const drawn = new Set();
  /** @type {Map<string, string>} metric id -> summary node id (for metrics inside summarized child scopes) */
  const summarized = new Map();
  const lines = ['flowchart LR', `  accTitle: ${esc(`Scope subgraph of ${g.path(scopeId)}`)}`, `  accDescr: ${esc(`Metrics of ${s.name} and their dependencies, colored and marked by provenance`)}`];
  const byProv = new Map();
  let budget = SCOPE_MAX;

  const metricNode = (m, indent) => {
    const n = g.node(m);
    if (!n) return;
    const prov = g.displayProv(m);
    const mid = id(m);
    addMap(nodes, mid, m);
    drawn.add(m);
    budget--;
    lines.push(`${indent}${mid}["${esc(`${PROVENANCE[prov]?.glyph || ''} ${n.name}`)}<br/>${esc(valueText(g, view, m))}"]`);
    const cls = prov === 'contested' ? 'estimated' : prov === 'failed' ? 'computed' : prov;
    (byProv.get(cls) || byProv.set(cls, []).get(cls)).push(mid);
  };

  // own metrics first, then children while there is budget
  for (const m of s.metrics) if (budget > 0) metricNode(m, '  ');
  for (const c of s.children) {
    const cs = g.scope(c);
    if (!cs) continue;
    const sub = g.subtreeNodes(c);
    if (sub.length && sub.length <= budget && !cs.children.length) {
      const sid = id(`sg_${c}`);
      addMap(nodes, sid, c);
      lines.push(`  subgraph ${sid}["${esc(`${cs.name} · ${g.protoName(cs.proto)}`)}"]`, '    direction LR');
      for (const m of cs.metrics) metricNode(m, '    ');
      lines.push('  end');
    } else {
      const sid = id(`sum_${c}`);
      addMap(nodes, sid, c);
      const sum = cleanSummary(g.summary(c, (nid) => shown(view, nid)));
      lines.push(`  ${sid}(["${esc(`▸ ${clip(sum, 70)}`)}"])`);
      (byProv.get('summary') || byProv.set('summary', []).get('summary')).push(sid);
      for (const m of sub) summarized.set(m, sid);
    }
  }
  // edges among drawn metrics, summary nodes, and outside inputs (context)
  const edges = new Set();
  const outside = new Map();
  const edgeLines = [];
  const endpoint = (m) => (drawn.has(m) ? id(m) : summarized.get(m) || null);
  for (const m of [...drawn, ...summarized.keys()]) {
    const n = g.node(m);
    if (!n) continue;
    const to = endpoint(m);
    if (!to) continue;
    for (const d of n.deps || []) {
      let from = endpoint(d);
      if (!from) {
        if (outside.size >= 12 && !outside.has(d)) continue;
        if (!outside.has(d)) {
          const oid = id(`ext_${d}`);
          outside.set(d, oid);
          addMap(nodes, oid, d);
        }
        from = /** @type {string} */ (outside.get(d));
      }
      if (from === to) continue;
      const key = `${from}>${to}`;
      if (edges.has(key)) continue;
      edges.add(key);
      edgeLines.push(`  ${from} --> ${to}`);
    }
  }
  for (const [d, oid] of outside) {
    lines.push(`  ${oid}["${esc(`${PROVENANCE[g.displayProv(d)]?.glyph || ''} ${clip(g.path(d), 40)}`)}"]`);
    (byProv.get('outside') || byProv.set('outside', []).get('outside')).push(oid);
  }
  lines.push(...edgeLines);
  lines.push(...provClasses.split('\n').map((l) => `  ${l}`));
  lines.push('  classDef summary stroke-dasharray:4 3;');
  lines.push('  classDef outside stroke-dasharray:2 2,opacity:0.75;');
  for (const [cls, ids] of byProv) lines.push(`  class ${ids.join(',')} ${cls};`);
  const hidden = g.subtreeNodes(scopeId).length - drawn.size;
  return {
    src: lines.join('\n'),
    title: `Scope subgraph of ${s.name}`,
    subtitle: `${drawn.size} metrics${hidden > 0 ? `, ${hidden} more summarized` : ''}${outside.size ? `, ${outside.size} outside inputs` : ''}`,
    nodes,
    messages: [],
    count: drawn.size + outside.size,
  };
}

// ---------------------------------------------------------------- request lifecycle (sequence)

/**
 * The nine steps from a typed request to updated editors, with live numbers from the last
 * recompute where available.
 * @param {{recompute?: {ms: number, nodes: number}|null, version?: string|null, samples?: number}} live
 * @returns {DiagramSource}
 */
export function requestLifecycle(live = {}) {
  const r = live.recompute;
  const rc = r ? `recompute ${r.nodes} node${r.nodes === 1 ? '' : 's'} in ${Math.max(1, Math.round(r.ms))} ms` : 'incremental recompute of the changed cone';
  const steps = [
    ['U', 'C', '->>', 'question or edit, typed in the composer'],
    ['C', 'R', '->>', 'classify while typing: numeric, structural or question'],
    ['R', 'E', '-->>', 'numeric edit: a local set delta, 0 model tokens'],
    ['R', 'S', '->>', 'structural (~3k tokens) or question (~40k tokens): model call'],
    ['S', 'V', '->>', 'proposed ScopeDeltas (Modeler, Researcher, Estimators, Skeptic)'],
    ['V', 'E', '->>', 'accepted deltas: grammar, names, units, invariants, evidence pass'],
    ['E', 'E', '->>', `${rc} + Monte Carlo (${(live.samples || 1000).toLocaleString('en-US')} samples)`],
    ['E', 'X', '->>', 'bound values and distributions'],
    ['X', 'W', '->>', `narrative with bound numbers + certificate${live.version ? ` (${live.version})` : ''}; editors update changed values only`],
  ];
  const lines = [
    'sequenceDiagram',
    `  accTitle: ${esc('Request lifecycle')}`,
    `  accDescr: ${esc('Nine steps from a typed request to updated editors')}`,
    '  autonumber',
    '  actor U as User',
    '  participant C as Composer',
    '  participant R as Router',
    '  participant S as Swarm',
    '  participant V as Verifier',
    '  participant E as Engine',
    '  participant X as Explainer',
    '  participant W as Workbench',
    ...steps.map(([a, b, arrow, text]) => `  ${a}${arrow}${b}: ${wrapEsc(text, 30)}`),
    `  Note over V,E: ${wrapEsc('rejections return to the Swarm with the verifier message', 30)}`,
  ];
  return { src: lines.join('\n'), title: 'Request lifecycle', subtitle: '9 steps · live numbers from the last recompute', nodes: new Map(), messages: steps.map(() => null), count: steps.length };
}

// ---------------------------------------------------------------- swarm build (sequence)

/**
 * The last swarm build as a sequence diagram: who proposed what, and what the verifier
 * decided (with its level and message).
 * @param {any} build services.swarm.last()
 * @returns {DiagramSource}
 */
export function swarmBuild(build) {
  const nodes = new Map();
  if (!build || !build.events.length) return { src: '', title: 'Swarm build', subtitle: '', nodes, messages: [], count: 0, empty: 'No swarm build yet. Ask a question in the composer to start one.' };
  const id = idMaker('p');
  const roles = [];
  const roleId = (r) => {
    if (!roles.includes(r)) roles.push(r);
    return id(r);
  };
  const body = [];
  /** @type {Array<string|null>} one entry per message, in drawing order */
  const messages = [];
  /** @type {number[]} */
  const messageLines = [];
  /** @param {string} from @param {string} arrow @param {string} to @param {string} text @param {string|null|undefined} nodeId */
  const msg = (from, arrow, to, text, nodeId) => {
    const t = wrapEsc(text);
    body.push(`  ${from}${arrow}${to}: ${t}`);
    messages.push(nodeId || null);
    messageLines.push(t.split('<br/>').length);
  };
  const MAX = 40;
  const events = build.events.slice(0, MAX);
  for (const e of events) {
    const who = roleId(e.role);
    const text = clip(e.text, 96);
    if (e.kind === 'plan') {
      msg(who, '->>', who, `plan: ${text}`, e.nodeId);
    } else if (e.kind === 'verify') {
      body.push(`  Note over ${who}: ${wrapEsc(text)}`);
    } else if (e.kind === 'estimate' && e.delphi) {
      const lead = roleId('Lead');
      const r1 = (e.delphi.round1 || []).length;
      msg(who, '->>', lead, `${text}${r1 ? ` (${r1} estimators, Delphi)` : ''}`, e.nodeId);
      if (e.delphi.contested) body.push(`  Note over ${lead}: ${wrapEsc('contested: kept as a flagged mixture')}`);
    } else if (e.kind === 'explain') {
      msg(who, '->>', roleId('Lead'), text, e.nodeId);
    } else {
      const ver = roleId('Verifier');
      msg(who, '->>', ver, text, e.nodeId);
      if (e.outcome === 'accepted' || e.outcome === 'rejected') {
        const lvl = e.level != null ? ` at level ${e.level}` : '';
        const why = e.outcome === 'rejected' && e.reason ? `: ${clip(e.reason, 90)}` : '';
        msg(ver, '-->>', who, `${e.outcome === 'accepted' ? '✓ accepted' : '✕ rejected'}${lvl}${why}`, e.nodeId);
      } else if (e.outcome === 'thinking' || e.outcome === 'proposed') {
        body.push(`  Note over ${ver}: ${esc('checking…')}`);
      }
    }
  }
  const head = [
    'sequenceDiagram',
    `  accTitle: ${esc(build.title)}`,
    `  accDescr: ${esc(`${build.events.length} swarm events; verifier decisions shown as replies`)}`,
    ...roles.map((r) => `  participant ${id(r)} as ${esc(r)}`),
  ];
  const lines = [...head, ...body];
  if (build.events.length > MAX) lines.push(`  Note over ${id(roles[0])}: ${wrapEsc(`… ${build.events.length - MAX} more events in the Swarm editor`)}`);
  const acc = build.events.filter((e) => e.outcome === 'accepted').length;
  const rej = build.events.filter((e) => e.outcome === 'rejected').length;
  return {
    src: lines.join('\n'),
    title: build.title,
    subtitle: `${build.events.length} events · ${acc} accepted · ${rej} rejected${build.ended ? '' : ' · running'}${build.historical ? ' · replayed' : ''}`,
    nodes,
    messages,
    messageLines,
    count: build.events.length,
  };
}

// ---------------------------------------------------------------- verification ladder (flowchart)

const STATUS = {
  pass: { glyph: '✓', label: 'pass', cls: 'ok' },
  proven: { glyph: '✓', label: 'proven', cls: 'proven' },
  fail: { glyph: '✕', label: 'fail', cls: 'fail' },
  not_proven: { glyph: '○', label: 'not proven', cls: 'open' },
  statistical: { glyph: '~', label: 'statistical', cls: 'stat' },
  judgment: { glyph: '≈', label: 'judgment', cls: 'judg' },
  na: { glyph: '–', label: 'n/a', cls: 'na' },
};

/**
 * The certificate's ladder, levels 0-8, bottom (cheap, mechanical) to top (judgment).
 * @param {any} cert services.verify.certificate()
 * @param {{ok: string, fail: string, proven: string, open: string, stat: string, judg: string, na: string}} colors
 * @returns {DiagramSource}
 */
export function verificationLadder(cert, colors) {
  const nodes = new Map();
  if (!cert || !cert.ladder) return { src: '', title: 'Verification ladder', subtitle: '', nodes, messages: [], count: 0, empty: 'No certificate yet.' };
  const lines = ['flowchart BT', `  accTitle: ${esc('Verification ladder')}`, `  accDescr: ${esc(`Levels 0 to 8 for ${cert.graphVersion}; each level lists what it catches and its status`)}`];
  const byCls = new Map();
  const ids = [];
  for (const l of cert.ladder) {
    const st = STATUS[l.status] || STATUS.na;
    const lid = `L${l.level}`;
    ids.push(lid);
    const nodeIds = (l.items || []).map((i) => i.nodeId).filter(Boolean);
    nodes.set(lid, [...new Set(nodeIds)]);
    lines.push(`  ${lid}["${esc(`${st.glyph} ${l.level} · ${l.name}`)}<br/>${esc(`${st.label}: ${clip(l.detail, 64)}`)}<br/>${esc(`catches: ${clip(l.catches, 56)}`)}"]`);
    (byCls.get(st.cls) || byCls.set(st.cls, []).get(st.cls)).push(lid);
  }
  for (let i = 1; i < ids.length; i++) lines.push(`  ${ids[i - 1]} --> ${ids[i]}`);
  lines.push(
    `  classDef ok stroke:${colors.ok},stroke-width:2px;`,
    `  classDef proven stroke:${colors.proven},stroke-width:2px;`,
    `  classDef fail stroke:${colors.fail},stroke-width:3px;`,
    `  classDef open stroke:${colors.open},stroke-width:2px,stroke-dasharray:5 3;`,
    `  classDef stat stroke:${colors.stat},stroke-width:2px;`,
    `  classDef judg stroke:${colors.judg},stroke-width:2px,stroke-dasharray:2 2;`,
    `  classDef na stroke:${colors.na},stroke-width:1px;`,
  );
  for (const [cls, list] of byCls) lines.push(`  class ${list.join(',')} ${cls};`);
  const failed = cert.ladder.filter((l) => l.status === 'fail').length;
  return {
    src: lines.join('\n'),
    title: 'Verification ladder',
    subtitle: `${cert.graphVersion} · ${failed ? `${failed} level${failed === 1 ? '' : 's'} failing` : 'no failing level'} · click a level to select the metrics it checked`,
    nodes,
    messages: [],
    count: cert.ladder.length,
  };
}
