/**
 * Nested beliefs: the party (depth 0), what it believes and how it models others (depth 1),
 * and how it models others modeling it (depth 2). d3 tree or radial layout; links in SVG,
 * nodes as HTML so each estimate is a live BoundValue. Table alternative lists the same rows.
 * @module editors/minds/nested
 */
import { tableView } from '../shared/chart-table.js';
import { h, icon, partyStrip, svgEl } from './view.js';

const DEPTH_TEXT = ['the party', 'beliefs and models of others', 'models of others modeling it'];

export class NestedView {
  /**
   * @param {HTMLElement} el @param {any} m party profile
   * @param {import('./view.js').MindsHost} host
   */
  constructor(el, m, host) {
    this.host = host;
    this.m = m;
    this.wrap = h('div', 'ms-mind-nested');
    this.wrap.appendChild(partyStrip(m, host));

    const bar = h('div', 'ms-mind-viewbar');
    const legend = h('div', 'ms-mind-depths');
    legend.setAttribute('aria-label', 'Depth legend');
    DEPTH_TEXT.forEach((t, i) => {
      const item = h('span', 'ms-mind-depth-item');
      item.append(h('span', 'ms-mind-depth-badge', `depth ${i}`), document.createTextNode(t));
      legend.appendChild(item);
    });
    bar.appendChild(legend);
    if (!host.table) {
      const seg = h('div', 'ms-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Layout');
      for (const [label, val] of [['Tree', 'tree'], ['Radial', 'radial']]) {
        const b = /** @type {HTMLButtonElement} */ (h('button', null, label));
        b.type = 'button';
        b.setAttribute('aria-pressed', String(host.layout === val));
        b.addEventListener('click', () => host.setLayout(/** @type {'tree'|'radial'} */ (val)));
        seg.appendChild(b);
      }
      bar.appendChild(seg);
    }
    this.wrap.appendChild(bar);

    this.body = h('div', 'ms-mind-nested-body');
    this.wrap.appendChild(this.body);
    const note = h('p', 'ms-mind-foot-note');
    note.textContent = 'Each level is an estimated distribution in the graph (median shown). Nested beliefs are simulated: they describe how the model represents the party, not what the person thinks.';
    this.wrap.appendChild(note);
    el.appendChild(this.wrap);
    this.draw();
  }

  /** Rows in depth-first order. */
  rows() {
    /** @type {Array<{depth: number, label: string, nodeId?: string}>} */
    const out = [];
    const walk = (n, depth) => {
      out.push({ depth, label: depth === 0 ? this.m.name : n.label, nodeId: n.nodeId });
      for (const c of n.children || []) walk(c, depth + 1);
    };
    walk(this.m.nested, 0);
    return out;
  }

  draw() {
    const { host } = this;
    const g = host.ctx.engine.graph;
    host.bv.releaseWithin(this.body);
    this.body.replaceChildren();
    if (host.table) {
      this.body.appendChild(tableView({
        caption: `Nested beliefs of ${this.m.name}`,
        columns: [{ label: 'Depth' }, { label: 'Belief or model' }, { label: 'Median', align: 'right' }],
        rows: this.rows().map((r) => {
          const label = h('span', 'ms-mind-tbl-indent', r.label);
          label.style.paddingLeft = `${r.depth * 16}px`;
          return [`depth ${r.depth}`, label, r.nodeId && g.node(r.nodeId) ? host.bv.create({ node: r.nodeId, stat: 'p50' }) : '—'];
        }),
      }));
      return;
    }
    const d3 = host.d3;
    const root = d3.hierarchy(this.m.nested, (d) => (d.children && d.children.length ? d.children : null));
    const W = Math.max(200, host.width());
    const radial = host.layout === 'radial';
    const narrow = !radial && W < 470;
    const chart = h('div', `ms-mind-tree${radial ? ' is-radial' : ''}${narrow ? ' is-indent' : ''}`);
    chart.setAttribute('role', 'list');
    chart.setAttribute('aria-label', `Nested beliefs of ${this.m.name}, ${root.height + 1} levels`);
    const svg = /** @type {SVGSVGElement} */ (svgEl('svg', { class: 'ms-mind-tree-svg', 'aria-hidden': 'true' }));
    chart.appendChild(svg);
    /** @type {Array<{node: any, x: number, y: number}>} */
    const placed = [];
    let width = W;
    let height;
    const nodeW = radial ? 140 : narrow ? Math.max(140, Math.min(260, W - 28 - root.height * 22)) : Math.max(130, Math.min(210, (W - 40 - root.height * 36) / (root.height + 1)));
    const nodeH = 70; // estimated box height for spacing (labels wrap to two lines at most)
    const pathFor = [];
    if (radial) {
      // radial: rings per depth; rotated a quarter turn so boxes do not line up on one row,
      // and the ring gap grows until no two boxes overlap
      d3.tree().size([2 * Math.PI, 1]).separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth))(root);
      const rot = -Math.PI / 4;
      const nodes = root.descendants();
      let gap = 150;
      const posAt = (n, gp) => [n.depth * gp * Math.sin(n.x + rot), -n.depth * gp * Math.cos(n.x + rot)];
      const overlaps = (gp) => {
        const pts = nodes.map((n) => posAt(n, gp));
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            if (Math.abs(pts[i][0] - pts[j][0]) < nodeW + 12 && Math.abs(pts[i][1] - pts[j][1]) < nodeH + 12) return true;
          }
        }
        return false;
      };
      for (let k = 0; k < 8 && overlaps(gap); k++) gap *= 1.2;
      const pts = nodes.map((n) => posAt(n, gap));
      const minX = Math.min(...pts.map((p) => p[0])) - nodeW / 2;
      const maxX = Math.max(...pts.map((p) => p[0])) + nodeW / 2;
      const minY = Math.min(...pts.map((p) => p[1])) - nodeH / 2;
      const maxY = Math.max(...pts.map((p) => p[1])) + nodeH / 2;
      width = Math.max(W, maxX - minX + 40);
      height = maxY - minY + 40;
      const cx = (width - (maxX - minX)) / 2 - minX;
      const cy = 20 - minY;
      for (let dpt = 1; dpt <= root.height; dpt++) svg.appendChild(svgEl('circle', { class: 'ring', cx, cy, r: gap * dpt }));
      nodes.forEach((n, i) => placed.push({ node: n, x: cx + pts[i][0], y: cy + pts[i][1] }));
      for (const l of root.links()) {
        const s = placed.find((p) => p.node === l.source);
        const t = placed.find((p) => p.node === l.target);
        if (s && t) pathFor.push({ d: `M${s.x.toFixed(1)},${s.y.toFixed(1)}L${t.x.toFixed(1)},${t.y.toFixed(1)}`, depth: l.target.depth });
      }
    } else if (narrow) {
      // indented list: one row per node, depth as indentation
      let row = 0;
      root.eachBefore((n) => {
        placed.push({ node: n, x: 8 + n.depth * 22, y: 8 + row * (nodeH + 8) });
        row++;
      });
      height = 8 + row * (nodeH + 8);
      for (const l of root.links()) {
        const s = placed.find((p) => p.node === l.source);
        const t = placed.find((p) => p.node === l.target);
        if (!s || !t) continue;
        pathFor.push({ d: `M${s.x + 10},${s.y + 12}V${t.y + 22}H${t.x}`, depth: l.target.depth });
      }
    } else {
      // horizontal tree with fixed spacing: siblings one row apart, cousins a little more
      const rowH = nodeH + 16;
      const colW = nodeW + Math.max(36, (W - 40 - (root.height + 1) * nodeW) / Math.max(1, root.height));
      d3.tree().nodeSize([rowH, colW]).separation((a, b) => (a.parent === b.parent ? 1 : 1.25))(root);
      let minX = Infinity;
      let maxX = -Infinity;
      root.each((n) => { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); });
      height = maxX - minX + rowH + 16;
      root.each((n) => placed.push({ node: n, x: 20 + n.y, y: 8 + rowH / 2 + (n.x - minX) }));
      const link = d3.linkHorizontal().x((p) => p[0]).y((p) => p[1]);
      for (const l of root.links()) {
        const s = placed.find((p) => p.node === l.source);
        const t = placed.find((p) => p.node === l.target);
        if (!s || !t) continue;
        pathFor.push({ d: link({ source: [s.x + nodeW, s.y], target: [t.x, t.y] }), depth: l.target.depth });
      }
    }
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    for (const p of pathFor) {
      const path = svgEl('path', { class: 'link', d: p.d, 'data-depth': p.depth });
      if (p.transform) path.setAttribute('transform', p.transform);
      svg.appendChild(path);
    }
    chart.style.height = `${height}px`;
    chart.style.minWidth = `${width}px`;
    for (const p of placed) chart.appendChild(this.nodeBox(p, nodeW, radial, narrow, g));
    this.body.appendChild(chart);
  }

  /**
   * @param {{node: any, x: number, y: number}} p @param {number} nodeW
   * @param {boolean} radial @param {boolean} narrow @param {any} g
   */
  nodeBox(p, nodeW, radial, narrow, g) {
    const { host } = this;
    const n = p.node;
    const depth = n.depth;
    const box = h('div', 'ms-mind-tnode');
    box.dataset.depth = String(depth);
    box.setAttribute('role', 'listitem');
    box.style.width = `${nodeW}px`;
    if (radial) {
      box.style.left = `${p.x}px`;
      box.style.top = `${p.y}px`;
      box.classList.add('is-centered');
    } else if (narrow) {
      box.style.left = `${p.x}px`;
      box.style.top = `${p.y}px`;
    } else {
      box.style.left = `${p.x}px`;
      box.style.top = `${p.y}px`;
      box.classList.add('is-middle');
    }
    const nodeId = n.data.nodeId;
    if (nodeId) box.dataset.node = nodeId;
    const head = h('div', 'ms-mind-tnode-head');
    head.appendChild(h('span', 'ms-mind-depth-badge', `depth ${depth}`));
    if (depth === 0) head.appendChild(icon('person'));
    box.appendChild(head);
    const label = /** @type {HTMLButtonElement} */ (h('button', 'ms-mind-tnode-label', depth === 0 ? this.m.name : n.data.label));
    label.type = 'button';
    const target = nodeId || this.m.id;
    label.title = nodeId && g.node(nodeId) ? `${g.node(nodeId).label || g.path(nodeId)}\nClick to select` : 'Select this Mind Scope';
    label.addEventListener('click', () => host.select([target]));
    label.addEventListener('pointerenter', () => host.hover(target));
    label.addEventListener('pointerleave', () => host.hover(null));
    box.appendChild(label);
    if (nodeId && g.node(nodeId)) box.appendChild(host.bv.create({ node: nodeId, stat: 'p50' }));
    else if (depth === 0) box.appendChild(h('span', 'ms-mind-tnode-sub', this.m.role));
    box.setAttribute('aria-label', `depth ${depth}: ${depth === 0 ? this.m.name : n.data.label}`);
    return box;
  }

  /** @param {string|null} id */
  onHover(id) {
    for (const b of this.body.querySelectorAll('.ms-mind-tnode')) {
      const el = /** @type {HTMLElement} */ (b);
      el.classList.toggle('is-hovered', !!id && el.dataset.node === id);
    }
  }

  resize() { this.draw(); }

  dispose() {}
}
