/**
 * 3D Scope Space (three.js). For large graphs (10k–100k metrics):
 *  - nodes: one InstancedMesh per scope cluster (per-instance color by provenance by default);
 *  - edges: a single LineSegments BufferGeometry, capped and faded by distance (fog);
 *  - layout: pure function in ./layout.js (depth on X, scope clusters on Y/Z), cached by
 *    graph id + structure version;
 *  - level of detail: clusters that are small on screen collapse into aggregate spheres sized by
 *    node count with a label; near nodes are labeled through a pool of at most 200 HTML labels;
 *  - picking: raycast against visible instances (click selects, hover highlights the cone);
 *  - recompute: changed nodes glow and a wave travels along the cone by dependency depth
 *    (skipped with reduced motion);
 *  - WebGL renderers come from the shared GL pool and are released while the area is hidden.
 * @module editors/space3d
 */
import { BaseEditor } from '../base-editor.js';
import { BoundValues } from '../shared/bound-value.js';
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { acquire, release, touch, isLost, glAvailable } from '../shared/gl-pool.js';
import { loadCss } from '../../core/lazy.js';
import { themeColors } from './colors.js';
import { PROVENANCE } from '../../theme/tokens.js';
import { layoutFor } from './layout.js';
import { baseColors, baseScales } from './encoding.js';
import { surfaceOptions, ReadbackPresenter } from '../shared/gl-present.js';

const EDGE_CAP = 60000;
const CONE_CAP = 20000;
const LABEL_MAX = 200;
const CLUSTER_LABEL_MAX = 48;
const DETAIL_ALWAYS = 3000; // graphs this small are always drawn in full detail
const DETAIL_BUDGET = 30000; // at most this many metric instances drawn in full detail per frame
const FAR_EDGE_BUDGET = 9000; // edges sampled into aggregated (far) clusters
const COLOR_KINDS = [['provenance', 'Provenance'], ['sensitivity', 'Sensitivity'], ['scope', 'Scope'], ['value', 'Value']];
const SIZE_KINDS = [['uniform', 'Uniform'], ['sensitivity', 'Sensitivity'], ['value', 'Value']];
const OUTPUT = 'sc_bakery.monthly_cash';

export default class Space3DEditor extends BaseEditor {
  static id = 'space3d';
  static label = '3D Scope Space';
  static icon = 'globe';
  static group = 'Scope';
  static needs = ['three'];

  async mount(ctx, state) {
    await loadCss(new URL('./space3d.css', import.meta.url));
    this.THREE = ctx.libs.three.THREE;
    this.OrbitControls = ctx.libs.three.OrbitControls;
    this.state = {
      colorBy: state.colorBy || 'provenance',
      sizeBy: state.sizeBy || 'uniform',
      edges: state.edges !== false,
      labels: state.labels !== false,
      camera: state.camera || null,
    };
    this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
    this.disposables.add({ dispose: () => this.bv.dispose() });

    const root = document.createElement('div');
    root.className = 'ms-ed ms-space3d';
    this.root = root;
    this.host = document.createElement('div');
    this.host.className = 'ms-s3-host';
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', '3D scope space');
    this.host.setAttribute('aria-label', '3D scope space. Drag to orbit, scroll to zoom. Arrow keys orbit, plus and minus zoom, Home frames all, period frames the selection. Left bracket moves to an input of the selected metric, right bracket to a dependent, shift with a bracket cycles siblings, Enter selects the hovered metric.');
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'ms-s3-labels';
    this.labelLayer.setAttribute('aria-hidden', 'true');
    this.hoverCard = document.createElement('div');
    this.hoverCard.className = 'ms-s3-hover';
    this.hoverCard.hidden = true;
    this.hoverCard.setAttribute('role', 'status');
    this.info = document.createElement('div');
    this.info.className = 'ms-s3-info';
    this.msg = document.createElement('div');
    this.msg.className = 'ms-s3-msg';
    this.msg.hidden = true;
    this.live = document.createElement('div');
    this.live.className = 'ms-sr-only';
    this.live.setAttribute('aria-live', 'polite');
    this.host.append(this.labelLayer, this.hoverCard, this.info, this.msg, this.live);
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!glAvailable()) {
      this.unavailable = true;
      this.host.replaceChildren(emptyState({
        icon: 'warning',
        title: 'WebGL is not available',
        text: 'This browser or device cannot create a WebGL context, so the 3D Scope Space cannot render. The 2D Scope Graph shows the same dependencies.',
        action: { label: 'Open the 2D Scope Graph', run: () => ctx.commands.executeWith('area.setType.graph', { areaId: ctx.areaId }) },
      }));
      return;
    }

    const THREE = this.THREE;
    this.theme = themeColors(THREE);
    this.scene = new THREE.Scene();
    this.scene.background = this.theme.background;
    this.scene.fog = new THREE.Fog(this.theme.background, 100, 400);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50000);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.32);
    this.sun.position.set(0.5, 1, 0.8);
    this.scene.add(this.ambient, this.sun);
    this.target = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    /** @type {any[]} */
    this.clusterMeshes = [];
    /** @type {Map<number, number>} node index -> glow start time */
    this.glow = new Map();
    this.glowAnim = null;
    this.hovered = -1;
    this.hoveredCluster = -1;
    this.externalHover = null;
    this.selectedIdx = new Set();
    /** @type {Map<string, HTMLElement>} label element per node/cluster key (stable while visible) */
    this.labelByKey = new Map();
    /** @type {HTMLElement[]} hidden pooled labels (pool never exceeds LABEL_MAX elements) */
    this.labelFree = [];

    this.buildScene();
    const hw = this.host.clientWidth;
    const hh = this.host.clientHeight;
    if (hw > 0 && hh > 0) {
      this.camera.aspect = hw / hh;
      this.camera.updateProjectionMatrix();
    }
    if (this.state.camera && this.state.camera.graph === this.graphKey) {
      this.camera.position.fromArray(this.state.camera.pos);
      this.target.fromArray(this.state.camera.target);
      this.camera.lookAt(this.target);
      this.camera.far = Math.max(2000, this.camera.position.distanceTo(this.target) * 4 + this.layout.radius * 4);
      this.camera.updateProjectionMatrix();
      this._framedOnce = true;
    } else this.frameAll(false);
    this.applySelection(ctx.services.selection.get().selected);

    // ---- input
    const pick = ctx.scheduler.rafThrottle((x, y) => this.pickHover(x, y));
    this.disposables.add({ dispose: () => pick.cancel() });
    this.listen(this.host, 'pointermove', (e) => {
      const pe = /** @type {PointerEvent} */ (e);
      if (pe.buttons) return;
      const r = this.host.getBoundingClientRect();
      pick(pe.clientX - r.left, pe.clientY - r.top);
    });
    this.listen(this.host, 'pointerleave', () => { pick.cancel(); this.setHover(-1, -1); });
    this.listen(this.host, 'pointerdown', (e) => {
      const pe = /** @type {PointerEvent} */ (e);
      this._down = { x: pe.clientX, y: pe.clientY };
    });
    this.listen(this.host, 'click', (e) => this.onClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.host, 'dblclick', (e) => this.onDblClick(/** @type {MouseEvent} */ (e)));
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.msg, 'click', () => {
      if (this.paused) {
        this.paused = false;
        this.msg.hidden = true;
        this.invalidate();
      }
    });
  }

  get graph() { return /** @type {any} */ (this.ctx).engine.graph; }

  // ------------------------------------------------------------------ scene construction

  buildScene() {
    const THREE = this.THREE;
    const g = this.graph;
    this.disposeGraphObjects();
    const t0 = performance.now();
    const { layout, meta } = layoutFor(g);
    this.layout = layout;
    this.meta = meta;
    this.graphKey = `${g.graphId}:${g.structureVersion}`;
    const n = g.list.length;
    this.n = n;
    const big = n > 20000;
    // top-level group slot per node (scope encoding): the root's children get slots 1..7, root 0
    const tops = new Map();
    const rootChildren = g.scope(g.rootId)?.children || [];
    rootChildren.forEach((c, k) => tops.set(c, k + 1));
    this.clusterTop = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const cl = meta.clusters[meta.clusterOf[i]];
      const scopeId = g.list[i].scope;
      const slot = scopeId === g.rootId ? 0 : tops.get(cl.top) ?? -1;
      this.clusterTop[i] = slot >= 0 && slot < 8 ? slot : -1;
    }
    // slot of each node inside its cluster mesh
    this.slot = new Int32Array(n);
    for (let c = 0; c < meta.clusters.length; c++) {
      const s = layout.clusterStart[c];
      for (let k = 0; k < layout.clusterCount[c]; k++) this.slot[layout.order[s + k]] = k;
    }
    // node radius: a little larger on small graphs (sparser layouts), never touching in a layer
    this.nodeR = n <= DETAIL_ALWAYS ? 0.62 : 0.5;
    this.nodeGeo = new THREE.IcosahedronGeometry(this.nodeR, big ? 0 : 1);
    this.nodeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.computeEncodings();
    for (let c = 0; c < meta.clusters.length; c++) {
      const count = layout.clusterCount[c];
      const mesh = new THREE.InstancedMesh(this.nodeGeo, this.nodeMat, Math.max(1, count));
      mesh.count = count;
      mesh.userData.cluster = c;
      const s = layout.clusterStart[c];
      for (let k = 0; k < count; k++) {
        const i = layout.order[s + k];
        this.writeMatrix(mesh, k, i);
        this._c.setRGB(this.colors[i * 3], this.colors[i * 3 + 1], this.colors[i * 3 + 2]);
        mesh.setColorAt(k, this._c);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.visible = n <= DETAIL_ALWAYS;
      this.clusterMeshes.push(mesh);
      this.scene.add(mesh);
    }
    // aggregate spheres for far clusters (level of detail)
    const C = meta.clusters.length;
    this.aggGeo = new THREE.SphereGeometry(1, 16, 10);
    this.aggMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    this.agg = new THREE.InstancedMesh(this.aggGeo, this.aggMat, Math.max(1, C));
    this.agg.count = C;
    this.aggScale = new Float32Array(C);
    this.lodFar = new Uint8Array(C);
    const startFar = n > DETAIL_ALWAYS;
    for (let c = 0; c < C; c++) {
      this.aggScale[c] = 1.2 + 1.05 * Math.cbrt(layout.clusterCount[c]);
      const s0 = startFar ? this.aggScale[c] : 0;
      this.lodFar[c] = startFar ? 1 : 0;
      this._m.makeScale(s0, s0, s0);
      this._m.setPosition(layout.clusterCenter[c * 3], layout.clusterCenter[c * 3 + 1], layout.clusterCenter[c * 3 + 2]);
      this.agg.setMatrixAt(c, this._m);
    }
    this.colorAggregates();
    this.agg.frustumCulled = false;
    this.scene.add(this.agg);
    // edges: one LineSegments geometry with one draw group per cluster (the edges into its
    // nodes); each group is stored in a shuffled order so any prefix is a uniform sample, and the
    // level of detail only changes group counts (detailed clusters: all edges, aggregated: few)
    const C0 = meta.clusters.length;
    const perCluster = new Int32Array(C0);
    for (let i = 0; i < n; i++) {
      const deps = g.depIdx[i];
      let m = 0;
      for (let j = 0; j < deps.length; j++) if (deps[j] >= 0) m++;
      perCluster[meta.clusterOf[i]] += m;
    }
    const eStart = new Int32Array(C0);
    for (let c = 1; c < C0; c++) eStart[c] = eStart[c - 1] + perCluster[c - 1];
    const total = C0 ? eStart[C0 - 1] + perCluster[C0 - 1] : 0;
    const src = new Int32Array(total);
    const dst = new Int32Array(total);
    const eFill = Int32Array.from(eStart);
    for (let i = 0; i < n; i++) {
      const deps = g.depIdx[i];
      const c = meta.clusterOf[i];
      for (let j = 0; j < deps.length; j++) {
        if (deps[j] < 0) continue;
        src[eFill[c]] = deps[j];
        dst[eFill[c]] = i;
        eFill[c]++;
      }
    }
    const P = layout.positions;
    const pos = new Float32Array(total * 6);
    const gcd = (x, y) => { while (y) [x, y] = [y, x % y]; return x; };
    for (let c = 0; c < C0; c++) {
      const m = perCluster[c];
      const s0 = eStart[c];
      let stride = Math.max(1, Math.round(m * 0.618));
      while (m > 1 && gcd(stride, m) !== 1) stride++;
      for (let q = 0; q < m; q++) {
        const e = s0 + ((q * stride) % m);
        const o = (s0 + q) * 6;
        const a0 = src[e] * 3;
        const b0 = dst[e] * 3;
        pos[o] = P[a0]; pos[o + 1] = P[a0 + 1]; pos[o + 2] = P[a0 + 2];
        pos[o + 3] = P[b0]; pos[o + 4] = P[b0 + 1]; pos[o + 5] = P[b0 + 2];
      }
    }
    this.edgeTotal = total;
    this.edgeGroupFull = perCluster;
    this.edgeGeo = new THREE.BufferGeometry();
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    for (let c = 0; c < C0; c++) this.edgeGeo.addGroup(eStart[c] * 2, perCluster[c] * 2, 0);
    this.edgeMat = new THREE.LineBasicMaterial({ color: this.theme.edge, transparent: true, opacity: n > 20000 ? 0.2 : 0.38, depthWrite: false });
    this.edges = new THREE.LineSegments(this.edgeGeo, [this.edgeMat]);
    this.edges.visible = this.state.edges;
    this.edges.frustumCulled = false;
    this.scene.add(this.edges);
    // cone highlight (hover / external hover)
    this.coneGeo = new THREE.BufferGeometry();
    this.coneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.coneGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.coneGeo.setDrawRange(0, 0);
    this.coneMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, fog: false });
    this.cone = new THREE.LineSegments(this.coneGeo, this.coneMat);
    this.cone.frustumCulled = false;
    this.cone.renderOrder = 2;
    this.scene.add(this.cone);
    // selection markers
    this.markGeo = new THREE.IcosahedronGeometry(this.nodeR * 1.9, 1);
    this.markMat = new THREE.MeshBasicMaterial({ color: this.theme.selection, wireframe: true, transparent: true, opacity: 0.95, fog: false });
    this.marks = new THREE.InstancedMesh(this.markGeo, this.markMat, 64);
    this.marks.count = 0;
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 3;
    this.scene.add(this.marks);
    this.updateEdgeLod();
    this.buildMs = performance.now() - t0;
    this.renderInfo();
    this.ctx?.refreshRegions?.();
  }

  /** @param {any} mesh @param {number} k @param {number} i */
  writeMatrix(mesh, k, i) {
    const P = this.layout.positions;
    const s = this.scales[i];
    this._m.makeScale(s, s, s);
    this._m.setPosition(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    mesh.setMatrixAt(k, this._m);
  }

  /** Recompute colors and sizes for the current encodings. */
  computeEncodings() {
    const ctx = /** @type {any} */ (this.ctx);
    const g = this.graph;
    const needSens = this.state.colorBy === 'sensitivity' || this.state.sizeBy === 'sensitivity';
    let sens = null;
    if (needSens) {
      sens = new Map();
      try {
        for (const it of ctx.engine.sensitivity(this.sensOutput()).items) sens.set(it.id, it.sobol);
      } catch { /* no output */ }
    }
    const rgb = (c) => [c.r, c.g, c.b];
    const t = this.theme;
    this.colors = baseColors({
      kind: this.state.colorBy,
      graph: g,
      engine: ctx.engine,
      clusterTop: this.clusterTop,
      colors: {
        prov: Object.fromEntries(Object.entries(t.prov).map(([k, v]) => [k, rgb(v)])),
        muted: rgb(t.muted),
        seq: t.seq.map(rgb),
        series: t.series.map(rgb),
      },
      sens,
    });
    this.scales = baseScales({ kind: this.state.sizeBy, graph: g, engine: ctx.engine, sens });
  }

  /** Output whose first-order sensitivity indices drive the sensitivity encodings. */
  sensOutput() {
    const g = this.graph;
    if (g.node(OUTPUT)) return OUTPUT;
    const out = g.list.find((n) => n.output);
    return out ? out.id : g.list[g.topo[g.topo.length - 1]]?.id || OUTPUT;
  }

  /** Push base colors (and glow) into every instance. */
  applyColors() {
    const L = this.layout;
    for (let c = 0; c < this.clusterMeshes.length; c++) {
      const mesh = this.clusterMeshes[c];
      const s = L.clusterStart[c];
      for (let k = 0; k < L.clusterCount[c]; k++) {
        const i = L.order[s + k];
        this.setNodeColor(mesh, k, i, this.glowLevel(i));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.colorAggregates();
  }

  applyScales() {
    const L = this.layout;
    for (let c = 0; c < this.clusterMeshes.length; c++) {
      const mesh = this.clusterMeshes[c];
      const s = L.clusterStart[c];
      for (let k = 0; k < L.clusterCount[c]; k++) this.writeMatrix(mesh, k, L.order[s + k]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** @param {any} mesh @param {number} k @param {number} i @param {number} glow 0..1 */
  setNodeColor(mesh, k, i, glow) {
    let r = this.colors[i * 3];
    let gg = this.colors[i * 3 + 1];
    let b = this.colors[i * 3 + 2];
    if (this.selectedIdx.has(i)) {
      const s = this.theme.selection;
      r = r * 0.35 + s.r * 0.65; gg = gg * 0.35 + s.g * 0.65; b = b * 0.35 + s.b * 0.65;
    }
    if (glow > 0) {
      const c = this.theme.cone;
      const w = Math.min(1, glow);
      r = r + (Math.min(1, c.r * 1.25 + 0.15) - r) * w;
      gg = gg + (Math.min(1, c.g * 1.25 + 0.15) - gg) * w;
      b = b + (Math.min(1, c.b * 1.25 + 0.15) - b) * w;
    }
    this._c.setRGB(r, gg, b);
    mesh.setColorAt(k, this._c);
  }

  /** Aggregate sphere color: the most common class color for categorical encodings, else the mean. */
  colorAggregates() {
    const C = this.meta.clusters.length;
    const L = this.layout;
    const categorical = this.state.colorBy === 'provenance' || this.state.colorBy === 'scope';
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (let c = 0; c < C; c++) {
      const s = L.clusterStart[c];
      const m = L.clusterCount[c];
      let r = 0; let g = 0; let b = 0;
      if (categorical) {
        counts.clear();
        let best = -1;
        let bestN = 0;
        for (let k = 0; k < m; k++) {
          const i = L.order[s + k];
          const key = ((this.colors[i * 3] * 255) << 16) | ((this.colors[i * 3 + 1] * 255) << 8) | (this.colors[i * 3 + 2] * 255);
          const n = (counts.get(key) || 0) + 1;
          counts.set(key, n);
          if (n > bestN) { bestN = n; best = i; }
        }
        if (best >= 0) { r = this.colors[best * 3]; g = this.colors[best * 3 + 1]; b = this.colors[best * 3 + 2]; }
      } else {
        for (let k = 0; k < m; k++) {
          const i = L.order[s + k];
          r += this.colors[i * 3]; g += this.colors[i * 3 + 1]; b += this.colors[i * 3 + 2];
        }
        r /= m || 1; g /= m || 1; b /= m || 1;
      }
      this._c.setRGB(r, g, b);
      this.agg.setColorAt(c, this._c);
    }
    if (this.agg.instanceColor) this.agg.instanceColor.needsUpdate = true;
  }

  disposeGraphObjects() {
    if (!this.scene) return;
    for (const m of this.clusterMeshes) { this.scene.remove(m); m.dispose?.(); }
    this.clusterMeshes = [];
    for (const key of ['agg', 'edges', 'cone', 'marks']) {
      const o = this[key];
      if (o) { this.scene.remove(o); o.dispose?.(); this[key] = null; }
    }
    for (const key of ['nodeGeo', 'nodeMat', 'aggGeo', 'aggMat', 'edgeGeo', 'edgeMat', 'coneGeo', 'coneMat', 'markGeo', 'markMat']) {
      this[key]?.dispose?.();
      this[key] = null;
    }
  }

  // ------------------------------------------------------------------ renderer (GL pool)

  ensureRenderer() {
    if (this.unavailable || this.paused) return false;
    if (this.renderer && isLost(this)) {
      this.releaseGl();
      this.showMsg('The WebGL context was lost. Click to restore the 3D view.', true);
      this.paused = true;
      return false;
    }
    if (this.renderer) return true;
    const THREE = this.THREE;
    try {
      this._aa = this.n <= 20000;
      this.renderer = acquire(this, THREE, { antialias: this._aa, ...surfaceOptions() });
    } catch (err) {
      this.showMsg(`Could not create a WebGL renderer: ${/** @type {Error} */ (err).message}. Click to retry.`, true);
      this.paused = true;
      return false;
    }
    // software GL: draw offscreen and present through an async read-back (see shared/gl-present.js)
    const offscreen = typeof HTMLCanvasElement !== 'undefined' && !(this.renderer.domElement instanceof HTMLCanvasElement);
    this.presenter = offscreen ? new ReadbackPresenter(this.renderer) : null;
    const canvas = this.presenter ? this.presenter.canvas : this.renderer.domElement;
    this.canvasEl = canvas;
    canvas.className = 'ms-s3-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    this.host.prepend(canvas);
    this.sizeRenderer();
    this.controls = new this.OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = false;
    this.controls.zoomSpeed = 1.1;
    this.controls.rotateSpeed = 0.8;
    this._onControls = () => {
      this.target.copy(this.controls.target);
      this.invalidate();
    };
    this._onControlsEnd = () => this.saveCamera();
    this.controls.addEventListener('change', this._onControls);
    this.controls.addEventListener('end', this._onControlsEnd);
    this.controls.update();
    this.msg.hidden = true;
    return true;
  }

  sizeRenderer() {
    if (!this.renderer) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    if (this.canvasEl) {
      this.canvasEl.style.width = '100%';
      this.canvasEl.style.height = '100%';
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  releaseGl() {
    if (this.controls) {
      this.controls.removeEventListener('change', this._onControls);
      this.controls.removeEventListener('end', this._onControlsEnd);
      this.controls.dispose();
      this.controls = null;
    }
    this.disposePresenter();
    if (this.renderer) {
      release(this);
      this.renderer = null;
    }
    this.canvasEl = null;
  }

  disposePresenter() {
    this.presentAnim?.dispose();
    this.presentAnim = null;
    this.presenter?.dispose();
    this.presenter = null;
  }

  /** GL pool callback: our context was evicted to make room for another view. */
  onContextEvicted() {
    if (this.controls) {
      this.controls.removeEventListener('change', this._onControls);
      this.controls.removeEventListener('end', this._onControlsEnd);
      this.controls.dispose();
      this.controls = null;
    }
    this.disposePresenter();
    this.canvasEl = null;
    this.renderer = null;
    this.paused = true;
    this.showMsg('3D view paused to free a WebGL context (browsers cap live contexts). Click to resume.', true);
  }

  /** @param {boolean} visible */
  onVisibility(visible) {
    if (this.unavailable) return;
    if (!visible) {
      this.releaseGl();
      return;
    }
    if (this.paused) {
      this.paused = false;
      this.msg.hidden = true;
    }
    this.invalidate();
  }

  /** @param {string} text @param {boolean} clickable */
  showMsg(text, clickable) {
    this.msg.textContent = text;
    this.msg.hidden = false;
    this.msg.classList.toggle('is-clickable', clickable);
    this.msg.setAttribute('role', clickable ? 'button' : 'status');
    this.msg.tabIndex = clickable ? 0 : -1;
  }

  // ------------------------------------------------------------------ rendering

  resize() {
    if (this.renderer) this.sizeRenderer();
    this.invalidate();
  }

  render() {
    if (!this.scene || !this.ensureRenderer()) return;
    this.updateLod();
    this.updateFog();
    this.renderer.render(this.scene, this.camera);
    if (this.presenter) this.present();
    touch(this);
    if (this.state.labels) this.updateLabels();
    else this.hideLabels();
  }

  /** Software GL: queue the frame for the visible canvas and poll until it is shown. */
  present() {
    const p = /** @type {ReadbackPresenter} */ (this.presenter);
    p.capture();
    if (this.presentAnim) return;
    this.presentAnim = /** @type {any} */ (this.ctx).scheduler.animate(this, () => {
      if (!this.presenter || this.presenter.poll()) {
        this.presentAnim?.dispose();
        this.presentAnim = null;
      }
    });
  }

  updateFog() {
    const d = this.camera.position.distanceTo(this.target);
    const R = this.layout.radius;
    this.scene.fog.near = Math.max(1, d - R * 0.15);
    this.scene.fog.far = d + R * 1.6 + 30;
  }

  /**
   * Level of detail: clusters that are small on screen, or beyond the detail budget, collapse into
   * one aggregate sphere sized by node count. Largest on-screen clusters get detail first.
   */
  updateLod() {
    const L = this.layout;
    const C = this.meta.clusters.length;
    if (this.n <= DETAIL_ALWAYS) {
      if (this._lodAll) return;
      this._lodAll = true;
      for (let c = 0; c < C; c++) this.clusterMeshes[c].visible = true;
      return;
    }
    const THREE = this.THREE;
    if (!this._frustum) {
      this._frustum = new THREE.Frustum();
      this._pm = new THREE.Matrix4();
      this._sphere = new THREE.Sphere();
    }
    const cam = this.camera;
    cam.updateMatrixWorld();
    this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pm);
    const h = this.host.clientHeight || 400;
    const k = h / 2 / Math.tan((cam.fov * Math.PI) / 360);
    if (!this._px || this._px.length !== C) {
      this._px = new Float32Array(C);
      this._lodOrder = Array.from({ length: C }, (_, i) => i);
    }
    const px = this._px;
    for (let c = 0; c < C; c++) {
      this._sphere.center.set(L.clusterCenter[c * 3], L.clusterCenter[c * 3 + 1], L.clusterCenter[c * 3 + 2]);
      this._sphere.radius = L.clusterRadius[c];
      if (!this._frustum.intersectsSphere(this._sphere)) { px[c] = -1; continue; }
      const dist = Math.max(0.1, this._sphere.center.distanceTo(cam.position) - L.clusterRadius[c] * 0.5);
      px[c] = (L.clusterRadius[c] / dist) * k;
    }
    const ord = this._lodOrder;
    ord.sort((a, b) => px[b] - px[a]);
    let used = 0;
    let changed = false;
    for (const c of ord) {
      const wasFar = this.lodFar[c] === 1;
      let far = wasFar;
      if (px[c] >= 0) {
        const bigEnough = wasFar ? px[c] >= 26 : px[c] >= 16;
        far = !bigEnough || used + L.clusterCount[c] > DETAIL_BUDGET;
        if (!far) used += L.clusterCount[c];
      }
      if (far !== wasFar) {
        this.lodFar[c] = far ? 1 : 0;
        this.clusterMeshes[c].visible = !far;
        const sc = far ? this.aggScale[c] : 0;
        this._m.makeScale(sc, sc, sc);
        this._m.setPosition(L.clusterCenter[c * 3], L.clusterCenter[c * 3 + 1], L.clusterCenter[c * 3 + 2]);
        this.agg.setMatrixAt(c, this._m);
        changed = true;
      }
    }
    this.detailCount = used;
    if (changed) {
      this.agg.instanceMatrix.needsUpdate = true;
      this.updateEdgeLod();
      this.updateInfoLine();
    }
  }

  /**
   * Edge level of detail: all edges into detailed clusters (up to EDGE_CAP), a uniform sample of
   * at most FAR_EDGE_BUDGET edges into aggregated clusters.
   */
  updateEdgeLod() {
    if (!this.edgeGeo) return;
    const full = this.edgeGroupFull;
    const groups = this.edgeGeo.groups;
    const C = full.length;
    const allNear = this.n <= DETAIL_ALWAYS;
    let nearSum = 0;
    let farSum = 0;
    for (let c = 0; c < C; c++) {
      if (allNear || !this.lodFar[c]) nearSum += full[c];
      else farSum += full[c];
    }
    const nearFrac = nearSum > EDGE_CAP ? EDGE_CAP / nearSum : 1;
    const farBudget = Math.max(0, Math.min(FAR_EDGE_BUDGET, EDGE_CAP - nearSum * nearFrac));
    const farFrac = farSum > farBudget ? farBudget / farSum : 1;
    let drawn = 0;
    for (let c = 0; c < C; c++) {
      const near = allNear || !this.lodFar[c];
      const m = Math.ceil(full[c] * (near ? nearFrac : farFrac));
      groups[c].count = m * 2;
      drawn += m;
    }
    this.edgeDrawn = drawn;
  }

  updateLabels() {
    const L = this.layout;
    const g = this.graph;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const cam = this.camera;
    /** @type {Array<{x: number, y: number, text: string, prov?: string, kind: string, pri: number, d: number}>} */
    const cands = [];
    const C = this.meta.clusters.length;
    const R = this.layout.radius;
    const labelDist = Math.max(40, Math.min(R * 0.9, 260));
    const project = (x, y, z) => {
      this._v.set(x, y, z).project(cam);
      if (this._v.z > 1 || this._v.z < -1) return null;
      const sx = (this._v.x * 0.5 + 0.5) * w;
      const sy = (-this._v.y * 0.5 + 0.5) * h;
      if (sx < -20 || sx > w + 20 || sy < -10 || sy > h + 10) return null;
      return [sx, sy];
    };
    const camPos = cam.position;
    // cluster labels for aggregates (and big near clusters on the overview)
    for (let c = 0; c < C; c++) {
      const far = this.lodFar[c] === 1;
      if (!far && this.n <= DETAIL_ALWAYS && C > 1) {
        // small graphs: label clusters at their center (scope names)
        const p = project(L.clusterCenter[c * 3], L.clusterCenter[c * 3 + 1] + L.clusterRadius[c] * 0.15, L.clusterCenter[c * 3 + 2]);
        if (p) cands.push({ key: `c${c}`, x: p[0], y: p[1], text: this.meta.clusters[c].name, kind: 'cluster', pri: 2, d: 0 });
        continue;
      }
      if (!far) continue;
      const p = project(L.clusterCenter[c * 3], L.clusterCenter[c * 3 + 1], L.clusterCenter[c * 3 + 2]);
      if (p) cands.push({ key: `a${c}`, x: p[0], y: p[1] - 12, text: `${this.meta.clusters[c].name} · ${L.clusterCount[c].toLocaleString('en-US')}`, kind: 'cluster', pri: 1, d: L.clusterCount[c] });
    }
    // node labels in near clusters, nearest first
    const P = L.positions;
    for (let c = 0; c < C; c++) {
      if (this.lodFar[c] === 1) continue;
      this._v.set(L.clusterCenter[c * 3], L.clusterCenter[c * 3 + 1], L.clusterCenter[c * 3 + 2]);
      if (this._v.distanceTo(camPos) > labelDist + L.clusterRadius[c]) continue;
      const s = L.clusterStart[c];
      for (let k = 0; k < L.clusterCount[c]; k++) {
        const i = L.order[s + k];
        const dx = P[i * 3] - camPos.x; const dy = P[i * 3 + 1] - camPos.y; const dz = P[i * 3 + 2] - camPos.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const special = this.selectedIdx.has(i) || i === this.hovered;
        if (d > labelDist && !special) continue;
        const p = project(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
        if (!p) continue;
        const node = g.list[i];
        const pri = special ? 4 : node.output || node.headline ? 3 : 2;
        cands.push({ key: `n${i}`, x: p[0] + 8, y: p[1] - 7, text: node.name, prov: g.displayProv(node.id), kind: 'node', pri, d });
      }
    }
    cands.sort((a, b) => b.pri - a.pri || (a.kind === 'cluster' && b.kind === 'cluster' ? b.d - a.d : a.d - b.d));
    // greedy placement: estimated label boxes, rejected when they collide with a placed one
    /** @type {Map<string, number[][]>} */
    const grid = new Map();
    const CW = 96;
    const CH = 16;
    const collides = (x0, y0, x1, y1) => {
      for (let gx = Math.floor(x0 / CW); gx <= Math.floor(x1 / CW); gx++) {
        for (let gy = Math.floor(y0 / CH); gy <= Math.floor(y1 / CH); gy++) {
          const cell = grid.get(`${gx}:${gy}`);
          if (!cell) continue;
          for (const r of cell) if (x0 < r[2] && r[0] < x1 && y0 < r[3] && r[1] < y1) return true;
        }
      }
      return false;
    };
    const occupy = (x0, y0, x1, y1) => {
      const r = [x0, y0, x1, y1];
      for (let gx = Math.floor(x0 / CW); gx <= Math.floor(x1 / CW); gx++) {
        for (let gy = Math.floor(y0 / CH); gy <= Math.floor(y1 / CH); gy++) {
          const key = `${gx}:${gy}`;
          const cell = grid.get(key);
          if (cell) cell.push(r);
          else grid.set(key, [r]);
        }
      }
    };
    let used = 0;
    let clusterLabels = 0;
    /** @type {Map<string, HTMLElement>} */
    const nextByKey = new Map();
    for (const cnd of cands) {
      if (used >= LABEL_MAX) break;
      if (cnd.kind === 'cluster' && cnd.pri === 1 && clusterLabels >= CLUSTER_LABEL_MAX) continue;
      const strong = cnd.pri >= 4;
      const w = this.labelWidth(cnd.text, cnd.kind === 'cluster') + (cnd.prov ? 14 : 0) + (strong ? 10 : 0);
      const x = cnd.kind === 'cluster' ? cnd.x - w / 2 : cnd.x;
      const y = cnd.y;
      const x1 = x + w;
      const y1 = y + (strong ? 18 : 14);
      if (collides(x - 2, y - 1, x1 + 2, y1 + 1) && !strong) continue;
      occupy(x - 2, y - 1, x1 + 2, y1 + 1);
      if (cnd.kind === 'cluster' && cnd.pri === 1) clusterLabels++;
      // reuse the element that showed this label last frame (no DOM churn while orbiting)
      let el = this.labelByKey.get(cnd.key);
      if (el) this.labelByKey.delete(cnd.key);
      else el = this.labelFree.pop() || this.makeLabel();
      nextByKey.set(cnd.key, el);
      if (el.dataset.text !== cnd.text || el.dataset.prov !== (cnd.prov || '')) {
        el.dataset.text = cnd.text;
        el.dataset.prov = cnd.prov || '';
        el.replaceChildren();
        if (cnd.prov) {
          const gl = document.createElement('span');
          gl.className = 'ms-prov';
          gl.dataset.prov = cnd.prov;
          gl.textContent = PROVENANCE[cnd.prov]?.glyph || '';
          el.appendChild(gl);
        }
        el.appendChild(document.createTextNode(cnd.text));
      }
      const cls = `ms-s3-label is-${cnd.kind}${strong ? ' is-strong' : ''}`;
      if (el.className !== cls) el.className = cls;
      const tf = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (el.style.transform !== tf) el.style.transform = tf;
      if (el.hidden) el.hidden = false;
      used++;
    }
    // labels not placed this frame go back to the pool
    for (const el of this.labelByKey.values()) {
      if (!el.hidden) el.hidden = true;
      this.labelFree.push(el);
    }
    this.labelByKey = nextByKey;
  }

  /** Estimated rendered width of a label (canvas text metrics, cached). @param {string} text @param {boolean} bold */
  labelWidth(text, bold) {
    if (!this._measure) {
      const c = document.createElement('canvas').getContext('2d');
      const family = getComputedStyle(this.labelLayer).fontFamily || 'sans-serif';
      this._measure = { c, family, cache: new Map() };
    }
    const m = this._measure;
    const key = `${bold ? 'b' : 'n'}${text}`;
    let w = m.cache.get(key);
    if (w === undefined) {
      m.c.font = `${bold ? '600 ' : ''}11px ${m.family}`;
      w = Math.min(220, Math.ceil(m.c.measureText(text).width) + 2);
      if (m.cache.size > 5000) m.cache.clear();
      m.cache.set(key, w);
    }
    return w;
  }

  makeLabel() {
    const el = document.createElement('div');
    el.className = 'ms-s3-label';
    this.labelLayer.appendChild(el);
    return el;
  }

  /** Hide every label (labels off). */
  hideLabels() {
    for (const el of this.labelByKey.values()) {
      if (!el.hidden) el.hidden = true;
      this.labelFree.push(el);
    }
    this.labelByKey.clear();
  }

  renderInfo() {
    this.info.replaceChildren();
    this.infoLine = document.createElement('div');
    this.infoLine.className = 'ms-s3-info-line';
    this.info.append(this.infoLine, this.legend());
    this.updateInfoLine();
  }

  updateInfoLine() {
    if (!this.infoLine || !this.meta) return;
    const C = this.meta.clusters.length;
    const fmt = (v) => v.toLocaleString('en-US');
    const aggregated = this.n > DETAIL_ALWAYS ? this.lodFar.reduce((a, b) => a + b, 0) : 0;
    const parts = [`${fmt(this.n)} metrics`, `${fmt(C)} clusters`, `${fmt(this.edgeDrawn)}${this.edgeDrawn < this.edgeTotal ? ` of ${fmt(this.edgeTotal)}` : ''} edges`];
    if (this.n > DETAIL_ALWAYS) parts.push(`${fmt(this.detailCount || 0)} in detail`, `${aggregated} clusters aggregated`);
    this.infoLine.textContent = parts.join(' · ');
  }

  legend() {
    const el = document.createElement('div');
    el.className = 'ms-s3-legend';
    const kind = this.state.colorBy;
    if (kind === 'provenance') {
      for (const k of ['input', 'observed', 'estimated', 'computed', 'proven']) {
        const it = document.createElement('span');
        it.append(provMark(k), document.createTextNode(PROVENANCE[k].label));
        el.appendChild(it);
      }
    } else if (kind === 'scope') {
      const g = this.graph;
      const tops = [g.rootId, ...(g.scope(g.rootId)?.children || [])].slice(0, 8);
      tops.forEach((sid, k) => {
        const it = document.createElement('span');
        const sw = document.createElement('i');
        sw.className = 'ms-s3-swatch';
        sw.style.background = `var(--ms-series-${k + 1})`;
        it.append(sw, document.createTextNode(k === 0 ? `${g.scope(sid)?.name} (own)` : g.scope(sid)?.name || sid));
        el.appendChild(it);
      });
      if ((g.scope(g.rootId)?.children.length || 0) > 7) {
        const it = document.createElement('span');
        const sw = document.createElement('i');
        sw.className = 'ms-s3-swatch is-other';
        it.append(sw, document.createTextNode('other'));
        el.appendChild(it);
      }
    } else {
      const it = document.createElement('span');
      const ramp = document.createElement('i');
      ramp.className = 'ms-s3-ramp';
      it.append(document.createTextNode(kind === 'sensitivity' ? 'low' : 'small'), ramp, document.createTextNode(kind === 'sensitivity' ? `high first-order index for ${this.graph.path(this.sensOutput())}` : 'large |value| (log)'));
      el.appendChild(it);
      if (kind === 'sensitivity') {
        const n2 = document.createElement('span');
        n2.className = 'ms-muted';
        n2.textContent = 'gray: not an input of the output';
        el.appendChild(n2);
      }
    }
    return el;
  }

  // ------------------------------------------------------------------ picking & hover

  /** @param {number} x @param {number} y returns {node, cluster} */
  pickAt(x, y) {
    if (!this.renderer) return { node: -1, cluster: -1 };
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this._v.set((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5);
    this.raycaster.setFromCamera({ x: this._v.x, y: this._v.y }, this.camera);
    const visible = this.clusterMeshes.filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(visible, false);
    let node = -1;
    let cluster = -1;
    let dist = Infinity;
    if (hits.length) {
      const hit = hits[0];
      const c = hit.object.userData.cluster;
      node = this.layout.order[this.layout.clusterStart[c] + hit.instanceId];
      dist = hit.distance;
    }
    if (this.n > DETAIL_ALWAYS) {
      const ah = this.raycaster.intersectObject(this.agg, false);
      for (const a of ah) {
        if (this.lodFar[a.instanceId] === 1 && a.distance < dist) {
          node = -1;
          cluster = a.instanceId;
          break;
        }
      }
    }
    return { node, cluster };
  }

  /** @param {number} x @param {number} y */
  pickHover(x, y) {
    const { node, cluster } = this.pickAt(x, y);
    this._hoverXY = [x, y];
    this.setHover(node, cluster);
  }

  /** @param {number} node @param {number} cluster */
  setHover(node, cluster) {
    if (node === this.hovered && cluster === this.hoveredCluster) {
      if (node >= 0 || cluster >= 0) this.placeHoverCard();
      return;
    }
    this.hovered = node;
    this.hoveredCluster = cluster;
    const g = this.graph;
    this.host.style.cursor = node >= 0 || cluster >= 0 ? 'pointer' : '';
    this.bv.releaseWithin(this.hoverCard);
    this.hoverCard.replaceChildren();
    if (node >= 0) {
      const id = g.list[node].id;
      this.hover(id);
      this.updateCone(id);
      const n = g.list[node];
      const head = document.createElement('div');
      head.className = 'ms-s3-hover-head';
      head.append(provMark(g.displayProv(id)));
      const name = document.createElement('strong');
      name.textContent = n.name;
      head.appendChild(name);
      const path = document.createElement('div');
      path.className = 'ms-s3-hover-path';
      path.textContent = g.path(id);
      const val = document.createElement('div');
      const ctx = /** @type {any} */ (this.ctx);
      const st = ctx.engine.stats(id);
      val.appendChild(this.bv.create({ node: id, stat: st && !st.deterministic ? 'p50' : 'value' }));
      if (n.type?.unit && n.type.unit !== '1') {
        const unit = document.createElement('span');
        unit.className = 'ms-s3-unit';
        unit.textContent = `${st && !st.deterministic ? 'median · ' : ''}${n.type.unit}`;
        val.appendChild(unit);
      }
      const hint = document.createElement('div');
      hint.className = 'ms-s3-hover-hint';
      hint.textContent = 'click selects · double-click frames';
      this.hoverCard.append(head, path, val, hint);
      this.hoverCard.hidden = false;
    } else if (cluster >= 0) {
      this.hover(null);
      this.updateCone(null);
      const cl = this.meta.clusters[cluster];
      const head = document.createElement('div');
      head.className = 'ms-s3-hover-head';
      const name = document.createElement('strong');
      name.textContent = cl.name;
      head.appendChild(name);
      const path = document.createElement('div');
      path.className = 'ms-s3-hover-path';
      path.textContent = `${cl.path} · ${this.layout.clusterCount[cluster].toLocaleString('en-US')} metrics (aggregated)`;
      const hint = document.createElement('div');
      hint.className = 'ms-s3-hover-hint';
      hint.textContent = 'click to zoom into this cluster';
      this.hoverCard.append(head, path, hint);
      this.hoverCard.hidden = false;
    } else {
      this.hover(null);
      this.updateCone(this.externalHover);
      this.hoverCard.hidden = true;
    }
    this.placeHoverCard();
    this.invalidate();
  }

  placeHoverCard() {
    if (this.hoverCard.hidden || !this._hoverXY) return;
    const [x, y] = this._hoverXY;
    const w = this.host.clientWidth;
    const cw = this.hoverCard.offsetWidth || 220;
    const left = x + 14 + cw > w ? x - cw - 14 : x + 14;
    this.hoverCard.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, y + 10)}px)`;
  }

  /** Highlight the downstream cone (cone color) and upstream inputs (upstream color). @param {string|null} id */
  updateCone(id) {
    const geo = this.coneGeo;
    if (!geo) return;
    if (!id || !this.graph.node(id)) {
      geo.setDrawRange(0, 0);
      return;
    }
    const g = this.graph;
    const P = this.layout.positions;
    const segs = [];
    const down = g.downstream(id);
    const up = g.upstream(id);
    const consider = (nodeId, kind) => {
      const j = g.index.get(nodeId);
      if (j === undefined) return;
      for (const d of g.depIdx[j]) {
        if (d < 0) continue;
        const depId = g.list[d].id;
        if (kind === 'down' && (depId === id || down.has(depId))) segs.push(d, j, 0);
        else if (kind === 'up' && up.has(depId)) segs.push(d, j, 1);
      }
    };
    for (const nid of down) { if (segs.length / 3 > CONE_CAP) break; consider(nid, 'down'); }
    const self = g.index.get(id);
    if (self !== undefined) for (const d of g.depIdx[self]) if (d >= 0) segs.push(d, self, 1);
    for (const nid of up) { if (segs.length / 3 > CONE_CAP * 1.5) break; consider(nid, 'up'); }
    const m = segs.length / 3;
    const pos = new Float32Array(m * 6);
    const col = new Float32Array(m * 6);
    const cc = this.theme.cone;
    const uc = this.theme.prov.estimated;
    for (let s = 0; s < m; s++) {
      const a = segs[s * 3];
      const b = segs[s * 3 + 1];
      const c = segs[s * 3 + 2] === 0 ? cc : uc;
      pos.set([P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], s * 6);
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], s * 6);
    }
    geo.setAttribute('position', new this.THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new this.THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, m * 2);
  }

  /** @param {MouseEvent} e */
  onClick(e) {
    if (this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > 4) return;
    const r = this.host.getBoundingClientRect();
    const { node, cluster } = this.pickAt(e.clientX - r.left, e.clientY - r.top);
    if (node >= 0) {
      const id = this.graph.list[node].id;
      this.select([id], { mode: e.ctrlKey || e.metaKey ? 'toggle' : 'replace' });
    } else if (cluster >= 0) {
      this.frameCluster(cluster, true);
    }
    this.host.focus({ preventScroll: true });
  }

  /** @param {MouseEvent} e */
  onDblClick(e) {
    const r = this.host.getBoundingClientRect();
    const { node, cluster } = this.pickAt(e.clientX - r.left, e.clientY - r.top);
    if (node >= 0) this.frameIndices([node], true, 10);
    else if (cluster >= 0) this.frameCluster(cluster, true);
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (!this.controls) return;
    const step = (Math.PI / 180) * (e.shiftKey ? 15 : 5);
    const off = this.camera.position.clone().sub(this.target);
    const sph = new this.THREE.Spherical().setFromVector3(off);
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': sph.theta -= step; break;
      case 'ArrowRight': sph.theta += step; break;
      case 'ArrowUp': sph.phi = Math.max(0.05, sph.phi - step); break;
      case 'ArrowDown': sph.phi = Math.min(Math.PI - 0.05, sph.phi + step); break;
      case '+': case '=': sph.radius *= 0.85; break;
      case '-': case '_': sph.radius *= 1.18; break;
      case 'Enter':
        if (this.hovered >= 0) this.select([this.graph.list[this.hovered].id]);
        break;
      case '[': this.navigate('up'); break;
      case ']': this.navigate('down'); break;
      case '{': this.navigate('prev'); break;
      case '}': this.navigate('next'); break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (!['Enter', '[', ']', '{', '}'].includes(e.key)) {
      off.setFromSpherical(sph);
      this.camera.position.copy(this.target).add(off);
      this.camera.lookAt(this.target);
      this.controls.update();
      this.invalidate();
    }
  }

  /**
   * Keyboard graph walk: 'up' to an input, 'down' to a dependent, 'prev'/'next' among siblings.
   * @param {'up'|'down'|'prev'|'next'} dir
   */
  navigate(dir) {
    const g = this.graph;
    const primary = this.selection().primary;
    const cur = primary && g.node(primary) ? primary : this.sensOutput();
    if (!g.node(cur)) return;
    if (dir === 'up' || dir === 'down') {
      const list = dir === 'up' ? [...new Set(g.node(cur).deps || [])].filter((id) => g.node(id)) : g.dependents(cur);
      if (!list.length) {
        this.announce(`${g.path(cur)} has no ${dir === 'up' ? 'inputs' : 'dependents'}.`);
        if (!primary) this.select([cur]);
        return;
      }
      this.nav = { parent: cur, dir, list, k: 0 };
    } else {
      if (!this.nav || this.nav.list[this.nav.k] !== cur) {
        this.announce('Press left or right bracket first to choose a direction.');
        return;
      }
      const n = this.nav.list.length;
      this.nav.k = (this.nav.k + (dir === 'next' ? 1 : -1) + n) % n;
    }
    const nav = /** @type {any} */ (this.nav);
    const id = nav.list[nav.k];
    this.select([id]);
    const prov = PROVENANCE[g.displayProv(id)]?.label || '';
    this.announce(`${g.path(id)}, ${prov}. ${nav.dir === 'up' ? 'Input' : 'Dependent'} ${nav.k + 1} of ${nav.list.length} of ${g.path(nav.parent)}.`);
  }

  /** @param {string} text */
  announce(text) {
    if (this.live) this.live.textContent = text;
  }

  // ------------------------------------------------------------------ camera framing

  /** @param {boolean} [animate] */
  frameAll(animate = true) {
    if (!this.layout) return;
    const L = this.layout;
    const P = L.positions;
    const center = new this.THREE.Vector3(...L.center);
    const dist = this.fitDistance(center, this.viewDir(), (cb) => {
      if (this.n <= DETAIL_ALWAYS) {
        for (let i = 0; i < this.n; i++) cb(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0.45 * (this.scales ? this.scales[i] : 1));
      } else {
        for (let c = 0; c < this.meta.clusters.length; c++) cb(L.clusterCenter[c * 3], L.clusterCenter[c * 3 + 1], L.clusterCenter[c * 3 + 2], L.clusterRadius[c] * 0.75);
      }
    });
    this.flyTo(center, dist, animate);
  }

  frameSelected() {
    const ids = [...this.selectedIdx];
    if (this.hovered >= 0 && !ids.length) ids.push(this.hovered);
    if (!ids.length) return this.frameAll();
    this.frameIndices(ids, true);
  }

  /** @param {number[]} idx @param {boolean} animate @param {number} [minRadius] */
  frameIndices(idx, animate, minRadius = 6) {
    const P = this.layout.positions;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const i of idx) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], P[i * 3 + k]);
        hi[k] = Math.max(hi[k], P[i * 3 + k]);
      }
    }
    const c = new this.THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const dist = this.fitDistance(c, this.viewDir(), (cb) => { for (const i of idx) cb(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 0.6); });
    this.flyTo(c, Math.max(dist, minRadius / tanV), animate);
  }

  /** @param {number} cl @param {boolean} animate */
  frameCluster(cl, animate) {
    const L = this.layout;
    const s = L.clusterStart[cl];
    const idx = Array.from(L.order.subarray(s, s + L.clusterCount[cl]));
    this.frameIndices(idx, animate, 6);
  }

  /** Current viewing direction (target -> camera), or the default oblique view. */
  viewDir() {
    const d = this.camera.position.clone().sub(this.target);
    if (d.lengthSq() < 1e-6 || !this._framedOnce) d.set(0.55, 0.42, 1);
    return d.normalize();
  }

  /**
   * Camera distance from `center` along `dir` that keeps every sphere in view (with a margin).
   * @param {any} center @param {any} dir unit vector, target -> camera
   * @param {(cb: (x: number, y: number, z: number, r: number) => void) => void} each
   */
  fitDistance(center, dir, each) {
    const THREE = this.THREE;
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360) * 0.92;
    const tanH = tanV * (this.camera.aspect || 1.6);
    let d = 1;
    const cx = center.x; const cy = center.y; const cz = center.z;
    each((x, y, z, r) => {
      const vx = x - cx; const vy = y - cy; const vz = z - cz;
      const a = vx * dir.x + vy * dir.y + vz * dir.z;
      const px = Math.abs(vx * right.x + vy * right.y + vz * right.z);
      const py = Math.abs(vx * up.x + vy * up.y + vz * up.z);
      d = Math.max(d, a + (px + r) / tanH, a + (py + r) / tanV, a + r + 1);
    });
    return d;
  }

  /**
   * Move the camera to look at `center` from `dist` along the current direction (animated unless
   * reduced motion or hidden).
   * @param {any} center THREE.Vector3 @param {number} dist @param {boolean} animate
   */
  flyTo(center, dist, animate) {
    const dir = this.viewDir();
    this._framedOnce = true;
    const toPos = center.clone().add(dir.multiplyScalar(dist));
    const fromPos = this.camera.position.clone();
    const fromT = this.target.clone();
    this.camera.far = Math.max(2000, dist * 4 + this.layout.radius * 4);
    this.camera.near = Math.max(0.05, dist / 3000);
    this.camera.updateProjectionMatrix();
    const ctx = /** @type {any} */ (this.ctx);
    const finish = () => {
      this.camera.position.copy(toPos);
      this.target.copy(center);
      this.camera.lookAt(this.target);
      if (this.controls) { this.controls.target.copy(this.target); this.controls.update(); }
      this.saveCamera();
      this.invalidate();
    };
    this.flyAnim?.dispose();
    this.flyAnim = null;
    if (!animate || ctx.scheduler.reducedMotion || !this.isVisible()) { finish(); return; }
    const t0 = performance.now();
    const dur = 420;
    this.flyAnim = ctx.scheduler.animate(this, () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.camera.position.lerpVectors(fromPos, toPos, e);
      this.target.lerpVectors(fromT, center, e);
      this.camera.lookAt(this.target);
      if (this.controls) this.controls.target.copy(this.target);
      this.invalidate();
      if (t >= 1) {
        this.flyAnim?.dispose();
        this.flyAnim = null;
        finish();
      }
    });
  }

  saveCamera() {
    this.state.camera = { graph: this.graphKey, pos: this.camera.position.toArray(), target: this.target.toArray() };
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 400);
  }

  // ------------------------------------------------------------------ selection, hover, recompute

  /** @param {string[]} ids */
  applySelection(ids) {
    const g = this.graph;
    const prev = this.selectedIdx;
    const next = new Set();
    for (const id of ids) {
      const i = g.index.get(id);
      if (i !== undefined) next.add(i);
      else if (g.scope(id)) for (const m of g.subtreeNodes(id).slice(0, 200)) { const j = g.index.get(m); if (j !== undefined) next.add(j); }
    }
    this.selectedIdx = next;
    for (const i of new Set([...prev, ...next])) this.refreshNodeColor(i);
    // markers
    const P = this.layout.positions;
    let k = 0;
    for (const i of next) {
      if (k >= 64) break;
      const s = this.scales[i] * 1.0;
      this._m.makeScale(s, s, s);
      this._m.setPosition(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      this.marks.setMatrixAt(k++, this._m);
    }
    this.marks.count = k;
    this.marks.instanceMatrix.needsUpdate = true;
    this.invalidate();
  }

  /** @param {number} i */
  refreshNodeColor(i) {
    const c = this.meta.clusterOf[i];
    const mesh = this.clusterMeshes[c];
    if (!mesh) return;
    this.setNodeColor(mesh, this.slot[i], i, this.glowLevel(i));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** @param {number} i */
  glowLevel(i) {
    const start = this.glow.get(i);
    if (start === undefined) return 0;
    const t = performance.now() - start;
    if (t < 0) return 0;
    return Math.max(0, 1 - t / 900);
  }

  onSelection(sel) {
    this.applySelection(sel.selected);
  }

  onHover(id) {
    if (this.hovered >= 0) return;
    this.externalHover = id && this.graph.node(id) ? id : null;
    this.updateCone(this.externalHover);
    this.invalidate();
  }

  onRecompute(changed, payload) {
    if (!this.layout || payload?.structural) return;
    const ctx = /** @type {any} */ (this.ctx);
    const g = this.graph;
    this.bv.update(changed);
    if (this.state.colorBy === 'value' || this.state.sizeBy === 'value' || ((this.state.colorBy === 'sensitivity' || this.state.sizeBy === 'sensitivity') && !payload?.transient)) {
      clearTimeout(this._encTimer);
      this._encTimer = setTimeout(() => {
        this.computeEncodings();
        this.applyColors();
        if (this.state.sizeBy !== 'uniform') this.applyScales();
        this.invalidate();
      }, payload?.transient ? 120 : 300);
    }
    if (ctx.scheduler.reducedMotion || !changed.length) return;
    // glow wave along the cone, ordered by dependency depth
    const D = this.layout.depth;
    let minD = Infinity;
    let maxD = -Infinity;
    const idx = [];
    for (const id of changed) {
      const i = g.index.get(id);
      if (i === undefined) continue;
      idx.push(i);
      if (D[i] < minD) minD = D[i];
      if (D[i] > maxD) maxD = D[i];
      if (idx.length >= 6000) break;
    }
    // the wave crosses the whole cone in at most ~0.7 s, one dependency layer at a time
    const perLayer = Math.min(55, 700 / Math.max(1, maxD - minD));
    const now = performance.now();
    for (const i of idx) this.glow.set(i, now + (D[i] - minD) * perLayer);
    if (!this.glowAnim) this.glowAnim = ctx.scheduler.animate(this, () => this.stepGlow());
  }

  stepGlow() {
    const dirty = new Set();
    for (const [i, start] of this.glow) {
      const t = performance.now() - start;
      if (t > 900) this.glow.delete(i);
      const c = this.meta.clusterOf[i];
      const mesh = this.clusterMeshes[c];
      if (!mesh) continue;
      this.setNodeColor(mesh, this.slot[i], i, this.glowLevel(i));
      dirty.add(mesh);
    }
    for (const m of dirty) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this.invalidate();
    if (!this.glow.size && this.glowAnim) {
      this.glowAnim.dispose();
      this.glowAnim = null;
    }
  }

  onStructure() {
    if (!this.scene) return;
    // antialiasing is chosen per graph size; a different choice needs a new renderer
    if (this.renderer && this._aa !== (this.graph.list.length <= 20000)) this.releaseGl();
    this.glow.clear();
    this.hovered = -1;
    this.hoveredCluster = -1;
    this._lodAll = false;
    const keepCamera = this.graphKey && this.graphKey.split(':')[0] === this.graph.graphId;
    this.buildScene();
    this.applySelection(/** @type {any} */ (this.ctx).services.selection.get().selected);
    if (!keepCamera) this.frameAll(false);
    this.invalidate();
  }

  onTheme() {
    if (!this.scene) return;
    this.theme = themeColors(this.THREE);
    this.scene.background = this.theme.background;
    this.scene.fog.color = this.theme.background;
    this.edgeMat.color = this.theme.edge;
    this.markMat.color = this.theme.selection;
    this.computeEncodings();
    this.applyColors();
    this.updateCone(this.hovered >= 0 ? this.graph.list[this.hovered].id : this.externalHover);
    this.renderInfo();
    this.invalidate();
  }

  // ------------------------------------------------------------------ header & regions

  getHeaderMenus() {
    return [{
      label: 'View',
      items: () => [
        { label: 'Frame All', key: 'Home', run: () => this.frameAll() },
        { label: 'Frame Selected', key: '.', run: () => this.frameSelected() },
        { separator: true },
        { label: 'Show Edges', checked: this.state.edges, run: () => { this.state.edges = !this.state.edges; if (this.edges) this.edges.visible = this.state.edges; this.save(); this.invalidate(); } },
        { label: 'Show Labels', checked: this.state.labels, run: () => { this.state.labels = !this.state.labels; this.save(); this.invalidate(); } },
      ],
    }];
  }

  getHeaderTools() {
    const wrap = document.createElement('div');
    wrap.className = 'ms-row';
    const mk = (label, kinds, value, onChange) => {
      const sel = document.createElement('select');
      sel.className = 'ms-select is-small';
      sel.setAttribute('aria-label', label);
      sel.dataset.tooltip = label;
      for (const [v, l] of kinds) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = `${label.split(' ')[0]}: ${l}`;
        if (v === value) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    };
    wrap.appendChild(mk('Color by', COLOR_KINDS, this.state.colorBy, (v) => {
      this.state.colorBy = v;
      this.save();
      if (!this.layout) return;
      this.computeEncodings();
      this.applyColors();
      this.renderInfo();
      this.invalidate();
    }));
    wrap.appendChild(mk('Size by', SIZE_KINDS, this.state.sizeBy, (v) => {
      this.state.sizeBy = v;
      this.save();
      if (!this.layout) return;
      this.computeEncodings();
      this.applyScales();
      this.applySelection(/** @type {any} */ (this.ctx).services.selection.get().selected);
      this.invalidate();
    }));
    const btn = (icon, label, run) => {
      const b = document.createElement('button');
      b.className = 'ms-icon-btn is-small';
      b.setAttribute('aria-label', label);
      b.dataset.tooltip = label;
      b.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
      b.addEventListener('click', run);
      return b;
    };
    wrap.append(btn('target', 'Focus selection (.)', () => this.frameSelected()), btn('screen-full', 'Frame all (Home)', () => this.frameAll()));
    return [wrap];
  }

  renderSidebar(el) {
    if (!this.meta) { el.innerHTML = '<div class="ms-region-empty">No graph.</div>'; return; }
    const L = this.layout;
    const list = document.createElement('div');
    list.className = 'ms-s3-clusters';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Scope clusters');
    const idx = this.meta.clusters.map((c, i) => i).sort((a, b) => L.clusterCount[b] - L.clusterCount[a]).slice(0, 300);
    for (const c of idx) {
      const b = document.createElement('button');
      b.className = 'ms-s3-cluster';
      b.setAttribute('role', 'listitem');
      const name = document.createElement('span');
      name.className = 'ms-ellipsis';
      name.textContent = this.meta.clusters[c].path;
      const n = document.createElement('span');
      n.className = 'ms-muted ms-tabular';
      n.textContent = L.clusterCount[c].toLocaleString('en-US');
      b.append(name, n);
      b.title = `Frame ${this.meta.clusters[c].path}`;
      b.addEventListener('click', () => this.frameCluster(c, true));
      list.appendChild(b);
    }
    const note = document.createElement('div');
    note.className = 'ms-region-empty';
    note.textContent = `Layout: dependency depth on X (0–${L.maxDepth}), scope clusters on Y/Z. Built in ${Math.round(this.buildMs || 0)} ms.`;
    el.append(note, list);
  }

  getState() {
    return { colorBy: this.state.colorBy, sizeBy: this.state.sizeBy, edges: this.state.edges, labels: this.state.labels, camera: this.state.camera };
  }

  /** Test/debug helper: screen position (relative to the area) of a metric node. @param {string} id */
  screenPositionOf(id) {
    const i = this.graph.index.get(id);
    if (i === undefined || !this.layout) return null;
    const P = this.layout.positions;
    this._v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).project(this.camera);
    const r = this.host.getBoundingClientRect();
    return { x: r.left + (this._v.x * 0.5 + 0.5) * r.width, y: r.top + (-this._v.y * 0.5 + 0.5) * r.height };
  }

  dispose() {
    clearTimeout(this._saveTimer);
    clearTimeout(this._encTimer);
    this.glowAnim?.dispose();
    this.flyAnim?.dispose();
    this.releaseGl();
    this.disposePresenter();
    this.disposeGraphObjects();
    this.scene = null;
    this.root?.remove();
    super.dispose();
  }
}

