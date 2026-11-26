/**
 * Agent field for the Simulation editor: the L0 customer population of one run rendered as L1
 * instanced points colored by state (prospect / customer A / customer B / lost to rival), animated
 * over steps. three.js is passed in (loaded on demand by the editor). The renderer comes from the
 * shared GL pool: this view is the pool owner (onContextEvicted, isVisible) and releases its
 * context whenever the tab or the area is hidden.
 * @module editors/simulation/field
 */
import { acquire, release, touch, isLost } from '../shared/gl-pool.js';
import { themeColors } from './colors.js';
import { surfaceOptions, ReadbackPresenter } from '../shared/gl-present.js';

/** States in the order used by the mock (0..3). `css` is the legend swatch (theme variables). */
export const FIELD_STATES = [
  { key: 'prospect', label: 'prospect', css: 'var(--vscode-descriptionForeground)' },
  { key: 'customerA', label: 'customer A (current bakery)', css: 'var(--ms-series-1)' },
  { key: 'customerB', label: 'customer B (Location B)', css: 'var(--ms-series-2)' },
  { key: 'lost', label: 'lost to rival', css: 'var(--ms-fail)' },
];

/**
 * Counts per state at a step.
 * @param {{states: Uint8Array[]}} field @param {number} step
 */
export function stateCounts(field, step) {
  const out = [0, 0, 0, 0];
  const s = field.states[Math.max(0, Math.min(field.states.length - 1, step))];
  for (let i = 0; i < s.length; i++) out[s[i]]++;
  return out;
}

const TWEEN_MS = 380;
const NEIGHBORHOODS = [
  { x: -7, label: 'Current bakery (A)', series: 0 },
  { x: 7, label: 'Location B, Harbor Street', series: 1 },
];

export class AgentFieldView {
  /**
   * @param {{
   *   host: HTMLElement, THREE: any, OrbitControls: any, scheduler: any,
   *   owner: {invalidate: () => void, isVisible: () => boolean},
   *   isVisible: () => boolean,
   *   onPaused: (text: string|null) => void,
   * }} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.THREE = opts.THREE;
    this.OrbitControls = opts.OrbitControls;
    this.scheduler = opts.scheduler;
    this.owner = opts.owner;
    this._visible = opts.isVisible;
    this.onPaused = opts.onPaused;
    const THREE = this.THREE;
    this.theme = themeColors(THREE);
    this.scene = new THREE.Scene();
    this.scene.background = this.theme.background;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    this.camera.position.set(0, 24, 30);
    this.target = new THREE.Vector3(0, -0.5, 0);
    this.camera.lookAt(this.target);
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
    this.pointGeo = new THREE.IcosahedronGeometry(0.2, 1);
    this.pointMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    /** @type {any} */
    this.mesh = null;
    /** @type {any} */
    this.field = null;
    this.step = -1;
    // neighborhood rings and shop markers
    const ring = [];
    const SEG = 72;
    for (const nb of NEIGHBORHOODS) {
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * Math.PI * 2;
        const a1 = ((k + 1) / SEG) * Math.PI * 2;
        ring.push(nb.x + Math.cos(a0) * 9.4, -0.9, Math.sin(a0) * 9.4, nb.x + Math.cos(a1) * 9.4, -0.9, Math.sin(a1) * 9.4);
      }
    }
    this.ringGeo = new THREE.BufferGeometry();
    this.ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ring), 3));
    this.ringMat = new THREE.LineBasicMaterial({ color: this.theme.muted, transparent: true, opacity: 0.45 });
    this.rings = new THREE.LineSegments(this.ringGeo, this.ringMat);
    this.scene.add(this.rings);
    this.shopGeo = new THREE.OctahedronGeometry(0.62, 0);
    this.shopMats = NEIGHBORHOODS.map((nb) => new THREE.MeshBasicMaterial({ color: this.theme.series[nb.series] || this.theme.fg }));
    this.shops = NEIGHBORHOODS.map((nb, k) => {
      const m = new THREE.Mesh(this.shopGeo, this.shopMats[k]);
      m.position.set(nb.x, 1.4, 0);
      m.scale.set(1, 1.6, 1);
      this.scene.add(m);
      return m;
    });
    // HTML labels for the two neighborhoods
    this.labels = NEIGHBORHOODS.map((nb) => {
      const el = document.createElement('div');
      el.className = 'ms-sim-nb-label';
      el.textContent = nb.label;
      el.setAttribute('aria-hidden', 'true');
      this.host.appendChild(el);
      return el;
    });
    this.paused = false;
    /** @type {any} */
    this.renderer = null;
    /** @type {any} */
    this.controls = null;
    /** @type {any} */
    this.tween = null;
  }

  /** GL pool: visible when the tab and the area are visible. */
  isVisible() {
    return this._visible();
  }

  palette() {
    const t = this.theme;
    return [t.muted, t.series[0] || t.fg, t.series[1] || t.fg, t.fail];
  }

  /**
   * Show a run's field (positions fixed for the run, states per step).
   * @param {{count: number, positions: Float32Array, states: Uint8Array[]}|null} field @param {number} step
   */
  setField(field, step) {
    const THREE = this.THREE;
    this.stopTween();
    this.field = field;
    this.step = -1;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    if (!field) {
      this.owner.invalidate();
      return;
    }
    const n = field.count;
    this.mesh = new THREE.InstancedMesh(this.pointGeo, this.pointMat, Math.max(1, n));
    this.mesh.count = n;
    this.colors = new Float32Array(n * 3);
    this.scales = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.writeMatrix(i, 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.scene.add(this.mesh);
    this.setStep(step, false);
  }

  /** @param {number} i @param {number} s */
  writeMatrix(i, s) {
    const P = this.field.positions;
    this._m.makeScale(s, s, s);
    this._m.setPosition(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    this.mesh.setMatrixAt(i, this._m);
  }

  /**
   * Color agents by their state at `step`; animate the change (color cross-fade and a short pulse
   * on agents that changed state) unless `animate` is false.
   * @param {number} step @param {boolean} animate
   */
  setStep(step, animate) {
    const f = this.field;
    if (!f || !this.mesh) return;
    const t = Math.max(0, Math.min(f.states.length - 1, step));
    const prev = this.step;
    this.step = t;
    const st = f.states[t];
    const pal = this.palette();
    const n = f.count;
    const to = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const c = pal[st[i]] || pal[0];
      to[i * 3] = c.r;
      to[i * 3 + 1] = c.g;
      to[i * 3 + 2] = c.b;
    }
    this.stopTween();
    if (this.scalesDirty) {
      // an interrupted pulse may have left agents enlarged
      for (let i = 0; i < n; i++) this.writeMatrix(i, 1);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.scalesDirty = false;
    }
    if (!animate || prev < 0 || prev === t) {
      this.colors.set(to);
      this.writeColors();
      this.owner.invalidate();
      return;
    }
    const before = f.states[prev];
    const from = this.colors.slice();
    /** @type {number[]} */
    const changed = [];
    for (let i = 0; i < n; i++) if (before[i] !== st[i]) changed.push(i);
    const t0 = performance.now();
    this.tween = this.scheduler.animate(this.owner, () => {
      const k = Math.min(1, (performance.now() - t0) / TWEEN_MS);
      const e = 1 - (1 - k) * (1 - k);
      for (let j = 0; j < n * 3; j++) this.colors[j] = from[j] + (to[j] - from[j]) * e;
      this.writeColors();
      const pulse = 1 + 1.3 * Math.sin(Math.PI * k);
      for (const i of changed) this.writeMatrix(i, k >= 1 ? 1 : pulse);
      if (changed.length) this.mesh.instanceMatrix.needsUpdate = true;
      this.owner.invalidate();
      if (k >= 1) {
        this.tween?.dispose();
        this.tween = null;
      }
    });
  }

  stopTween() {
    if (this.tween) {
      this.tween.dispose();
      this.tween = null;
      this.scalesDirty = true;
    }
  }

  writeColors() {
    const n = this.field.count;
    for (let i = 0; i < n; i++) {
      this._c.setRGB(this.colors[i * 3], this.colors[i * 3 + 1], this.colors[i * 3 + 2]);
      this.mesh.setColorAt(i, this._c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  retheme() {
    this.theme = themeColors(this.THREE);
    this.scene.background = this.theme.background;
    this.ringMat.color = this.theme.muted;
    NEIGHBORHOODS.forEach((nb, k) => { this.shopMats[k].color = this.theme.series[nb.series] || this.theme.fg; });
    if (this.field) {
      const s = this.step;
      this.step = -1;
      this.setStep(s, false);
    }
    this.owner.invalidate();
  }

  // ------------------------------------------------------------------ GL pool

  ensureRenderer() {
    if (this.paused) return false;
    if (this.renderer && isLost(this)) {
      this.release();
      this.paused = true;
      this.onPaused('The WebGL context was lost. Click to restore the agent field.');
      return false;
    }
    if (this.renderer) return true;
    try {
      this.renderer = acquire(this, this.THREE, surfaceOptions());
    } catch (err) {
      this.paused = true;
      this.onPaused(`Could not create a WebGL renderer (${/** @type {Error} */ (err).message}). Click to retry.`);
      return false;
    }
    // software GL: draw offscreen and present through an async read-back (see shared/gl-present.js)
    const offscreen = !(this.renderer.domElement instanceof HTMLCanvasElement);
    this.presenter = offscreen ? new ReadbackPresenter(this.renderer) : null;
    const canvas = this.presenter ? this.presenter.canvas : this.renderer.domElement;
    this.canvasEl = canvas;
    canvas.className = 'ms-sim-field-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    this.host.prepend(canvas);
    this.resize();
    this.controls = new this.OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = false;
    this.controls.maxDistance = 120;
    this.controls.minDistance = 4;
    this._onChange = () => {
      this.target.copy(this.controls.target);
      this.owner.invalidate();
    };
    this.controls.addEventListener('change', this._onChange);
    this._onStart = () => { this.userMoved = true; };
    this.controls.addEventListener('start', this._onStart);
    this.controls.update();
    this.onPaused(null);
    return true;
  }

  /** Called by the pool when another view needed our context. */
  onContextEvicted() {
    this.disposeControls();
    this.disposePresenter();
    this.renderer = null;
    this.paused = true;
    this.onPaused('Agent field paused to free a WebGL context (browsers cap live contexts). Click to resume.');
  }

  resume() {
    this.paused = false;
    this.onPaused(null);
    this.owner.invalidate();
  }

  disposeControls() {
    if (this.controls) {
      this.controls.removeEventListener('change', this._onChange);
      this.controls.removeEventListener('start', this._onStart);
      this.controls.dispose();
      this.controls = null;
    }
  }

  /** Release the WebGL context (tab or area hidden, dispose). */
  release() {
    this.stopTween();
    this.disposeControls();
    this.disposePresenter();
    if (this.renderer) {
      release(this);
      this.renderer = null;
    }
  }

  disposePresenter() {
    this.presentAnim?.dispose();
    this.presentAnim = null;
    this.presenter?.dispose();
    this.presenter = null;
    this.canvasEl = null;
  }

  resize() {
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
    if (!this.userMoved) this.fit();
  }

  /** Frame both neighborhoods for the current aspect (until the user moves the camera). */
  fit() {
    const THREE = this.THREE;
    const dir = new THREE.Vector3(0, 24, 30).normalize();
    const right = new THREE.Vector3(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360) * 0.94;
    const tanH = tanV * (this.camera.aspect || 1.6);
    let d = 5;
    for (const x of [-16.6, 16.6]) {
      for (const y of [-1, 3.2]) {
        for (const z of [-9.6, 9.6]) {
          const v = new THREE.Vector3(x, y, z).sub(this.target);
          const a = v.dot(dir);
          d = Math.max(d, a + Math.abs(v.dot(right)) / tanH, a + Math.abs(v.dot(up)) / tanV);
        }
      }
    }
    this.camera.position.copy(this.target).add(dir.multiplyScalar(d));
    this.camera.lookAt(this.target);
    this.controls?.update();
  }

  /** Orbit/zoom from the keyboard. @param {KeyboardEvent} e @returns {boolean} handled */
  onKey(e) {
    const THREE = this.THREE;
    const step = (Math.PI / 180) * (e.shiftKey ? 15 : 5);
    const off = this.camera.position.clone().sub(this.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    switch (e.key) {
      case 'ArrowLeft': sph.theta -= step; break;
      case 'ArrowRight': sph.theta += step; break;
      case 'ArrowUp': sph.phi = Math.max(0.08, sph.phi - step); break;
      case 'ArrowDown': sph.phi = Math.min(Math.PI / 2, sph.phi + step); break;
      case '+': case '=': sph.radius = Math.max(4, sph.radius * 0.85); break;
      case '-': case '_': sph.radius = Math.min(120, sph.radius * 1.18); break;
      default: return false;
    }
    off.setFromSpherical(sph);
    this.camera.position.copy(this.target).add(off);
    this.camera.lookAt(this.target);
    this.controls?.update();
    this.userMoved = true;
    this.owner.invalidate();
    return true;
  }

  render() {
    if (!this.ensureRenderer()) return;
    this.renderer.render(this.scene, this.camera);
    if (this.presenter) {
      this.presenter.capture();
      if (!this.presentAnim) {
        this.presentAnim = this.scheduler.animate(this.owner, () => {
          if (!this.presenter || this.presenter.poll()) {
            this.presentAnim?.dispose();
            this.presentAnim = null;
          }
        });
      }
    }
    touch(this);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    NEIGHBORHOODS.forEach((nb, k) => {
      this._v.set(nb.x, 2.9, 0).project(this.camera);
      const el = this.labels[k];
      const vis = this._v.z < 1 && this._v.z > -1;
      el.hidden = !vis;
      if (vis) el.style.transform = `translate(${Math.round((this._v.x * 0.5 + 0.5) * w)}px, ${Math.round((-this._v.y * 0.5 + 0.5) * h)}px) translate(-50%, -100%)`;
    });
  }

  dispose() {
    this.release();
    if (this.mesh) this.mesh.dispose();
    this.mesh = null;
    for (const o of [this.pointGeo, this.pointMat, this.ringGeo, this.ringMat, this.shopGeo, ...this.shopMats]) o?.dispose?.();
    for (const el of this.labels) el.remove();
    this.scene = null;
    this.field = null;
  }
}
