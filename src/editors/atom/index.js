/**
 * Atom: a holographic Bohr-style atom built from primitives (no model download).
 *  - proportions follow public/atom/scene.gltf (Atom by LucasPresoto, CC BY 4.0): three orbits
 *    (r 1.2 / 1.7 / 2.0) sharing one diameter axis 60° apart, 2 + 4 + 4 electrons, 14 nucleons;
 *  - each orbit spins forever about its own normal (perpendicular to its plane), carrying its
 *    electrons; a comet trail in the ring shader follows each electron;
 *  - fresnel hologram shaders + UnrealBloom; cool cyan/violet shells around a warm glowing nucleus;
 *  - the WebGL renderer comes from the shared GL pool and is released while the area is hidden.
 * @module editors/atom
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { acquire, release, touch, isLost, glAvailable } from '../shared/gl-pool.js';
import { surfaceOptions, ReadbackPresenter } from '../shared/gl-present.js';
import { loadCss } from '../../core/lazy.js';

/** three.js and add-ons, set from ctx.libs on mount. */
let THREE;
let OrbitControls;
let FX;

const HOME = [0.8, 1.8, 8.6];
// orbits: radius, electrons, electron radius, plane angle about the shared z axis, spin (rad/s), colour
const ORBITS = [
  { r: 1.2, n: 2, e: 0.11, phi: 60, w: 1.5, color: '#6dffe4' },
  { r: 1.7, n: 4, e: 0.11, phi: 120, w: -1.0, color: '#3fb8ff' },
  { r: 2.0, n: 4, e: 0.13, phi: 0, w: 0.7, color: '#a78bff' },
];
const TUBE = 0.035;
const NUCLEON_R = 0.178;
// nucleon centres measured from the glTF (14 spheres, alternating proton / neutron), centred below
const NUCLEONS = [
  [-0.016, 0.17, -0.138], [0.017, -0.197, -0.142], [0.169, 0.115, 0.082], [-0.007, -0.006, -0.258], [-0.212, 0.067, 0.216],
  [0.208, -0.058, 0.183], [-0.078, -0.242, 0.208], [0.015, 0.022, 0.315], [0.04, 0.219, 0.193], [0.166, -0.031, -0.131],
  [-0.2, -0.045, -0.149], [-0.193, 0.123, 0.046], [0.11, -0.193, 0.081], [-0.187, -0.165, 0.081],
];
const PROTON = '#ff6a3d';
const NEUTRON = '#ffc46b';

const VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}`;
// orbit ring: fresnel rim + a comet trail behind each of the uN evenly spaced electrons
// (uv.x runs around the torus; uDir is the spin direction so the trail stays behind)
const RING_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uN, uDir;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(1.0 - ndv, 2.0);
  float t = fract(-uDir * vUv.x * uN);
  float trail = pow(1.0 - t, 7.0);
  vec3 col = uColor * (0.25 + 0.7 * rim + 1.8 * trail);
  gl_FragColor = vec4(col, clamp(0.35 + 0.5 * rim + 0.6 * trail, 0.0, 1.0));
}`;
// solid glowing sphere: white-hot core fading to its colour at the rim, breathing with uTime
const BALL_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uGain, uTime;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  float ndv = clamp(dot(n, normalize(vV)), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.0);
  float lit = 0.45 + 0.55 * max(dot(n, normalize(vec3(0.4, 0.7, 0.6))), 0.0);
  float pulse = 0.9 + 0.1 * sin(uTime * 2.2);
  vec3 col = mix(uColor * lit, vec3(1.0), 0.15 * ndv * ndv) + uColor * rim * 1.2;
  gl_FragColor = vec4(col * uGain * pulse, 1.0);
}`;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export default class AtomEditor extends BaseEditor {
  static id = 'atom';
  static label = 'Atom';
  static icon = 'symbol-misc';
  static group = 'Scope';
  static needs = ['three', 'threefx'];

  async mount(ctx, state) {
    await loadCss(new URL('../scope/scope.css', import.meta.url));
    ({ THREE, OrbitControls } = ctx.libs.three);
    FX = ctx.libs.threefx;
    this.state = { spin: state.spin !== false, glow: state.glow !== false };

    const root = el('div', 'ms-ed ms-scope');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'atom viewer');
    this.host.setAttribute('aria-label', 'Atom hologram. Drag to orbit, scroll to zoom. S pauses the orbits, Home resets the camera.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!glAvailable()) {
      this.unavailable = true;
      this.host.replaceChildren(emptyState({ icon: 'warning', title: 'WebGL is not available', text: 'This browser or device cannot create a WebGL context, so the atom cannot render.' }));
      return;
    }
    this.buildScene();
    this.buildOverlay();

    this.anim = ctx.scheduler.animate(this, (info) => this.tick(info));
    this.disposables.add(this.anim);
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.msg, 'click', () => {
      if (this.paused) { this.paused = false; this.msg.hidden = true; this.invalidate(); }
    });
  }

  // ------------------------------------------------------------------ scene

  buildScene() {
    const scene = (this.scene = new THREE.Scene());
    scene.background = this.backdrop();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    this.camera.position.set(...HOME);
    this.target = new THREE.Vector3();
    this.camera.lookAt(this.target);
    this.uTime = { value: 0 };
    this.dotTex = this.dot();

    const ball = (color, gain) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BALL_FRAG,
      uniforms: { uColor: { value: new THREE.Color(color) }, uGain: { value: gain }, uTime: this.uTime },
    });
    const halo = (color, size, opacity) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.scale.setScalar(size);
      return s;
    };

    // atom: the shared orbit axis is z, tilted a little so the rings read as 3D at the home view
    this.atom = new THREE.Group();
    this.atom.rotation.set(-0.35, 0.25, 0);
    scene.add(this.atom);

    // nucleus: one shared sphere geometry, opaque and depth-written (additive would white out)
    this.nucleus = new THREE.Group();
    const nGeo = new THREE.SphereGeometry(NUCLEON_R, 32, 20);
    const pMat = ball(PROTON, 0.8);
    const nMat = ball(NEUTRON, 0.6);
    NUCLEONS.forEach((p, i) => {
      const m = new THREE.Mesh(nGeo, i % 2 ? nMat : pMat);
      m.position.set(...p);
      this.nucleus.add(m);
    });
    const c = new THREE.Box3().setFromObject(this.nucleus).getCenter(new THREE.Vector3());
    for (const m of this.nucleus.children) m.position.sub(c);
    this.nucleus.add(halo('#ff7a3a', 1.8, 0.3));
    this.atom.add(this.nucleus);

    // orbits: tilt (fixed plane) > spin (rotation.z about the plane's normal) > torus + electrons
    const eGeo = new THREE.SphereGeometry(1, 24, 16);
    this.spins = ORBITS.map((o) => {
      const tilt = new THREE.Group();
      tilt.rotation.set(0, Math.PI / 2, THREE.MathUtils.degToRad(o.phi), 'ZYX'); // normal → (cos φ, sin φ, 0)
      const spin = new THREE.Group();
      spin.userData.w = o.w;
      const ringMat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: new THREE.Color(o.color) }, uN: { value: o.n }, uDir: { value: Math.sign(o.w) } },
      });
      spin.add(new THREE.Mesh(new THREE.TorusGeometry(o.r, TUBE, 12, 256), ringMat));
      const eMat = ball(o.color, 1.25);
      for (let k = 0; k < o.n; k++) {
        const a = (k / o.n) * Math.PI * 2; // matches the trail phase in RING_FRAG
        const e = new THREE.Mesh(eGeo, eMat);
        e.scale.setScalar(o.e);
        e.position.set(Math.cos(a) * o.r, Math.sin(a) * o.r, 0);
        const h = halo(o.color, 4, 0.5); // child of a scaled mesh: 4 × e ≈ 0.5 units
        e.add(h);
        spin.add(e);
      }
      tilt.add(spin);
      this.atom.add(tilt);
      return spin;
    });

    // dust drifting around the atom
    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(2.6 + Math.random() * 5);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x7fdcff, size: 0.05, map: this.dotTex, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(this.particles);
  }

  /** Soft round sprite for halos and particles. */
  dot() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  /** Navy radial gradient behind the hologram. */
  backdrop() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(256, 256, 10, 256, 256, 360);
    grad.addColorStop(0, '#0c2a4a');
    grad.addColorStop(0.55, '#061426');
    grad.addColorStop(1, '#02060d');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  frameAll() {
    this.camera.position.set(...HOME);
    (this.controls?.target ?? this.target).set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    this.invalidate();
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = Math.min(info.dt / 1000, 0.1);
    // orbits always loop; reduced motion slows them instead of stopping (S pauses them outright)
    const k = this.state.spin ? (info.reducedMotion ? 0.35 : 1) : 0;
    this.uTime.value += dt * k;
    this.loopCheck(this.uTime.value - dt * k, this.uTime.value, (4 * Math.PI) / 0.7);
    for (const s of this.spins) s.rotation.z += s.userData.w * dt * k;
    this.nucleus.rotation.y += 0.25 * dt * k;
    this.particles.rotation.y += 0.02 * dt * k;
    if (this.controls) this.controls.update();
    else this.camera.lookAt(this.target);
    this.invalidate();
  }

  render() {
    if (!this.scene || !this.ensureRenderer()) return;
    this.bloom.enabled = this.state.glow;
    this.composer.render();
    if (this.presenter) this.present();
    touch(this);
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
    this.bloom = new FX.UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 0.45);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new FX.OutputPass());
    this.sizeRenderer();
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 20;
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
    const left = el('div', 'ms-sc-col is-left');
    const detail = el('section', 'ms-sc-panel ms-sc-detail');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Atom · Bohr model'));
    const title = el('h3', '', 'Electron orbits');
    title.style.setProperty('--c', ORBITS[1].color);
    const text = el('p', '', 'A nucleus of 7 protons and 7 neutrons, circled by 10 electrons on three orbits. Each orbit spins about the axis perpendicular to its plane.');
    const meta = el('div', 'ms-sc-meta');
    meta.append(el('span', '', '14 nucleons'), el('span', '', '2 · 4 · 4 e⁻'));
    detail.append(head, title, text, meta);
    left.append(detail);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    // CC BY 4.0: the proportions follow this model
    const credit = el('a', 'ms-sc-credit', 'Based on “Atom” by LucasPresoto · CC BY 4.0');
    credit.href = 'https://sketchfab.com/3d-models/atom-8ea2315dc6ae40a4b7c1d2eb75305d2c';
    credit.target = '_blank';
    credit.rel = 'noreferrer';
    this.host.append(left, this.msg, credit);
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
    if (k === 's') this.toggle('spin');
    else if (k === 'home') this.frameAll();
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
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
    wrap.append(tog('spin', 'sync', 'Spin orbits (S)'), tog('glow', 'sparkle', 'Glow'), frame);
    return [wrap];
  }

  getState() {
    const { spin, glow } = this.state;
    return { spin, glow };
  }

  dispose() {
    this.releaseGl();
    this.scene?.background?.dispose?.();
    this.dotTex?.dispose();
    this.scene?.traverse((o) => {
      if (!o.isSprite) o.geometry?.dispose(); // sprites share three's module-level quad
      o.material?.dispose();
    });
    this.scene = null;
    this.root?.remove();
    super.dispose();
  }
}
