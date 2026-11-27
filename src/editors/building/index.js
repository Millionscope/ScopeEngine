/**
 * Building: a holographic Burj Khalifa (public/mesh/scene.gltf, CC BY 4.0, SDC PERFORMANCE).
 *  - the glTF's materials are replaced by one fresnel hologram ShaderMaterial (Atlas style: rim,
 *    drifting scan bands, UnrealBloom glow) plus a fill that climbs the tower bottom to top;
 *  - camera tour (loop, tour.js): overview → fly down to the base → spiral up around the fixed
 *    tower, the glow rising with the camera → top → back to the overview. Dragging pauses it; it
 *    resumes after a few idle seconds;
 *  - the WebGL renderer comes from the shared GL pool and is released while the area is hidden.
 * @module editors/building
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { acquire, release, touch, isLost, glAvailable } from '../shared/gl-pool.js';
import { surfaceOptions, ReadbackPresenter } from '../shared/gl-present.js';
import { loadCss } from '../../core/lazy.js';
import { tourAt } from './tour.js';

/** three.js and add-ons, set from ctx.libs on mount. */
let THREE;
let OrbitControls;
let FX;
let GLTFLoader;

const MODEL_URL = '/mesh/scene.gltf';
const H = 10; // tower height in scene units (the model is scaled to it)
const REAL_M = 828; // real height, for the altitude readout
const IDLE_RESUME_MS = 8000;
const FULL_GLOW = { sweep: 1.03, fill: 1, dim: 0 };

const VERT = /* glsl */`
uniform float uHeight;
varying vec3 vN;
varying vec3 vV;
varying float vH;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * w;
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vH = w.y / uHeight;
  gl_Position = projectionMatrix * mv;
}`;
// hologram (Atlas FRAG): fresnel rim + lit term + drifting scan band; below uSweep the tower fills
// with uHot and a bright line marks the front (uFill 0 hides both); the rest dims by uDim
const FRAG = /* glsl */`
uniform vec3 uColor, uHot;
uniform float uTime, uSweep, uFill, uDim, uOpacity;
varying vec3 vN;
varying vec3 vV;
varying float vH;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float ndv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.2);
  float lit = 0.3 + 0.7 * max(dot(n, normalize(vec3(0.4, 0.7, 0.6))), 0.0);
  float band = pow(fract(vH * 6.0 - uTime * 0.25), 30.0);
  float d = uSweep - vH;
  float filled = step(0.0, d) * uFill;
  float line = smoothstep(0.006, 0.0, abs(d)) * uFill;
  float dim = uDim * (1.0 - filled); // unfilled (or fading) parts dim
  vec3 col = uColor * (0.35 * lit + 1.1 * rim + band * 1.4);
  col = mix(col, uHot * (0.35 + 0.45 * lit + 1.2 * rim), filled * 0.7);
  col *= 1.0 - 0.6 * dim;
  col += uHot * line * 1.2;
  float a = (uOpacity * (0.12 + rim) + band * 0.15) * (1.0 - 0.4 * dim) + filled * 0.12 + line * 0.35;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export default class BuildingEditor extends BaseEditor {
  static id = 'building';
  static label = 'Building';
  static icon = 'home';
  static group = 'Scope';
  static needs = ['three', 'threefx', 'gltf'];

  async mount(ctx, state) {
    await loadCss(new URL('../scope/scope.css', import.meta.url));
    ({ THREE, OrbitControls } = ctx.libs.three);
    FX = ctx.libs.threefx;
    GLTFLoader = ctx.libs.gltf;
    this.reduce = ctx.store?.get?.('ui.reducedMotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = { tour: state.tour ?? !this.reduce, glow: state.glow !== false };
    this.tourT = 0;
    this.touring = this.state.tour;
    this.idleSince = 0;
    this.phase = '';

    const root = el('div', 'ms-ed ms-scope');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'building viewer');
    this.host.setAttribute('aria-label', 'Burj Khalifa hologram. Drag to orbit, scroll to zoom. T toggles the camera tour, Home resets the camera.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!glAvailable()) {
      this.unavailable = true;
      this.host.replaceChildren(emptyState({ icon: 'warning', title: 'WebGL is not available', text: 'This browser or device cannot create a WebGL context, so the building cannot render.' }));
      return;
    }
    this.buildScene();
    this.buildOverlay();
    this.pose(tourAt(0), this.camera.position, this.target);
    this.camera.lookAt(this.target);
    this.loadModel();

    this.anim = ctx.scheduler.animate(this, (info) => this.tick(info));
    this.disposables.add(this.anim);
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.msg, 'click', () => {
      if (this.loadError) { this.msg.hidden = true; this.loadModel(); }
      if (this.paused) { this.paused = false; this.msg.hidden = true; this.invalidate(); }
    });
  }

  // ------------------------------------------------------------------ scene

  buildScene() {
    const scene = (this.scene = new THREE.Scene());
    scene.background = this.backdrop();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.02, 200);
    this.target = new THREE.Vector3();
    this.uTime = { value: 0 };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      // depth-written: the model nests 11 shells, and additive blending stacks them into a white-out
      uniforms: {
        uColor: { value: new THREE.Color('#3fd8ff') }, uHot: { value: new THREE.Color('#9ff4ff') },
        uOpacity: { value: 0.6 }, uHeight: { value: H }, uSweep: { value: 1.03 }, uFill: { value: 1 }, uDim: { value: 0 }, uTime: this.uTime,
      },
    });
    this.tower = new THREE.Group();
    scene.add(this.tower);

    // holographic platform under the tower (Atlas): polar grid + spinning arcs
    const lineMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const grid = new THREE.PolarGridHelper(H * 0.55, 24, 8, 96, 0x1d6fa5, 0x0f3d5e);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.material.depthWrite = false;
    scene.add(grid);
    this.spinners = [[0.3, 0.304, 1, 0.8], [0.38, 0.39, 0.32, 0.5], [0.46, 0.462, 0.75, 0.7], [0.53, 0.536, 1, 0.5]].map(([r0, r1, arc, op], i) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r0 * H, r1 * H, 160, 1, i * 1.3, arc * Math.PI * 2), lineMat(0x38c6ff, op));
      ring.rotation.x = -Math.PI / 2;
      ring.userData.spin = (i % 2 ? -1 : 1) * (0.05 + i * 0.04);
      scene.add(ring);
      return ring;
    });

    // dust drifting around the tower
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = H * (0.12 + Math.random() * 0.9);
      const a = Math.random() * Math.PI * 2;
      pos.set([Math.cos(a) * r, Math.random() * H * 1.1, Math.sin(a) * r], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x7fdcff, size: 0.05, map: this.dot(), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(this.particles);
    this._v = new THREE.Vector3();
    this._t = new THREE.Vector3();
  }

  /** Soft round sprite for the particles. */
  dot() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }

  /** Navy radial gradient behind the hologram. */
  backdrop() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(256, 230, 10, 256, 256, 360);
    grad.addColorStop(0, '#0c2a4a');
    grad.addColorStop(0.55, '#061426');
    grad.addColorStop(1, '#02060d');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ponytail: loads (and parses 24 MB) on every mount; a module-level cache of the parsed scene is
  // the upgrade path if the editor gets reopened often.
  loadModel() {
    this.loadError = null;
    this.loading.hidden = false;
    new GLTFLoader().load(MODEL_URL, (gltf) => {
      if (this._disposed) return gltf.scene.traverse((o) => o.geometry?.dispose());
      this.loading.hidden = true;
      this.placeModel(gltf.scene);
      this.invalidate();
    }, undefined, (err) => {
      this.loading.hidden = true;
      this.loadError = err;
      this.showMsg(`Could not load the tower model: ${err?.message ?? err}. Click to retry.`, true);
    });
  }

  /** Swap in the hologram material, scale the tower to H and stand its spire axis on the origin. */
  placeModel(model) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y;
    // the footprint is off-centre (podium): orbit the axis through the top 15%, not the box centre
    const top = new THREE.Box3();
    const v = this._v;
    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m.dispose());
      o.material = this.mat;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i += 4) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        if (v.y > box.max.y - 0.15 * h) top.expandByPoint(v);
      }
    });
    const axis = top.getCenter(new THREE.Vector3());
    const k = H / h;
    this.tower.scale.setScalar(k);
    this.tower.position.set(-axis.x * k, -box.min.y * k, -axis.z * k);
    this.tower.add(model);
  }

  // ------------------------------------------------------------------ camera

  /** Write a tour pose (tower-height units, tour.js) into pos / tgt. */
  pose(p, pos, tgt) {
    pos.set(Math.cos(p.az) * p.r * H, p.y * H, Math.sin(p.az) * p.r * H);
    tgt.set(0, p.ty * H, 0);
  }

  startTour() {
    this.touring = true;
    this.fly = { t: 0, fromP: this.camera.position.clone(), fromT: (this.controls?.target ?? this.target).clone() };
  }

  stopTour() {
    this.touring = false;
    this.fly = null;
    this.idleSince = performance.now();
  }

  frameAll() {
    this.tourT = 0;
    if (this.state.tour && !this.reduce) return this.startTour();
    this.pose(tourAt(0), this._v, this._t);
    this.fly = { t: 0, fromP: this.camera.position.clone(), fromT: (this.controls?.target ?? this.target).clone(), to: { pos: this._v.clone(), tgt: this._t.clone() } };
    this.invalidate();
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = Math.min(info.dt / 1000, 0.1);
    const moving = !info.reducedMotion;
    if (moving) {
      this.uTime.value += dt;
      for (const r of this.spinners) r.rotation.z += r.userData.spin * dt;
      this.particles.rotation.y += dt * 0.02;
    }
    const tgt = this.controls ? this.controls.target : this.target;
    if (this.state.tour && !this.touring && !this._dragging && moving && performance.now() - this.idleSince > IDLE_RESUME_MS) this.startTour();

    if (this.touring && moving) {
      this.tourT += dt;
      const p = tourAt(this.tourT);
      this.phase = p.phase;
      this.pose(p, this._v, this._t);
      if (this.fly) this.blendFly(dt, this._v, this._t);
      else { this.camera.position.copy(this._v); tgt.copy(this._t); }
      this.camera.lookAt(tgt);
      this.glowTo(p, this.fly ? dt * 2 : Infinity); // resuming mid-loop: ease in with the camera
    } else {
      if (this.fly?.to) this.blendFly(dt, this.fly.to.pos, this.fly.to.tgt);
      this.phase = this.state.tour && moving ? 'Manual · tour resumes' : 'Manual';
      this.glowTo(FULL_GLOW, dt * 2); // out of the tour the whole tower glows
      this.controls?.update();
    }
    if (!this.controls) this.camera.lookAt(tgt);
    this.invalidate();
  }

  /** Move the glow uniforms towards a tour state (rate 1/s; Infinity = jump). */
  glowTo(p, rate) {
    const u = this.mat.uniforms;
    const k = Math.min(1, rate);
    u.uSweep.value += (p.sweep - u.uSweep.value) * k;
    u.uFill.value += (p.fill - u.uFill.value) * k;
    u.uDim.value += (p.dim - u.uDim.value) * k;
  }

  /** Ease the camera from the fly start towards a (possibly moving) pose. */
  blendFly(dt, toP, toT) {
    const f = this.fly;
    f.t = Math.min(1, f.t + dt / 2);
    const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
    this.camera.position.lerpVectors(f.fromP, toP, e);
    (this.controls?.target ?? this.target).lerpVectors(f.fromT, toT, e);
    this.camera.lookAt(this.controls?.target ?? this.target);
    if (f.t >= 1) this.fly = null;
  }

  render() {
    if (!this.scene || !this.ensureRenderer()) return;
    this.bloom.enabled = this.state.glow;
    this.composer.render();
    if (this.presenter) this.present();
    touch(this);
    const now = performance.now();
    if (!this._lastHud || now - this._lastHud > 200) {
      this._lastHud = now;
      this.updateHud();
    }
  }

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
    try {
      this.renderer = acquire(this, THREE, { antialias: true, ...surfaceOptions() });
    } catch (err) {
      this.showMsg(`Could not create a WebGL renderer: ${/** @type {Error} */ (err).message}. Click to retry.`, true);
      this.paused = true;
      return false;
    }
    const offscreen = typeof HTMLCanvasElement !== 'undefined' && !(this.renderer.domElement instanceof HTMLCanvasElement);
    this.presenter = offscreen ? new ReadbackPresenter(this.renderer) : null;
    const canvas = this.presenter ? this.presenter.canvas : this.renderer.domElement;
    this.canvasEl = canvas;
    canvas.className = 'ms-sc-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    this.host.prepend(canvas);
    this.composer = new FX.EffectComposer(this.renderer);
    this.composer.addPass(new FX.RenderPass(this.scene, this.camera));
    this.bloom = new FX.UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new FX.OutputPass());
    this.sizeRenderer();
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = H * 0.05;
    this.controls.maxDistance = H * 4;
    this.controls.addEventListener('start', this._onStart = () => { this._dragging = true; this.stopTour(); });
    this.controls.addEventListener('end', this._onEnd = () => { this._dragging = false; this.idleSince = performance.now(); });
    this.msg.hidden = !this.loadError;
    return true;
  }

  sizeRenderer() {
    if (!this.renderer) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    if (this.canvasEl) {
      this.canvasEl.style.width = '100%';
      this.canvasEl.style.height = '100%';
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dropGl() {
    if (this.controls) {
      this.target.copy(this.controls.target);
      this.controls.removeEventListener('start', this._onStart);
      this.controls.removeEventListener('end', this._onEnd);
      this.controls.dispose();
      this.controls = null;
    }
    this.composer?.dispose();
    this.bloom?.dispose();
    this.composer = null;
    this.bloom = null;
    this.presentAnim?.dispose();
    this.presentAnim = null;
    this.presenter?.dispose();
    this.presenter = null;
    this.canvasEl = null;
  }

  releaseGl() {
    this.dropGl();
    if (this.renderer) {
      release(this);
      this.renderer = null;
    }
  }

  /** GL pool callback: our context was evicted to make room for another view. */
  onContextEvicted() {
    this.dropGl();
    this.renderer = null;
    this.paused = true;
    this.showMsg('Viewer paused to free a WebGL context (browsers cap live contexts). Click to resume.', true);
  }

  /** @param {boolean} visible */
  onVisibility(visible) {
    if (this.unavailable) return;
    if (!visible) return this.releaseGl();
    if (this.paused) { this.paused = false; this.msg.hidden = true; }
    this.invalidate();
  }

  resize() {
    if (this.renderer) this.sizeRenderer();
    this.invalidate();
  }

  // ------------------------------------------------------------------ overlay (HUD)

  buildOverlay() {
    this.left = el('div', 'ms-sc-col is-left');
    this.detail = el('section', 'ms-sc-panel ms-sc-detail');
    this.detail.setAttribute('aria-live', 'polite');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Burj Khalifa · Dubai'));
    this.phaseEl = el('h3', '', '');
    this.phaseEl.style.setProperty('--c', '#3fd8ff');
    const text = el('p', '', 'World’s tallest building: 828 m, 163 floors, completed 2010. The hologram fills from the base as the camera climbs.');
    const meta = el('div', 'ms-sc-meta');
    this.altEl = el('span', '', '');
    meta.append(this.altEl, el('span', '', '828 m · 163 fl'));
    this.detail.append(head, this.phaseEl, text, meta);
    this.left.append(this.detail);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    this.loading = el('div', 'ms-sc-loading');
    this.loading.setAttribute('role', 'status');
    this.loading.innerHTML = '<span>Loading tower model…</span>';
    // CC BY 4.0: attribution is required
    const credit = el('a', 'ms-sc-credit', 'Burj Khalifa model © SDC PERFORMANCE · CC BY 4.0');
    credit.href = 'https://sketchfab.com/3d-models/free-burj-khalifa-dubai-c1d6f5884c9c4a56b8d8f9c5555f1902';
    credit.target = '_blank';
    credit.rel = 'noreferrer';
    this.host.append(this.left, this.loading, this.msg, credit);
  }

  updateHud() {
    if (this.phaseEl.textContent !== this.phase) this.phaseEl.textContent = this.phase;
    const alt = Math.max(0, Math.round((this.camera.position.y / H) * REAL_M));
    this.altEl.textContent = `Camera ${alt} m`;
  }

  showMsg(text, clickable) {
    this.msg.textContent = text;
    this.msg.hidden = false;
    this.msg.classList.toggle('is-clickable', clickable);
    this.msg.setAttribute('role', clickable ? 'button' : 'status');
    this.msg.tabIndex = clickable ? 0 : -1;
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (e.target !== this.host) return;
    const k = e.key.toLowerCase();
    if (k === 't') this.toggle('tour');
    else if (k === 'home') this.frameAll();
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
    if (key === 'tour') {
      if (this.state.tour) this.startTour();
      else this.stopTour();
    }
    this.ctx?.refreshHeader();
    this.save();
    this.invalidate();
  }

  getHeaderTools() {
    const wrap = el('div', 'ms-row');
    const tog = (key, icon, label) => {
      const b = el('button', 'ms-icon-btn is-small ms-toggle');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(!!this.state?.[key]));
      b.setAttribute('aria-label', label);
      b.dataset.tooltip = label;
      b.innerHTML = `<span class="codicon codicon-${icon}"></span>`;
      b.addEventListener('click', () => this.toggle(key));
      return b;
    };
    const frame = el('button', 'ms-icon-btn is-small');
    frame.type = 'button';
    frame.setAttribute('aria-label', 'Reset camera (Home)');
    frame.dataset.tooltip = 'Reset camera (Home)';
    frame.innerHTML = '<span class="codicon codicon-screen-full"></span>';
    frame.addEventListener('click', () => this.frameAll());
    wrap.append(tog('tour', 'device-camera-video', 'Camera tour (T)'), tog('glow', 'sparkle', 'Glow'), frame);
    return [wrap];
  }

  getState() {
    const { tour, glow } = this.state;
    return { tour, glow };
  }

  dispose() {
    this.releaseGl();
    this.mat?.dispose();
    this.scene?.background?.dispose?.();
    this.particles?.material.map?.dispose();
    this.scene?.traverse((o) => {
      o.geometry?.dispose();
      if (o.material && o.material !== this.mat) o.material.dispose();
    });
    this.scene = null;
    this.root?.remove();
    super.dispose();
  }
}
