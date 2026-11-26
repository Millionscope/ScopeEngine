/**
 * Party cards: one card per modeled party (Mind Scope). Header: name, role, LOD chip and
 * "simulation, not assessment". Body: hidden state, goals as weighted bars, traits as
 * sparklines, knowledge partition (source names), beliefs keyed by world scope,
 * relationships (trust, reciprocity) and affect meters with decay. Every graph number is a
 * BoundValue; profile constants that are not graph metrics are drawn without numerals.
 * @module editors/minds/cards
 */
import { sparkline } from '../shared/sparkline.js';
import { scopeChip } from '../shared/scope-chip.js';
import {
  h, icon, button, simBanner, lodChip, meter, setMeter, decayCurve, reciprocityWord, levelWord, sourceIcon,
} from './view.js';

export class CardsView {
  /**
   * @param {HTMLElement} el @param {any[]} parties
   * @param {import('./view.js').MindsHost} host
   */
  constructor(el, parties, host) {
    this.host = host;
    /** @type {Map<string, Array<() => void>>} node id -> refreshers of non-text visuals */
    this.refreshers = new Map();
    this.grid = h('div', 'ms-mind-cards');
    for (const m of parties) this.grid.appendChild(this.card(m));
    el.appendChild(this.grid);
    this.markCurrent();
  }

  get g() { return this.host.ctx.engine.graph; }
  get engine() { return this.host.ctx.engine; }

  /** Register a refresher for a node and run it once. @param {string} id @param {() => void} fn */
  track(id, fn) {
    let list = this.refreshers.get(id);
    if (!list) this.refreshers.set(id, (list = []));
    list.push(fn);
    fn();
  }

  /** @param {string[]} changed */
  update(changed) {
    for (const id of changed) for (const fn of this.refreshers.get(id) || []) fn();
  }

  markCurrent() {
    const cur = this.host.agentId();
    for (const c of this.grid.children) {
      if (/** @type {HTMLElement} */ (c).dataset.id === cur) c.setAttribute('aria-current', 'true');
      else c.removeAttribute('aria-current');
    }
  }

  /** @param {string} id */
  reveal(id) {
    this.markCurrent();
    const card = /** @type {HTMLElement|null} */ (this.grid.querySelector(`[data-id="${CSS.escape(id)}"]`));
    card?.scrollIntoView({ block: 'nearest', behavior: this.host.reducedMotion() ? 'auto' : 'smooth' });
  }

  /** @param {any} m */
  card(m) {
    const host = this.host;
    const art = h('article', 'ms-pcard ms-mind-card');
    art.dataset.id = m.id;
    art.setAttribute('aria-label', `${m.name}, ${m.role}. Simulation, not assessment.`);
    const head = h('header', 'ms-pcard-head ms-mind-card-head');
    const title = h('div', 'ms-mind-card-title');
    const name = /** @type {HTMLButtonElement} */ (h('button', 'ms-mind-name', m.name));
    name.type = 'button';
    name.title = 'Select this Mind Scope';
    name.addEventListener('click', () => { host.select([m.id]); });
    title.append(name, h('div', 'ms-mind-role', m.role));
    const badges = h('div', 'ms-mind-badges');
    badges.append(lodChip(m.lod), simBanner());
    head.append(icon('person'), title, badges);
    art.appendChild(head);

    const body = h('div', 'ms-pcard-body ms-mind-card-body');
    body.appendChild(this.hiddenBlock(m));
    if (m.goals.length) body.appendChild(this.section('Goals', 'target', 'weights the party is modeled to trade off', (rows) => {
      for (const goal of m.goals) this.goalRow(rows, goal);
    }));
    if (m.traits.length) body.appendChild(this.section('Traits', 'symbol-property', 'estimated distributions', (rows) => {
      for (const t of m.traits) this.traitRow(rows, t);
    }));
    body.appendChild(this.knowledge(m));
    if (m.beliefs.length) body.appendChild(this.beliefs(m));
    if (m.relationships.length) body.appendChild(this.section('Relationships', 'references', 'trust and reciprocity', (rows) => {
      for (const r of m.relationships) this.relRow(rows, r);
    }));
    if (m.affect.length) body.appendChild(this.section('Affect', 'pulse', 'current level and decay toward neutral', (rows) => {
      for (const a of m.affect) this.affectRow(rows, a);
    }));
    art.appendChild(body);

    const foot = h('footer', 'ms-mind-card-foot');
    foot.append(
      button('Nested beliefs', 'type-hierarchy', () => host.open(m.id, 'nested')),
      button('Evidence trail', 'pulse', () => host.open(m.id, 'trail')),
    );
    if (m.claims.length) foot.appendChild(button('Claims', 'comment-discussion', () => host.open(m.id, 'claims')));
    art.appendChild(foot);
    return art;
  }

  /**
   * @param {string} title @param {string} iconName @param {string} hint
   * @param {(rows: HTMLElement) => void} fill
   */
  section(title, iconName, hint, fill) {
    const sec = h('section', 'ms-mind-sec');
    const hd = h('h4', 'ms-mind-sec-h');
    hd.append(icon(iconName), document.createTextNode(title));
    const hn = h('span', 'ms-mind-sec-hint', hint);
    hd.appendChild(hn);
    const rows = h('div', 'ms-mind-rows');
    sec.append(hd, rows);
    fill(rows);
    return sec;
  }

  /** @param {any} m */
  hiddenBlock(m) {
    const { bv } = this.host;
    const g = this.g;
    const id = m.hidden.nodeId;
    const box = h('div', 'ms-mind-hidden');
    const top = h('div', 'ms-mind-hidden-top');
    const lab = h('span', 'ms-mind-hidden-label');
    lab.append(icon('eye-closed'), document.createTextNode(`Hidden state: ${m.hidden.name}`));
    top.appendChild(lab);
    box.appendChild(top);
    if (!g.node(id)) {
      box.appendChild(h('div', 'ms-muted ms-small', 'Not in the current graph.'));
      return box;
    }
    const row = h('div', 'ms-mind-hidden-row');
    const spark = h('span', 'ms-mind-spark-host');
    const p50 = bv.create({ node: id, stat: 'p50' });
    const iv = h('span', 'ms-mind-iv');
    iv.append('p10 ', bv.create({ node: id, stat: 'p10', glyph: false, plain: true }), ' to p90 ', bv.create({ node: id, stat: 'p90', glyph: false, plain: true }));
    row.append(spark, p50, iv);
    const src = h('div', 'ms-mind-hidden-src');
    box.append(row, src);
    this.track(id, () => {
      const st = this.engine.stats(id);
      spark.replaceChildren(sparkline(this.engine.sample(id), { width: 84, height: 20, color: 'var(--ms-prov-estimated)', p50: st?.p50, label: `${m.hidden.name} distribution` }));
      const by = g.node(id)?.prov?.by;
      src.textContent = by ? `estimated by ${by}` : 'estimated';
    });
    return box;
  }

  /** @param {HTMLElement} rows @param {any} goal */
  goalRow(rows, goal) {
    const { bv } = this.host;
    const row = h('div', 'ms-mind-row');
    const m = meter();
    row.append(h('span', 'ms-mind-row-label', goal.name), m, bv.create({ node: goal.nodeId }));
    rows.appendChild(row);
    this.track(goal.nodeId, () => setMeter(m, this.engine.value(goal.nodeId)));
  }

  /** @param {HTMLElement} rows @param {any} t */
  traitRow(rows, t) {
    const { bv } = this.host;
    const row = h('div', 'ms-mind-row');
    const spark = h('span', 'ms-mind-spark-host');
    row.append(h('span', 'ms-mind-row-label', t.name), spark, bv.create({ node: t.nodeId, stat: 'p50' }));
    rows.appendChild(row);
    this.track(t.nodeId, () => {
      const st = this.engine.stats(t.nodeId);
      spark.replaceChildren(sparkline(this.engine.sample(t.nodeId), { width: 72, height: 16, color: 'var(--ms-prov-estimated)', p50: st?.p50, label: `${t.name} distribution` }));
    });
  }

  /** Knowledge partition: the evidence this party can see, by source name. @param {any} m */
  knowledge(m) {
    const ev = this.host.ctx.services.evidence;
    const sec = h('section', 'ms-mind-sec');
    const hd = h('h4', 'ms-mind-sec-h');
    hd.append(icon('library'), document.createTextNode('Knows'));
    hd.appendChild(h('span', 'ms-mind-sec-hint', 'information partition: the sources this party can see'));
    const list = h('div', 'ms-mind-know');
    list.setAttribute('role', 'list');
    // one chip per source; the extractions this party knows from it are listed in the tooltip
    /** @type {Map<string, {src: any, exs: any[]}>} */
    const bySource = new Map();
    const missing = [];
    for (const evId of m.knowledge) {
      const ex = ev?.extraction(evId);
      const src = ex ? ev.source(ex.source) : null;
      if (!src) { missing.push(evId); continue; }
      if (!bySource.has(src.id)) bySource.set(src.id, { src, exs: [] });
      bySource.get(src.id)?.exs.push(ex);
    }
    const g = this.g;
    for (const { src, exs } of bySource.values()) {
      const item = h('span', 'ms-mind-know-item');
      item.setAttribute('role', 'listitem');
      const chip = /** @type {HTMLButtonElement} */ (h('button', 'ms-chip ms-mind-know-chip'));
      chip.type = 'button';
      chip.append(icon(sourceIcon(src.type)), h('span', 'ms-ellipsis', src.name));
      const targets = [...new Set(exs.flatMap((e) => e.binds.slice(0, 1)))];
      const what = targets.map((id) => g.node(id)?.label || g.path(id)).join('; ');
      chip.title = `${src.title || src.name}\nKnows: ${what || 'unbound values'}\nClick to select ${targets.length === 1 ? 'that metric' : 'those metrics'}`;
      chip.setAttribute('aria-label', `${src.name}: ${what || 'unbound values'}`);
      if (targets.length) chip.addEventListener('click', () => this.host.select(targets));
      else chip.disabled = true;
      item.appendChild(chip);
      list.appendChild(item);
    }
    for (const evId of missing) {
      const item = h('span', 'ms-mind-know-item ms-muted ms-small', evId);
      item.setAttribute('role', 'listitem');
      item.title = 'Source not found';
      list.appendChild(item);
    }
    if (!m.knowledge.length) list.appendChild(h('span', 'ms-muted ms-small', 'No sources in this party’s information set.'));
    sec.append(hd, list);
    return sec;
  }

  /** Beliefs grouped by the world scope they are about. @param {any} m */
  beliefs(m) {
    const { bv } = this.host;
    const g = this.g;
    const sec = h('section', 'ms-mind-sec');
    const hd = h('h4', 'ms-mind-sec-h');
    hd.append(icon('lightbulb'), document.createTextNode('Beliefs'));
    hd.appendChild(h('span', 'ms-mind-sec-hint', 'keyed by the world scope they are about'));
    sec.appendChild(hd);
    /** @type {Map<string, any[]>} */
    const byWorld = new Map();
    for (const b of m.beliefs) {
      const w = b.world || 'unscoped';
      if (!byWorld.has(w)) byWorld.set(w, []);
      byWorld.get(w)?.push(b);
    }
    for (const [world, list] of byWorld) {
      const wl = h('div', 'ms-mind-world');
      wl.appendChild(h('span', 'ms-mind-world-label', 'world'));
      if (g.scope(world)) wl.appendChild(scopeChip(g, world, { onClick: (id) => this.host.select([id]) }));
      else wl.appendChild(h('span', 'ms-muted', world));
      sec.appendChild(wl);
      const rows = h('div', 'ms-mind-rows');
      for (const b of list) {
        const row = h('div', 'ms-mind-row');
        const mt = meter();
        row.append(h('span', 'ms-mind-row-label', b.about), mt, bv.create({ node: b.nodeId, stat: 'p50' }));
        rows.appendChild(row);
        this.track(b.nodeId, () => setMeter(mt, this.engine.stats(b.nodeId)?.p50 ?? NaN));
      }
      sec.appendChild(rows);
    }
    return sec;
  }

  /** @param {HTMLElement} rows @param {any} r */
  relRow(rows, r) {
    const { bv } = this.host;
    const g = this.g;
    const target = g.scope(r.target)?.name || r.target;
    const row = h('div', 'ms-mind-row');
    const label = h('span', 'ms-mind-row-label', `trust in ${target}`);
    if (r.nodeId && g.node(r.nodeId)) {
      const mt = meter();
      row.append(label, mt, bv.create({ node: r.nodeId, stat: 'p50' }));
      this.track(r.nodeId, () => setMeter(mt, this.engine.stats(r.nodeId)?.p50 ?? NaN));
    } else {
      const v = Number(r.value ?? 0);
      const mt = meter({ label: `trust in ${target}: ${v} (profile constant)` });
      setMeter(mt, v);
      const word = h('span', 'ms-mind-const', levelWord(v));
      word.title = 'Profile constant, not a graph metric';
      row.append(label, mt, word);
    }
    rows.appendChild(row);
    if (r.reciprocity != null) {
      const rec = h('div', 'ms-mind-row is-sub');
      const rv = Number(r.reciprocity);
      const mt = meter({ diverging: true, label: `reciprocity toward ${target}: ${rv} (profile constant, from -1 adversarial to 1 reciprocal)` });
      setMeter(mt, rv, { diverging: true });
      const word = h('span', 'ms-mind-const', reciprocityWord(rv));
      word.title = 'Reciprocity: profile constant, not a graph metric';
      rec.append(h('span', 'ms-mind-row-label', 'reciprocity'), mt, word);
      rows.appendChild(rec);
    }
  }

  /** @param {HTMLElement} rows @param {any} a */
  affectRow(rows, a) {
    const { bv } = this.host;
    const diverging = a.name === 'valence';
    const row = h('div', 'ms-mind-row');
    const vis = h('span', 'ms-mind-affect-vis');
    const mt = meter({ diverging });
    const curve = h('span', 'ms-mind-decay-host');
    vis.append(mt, curve);
    row.append(h('span', 'ms-mind-row-label', a.name), vis, bv.create({ node: a.nodeId }));
    rows.appendChild(row);
    this.track(a.nodeId, () => {
      const v = this.engine.value(a.nodeId);
      setMeter(mt, v, { diverging });
      curve.replaceChildren(decayCurve(v, a.decay, diverging));
    });
  }

  dispose() {
    this.refreshers.clear();
  }
}
