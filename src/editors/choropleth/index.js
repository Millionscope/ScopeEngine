/**
 * Choropleth Map: the 50 U.S. states + DC as holographic slabs, coloured and raised by
 * 2020 Census resident population (log scale).
 *  - geometry: public/geo/us-states-albers.json, made from us-atlas@3 states-albers-10m.json
 *    (Albers USA, 975×610 px, AK/HI inset) with topojson-client `feature()`, coordinates rounded
 *    to 0.1 px, properties trimmed to { id (FIPS), name };
 *  - every state is one ExtrudeGeometry: a scanline hologram fill on the caps, additive side walls
 *    that burn brightest at the top edge, plus a crisp top-ring line, so its border glows in bloom;
 *  - states undulate on a wave that rolls across the country (phase from each state's centroid);
 *  - the WebGL renderer comes from the shared GL pool and is released while the area is hidden.
 * @module editors/choropleth
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

const GEO_URL = '/geo/us-states-albers.json';
const HOME = [0, 7.2, 8.4];
const SCALE = 1 / 90; // Albers px → world units (map ≈ 10.6 wide)
const CX = 450; // centre of the us-atlas albers bbox
const CY = 310;
const H_MIN = 0.06; // slab height for the least populous state
const H_MAX = 0.6;
const WAVE_A = 0.18; // undulation amplitude
const WAVE_W = 1.6; // rad/s
// atom palette ramp: low → high, warm accent at the top
const RAMP = ['#6dffe4', '#3fb8ff', '#a78bff', '#ff6a3d'];

// 2020 Census apportionment resident population by FIPS (census.gov, table "Apportionment Population and Number of Representatives"); DC from the 2020 Census resident count
const POP = {
  '01': 5024279, '02': 733391, '04': 7151502, '05': 3011524, '06': 39538223, '08': 5773714, '09': 3605944, '10': 989948,
  '11': 689545, '12': 21538187, '13': 10711908, '15': 1455271, '16': 1839106, '17': 12812508, '18': 6785528, '19': 3190369,
  '20': 2937880, '21': 4505836, '22': 4657757, '23': 1362359, '24': 6177224, '25': 7029917, '26': 10077331, '27': 5706494,
  '28': 2961279, '29': 6154913, '30': 1084225, '31': 1961504, '32': 3104614, '33': 1377529, '34': 9288994, '35': 2117522,
  '36': 20201249, '37': 10439388, '38': 779094, '39': 11799448, '40': 3959353, '41': 4237256, '42': 13002700, '44': 1097379,
  '45': 5118425, '46': 886667, '47': 6910840, '48': 29145505, '49': 3271616, '50': 643077, '51': 8631393, '53': 7705281,
  '54': 1793716, '55': 5893718, '56': 576851,
};

const VERT = /* glsl */`
uniform float uDepth;
varying vec3 vN;
varying vec3 vV;
varying vec3 vW;
varying float vH;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * w;
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vW = w.xyz;
  vH = position.z / uDepth; // 0 at the base, 1 at the top cap
  gl_Position = projectionMatrix * mv;
}`;
// caps: translucent fill with drifting scanlines and a fresnel rim; brightens on hover
const FILL_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime, uHover;
varying vec3 vN;
varying vec3 vV;
varying vec3 vW;
void main() {
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(1.0 - ndv, 2.0);
  float scan = pow(0.5 + 0.5 * sin(vW.z * 70.0 - uTime * 4.0), 6.0);
  float sweep = smoothstep(0.92, 1.0, sin(vW.x * 0.6 - uTime * 0.8));
  vec3 col = uColor * (0.32 + 0.35 * scan + 0.5 * rim + 0.6 * sweep + 0.7 * uHover);
  gl_FragColor = vec4(col, 0.5 + 0.25 * scan + 0.2 * uHover);
}`;
// side walls (additive): a gradient that burns at the top edge, the glowing border
const WALL_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime, uHover;
varying float vH;
void main() {
  float edge = pow(vH, 5.0);
  float flicker = 0.92 + 0.08 * sin(uTime * 9.0 + vH * 20.0);
  vec3 col = uColor * (0.25 + 2.2 * edge + 0.8 * uHover) * flicker;
  gl_FragColor = vec4(col, 0.12 + 0.88 * vH * vH);
}`;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmt = new Intl.NumberFormat('en-US');

export default class ChoroplethEditor extends BaseEditor {
  static id = 'choropleth';
  static label = 'Choropleth Map';
  static icon = 'map';
  static group = 'Scope';
  static needs = ['three', 'threefx'];

  async mount(ctx, state) {
    await loadCss(new URL('../scope/scope.css', import.meta.url));
    ({ THREE, OrbitControls } = ctx.libs.three);
    FX = ctx.libs.threefx;
    this.state = { wave: state.wave !== false, glow: state.glow !== false };
    /** @type {Array<{id: string, name: string, pop: number, rank: number, mesh: any, phase: number, uHover: {value: number}, target: number}>} */
    this.states = [];
    this.hoverIdx = -1;

    const root = el('div', 'ms-ed ms-scope');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'choropleth map');
    this.host.setAttribute('aria-label', 'U.S. states by 2020 population. Drag to orbit, scroll to zoom, hover a state for its value. Left and Right arrows step through states by population, S pauses the wave, Home resets the camera.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!glAvailable()) {
      this.unavailable = true;
      this.host.replaceChildren(emptyState({ icon: 'warning', title: 'WebGL is not available', text: 'This browser or device cannot create a WebGL context, so the map cannot render.' }));
      return;
    }
    this.buildScene();
    this.buildOverlay();

    this.anim = ctx.scheduler.animate(this, (info) => this.tick(info));
    this.disposables.add(this.anim);
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.host, 'pointermove', (e) => this.pick(/** @type {PointerEvent} */ (e)));
    this.listen(this.host, 'pointerleave', () => this.setHover(-1));
    this.listen(this.msg, 'click', () => {
      if (this.paused) { this.paused = false; this.msg.hidden = true; this.invalidate(); }
    });
    this.loadStates();
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
    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    const grid = new THREE.GridHelper(16, 64, 0x1f6f9a, 0x0d3550);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    grid.material.depthWrite = false;
    grid.position.y = -0.01;
    scene.add(grid);

    this.map = new THREE.Group();
    scene.add(this.map);

    // dust drifting above the map
    const n = 600;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([(Math.random() - 0.5) * 16, Math.random() * 5, (Math.random() - 0.5) * 11], i * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x7fdcff, size: 0.05, map: this.dotTex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(this.particles);
  }

  async loadStates() {
    this.showMsg('Charting states…', false);
    try {
      const res = await fetch(GEO_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo = await res.json();
      if (!this.scene) return; // disposed while loading
      this.buildStates(geo.features);
      this.msg.hidden = true;
      this.showDetail();
      this.invalidate();
    } catch (err) {
      this.showMsg(`Could not load state borders: ${/** @type {Error} */ (err).message}.`, false);
    }
  }

  /** @param {Array<{properties: {id: string, name: string}, geometry: {type: string, coordinates: any}}>} features */
  buildStates(features) {
    const pops = Object.values(POP);
    const lo = Math.log(Math.min(...pops));
    const hi = Math.log(Math.max(...pops));
    const ramp = RAMP.map((c) => new THREE.Color(c));
    const order = [...features].sort((a, b) => (POP[b.properties.id] || 0) - (POP[a.properties.id] || 0)).map((f) => f.properties.id);
    const v2 = ([x, y]) => new THREE.Vector2((x - CX) * SCALE, -(y - CY) * SCALE);

    for (const f of features) {
      const { id, name } = f.properties;
      const pop = POP[id] || 0;
      const t = pop ? (Math.log(pop) - lo) / (hi - lo) : 0;
      const k = t * (ramp.length - 1);
      const i = Math.min(ramp.length - 2, Math.floor(k));
      const color = new THREE.Color().lerpColors(ramp[i], ramp[i + 1], k - i);
      const depth = H_MIN + (H_MAX - H_MIN) * t;

      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const shapes = polys.map(([outer, ...holes]) => {
        const s = new THREE.Shape(outer.map(v2));
        s.holes = holes.map((h) => new THREE.Path(h.map(v2)));
        return s;
      });
      const geom = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
      const uHover = { value: 0 };
      const uniforms = { uColor: { value: color }, uTime: this.uTime, uHover, uDepth: { value: depth } };
      const fill = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FILL_FRAG, uniforms, transparent: true });
      const wall = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: WALL_FRAG, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, [fill, wall]); // ExtrudeGeometry groups: 0 caps, 1 side walls
      mesh.rotation.x = -Math.PI / 2; // extrude depth (local z) → world up

      // crisp border on the top cap
      const seg = [];
      for (const poly of polys) {
        for (const ring of poly) {
          for (let j = 1; j < ring.length; j++) {
            const a = v2(ring[j - 1]);
            const b = v2(ring[j]);
            seg.push(a.x, a.y, depth, b.x, b.y, depth);
          }
        }
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      mesh.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: color.clone().lerp(new THREE.Color('#ffffff'), 0.35).multiplyScalar(1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));

      geom.computeBoundingBox();
      const c = geom.boundingBox.getCenter(new THREE.Vector3()); // local x, y → world x, -z
      mesh.userData.idx = this.states.length;
      this.map.add(mesh);
      this.states.push({ id, name, pop, rank: order.indexOf(id) + 1, mesh, phase: 0.9 * c.x - 0.6 * c.y, uHover, target: 0 });
    }
    this.byRank = [...this.states].sort((a, b) => a.rank - b.rank);
  }

  /** Soft round sprite for particles. */
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

  /** Home view, pulled back until the whole map (≈11 units wide) fits the area's width. */
  frameAll() {
    const home = new THREE.Vector3(...HOME);
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect;
    this.camera.position.copy(home.setLength(Math.max(home.length(), 6.2 / tanH)));
    (this.controls?.target ?? this.target).set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    this.invalidate();
  }

  // ------------------------------------------------------------------ hover / pick

  /** @param {PointerEvent} e */
  pick(e) {
    if (!this.states.length || e.buttons) return;
    const r = this.host.getBoundingClientRect();
    this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.map.children, false)[0];
    this.setHover(hit ? hit.object.userData.idx : -1);
  }

  /** @param {number} idx */
  setHover(idx) {
    if (idx === this.hoverIdx) return;
    if (this.states[this.hoverIdx]) this.states[this.hoverIdx].target = 0;
    this.hoverIdx = idx;
    if (this.states[idx]) this.states[idx].target = 1;
    this.showDetail();
    this.invalidate();
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = Math.min(info.dt / 1000, 0.1);
    // the wave always loops; reduced motion slows it instead of stopping (S pauses it outright)
    const k = this.state.wave ? (info.reducedMotion ? 0.35 : 1) : 0;
    this.uTime.value += dt * k;
    this.loopCheck(this.uTime.value - dt * k, this.uTime.value, (2 * Math.PI) / WAVE_W);
    const t = this.uTime.value;
    const ease = Math.min(1, dt * 10);
    for (const s of this.states) {
      s.uHover.value += (s.target - s.uHover.value) * ease;
      s.mesh.position.y = WAVE_A * (0.5 + 0.5 * Math.sin(WAVE_W * t - s.phase)) + 0.25 * s.uHover.value;
    }
    this.particles.rotation.y += 0.01 * dt * k;
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
    this.bloom = new FX.UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.4);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new FX.OutputPass());
    this.sizeRenderer();
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 45;
    this.controls.maxPolarAngle = 1.4; // stay above the grid
    if (this.states.length) this.msg.hidden = true;
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
    if (!this.framed) { this.framed = true; this.frameAll(); }
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

    const legend = el('section', 'ms-sc-panel');
    const lh = el('header', 'ms-sc-head');
    lh.append(el('span', '', 'Population · 2020 Census'));
    const bar = el('div');
    bar.style.cssText = `height:8px;border-radius:4px;margin:2px 0 4px;background:linear-gradient(90deg,${RAMP.join(',')});box-shadow:0 0 10px rgba(63,216,255,.35)`;
    const scale = el('div', 'ms-sc-meta');
    const pops = Object.values(POP);
    const short = (n) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
    scale.append(el('span', '', short(Math.min(...pops))), el('span', '', 'log scale'), el('span', '', short(Math.max(...pops))));
    legend.append(lh, bar, scale);

    this.detail = el('section', 'ms-sc-panel ms-sc-detail');
    this.detail.setAttribute('role', 'status');
    this.detail.setAttribute('aria-live', 'polite');
    left.append(legend, this.detail);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    const credit = el('a', 'ms-sc-credit', 'Borders: us-atlas (ISC) · Data: U.S. Census Bureau 2020');
    credit.href = 'https://github.com/topojson/us-atlas';
    credit.target = '_blank';
    credit.rel = 'noreferrer';
    this.host.append(left, this.msg, credit);
    this.showDetail();
  }

  showDetail() {
    if (!this.detail) return;
    const s = this.states[this.hoverIdx];
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', s ? `Rank ${s.rank} of ${this.states.length}` : 'United States'));
    const title = el('h3', '', s ? s.name : 'Population by state');
    title.style.setProperty('--c', s ? `#${s.mesh.material[0].uniforms.uColor.value.getHexString()}` : RAMP[1]);
    const total = Object.values(POP).reduce((a, b) => a + b, 0);
    const text = el('p', '', s
      ? `${fmt.format(s.pop)} residents, ${((s.pop / total) * 100).toFixed(1)}% of the U.S. total.`
      : `${fmt.format(total)} residents across 50 states and DC. Colour and height follow population. Hover a state for its value.`);
    this.detail.replaceChildren(head, title, text);
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
    if (k === 's') this.toggle('wave');
    else if (k === 'home') this.frameAll();
    else if ((k === 'arrowright' || k === 'arrowleft') && this.byRank?.length) {
      const n = this.byRank.length;
      const cur = this.states[this.hoverIdx];
      const r = cur ? cur.rank - 1 + (k === 'arrowright' ? 1 : -1) : 0;
      this.setHover(this.byRank[(r + n) % n].mesh.userData.idx);
    } else if (k === 'escape') this.setHover(-1);
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
    wrap.append(tog('wave', 'pulse', 'Undulate states (S)'), tog('glow', 'sparkle', 'Glow'), frame);
    return [wrap];
  }

  getState() {
    const { wave, glow } = this.state;
    return { wave, glow };
  }

  dispose() {
    this.releaseGl();
    this.scene?.background?.dispose?.();
    this.dotTex?.dispose();
    this.scene?.traverse((o) => {
      o.geometry?.dispose();
      [].concat(o.material || []).forEach((m) => m.dispose());
    });
    this.scene = null;
    this.root?.remove();
    super.dispose();
  }
}
