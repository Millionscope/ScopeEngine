/**
 * Scope: a sci-fi anatomy viewport over the BodyParts3D atlas (public/models).
 *  - Body and Brain views; the model auto-rotates (off with reduced motion) and the camera flies
 *    between views;
 *  - hologram shading: one fresnel ShaderMaterial per system (solid organs, glass lungs, an
 *    additive rim shell for skin and bones) plus an UnrealBloom pass for the glow;
 *  - annotations: HTML callouts with leader lines anchored at concept centers, re-projected every
 *    frame and dimmed when the anchor is behind the body; hovering or clicking one lights up its parts;
 *  - click a structure to select it: the part pulses and the detail card explains it;
 *  - HUD panels: simulated vitals / neural bands, and per-system visibility toggles;
 *  - the WebGL renderer comes from the shared GL pool and is released while the area is hidden.
 * @module editors/scope
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { acquire, release, touch, isLost, glAvailable } from '../shared/gl-pool.js';
import { surfaceOptions, ReadbackPresenter } from '../shared/gl-present.js';
import { loadCss } from '../../core/lazy.js';
import { SYSTEMS, SYSTEM_BY_ID, ANNOTATIONS, subscribeAtlas, retryAtlas, atlasState, conceptInfo } from './atlas.js';

/** three.js and add-ons, set from ctx.libs on mount (libraries load only through core/lazy.js). */
let THREE;
let OrbitControls;
let FX;

/**
 * How each system is drawn per view. kind: solid (opaque), glass (translucent), shell (additive rim).
 * Systems missing from a view are hidden in it.
 */
const STYLES = {
  body: {
    cardiac: { kind: 'solid' }, arterial: { kind: 'solid' }, venous: { kind: 'solid' }, nervous: { kind: 'solid' },
    digestive: { kind: 'solid' }, urinary: { kind: 'solid' }, endocrine: { kind: 'solid' }, lymphatic: { kind: 'solid' },
    reproductive: { kind: 'solid' }, sensory: { kind: 'solid' },
    respiratory: { kind: 'glass', opacity: 0.55 },
    skeletal: { kind: 'shell', opacity: 0.1 },
    integumentary: { kind: 'shell', opacity: 0.22 },
  },
  brain: {
    nervous: { kind: 'solid', color: '#3fd8ff' },
    arterial: { kind: 'glass', opacity: 0.25 },
    skeletal: { kind: 'shell', opacity: 0.08 },
    integumentary: { kind: 'shell', opacity: 0.12 },
  },
};
const KIND = {
  solid: { fill: 1.0, rim: 1.1, base: 1.0, order: 0 },
  glass: { fill: 0.55, rim: 1.4, base: 0.25, order: 1 },
  shell: { fill: 0.05, rim: 1.6, base: 0.02, order: 2 },
};
const VIEWS = [['body', 'Body'], ['brain', 'Brain']];

const VERT = /* glsl */`
attribute float partIndex;
uniform sampler2D uState;
uniform float uW;
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying vec2 vS;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vY = position.y;
  vS = texture2D(uState, vec2((partIndex + 0.5) / uW, 0.5)).rg;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity, uFill, uRim, uBase, uTime, uScan;
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying vec2 vS;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float ndv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.2);
  float lit = 0.3 + 0.7 * max(dot(n, normalize(vec3(0.4, 0.7, 0.6))), 0.0);
  float band = pow(fract(vY * 2.5 - uTime * 0.3), 30.0) * uScan;
  vec3 col = uColor * (uFill * lit + uRim * rim + band * 1.6);
  float pulse = 0.5 + 0.5 * sin(uTime * 5.0);
  col = mix(col, vec3(0.45, 0.9, 1.0) * (0.55 + 1.1 * rim), vS.r * (0.35 + 0.25 * pulse));
  col += uColor * vS.g * 0.5;
  float a = clamp(uOpacity * (uBase + rim) + band * 0.25 + vS.r * 0.6 + vS.g * 0.3, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
}`;

const svg = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Simulated readouts for the HUD. f(t) returns the waveform sample; v(t) the displayed value. */
const VITALS = {
  body: [
    { label: 'Heart rate', unit: 'bpm', icon: 'heart', color: '#ff4d6a', v: (t) => 72 + Math.round(2 * Math.sin(t / 7)), f: (t) => { const p = (t * 1.2) % 1; return p < 0.04 ? -0.4 : p < 0.08 ? 1 : p < 0.12 ? -0.6 : p > 0.3 && p < 0.42 ? 0.25 * Math.sin((p - 0.3) / 0.12 * Math.PI) : 0; } },
    { label: 'Blood oxygen', unit: '%', icon: 'drop', color: '#38c6ff', v: (t) => 97 + Math.round(Math.sin(t / 11) + 0.6), f: (t) => 0.6 * Math.sin(t * 7.5) + 0.25 * Math.sin(t * 15) },
    { label: 'Respiration', unit: 'rpm', icon: 'pulse', color: '#4ade80', v: (t) => 16 + Math.round(Math.sin(t / 9)), f: (t) => 0.8 * Math.sin(t * 1.7) },
    { label: 'Body temp', unit: '°C', icon: 'flame', color: '#ffc845', v: (t) => (36.6 + 0.1 * Math.sin(t / 13)).toFixed(1), f: (t) => 0.3 * Math.sin(t * 0.9) + 0.15 * Math.sin(t * 2.3) },
  ],
  brain: [
    { label: 'Alpha', unit: 'Hz', icon: 'pulse', color: '#3fd8ff', v: (t) => (10 + 0.4 * Math.sin(t / 5)).toFixed(1), f: (t) => 0.7 * Math.sin(t * 10) * (0.6 + 0.4 * Math.sin(t)) },
    { label: 'Beta', unit: 'Hz', icon: 'pulse', color: '#c58cff', v: (t) => (18 + Math.sin(t / 6)).toFixed(1), f: (t) => 0.4 * Math.sin(t * 18) + 0.2 * Math.sin(t * 31) },
    { label: 'Theta', unit: 'Hz', icon: 'pulse', color: '#4ade80', v: (t) => (6 + 0.3 * Math.sin(t / 8)).toFixed(1), f: (t) => 0.8 * Math.sin(t * 5.5) },
    { label: 'Gamma', unit: 'Hz', icon: 'pulse', color: '#ffc845', v: (t) => (40 + 2 * Math.sin(t / 4)).toFixed(0), f: (t) => 0.3 * Math.sin(t * 40) + 0.25 * Math.sin(t * 57) },
  ],
};
const WAVE_N = 60;

export default class ScopeEditor extends BaseEditor {
  static id = 'scope';
  static label = 'Scope';
  static icon = 'pulse';
  static group = 'Scope';
  static needs = ['three', 'threefx'];

  async mount(ctx, state) {
    await loadCss(new URL('./scope.css', import.meta.url));
    ({ THREE, OrbitControls } = ctx.libs.three);
    FX = ctx.libs.threefx;
    const reduce = ctx.store?.get?.('ui.reducedMotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = {
      view: state.view === 'brain' ? 'brain' : 'body',
      rotate: state.rotate ?? !reduce,
      labels: state.labels !== false,
      glow: state.glow !== false,
      hidden: new Set(Array.isArray(state.hidden) ? state.hidden : []),
    };

    const root = el('div', 'ms-ed ms-scope');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'anatomy viewer');
    this.host.setAttribute('aria-label', 'Human anatomy hologram. Drag to orbit, scroll to zoom, click a structure or a callout to inspect it. B shows the body, N the brain, R toggles rotation, Escape clears the selection.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!glAvailable()) {
      this.unavailable = true;
      this.host.replaceChildren(emptyState({ icon: 'warning', title: 'WebGL is not available', text: 'This browser or device cannot create a WebGL context, so the anatomy viewer cannot render.' }));
      return;
    }
    this.buildOverlay();
    this.buildScene();
    this.frameView(false);

    this.unsub = subscribeAtlas(() => this.onAtlas(), { THREE, mergeGeometries: FX.mergeGeometries });
    this.disposables.add({ dispose: () => this.unsub() });
    // continuous animation (rotation, pulses, waveforms) while the area is visible
    this.anim = ctx.scheduler.animate(this, (info) => this.tick(info));
    this.disposables.add(this.anim);

    this.listen(this.host, 'pointerdown', (e) => {
      const pe = /** @type {PointerEvent} */ (e);
      this._down = { x: pe.clientX, y: pe.clientY };
    });
    this.listen(this.host, 'pointerup', (e) => {
      const pe = /** @type {PointerEvent} */ (e);
      if (!this._down || Math.hypot(pe.clientX - this._down.x, pe.clientY - this._down.y) > 5) return;
      if (pe.target === this.canvasEl) this.pick(pe.clientX, pe.clientY);
    });
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.msg, 'click', () => {
      if (atlasState().error) retryAtlas();
      if (this.paused) { this.paused = false; this.msg.hidden = true; this.invalidate(); }
    });
  }

  // ------------------------------------------------------------------ scene

  buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = this.backdrop();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
    this.target = new THREE.Vector3(0, 0.88, 0);
    this.uTime = { value: 0 };
    // per-part state texture: R = selected, G = hovered (read in the vertex shader)
    this.stateW = 4096; // >= part count (2,234)
    this.stateData = new Uint8Array(this.stateW * 4);
    this.stateTex = new THREE.DataTexture(this.stateData, this.stateW, 1);
    this.stateTex.needsUpdate = true;
    /** @type {Map<string, THREE.ShaderMaterial>} */
    this.materials = new Map(SYSTEMS.map((s) => [s.id, new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: {
        uColor: { value: new THREE.Color(s.color) }, uOpacity: { value: 1 }, uFill: { value: 1 }, uRim: { value: 1 }, uBase: { value: 1 },
        uScan: { value: 1 }, uTime: this.uTime, uState: { value: this.stateTex }, uW: { value: this.stateW },
      },
    })]));
    this.body = new THREE.Group();
    this.scene.add(this.body);
    /** @type {THREE.Mesh[]} */
    this.meshes = [];

    // holographic platform: polar grid + glowing rings
    const add = (o) => { o.renderOrder = 3; return o; };
    const lineMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.platform = new THREE.Group();
    const grid = new THREE.PolarGridHelper(0.95, 24, 8, 96, 0x1d6fa5, 0x0f3d5e);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.material.depthWrite = false;
    this.platform.add(add(grid));
    this.spinners = [];
    [[0.58, 0.592, 1, 0.9], [0.7, 0.703, 1, 0.5], [0.8, 0.83, 0.32, 0.5], [0.88, 0.884, 0.75, 0.7], [0.47, 0.475, 0.5, 0.8]].forEach(([r0, r1, arc, op], i) => {
      const ring = add(new THREE.Mesh(new THREE.RingGeometry(r0, r1, 160, 1, i * 1.3, arc * Math.PI * 2), lineMat(0x38c6ff, op)));
      ring.rotation.x = -Math.PI / 2;
      ring.userData.spin = (i % 2 ? -1 : 1) * (0.05 + i * 0.04);
      this.platform.add(ring);
      this.spinners.push(ring);
    });
    const disc = add(new THREE.Mesh(new THREE.CircleGeometry(0.6, 96), lineMat(0x0b4f80, 0.35)));
    disc.rotation.x = -Math.PI / 2;
    this.platform.add(disc);
    this.scene.add(this.platform);

    // floating particles
    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 0.3 + Math.random() * 1.4;
      const a = Math.random() * Math.PI * 2;
      pos.set([Math.cos(a) * r, Math.random() * 2.1, Math.sin(a) * r], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x7fdcff, size: 0.012, map: this.dot(), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.particles);
    this.raycaster = new THREE.Raycaster();
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
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

  /** New chunks arrived (or progress/error changed). */
  onAtlas() {
    const s = atlasState();
    for (let i = this.meshes.length; i < s.meshes.length; i++) {
      const { system, geometry } = s.meshes[i];
      const mesh = new THREE.Mesh(geometry, this.materials.get(system));
      mesh.userData.system = system;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.body.add(mesh);
    }
    if (s.atlas && !this.annos) this.buildAnnotations();
    this.applyStyles();
    this.renderLoading();
    this.invalidate();
  }

  applyStyles() {
    const style = STYLES[this.state.view];
    for (const [id, m] of this.materials) {
      const st = style[id];
      if (!st) continue;
      const k = KIND[st.kind];
      const u = m.uniforms;
      u.uColor.value.set(st.color || SYSTEM_BY_ID.get(id).color);
      u.uOpacity.value = st.opacity ?? 1;
      u.uFill.value = k.fill;
      u.uRim.value = k.rim;
      u.uBase.value = k.base;
      u.uScan.value = st.kind === 'solid' ? 0.6 : 1;
      m.blending = st.kind === 'shell' ? THREE.AdditiveBlending : THREE.NormalBlending;
      m.depthWrite = st.kind === 'solid';
    }
    for (const mesh of this.meshes) {
      const st = style[mesh.userData.system];
      mesh.visible = !!st && !this.state.hidden.has(mesh.userData.system);
      if (st) mesh.renderOrder = KIND[st.kind].order;
    }
    this.renderSystems();
  }

  // ------------------------------------------------------------------ camera

  /** Fly (or jump) to the current view's framing. */
  frameView(animate = true) {
    const brain = this.state.view === 'brain';
    const box = brain ? (conceptInfo('brain')?.box ?? new THREE.Box3(new THREE.Vector3(-0.07, 1.54, -0.11), new THREE.Vector3(0.07, 1.71, 0.07)))
      : new THREE.Box3(new THREE.Vector3(-0.34, 0, -0.15), new THREE.Vector3(0.34, 1.75, 0.15));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspect = this.camera.aspect || 1;
    const fit = Math.max(size.y, size.x / aspect) / (2 * Math.tan(fov / 2));
    const dist = fit * (brain ? 2.1 : 1.15);
    const dir = brain ? new THREE.Vector3(0.55, 0.3, 1).normalize() : new THREE.Vector3(0, 0.12, 1).normalize();
    const to = { target: center, pos: center.clone().addScaledVector(dir, dist) };
    // the platform sits under the body, or becomes a halo below the brain
    this.platform.position.set(0, brain ? box.min.y - 0.02 : 0.002, 0);
    this.platform.scale.setScalar(brain ? 0.22 : 1);
    this.particles.scale.setScalar(brain ? 0.25 : 1);
    this.particles.material.size = brain ? 0.003 : 0.012; // point size ignores object scale
    this.particles.position.y = brain ? box.min.y - 0.1 : 0;
    if (!animate || !this.controls) {
      this.target.copy(to.target);
      this.camera.position.copy(to.pos);
      this.camera.lookAt(this.target);
      if (this.controls) this.controls.target.copy(this.target);
      this.fly = null;
    } else {
      this.fly = { t: 0, fromT: this.controls.target.clone(), fromP: this.camera.position.clone(), to };
    }
    if (this.controls) {
      this.controls.minDistance = brain ? 0.12 : 0.3;
      this.controls.maxDistance = brain ? 1.5 : 6;
    }
    this.invalidate();
  }

  frameAll() { this.frameView(true); }
  frameSelected() { this.frameView(true); }

  setView(view) {
    if (view === this.state.view) return;
    this.state.view = view;
    this.choose(null);
    this.applyStyles();
    this.layoutAnnotations();
    this.frameView(true);
    this.renderVitals();
    this.ctx?.refreshHeader();
    this.save();
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = info.dt / 1000;
    if (!info.reducedMotion) this.uTime.value += dt;
    if (this.controls) {
      this.controls.autoRotate = this.state.rotate && !info.reducedMotion && !this._dragging && !this.fly;
      this.controls.autoRotateSpeed = this.state.view === 'brain' ? 1.6 : 1.0;
    }
    if (this.fly && this.controls) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / 0.9);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.controls.target.lerpVectors(f.fromT, f.to.target, e);
      this.camera.position.lerpVectors(f.fromP, f.to.pos, e);
      if (f.t >= 1) this.fly = null;
    }
    if (!info.reducedMotion) {
      for (const r of this.spinners) r.rotation.z += r.userData.spin * dt;
      this.particles.rotation.y += dt * 0.03;
    }
    this.controls?.update();
    this.invalidate();
  }

  render() {
    if (!this.scene || !this.ensureRenderer()) return;
    this.bloom.enabled = this.state.glow;
    this.composer.render();
    if (this.presenter) this.present();
    touch(this);
    this.updateAnnotations();
    const now = performance.now();
    if (!this._lastWave || now - this._lastWave > 66) {
      this._lastWave = now;
      this.updateVitals(now / 1000);
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
    this.bloom = new FX.UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.35);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new FX.OutputPass());
    this.sizeRenderer();
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('start', this._onStart = () => { this._dragging = true; this.fly = null; });
    this.controls.addEventListener('end', this._onEnd = () => { this._dragging = false; });
    if (!this._framed) this.frameView(false); // first renderer: fit to the real aspect; later ones keep the camera
    this._framed = true;
    this.msg.hidden = true;
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
    this.layoutAnnotations();
    this.invalidate();
  }

  // ------------------------------------------------------------------ picking & selection

  pick(clientX, clientY) {
    if (!this.renderer) return;
    const r = this.host.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const style = STYLES[this.state.view];
    // shells (skin, bones as a rim glow) are see-through: pick what is inside them
    const targets = this.meshes.filter((m) => m.visible && style[m.userData.system]?.kind !== 'shell');
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return this.choose(null);
    const part = hit.object.geometry.attributes.partIndex.getX(hit.face.a);
    const anno = this.annos?.find((a) => a.info.parts.includes(part));
    this.choose(anno ? { anno } : { part });
  }

  /** @param {{anno?: any, part?: number}|null} sel */
  choose(sel) {
    this.selected = sel;
    this.stateData.fill(0, 0);
    if (this.hoverAnno) this.markParts(this.hoverAnno.info.parts, 1);
    if (sel?.anno) this.markParts(sel.anno.info.parts, 0);
    else if (sel && sel.part != null) this.stateData[sel.part * 4] = 255;
    this.stateTex.needsUpdate = true;
    this.annos?.forEach((a) => a.el.classList.toggle('is-selected', a === sel?.anno));
    this.renderDetail();
    this.invalidate();
  }

  /** @param {number[]} parts @param {number} channel 0 = selected, 1 = hovered */
  markParts(parts, channel) {
    for (const i of parts) this.stateData[i * 4 + channel] = 255;
  }

  setHover(anno) {
    if (this.hoverAnno === anno) return;
    this.hoverAnno = anno;
    for (let i = 1; i < this.stateData.length; i += 4) this.stateData[i] = 0;
    if (anno) this.markParts(anno.info.parts, 1);
    this.stateTex.needsUpdate = true;
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (e.target !== this.host) return;
    const k = e.key.toLowerCase();
    if (k === 'b') this.setView('body');
    else if (k === 'n') this.setView('brain');
    else if (k === 'r') this.toggle('rotate');
    else if (k === 'escape') this.choose(null);
    else if (k === 'home') this.frameView(true);
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
    if (key === 'labels') this.annoLayer.hidden = !this.state.labels;
    this.ctx?.refreshHeader();
    this.save();
    this.invalidate();
  }

  // ------------------------------------------------------------------ overlay (HUD)

  buildOverlay() {
    this.annoLayer = el('div', 'ms-sc-anno');
    this.annoLayer.hidden = !this.state.labels;
    this.lines = svg('svg');
    this.lines.setAttribute('class', 'ms-sc-lines');
    this.annoLayer.appendChild(this.lines);

    this.left = el('div', 'ms-sc-col is-left');
    this.vitalsPanel = el('section', 'ms-sc-panel');
    this.detail = el('section', 'ms-sc-panel ms-sc-detail');
    this.detail.setAttribute('aria-live', 'polite');
    this.left.append(this.vitalsPanel, this.detail);

    this.right = el('div', 'ms-sc-col is-right');
    this.systemsPanel = el('section', 'ms-sc-panel');
    this.right.append(this.systemsPanel);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    this.loading = el('div', 'ms-sc-loading');
    this.loading.setAttribute('role', 'status');
    const credit = el('a', 'ms-sc-credit', 'BodyParts3D © DBCLS · CC BY 4.0');
    credit.href = 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html';
    credit.target = '_blank';
    credit.rel = 'noreferrer';
    this.host.append(this.annoLayer, this.left, this.right, this.loading, this.msg, credit);
    this.renderVitals();
    this.renderDetail();
  }

  renderLoading() {
    const s = atlasState();
    if (s.error) {
      this.loading.hidden = true;
      this.showMsg(`Could not load the anatomy: ${s.error.message}. Click to retry.`, true);
      return;
    }
    this.loading.hidden = s.done;
    this.loading.innerHTML = `<span>Assembling anatomy · ${s.progress}%</span><i><b style="width:${s.progress}%"></b></i>`;
  }

  showMsg(text, clickable) {
    this.msg.textContent = text;
    this.msg.hidden = false;
    this.msg.classList.toggle('is-clickable', clickable);
    this.msg.setAttribute('role', clickable ? 'button' : 'status');
    this.msg.tabIndex = clickable ? 0 : -1;
  }

  renderVitals() {
    const brain = this.state.view === 'brain';
    this.vitals = VITALS[this.state.view].map((v) => ({ ...v, buf: new Float32Array(WAVE_N) }));
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', brain ? 'Neural activity' : 'Vital signs'), el('span', 'ms-sc-tag', 'Simulated'));
    const rows = this.vitals.map((v) => {
      const row = el('div', 'ms-sc-vital');
      row.style.setProperty('--c', v.color);
      const icon = el('span', `codicon codicon-${v.icon}`);
      icon.setAttribute('aria-hidden', 'true');
      const text = el('div', 'ms-sc-vital-text');
      v.valueEl = el('b', '', '');
      text.append(el('span', '', v.label), v.valueEl);
      const wave = svg('svg');
      wave.setAttribute('viewBox', `0 0 ${WAVE_N - 1} 2`);
      wave.setAttribute('preserveAspectRatio', 'none');
      wave.setAttribute('aria-hidden', 'true');
      v.line = svg('polyline');
      wave.appendChild(v.line);
      row.append(icon, text, wave);
      return row;
    });
    this.vitalsPanel.replaceChildren(head, ...rows);
    this.updateVitals(performance.now() / 1000);
  }

  /** @param {number} t seconds */
  updateVitals(t) {
    if (!this.vitals) return;
    for (const v of this.vitals) {
      v.buf.copyWithin(0, 1);
      v.buf[WAVE_N - 1] = v.f(t);
      let pts = '';
      for (let i = 0; i < WAVE_N; i++) pts += `${i},${(1 - v.buf[i]).toFixed(3)} `;
      v.line.setAttribute('points', pts);
      v.valueEl.textContent = `${v.v(t)} ${v.unit}`;
    }
  }

  renderSystems() {
    const style = STYLES[this.state.view];
    const counts = new Map();
    atlasState().atlas?.parts.forEach((p) => counts.set(p.system, (counts.get(p.system) || 0) + 1));
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'System overview'));
    const list = el('div', 'ms-sc-systems');
    for (const s of SYSTEMS) {
      if (!style[s.id]) continue;
      const on = !this.state.hidden.has(s.id);
      const b = el('button', 'ms-sc-sys');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.title = `${on ? 'Hide' : 'Show'} ${s.name.toLowerCase()}`;
      b.style.setProperty('--c', style[s.id].color || s.color);
      b.append(el('i'), el('span', '', s.name), el('small', '', on ? `${counts.get(s.id) ?? '—'}` : 'off'));
      b.addEventListener('click', () => {
        if (this.state.hidden.has(s.id)) this.state.hidden.delete(s.id);
        else this.state.hidden.add(s.id);
        this.applyStyles();
        this.save();
        this.invalidate();
      });
      list.appendChild(b);
    }
    this.systemsPanel.replaceChildren(head, list);
  }

  renderDetail() {
    const sel = this.selected;
    const atlas = atlasState().atlas;
    if (!sel || !atlas) {
      this.detail.replaceChildren(el('p', 'ms-sc-hint', this.state.view === 'brain'
        ? 'Click a callout or a brain region to inspect it.'
        : 'Click a callout or an organ to inspect it. Drag to orbit, scroll to zoom.'));
      return;
    }
    const part = sel.anno ? null : atlas.parts[sel.part];
    const system = SYSTEM_BY_ID.get(part ? part.system : sel.anno.system);
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', system?.name ?? 'Anatomy'));
    const close = el('button', 'ms-icon-btn is-small');
    close.type = 'button';
    close.setAttribute('aria-label', 'Clear selection');
    close.innerHTML = '<span class="codicon codicon-close"></span>';
    close.addEventListener('click', () => this.choose(null));
    head.appendChild(close);
    const title = el('h3', '', sel.anno ? sel.anno.title : part.name);
    title.style.setProperty('--c', system?.color ?? '#3fd8ff');
    const text = el('p', '', sel.anno ? sel.anno.text : system?.text ?? '');
    const meta = el('div', 'ms-sc-meta');
    meta.append(
      el('span', '', `Ref ${sel.anno ? sel.anno.info.id : part.conceptId}`),
      el('span', '', `${sel.anno ? sel.anno.info.parts.length : 1} piece${sel.anno && sel.anno.info.parts.length > 1 ? 's' : ''}`),
    );
    this.detail.replaceChildren(head, title, text, meta);
  }

  // ------------------------------------------------------------------ annotations

  buildAnnotations() {
    this.annos = ANNOTATIONS.map((a) => ({ ...a, info: conceptInfo(a.concept) })).filter((a) => a.info?.parts.length);
    for (const a of this.annos) {
      const b = el('button', 'ms-sc-label');
      b.type = 'button';
      const sys = SYSTEM_BY_ID.get(a.system);
      b.style.setProperty('--c', a.mode === 'brain' ? '#3fd8ff' : sys?.color ?? '#3fd8ff');
      b.append(el('b', '', a.title), el('small', '', a.mode === 'brain' ? 'Brain' : sys?.name ?? ''));
      b.addEventListener('pointerenter', () => this.setHover(a));
      b.addEventListener('pointerleave', () => this.setHover(null));
      b.addEventListener('focus', () => this.setHover(a));
      b.addEventListener('blur', () => this.setHover(null));
      b.addEventListener('click', () => this.choose(this.selected?.anno === a ? null : { anno: a }));
      a.el = b;
      a.line = svg('polyline');
      a.dot = svg('circle');
      a.dot.setAttribute('r', '3');
      a.line.style.setProperty('--c', b.style.getPropertyValue('--c'));
      a.dot.style.setProperty('--c', b.style.getPropertyValue('--c'));
      this.lines.append(a.line, a.dot);
      this.annoLayer.appendChild(b);
    }
    this.layoutAnnotations();
  }

  layoutAnnotations() {
    if (!this.annos) return;
    for (const a of this.annos) {
      const on = a.mode === this.state.view;
      a.el.hidden = !on;
      a.line.style.display = on ? '' : 'none';
      a.dot.style.display = on ? '' : 'none';
    }
  }

  /** Project anchors, place callouts in two columns beside the model and draw leader lines. */
  updateAnnotations() {
    if (!this.annos || !this.state.labels) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.lines.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const cam = this.camera;
    cam.updateMatrixWorld();
    const view = this.state.view;
    // screen half-width of the model: label columns sit just outside it
    const tgt = this.controls ? this.controls.target : this.target;
    const half = view === 'brain' ? 0.1 : 0.26;
    const right = this._w.setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(half);
    const c0 = this._v.copy(tgt).project(cam);
    const cx = (c0.x * 0.5 + 0.5) * w;
    const c1 = this._v.copy(tgt).add(right).project(cam);
    const span = Math.max(40, Math.abs((c1.x * 0.5 + 0.5) * w - cx));
    const tgtDepth = this._v.copy(tgt).applyMatrix4(cam.matrixWorldInverse).z;
    const sides = { L: [], R: [] };
    for (const a of this.annos) {
      if (a.mode !== view) continue;
      const p = this._v.copy(a.info.center).project(cam);
      a.x = (p.x * 0.5 + 0.5) * w;
      a.y = (-p.y * 0.5 + 0.5) * h;
      const depth = this._v.copy(a.info.center).applyMatrix4(cam.matrixWorldInverse).z;
      a.behind = depth < tgtDepth - (view === 'brain' ? 0.02 : 0.05);
      a.side = a.x < cx ? 'L' : 'R';
      sides[a.side].push(a);
    }
    const gap = 38;
    for (const [side, list] of Object.entries(sides)) {
      list.sort((p, q) => p.y - q.y);
      let y = -Infinity;
      for (const a of list) {
        a.ly = Math.max(a.y, y + gap);
        y = a.ly;
      }
      // pushed past the bottom: shift the column back up
      const over = y - (h - 24);
      if (over > 0) list.forEach((a) => { a.ly -= over; });
      const colX = side === 'L' ? cx - span - 36 : cx + span + 36;
      for (const a of list) {
        const ly = Math.max(14, a.ly);
        const tx = side === 'L' ? `calc(${colX}px - 100%)` : `${colX}px`;
        a.el.style.transform = `translate(${tx}, calc(${ly}px - 50%))`;
        a.el.classList.toggle('is-behind', a.behind && a !== this.selected?.anno);
        const elbow = side === 'L' ? colX + 14 : colX - 14;
        a.line.setAttribute('points', `${a.x},${a.y} ${elbow},${ly} ${colX},${ly}`);
        a.line.classList.toggle('is-behind', a.behind);
        a.line.classList.toggle('is-active', a === this.selected?.anno || a === this.hoverAnno);
        a.dot.setAttribute('cx', String(a.x));
        a.dot.setAttribute('cy', String(a.y));
      }
    }
  }

  // ------------------------------------------------------------------ header

  getHeaderTools() {
    const wrap = el('div', 'ms-row');
    const seg = el('div', 'ms-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'View');
    for (const [v, label] of VIEWS) {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(this.state?.view === v));
      b.addEventListener('click', () => this.setView(v));
      seg.appendChild(b);
    }
    wrap.appendChild(seg);
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
    frame.addEventListener('click', () => this.frameView(true));
    wrap.append(tog('rotate', 'sync', 'Auto rotate (R)'), tog('labels', 'tag', 'Annotations'), tog('glow', 'sparkle', 'Glow'), frame);
    return [wrap];
  }

  getState() {
    const { view, rotate, labels, glow, hidden } = this.state;
    return { view, rotate, labels, glow, hidden: [...hidden] };
  }

  dispose() {
    this.releaseGl();
    this.materials?.forEach((m) => m.dispose());
    this.stateTex?.dispose();
    this.scene?.background?.dispose?.();
    this.particles?.material.map?.dispose();
    // atlas geometries are shared (atlas.js); dispose only this editor's own objects
    this.scene?.traverse((o) => {
      if (o.parent === this.body) return;
      if (o.geometry) o.geometry.dispose();
      if (o.material && !(o.material instanceof THREE.ShaderMaterial)) o.material.dispose();
    });
    this.scene = null;
    this.root?.remove();
    super.dispose();
  }
}
