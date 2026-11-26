/**
 * Relationship graph: d3 force layout of the modeled parties and the scopes they relate to.
 * Edge width encodes trust (median of the trust estimate, or the profile constant), edge color
 * identifies the party holding the relationship (categorical series in fixed order). The
 * simulation is ticked by the shared scheduler (never its own timer) and stopped on dispose;
 * with reduced motion the layout is computed synchronously.
 * @module editors/minds/relations
 */
import { tableView } from '../shared/chart-table.js';
import { h, svgEl, reciprocityWord, levelWord } from './view.js';

const MIND_R = 20;
const OTHER_R = 24;

export class RelationsView {
  /**
   * @param {HTMLElement} el @param {any[]} parties
   * @param {import('./view.js').MindsHost} host
   */
  constructor(el, parties, host) {
    this.host = host;
    this.parties = parties;
    this.anim = null;
    this.sim = null;
    this.dragging = false;
    const g = host.ctx.engine.graph;
    const all = host.mind.minds;
    /** @type {Map<string, any>} */
    const nodes = new Map();
    const addNode = (id) => {
      if (!nodes.has(id)) {
        const sc = g.scope(id);
        nodes.set(id, { id, name: sc?.name || id, kind: sc?.kind || 'entity', party: null });
      }
      return nodes.get(id);
    };
    for (const p of parties) addNode(p.id).party = p;
    /** @type {any[]} */
    this.links = [];
    for (const p of parties) {
      const k = Math.max(0, all.indexOf(p));
      for (const r of p.relationships) {
        addNode(r.target);
        this.links.push({ source: p.id, target: r.target, r, party: p, k, sourceId: p.id, targetId: r.target });
      }
    }
    this.nodes = [...nodes.values()];

    this.wrap = h('div', 'ms-mind-rel');
    this.body = h('div', 'ms-mind-rel-body');
    this.wrap.appendChild(this.body);
    el.appendChild(this.wrap);
    if (host.table) this.drawTable();
    else this.drawChart();
  }

  /** Trust in [0, 1] for a link. @param {any} l */
  trust(l) {
    const id = l.r.nodeId;
    if (id && this.host.ctx.engine.graph.node(id)) {
      const st = this.host.ctx.engine.stats(id);
      return st ? st.p50 : 0;
    }
    return Number(l.r.value ?? 0);
  }

  /** Stroke width for a trust level. @param {number} t */
  widthFor(t) {
    return 1.5 + Math.max(0, Math.min(1, t)) * 8;
  }

  /** @param {any} l */
  edgeText(l) {
    const t = this.trust(l);
    const g = this.host.ctx.engine.graph;
    const tgt = g.scope(l.targetId)?.name || l.targetId;
    const trustTxt = l.r.nodeId ? `trust ${t.toFixed(2)} (median, estimated)` : `trust ${levelWord(t)} (profile constant)`;
    const rec = l.r.reciprocity != null ? `, reciprocity ${reciprocityWord(Number(l.r.reciprocity))}` : '';
    return `${l.party.name} → ${tgt}: ${trustTxt}${rec}`;
  }

  drawTable() {
    const { host } = this;
    const g = host.ctx.engine.graph;
    this.body.appendChild(tableView({
      caption: 'Relationships between modeled parties',
      columns: [{ label: 'From' }, { label: 'To' }, { label: 'Relationship' }, { label: 'Trust (median)', align: 'right' }, { label: 'Reciprocity' }],
      rows: this.links.map((l) => {
        let trust;
        if (l.r.nodeId && g.node(l.r.nodeId)) trust = host.bv.create({ node: l.r.nodeId, stat: 'p50' });
        else {
          trust = h('span', 'ms-mind-const', `${levelWord(this.trust(l))} (profile constant)`);
          trust.title = `Profile constant ${l.r.value}; not a graph metric`;
        }
        let rec = '—';
        if (l.r.reciprocity != null) {
          rec = /** @type {any} */ (h('span', 'ms-mind-const', reciprocityWord(Number(l.r.reciprocity))));
          /** @type {HTMLElement} */ (rec).title = `Profile constant ${l.r.reciprocity}; not a graph metric`;
        }
        return [l.party.name, g.scope(l.targetId)?.name || l.targetId, l.r.label, trust, rec];
      }),
    }));
  }

  drawChart() {
    const { host } = this;
    const d3 = host.d3;
    const W = Math.max(300, host.width());
    const H = Math.max(260, Math.min(480, host.height() - 120, W * 0.75));
    this.W = W;
    this.H = H;
    const box = h('div', 'ms-mind-force-box');
    const svg = /** @type {SVGSVGElement} */ (svgEl('svg', { class: 'ms-mind-force', width: W, height: H, viewBox: `0 0 ${W} ${H}` }));
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `Relationship graph: ${this.links.map((l) => this.edgeText(l)).join('; ')}`);
    const gl = svgEl('g', { class: 'edges' });
    const gn = svgEl('g', { class: 'nodes' });
    svg.append(gl, gn);
    box.appendChild(svg);
    this.body.appendChild(box);

    for (const l of this.links) {
      const grp = svgEl('g', { class: 'edge', 'data-k': l.k + 1 });
      grp.style.setProperty('--edge-color', `var(--ms-series-${l.k + 1})`);
      const line = svgEl('path', { class: 'edge-line' });
      const head = svgEl('path', { class: 'edge-head' });
      const hit = svgEl('path', { class: 'edge-hit', tabindex: 0, role: 'button' });
      hit.setAttribute('aria-label', this.edgeText(l));
      /** @type {any} */ (hit).dataset.tooltip = this.edgeText(l);
      const select = () => host.select([l.r.nodeId && host.ctx.engine.graph.node(l.r.nodeId) ? l.r.nodeId : l.sourceId]);
      hit.addEventListener('click', select);
      hit.addEventListener('keydown', (e) => { if (/** @type {KeyboardEvent} */ (e).key === 'Enter') select(); });
      hit.addEventListener('pointerenter', () => { grp.classList.add('is-hot'); if (l.r.nodeId) host.hover(l.r.nodeId); });
      hit.addEventListener('pointerleave', () => { grp.classList.remove('is-hot'); host.hover(null); });
      grp.append(line, head, hit);
      gl.appendChild(grp);
      l.el = { grp, line, head, hit };
    }
    for (const n of this.nodes) {
      const r = n.party ? MIND_R : OTHER_R;
      n.r = r;
      const grp = svgEl('g', { class: `fnode${n.party ? ' is-mind' : ''}`, tabindex: 0, role: 'button', 'data-id': n.id });
      grp.setAttribute('aria-label', `${n.name}${n.party ? ', modeled party (simulation, not assessment)' : ''}`);
      /** @type {any} */ (grp).dataset.tooltip = n.party ? `${n.name}: ${n.party.role}. Simulation, not assessment.` : `${n.name} (${n.kind})`;
      const c = svgEl('circle', { r });
      const ring = svgEl('circle', { class: 'ring', r: r + 4 });
      const t = svgEl('text', { class: 'name', y: r + 14, 'text-anchor': 'middle' });
      t.textContent = n.name;
      n.label = t;
      const ic = svgEl('text', { class: 'glyph', y: 4, 'text-anchor': 'middle' });
      ic.textContent = n.party ? n.party.lod : (n.name || '?').slice(0, 1).toUpperCase();
      grp.append(ring, c, ic, t);
      grp.addEventListener('click', () => host.select([n.id]));
      grp.addEventListener('keydown', (e) => { if (/** @type {KeyboardEvent} */ (e).key === 'Enter') host.select([n.id]); });
      grp.addEventListener('pointerenter', () => host.hover(n.id));
      grp.addEventListener('pointerleave', () => host.hover(null));
      gn.appendChild(grp);
      n.el = grp;
    }

    // legend: one row per relationship, colored line key = party, key thickness = trust
    const legend = h('ul', 'ms-mind-edges');
    legend.setAttribute('aria-label', 'Relationships');
    for (const l of this.links) {
      const li = h('li', 'ms-mind-edge-row');
      const key = h('span', 'ms-mind-edge-key');
      key.style.background = `var(--ms-series-${l.k + 1})`;
      key.setAttribute('aria-hidden', 'true');
      l.key = key;
      const g = host.ctx.engine.graph;
      const name = h('span', 'ms-mind-edge-name', `${l.party.name} → ${g.scope(l.targetId)?.name || l.targetId}`);
      li.append(key, name);
      if (l.r.nodeId && g.node(l.r.nodeId)) {
        li.append(h('span', 'ms-mind-edge-k', 'trust'), host.bv.create({ node: l.r.nodeId, stat: 'p50' }));
      } else {
        const c = h('span', 'ms-mind-const', `trust ${levelWord(this.trust(l))}, profile constant`);
        c.title = `Profile constant ${l.r.value}; not a graph metric`;
        li.appendChild(c);
      }
      if (l.r.reciprocity != null) {
        const rc = h('span', 'ms-mind-const', `· ${reciprocityWord(Number(l.r.reciprocity))}`);
        rc.title = `Reciprocity, profile constant ${l.r.reciprocity}`;
        li.appendChild(rc);
      }
      legend.appendChild(li);
    }
    const note = h('p', 'ms-mind-foot-note', 'Line width = trust. Color = the party holding the relationship. Circles with a dashed ring are modeled minds: simulation, not assessment. Drag to rearrange.');
    this.body.append(legend, note);
    this.refreshWidths();

    // simulation (stopped immediately: ticks come from the shared scheduler)
    const span = Math.min(W, H * 1.4);
    const sim = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links).id((d) => d.id).distance((l) => span * 0.34 + (1 - this.trust(l)) * span * 0.14).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-span * 2.2))
      .force('x', d3.forceX(W / 2).strength(0.04))
      .force('y', d3.forceY(H / 2).strength(0.08))
      .force('collide', d3.forceCollide((d) => d.r + 30))
      .stop();
    this.sim = sim;
    for (const n of this.nodes) {
      // deterministic start around the center
      n.x = W / 2 + (n.x ?? 0) * 0.6;
      n.y = H / 2 + (n.y ?? 0) * 0.6;
    }
    const drag = d3.drag()
      .on('start', (ev, d) => {
        this.dragging = false;
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (ev, d) => {
        if (!this.dragging) {
          // heat only once the pointer actually moves (a click does not disturb the layout)
          this.dragging = true;
          if (!host.reducedMotion()) { sim.alphaTarget(0.25); this.run(0.3); }
        }
        d.fx = Math.max(d.r, Math.min(this.W - d.r, ev.x));
        d.fy = Math.max(d.r + 22, Math.min(this.H - d.r - 22, ev.y));
        if (host.reducedMotion()) { d.x = d.fx; d.y = d.fy; this.paint(); }
      })
      .on('end', (ev, d) => {
        this.dragging = false;
        sim.alphaTarget(0);
        if (host.reducedMotion()) { d.x = d.fx; d.y = d.fy; }
        d.fx = null;
        d.fy = null;
        this.paint();
      });
    d3.select(gn).selectAll('g.fnode').data(this.nodes).call(drag);
    this.run(1);
  }

  /** Heat the simulation and tick it from the scheduler. @param {number} alpha */
  run(alpha) {
    const sim = this.sim;
    if (!sim) return;
    sim.alpha(Math.max(sim.alpha(), alpha));
    if (this.host.reducedMotion()) {
      const n = Math.ceil(Math.log(sim.alphaMin() / sim.alpha()) / Math.log(1 - sim.alphaDecay()));
      sim.tick(Math.max(1, n));
      this.clamp();
      this.paint();
      return;
    }
    if (this.anim) return;
    this.anim = this.host.ctx.scheduler.animate(this.host.owner, () => {
      sim.tick(2);
      this.clamp();
      this.paint();
      if (sim.alpha() < sim.alphaMin() && !this.dragging) this.stopAnim();
    });
  }

  stopAnim() {
    this.anim?.dispose();
    this.anim = null;
  }

  clamp() {
    for (const n of this.nodes) {
      n.x = Math.max(n.r + 6, Math.min(this.W - n.r - 6, n.x));
      n.y = Math.max(n.r + 22, Math.min(this.H - n.r - 22, n.y));
    }
  }

  paint() {
    for (const n of this.nodes) {
      n.el?.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      // labels sit on the outer side (above in the upper half) so edges rarely cross them
      n.label?.setAttribute('y', String(n.y < this.H / 2 ? -(n.r + 8) : n.r + 14));
    }
    for (const l of this.links) {
      const s = l.source;
      const t = l.target;
      if (!l.el || typeof s !== 'object') continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const w = this.widthFor(this.trust(l));
      const headLen = 7 + w * 0.9;
      const x1 = s.x + ux * (s.r + 3);
      const y1 = s.y + uy * (s.r + 3);
      const x2 = t.x - ux * (t.r + 3);
      const y2 = t.y - uy * (t.r + 3);
      const bx = x2 - ux * headLen;
      const by = y2 - uy * headLen;
      const hw = headLen * 0.55;
      l.el.line.setAttribute('d', `M${x1.toFixed(1)},${y1.toFixed(1)}L${bx.toFixed(1)},${by.toFixed(1)}`);
      l.el.head.setAttribute('d', `M${x2.toFixed(1)},${y2.toFixed(1)}L${(bx - uy * hw).toFixed(1)},${(by + ux * hw).toFixed(1)}L${(bx + uy * hw).toFixed(1)},${(by - ux * hw).toFixed(1)}Z`);
      l.el.hit.setAttribute('d', `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`);
    }
  }

  refreshWidths() {
    for (const l of this.links) {
      const w = this.widthFor(this.trust(l));
      if (l.el) {
        l.el.line.setAttribute('stroke-width', w.toFixed(2));
        l.el.hit.setAttribute('stroke-width', String(Math.max(16, w + 10)));
        const txt = this.edgeText(l);
        l.el.hit.setAttribute('aria-label', txt);
        l.el.hit.dataset.tooltip = txt;
      }
      if (l.key) l.key.style.height = `${Math.max(2, Math.round(w))}px`;
    }
  }

  /** @param {string[]} changed */
  update(changed) {
    if (this.host.table || !this.sim) return;
    const ids = new Set(changed);
    if (this.links.some((l) => l.r.nodeId && ids.has(l.r.nodeId))) {
      this.refreshWidths();
      this.paint();
    }
  }

  /** @param {string|null} id */
  onHover(id) {
    for (const n of this.nodes) n.el?.classList.toggle('is-hovered', !!id && n.id === id);
    for (const l of this.links) l.el?.grp.classList.toggle('is-hovered', !!id && l.r.nodeId === id);
  }

  /** @param {string[]} ids */
  onSelection(ids) {
    const set = new Set(ids);
    for (const n of this.nodes) n.el?.classList.toggle('is-selected', set.has(n.id));
    for (const l of this.links) l.el?.grp.classList.toggle('is-selected', !!l.r.nodeId && set.has(l.r.nodeId));
  }

  resize() {
    if (this.host.table || !this.sim) return;
    const W = Math.max(300, this.host.width());
    const H = Math.max(260, Math.min(480, this.host.height() - 120, W * 0.75));
    if (Math.abs(W - this.W) < 2 && Math.abs(H - this.H) < 2) return;
    this.W = W;
    this.H = H;
    const svg = this.body.querySelector('svg.ms-mind-force');
    svg?.setAttribute('width', String(W));
    svg?.setAttribute('height', String(H));
    svg?.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const d3 = this.host.d3;
    this.sim.force('x', d3.forceX(W / 2).strength(0.04)).force('y', d3.forceY(H / 2).strength(0.08));
    this.run(0.3);
  }

  dispose() {
    this.stopAnim();
    if (this.sim) {
      this.sim.stop();
      this.sim.on('tick', null).on('end', null);
      this.sim = null;
    }
    for (const n of this.nodes) { n.el = null; n.label = null; }
    for (const l of this.links) { l.el = null; l.key = null; }
  }
}
