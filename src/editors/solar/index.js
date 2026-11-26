/**
 * Solar: a sci-fi viewport of the whole solar system (orbit/rotation core ported from Atlas26).
 *  - Sun: HDR textured sphere + additive halo sprites; UnrealBloom (high threshold) makes it glow;
 *  - planets: real Kepler orbits and real sidereal spin ratios (orbits.js), Atlas26's day/night
 *    shader lit from the Sun, fresnel rim + atmosphere shell for the hologram glow, Saturn's rings,
 *    Earth's night lights and clouds, orbit ellipses and an asteroid belt;
 *  - camera tour (loop): orbit the system → fly to Earth → closer to Earth → pull back to the whole
 *    system. Dragging pauses it; it resumes after a few idle seconds. Picking a planet follows it;
 *    picking Earth (label, list, key 3 or a click on its disc) also opens the Earth globe beside it;
 *  - two clocks so both read on screen: spin (1 Earth day = 8 s) and orbits (1 Earth year = 2 min);
 *    each keeps the true ratios between bodies;
 *  - the WebGL renderer comes from the shared GL pool and is released while the area is hidden.
 * @module editors/solar
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { acquire, release, touch, isLost, glAvailable } from '../shared/gl-pool.js';
import { surfaceOptions, ReadbackPresenter } from '../shared/gl-present.js';
import { loadCss } from '../../core/lazy.js';
import { SUN, PLANETS, EARTH_YEAR_DAYS, daysSinceJ2000, orbitPosition, orbitPath, spinAngle } from './orbits.js';

/** three.js and add-ons, set from ctx.libs on mount. */
let THREE;
let OrbitControls;
let FX;

// ponytail: two clocks, so spin vs orbit is not to scale (Earth turns ~15× per lap, not 365×); a single
// clock with a speed control is the upgrade path if true day/year ratios are wanted.
const SPIN_HOURS_PER_SEC = 24 / 8;              // Earth turns once every 8 s
const ORBIT_DAYS_PER_SEC = EARTH_YEAR_DAYS / 120; // Earth laps the Sun every 2 min
const IDLE_RESUME_MS = 8000;

/**
 * Camera tour keyframes, looped: [time s, focus (0 Sun … 1 Earth), distance, elevation rad, phase of
 * the segment that starts here].
 * Distance is interpolated in log space so zooms feel even across 1.2 → 150 units.
 */
const TOUR = [
  [0, 0, 70, 0.42, 'System overview'],
  [10, 0, 42, 0.3, 'Approaching Earth'],
  [19, 1, 4, 0.16, 'Closing in on Earth'],
  [27, 1, 1.25, 0.08, 'Earth close-up'],
  [35, 1, 1.25, 0.08, 'Pulling back'],
  [47, 0, 150, 0.8, 'Full solar system'],
  [56, 0, 150, 0.8, 'System overview'],
  [64, 0, 70, 0.42, ''],
];
const TOUR_LEN = TOUR[TOUR.length - 1][0];

const PLANET_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
/** Atlas26's day/night terminator, with the Sun at the origin, plus a sunlit fresnel rim. */
const PLANET_FRAG = /* glsl */`
uniform sampler2D uDay, uNight;
uniform float uNightAmt, uAlpha;
uniform vec3 uRim;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(-vW);
  vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(N, L);
  vec4 tex = texture2D(uDay, vUv);
  vec3 col = tex.rgb * (0.035 + 1.05 * smoothstep(-0.05, 0.6, ndl) * (0.55 + 0.45 * max(ndl, 0.0)));
  col += texture2D(uNight, vUv).rgb * uNightAmt * (1.0 - smoothstep(-0.12, 0.08, ndl));
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uRim * rim * smoothstep(-0.35, 0.5, ndl);
#ifdef CLOUDS
  gl_FragColor = vec4(col, tex.r * uAlpha);
#else
  gl_FragColor = vec4(col, 1.0);
#endif
}`;
/** Back-face shell: glow fading out from the limb, brighter on the day side. */
const ATMO_FRAG = /* glsl */`
uniform vec3 uColor;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  float d = -dot(N, normalize(cameraPosition - vW));
  float g = smoothstep(0.0, 0.5, d) * (1.0 - smoothstep(0.5, 1.0, d));
  float day = smoothstep(-0.4, 0.5, dot(N, normalize(-vW)));
  gl_FragColor = vec4(uColor * g * (0.15 + 0.85 * day), 1.0);
}`;
/** Sun: texture pushed into HDR (bloom picks it up), hotter core, orange limb. */
const SUN_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const SUN_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float t = texture2D(uMap, vUv).r;
  float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  // granules stay below the bloom threshold, only the hottest cells (and the halos) bloom
  vec3 core = vec3(1.3, 0.88, 0.22);
  vec3 limb = vec3(1.25, 0.42, 0.06);
  vec3 col = mix(limb, core, pow(ndv, 0.7)) * (0.22 + 0.95 * t);
  col *= 0.96 + 0.04 * sin(uTime * 2.0 + t * 12.0);
  gl_FragColor = vec4(col, 1.0);
}`;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const ease = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;
/** Angle b moved to within ±π of a. */
const near = (a, b) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a));
const fmtHours = (h) => {
  const a = Math.abs(h);
  const s = a >= 48 ? `${(a / 24).toFixed(1)} d` : `${a.toFixed(1)} h`;
  return h < 0 ? `${s} (retro)` : s;
};
const fmtYears = (d) => (d < 400 ? `${d.toFixed(0)} d` : `${(d / EARTH_YEAR_DAYS).toFixed(1)} yr`);

export default class SolarEditor extends BaseEditor {
  static id = 'solar';
  static label = 'Solar System';
  static icon = 'globe';
  static group = 'Scope';
  static needs = ['three', 'threefx'];

  async mount(ctx, state) {
    await Promise.all([loadCss(new URL('../scope/scope.css', import.meta.url)), loadCss(new URL('./solar.css', import.meta.url))]);
    ({ THREE, OrbitControls } = ctx.libs.three);
    FX = ctx.libs.threefx;
    const reduce = ctx.store?.get?.('ui.reducedMotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = {
      tour: state.tour ?? !reduce,
      labels: state.labels !== false,
      glow: state.glow !== false,
      orbits: state.orbits !== false,
    };
    this.epoch = Date.now();
    this.orbitDays = 0; // simulated days since mount (orbit clock)
    this.spinHours = 0; // simulated hours since mount (spin clock)
    this.tourT = 0;
    this.touring = this.state.tour;
    this.idleSince = 0;
    this.focus = null;

    const root = el('div', 'ms-ed ms-scope ms-solar');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'solar system viewer');
    this.host.setAttribute('aria-label', 'Solar system. Drag to orbit, scroll to zoom, pick a planet to follow it. T toggles the camera tour, L the labels, O the orbits, Escape releases the planet, Home resets the camera.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!glAvailable()) {
      this.unavailable = true;
      this.host.replaceChildren(emptyState({ icon: 'warning', title: 'WebGL is not available', text: 'This browser or device cannot create a WebGL context, so the solar system cannot render.' }));
      return;
    }
    this.buildScene();
    this.buildOverlay();
    this.updateBodies();
    this.tourPose(this.camera.position, this.target);
    this.camera.lookAt(this.target);

    this.anim = ctx.scheduler.animate(this, (info) => this.tick(info));
    this.disposables.add(this.anim);
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    this.listen(this.host, 'pointerdown', (e) => { this._down = [/** @type {PointerEvent} */ (e).clientX, /** @type {PointerEvent} */ (e).clientY]; });
    this.listen(this.host, 'pointerup', (e) => this.pickEarth(/** @type {PointerEvent} */ (e)));
    this.listen(this.msg, 'click', () => {
      if (this.paused) { this.paused = false; this.msg.hidden = true; this.invalidate(); }
    });
  }

  // ------------------------------------------------------------------ scene

  buildScene() {
    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
    this.target = new THREE.Vector3();
    this.uTime = { value: 0 };
    this.textures = [];
    const manager = new THREE.LoadingManager();
    manager.onProgress = (_url, done, total) => this.renderLoading(Math.round((done / total) * 100));
    manager.onLoad = () => this.renderLoading(100);
    manager.onError = (url) => this.showMsg(`Could not load ${url}.`, false);
    const loader = new THREE.TextureLoader(manager);
    const tex = (url, color = true) => {
      const t = loader.load(url, () => this.invalidate());
      if (color) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.textures.push(t);
      return t;
    };

    const stars = tex('/textures/solar/stars.jpg');
    stars.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = stars;
    scene.backgroundIntensity = 0.55;

    // Sun: HDR sphere + two additive halos
    this.sun = new THREE.Group();
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN.radius, 96, 64), new THREE.ShaderMaterial({
      vertexShader: SUN_VERT, fragmentShader: SUN_FRAG, uniforms: { uMap: { value: tex(SUN.tex) }, uTime: this.uTime },
    }));
    this.sunSpin = sunMesh;
    this.sun.rotation.x = SUN.tiltDeg * Math.PI / 180;
    this.sun.add(sunMesh);
    scene.add(this.sun);
    this.halos = [
      [SUN.radius * 4, [[0, 'rgba(255,240,190,1)'], [0.3, 'rgba(255,200,90,.7)'], [0.55, 'rgba(255,140,40,.18)'], [1, 'rgba(255,110,20,0)']], 0.9],
      [SUN.radius * 10, [[0, 'rgba(255,160,60,.45)'], [0.3, 'rgba(255,120,40,.12)'], [1, 'rgba(255,90,20,0)']], 0.5],
    ].map(([size, stops, opacity]) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.radial(stops), color: 0xffffff, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.scale.setScalar(size);
      scene.add(s);
      return s;
    });

    // planets: orbit group (position) → tilt group (axial tilt) → spin group (rotation.y)
    this.bodies = PLANETS.map((p) => {
      const orbit = new THREE.Group();
      const tilt = new THREE.Group();
      tilt.rotation.x = p.tiltDeg * Math.PI / 180;
      const spin = new THREE.Group();
      const day = tex(p.tex);
      const mat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG,
        uniforms: { uDay: { value: day }, uNight: { value: p.night ? tex(p.night) : day }, uNightAmt: { value: p.night ? 1.6 : 0 }, uAlpha: { value: 1 }, uRim: { value: new THREE.Color(p.atmo || p.color).multiplyScalar(0.6) } },
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius, 96, 64), mat);
      spin.add(mesh);
      if (p.clouds) {
        const clouds = new THREE.Mesh(new THREE.SphereGeometry(p.radius * 1.012, 96, 64), new THREE.ShaderMaterial({
          vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG, defines: { CLOUDS: '' }, transparent: true, depthWrite: false,
          uniforms: { uDay: { value: tex(p.clouds) }, uNight: { value: day }, uNightAmt: { value: 0 }, uAlpha: { value: 0.85 }, uRim: { value: new THREE.Color(0, 0, 0) } },
        }));
        spin.add(clouds);
      }
      tilt.add(spin);
      if (p.atmo) {
        const shell = new THREE.Mesh(new THREE.SphereGeometry(p.radius * 1.09, 64, 48), new THREE.ShaderMaterial({
          vertexShader: PLANET_VERT, fragmentShader: ATMO_FRAG, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: { uColor: { value: new THREE.Color(p.atmo) } },
        }));
        tilt.add(shell);
      }
      if (p.ring) tilt.add(this.ring(p, tex(p.ring)));
      orbit.add(tilt);
      scene.add(orbit);
      return { p, orbit, spin, mesh, pos: new THREE.Vector3(), au: p.a };
    });
    this.earth = this.bodies.find((b) => b.p.id === 'earth');

    // orbit ellipses
    this.orbitLines = new THREE.Group();
    for (const p of PLANETS) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(orbitPath(p), 3));
      const earth = p.id === 'earth';
      this.orbitLines.add(new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: earth ? 0x3fd8ff : 0x7fb4d8, transparent: true, opacity: earth ? 0.55 : 0.22, blending: THREE.AdditiveBlending, depthWrite: false })));
    }
    scene.add(this.orbitLines);

    // asteroid belt between Mars and Jupiter (2.2–3.3 AU), turning at its Kepler rate
    const n = 2500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 20 + Math.random() * 3.6 + Math.random() * Math.random() * 0.8;
      const a = Math.random() * Math.PI * 2;
      pos.set([Math.cos(a) * r, (Math.random() - 0.5) * 0.5, Math.sin(a) * r], i * 3);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dotTex = this.radial([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,.5)'], [1, 'rgba(255,255,255,0)']]);
    this.belt = new THREE.Points(bg, new THREE.PointsMaterial({ color: 0xc8b48f, size: 0.09, map: this.dotTex, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(this.belt);
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
  }

  /** Saturn's rings: RingGeometry with UVs remapped radially (Atlas26). */
  ring(p, map) {
    const inner = p.radius * 1.2;
    const outer = p.radius * 2.3;
    const g = new THREE.RingGeometry(inner, outer, 160);
    const { position, uv } = g.attributes;
    for (let i = 0; i < position.count; i++) uv.setXY(i, (Math.hypot(position.getX(i), position.getY(i)) - inner) / (outer - inner), 0.5);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map, color: 0xd8d0c0, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  /** Radial-gradient sprite texture. @param {Array<[number, string]>} stops */
  radial(stops) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    for (const [o, col] of stops) grad.addColorStop(o, col);
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(t);
    return t;
  }

  /** Place every body for the current clocks. */
  updateBodies() {
    const days = daysSinceJ2000(this.epoch) + this.orbitDays;
    for (const b of this.bodies) {
      const o = orbitPosition(b.p, days);
      b.orbit.position.set(o.x, 0, o.z);
      b.pos.set(o.x, 0, o.z);
      b.au = o.au;
      b.spin.rotation.y = spinAngle(b.p.rotationHours, this.spinHours);
    }
    this.sunSpin.rotation.y = spinAngle(SUN.rotationHours, this.spinHours);
    this.belt.rotation.y = (this.orbitDays / 1622) * Math.PI * 2; // 2.7 AU
  }

  // ------------------------------------------------------------------ camera

  /** Camera pose of the tour at this.tourT, written into pos / tgt. Returns the phase name. */
  tourPose(pos, tgt) {
    const t = this.tourT % TOUR_LEN;
    let i = 0;
    while (TOUR[i + 1][0] <= t) i++;
    const [t0, f0, d0, e0, phase] = TOUR[i];
    const [t1, f1, d1, e1] = TOUR[i + 1];
    const s = ease((t - t0) / (t1 - t0));
    const focus = lerp(f0, f1, s);
    const dist = Math.exp(lerp(Math.log(d0), Math.log(d1), s));
    const elev = lerp(e0, e1, s);
    const ep = this.earth.pos;
    // free orbit around the Sun; near Earth come in ~75° off the sunward side: mostly lit with the
    // terminator in view, and the path stays clear of the Sun while target and distance blend
    const azFree = 0.6 + this.tourT * 0.045;
    const azEarth = near(azFree, Math.atan2(ep.z, ep.x) + Math.PI - 1.3 + this.tourT * 0.045);
    const az = lerp(azFree, azEarth, focus);
    tgt.copy(ep).multiplyScalar(focus);
    pos.set(Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az)).multiplyScalar(dist).add(tgt);
    return phase;
  }

  /** Follow a planet (null releases it). */
  setFocus(body) {
    this.focus = body;
    this.idleSince = performance.now();
    if (this.controls) this.controls.minDistance = body ? body.p.radius * 1.3 : 0.4;
    if (body) {
      this.touring = false;
      const cam = this.camera.position;
      const off = cam.clone().sub(body.pos).normalize().multiplyScalar(body.p.radius * (body.p.ring ? 9 : 6));
      this.fly = { t: 0, fromP: cam.clone(), fromT: (this.controls?.target ?? this.target).clone(), off };
    }
    this.renderPlanets();
    this.renderDetail();
    this.invalidate();
    // picking Earth opens the Earth globe beside this area (or focuses it)
    if (body && body === this.earth) this.ctx?.commands.executeWith('area.openGlobe', { areaId: this.ctx.areaId });
  }

  /** A click (not a drag) on or near Earth's disc on the canvas picks Earth. @param {PointerEvent} e */
  pickEarth(e) {
    const down = this._down;
    this._down = null;
    if (!down || e.target !== this.canvasEl || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const r = this.canvasEl.getBoundingClientRect();
    const p = this._v.copy(this.earth.pos).project(this.camera);
    if (p.z > 1) return;
    const dist = this.camera.position.distanceTo(this.earth.pos);
    const px = (this.earth.p.radius / (dist * Math.tan((this.camera.fov * Math.PI) / 360))) * (r.height / 2);
    const dx = r.left + (p.x * 0.5 + 0.5) * r.width - e.clientX;
    const dy = r.top + (-p.y * 0.5 + 0.5) * r.height - e.clientY;
    if (Math.hypot(dx, dy) <= Math.max(px, 12)) this.setFocus(this.earth);
  }

  startTour() {
    this.touring = true;
    this.focus = null;
    this.fly = { t: 0, fromP: this.camera.position.clone(), fromT: (this.controls?.target ?? this.target).clone(), tour: true };
    this.renderPlanets();
    this.renderDetail();
  }

  frameAll() {
    this.setFocus(null);
    if (this.state.tour) { this.tourT = 0; this.startTour(); return; }
    this.fly = { t: 0, fromP: this.camera.position.clone(), fromT: (this.controls?.target ?? this.target).clone(), to: { pos: new THREE.Vector3(0, 60, 110), tgt: new THREE.Vector3() } };
    this.invalidate();
  }

  frameSelected() { if (this.focus) this.setFocus(this.focus); }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = Math.min(info.dt / 1000, 0.1);
    const moving = !info.reducedMotion;
    if (moving) {
      this.uTime.value += dt;
      this.orbitDays += dt * ORBIT_DAYS_PER_SEC;
      this.spinHours += dt * SPIN_HOURS_PER_SEC;
    }
    const prev = this.focus ? this.focus.pos.clone() : null;
    this.updateBodies();

    const tgt = this.controls ? this.controls.target : this.target;
    const cam = this.camera.position;
    // resume the tour after the user has let go for a while
    if (this.state.tour && !this.touring && !this.focus && !this._dragging && moving && performance.now() - this.idleSince > IDLE_RESUME_MS) this.startTour();

    if (this.touring && moving) {
      this.tourT += dt;
      this.phase = this.tourPose(this._v.set(0, 0, 0), this._tgt ??= new THREE.Vector3());
      if (this.fly) this.blendFly(dt, this._v, this._tgt);
      else { cam.copy(this._v); tgt.copy(this._tgt); }
      this.camera.lookAt(tgt);
    } else if (this.focus) {
      const fp = this.focus.pos;
      if (this.fly) this.blendFly(dt, this._v.copy(fp).add(this.fly.off), fp);
      else if (prev) { cam.add(this._v.copy(fp).sub(prev)); tgt.copy(fp); }
      this.phase = `Tracking ${this.focus.p.name}`;
      this.controls?.update();
    } else {
      if (this.fly?.to) this.blendFly(dt, this.fly.to.pos, this.fly.to.tgt);
      this.phase = this.state.tour && moving ? 'Manual · tour resumes' : 'Manual';
      this.controls?.update();
    }
    if (!this.controls) this.camera.lookAt(tgt);
    this.invalidate();
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
    this.halos.forEach((h) => { h.visible = this.state.glow; });
    this.orbitLines.visible = this.state.orbits;
    this.composer.render();
    if (this.presenter) this.present();
    touch(this);
    this.updateLabels();
    const now = performance.now();
    if (!this._lastHud || now - this._lastHud > 250) {
      this._lastHud = now;
      this.updateTelemetry();
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
    // high threshold: only the HDR sun (and bright rims) bloom, textured planets stay crisp
    this.bloom = new FX.UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.55, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new FX.OutputPass());
    this.sizeRenderer();
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 400;
    this.controls.addEventListener('start', this._onStart = () => { this._dragging = true; this.touring = false; this.fly = null; this.idleSince = performance.now(); });
    this.controls.addEventListener('end', this._onEnd = () => { this._dragging = false; this.idleSince = performance.now(); });
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
    this.invalidate();
  }

  // ------------------------------------------------------------------ input

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (e.target !== this.host) return;
    const k = e.key.toLowerCase();
    if (k === 't') this.toggle('tour');
    else if (k === 'l') this.toggle('labels');
    else if (k === 'o') this.toggle('orbits');
    else if (k === 'escape') this.setFocus(null);
    else if (k === 'home') this.frameAll();
    else if (k >= '1' && k <= '8') this.setFocus(this.bodies[Number(k) - 1]);
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
    if (key === 'labels') this.labelLayer.hidden = !this.state.labels;
    if (key === 'tour') {
      if (this.state.tour) { this.setFocus(null); this.startTour(); } else { this.touring = false; this.fly = null; }
    }
    this.ctx?.refreshHeader();
    this.save();
    this.invalidate();
  }

  // ------------------------------------------------------------------ overlay (HUD)

  buildOverlay() {
    this.labelLayer = el('div', 'ms-sc-anno');
    this.labelLayer.hidden = !this.state.labels;
    this.labels = [SUN, ...PLANETS].map((p, i) => {
      const b = el('button', 'ms-sc-label ms-so-label');
      b.type = 'button';
      b.style.setProperty('--c', p.color);
      b.append(el('b', '', p.name));
      b.addEventListener('click', () => (i === 0 ? this.frameAll() : this.setFocus(this.focus === this.bodies[i - 1] ? null : this.bodies[i - 1])));
      this.labelLayer.appendChild(b);
      return b;
    });

    const left = el('div', 'ms-sc-col is-left');
    this.telemetry = el('section', 'ms-sc-panel');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Telemetry'), el('span', 'ms-sc-tag', 'Simulated'));
    this.tele = {};
    const rows = [['date', 'Sim date'], ['phase', 'Camera'], ['earth', 'Earth – Sun'], ['spin', 'Spin clock'], ['orbit', 'Orbit clock']].map(([k, label]) => {
      const row = el('div', 'ms-so-row');
      this.tele[k] = el('b', '', '');
      row.append(el('span', '', label), this.tele[k]);
      return row;
    });
    this.tele.spin.textContent = '1 Earth day = 8 s';
    this.tele.orbit.textContent = '1 Earth year = 2 min';
    this.telemetry.append(head, ...rows);
    this.detail = el('section', 'ms-sc-panel ms-sc-detail');
    this.detail.setAttribute('aria-live', 'polite');
    left.append(this.telemetry, this.detail);

    const right = el('div', 'ms-sc-col is-right');
    this.planetsPanel = el('section', 'ms-sc-panel');
    right.append(this.planetsPanel);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    this.loading = el('div', 'ms-sc-loading');
    this.loading.setAttribute('role', 'status');
    this.host.append(this.labelLayer, left, right, this.loading, this.msg);
    this.renderPlanets();
    this.renderDetail();
  }

  renderLoading(pct) {
    this.loading.hidden = pct >= 100;
    this.loading.innerHTML = `<span>Charting the solar system · ${pct}%</span><i><b style="width:${pct}%"></b></i>`;
  }

  showMsg(text, clickable) {
    this.msg.textContent = text;
    this.msg.hidden = false;
    this.msg.classList.toggle('is-clickable', clickable);
    this.msg.setAttribute('role', clickable ? 'button' : 'status');
    this.msg.tabIndex = clickable ? 0 : -1;
  }

  updateTelemetry() {
    if (!this.tele) return;
    const date = new Date(this.epoch + this.orbitDays * 86400000);
    this.tele.date.textContent = date.toISOString().slice(0, 10);
    this.tele.phase.textContent = this.phase ?? '';
    this.tele.earth.textContent = `${this.earth.au.toFixed(4)} AU`;
  }

  renderPlanets() {
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Planets'), el('span', 'ms-sc-tag', 'Day'));
    const list = el('div', 'ms-sc-systems');
    this.bodies.forEach((b, i) => {
      const btn = el('button', 'ms-sc-sys');
      btn.type = 'button';
      if (this.focus === b) btn.setAttribute('aria-current', 'true');
      btn.title = `Follow ${b.p.name} (${i + 1})`;
      btn.style.setProperty('--c', b.p.color);
      btn.append(el('i'), el('span', '', b.p.name), el('small', '', fmtHours(b.p.rotationHours)));
      btn.addEventListener('click', () => this.setFocus(this.focus === b ? null : b));
      list.appendChild(btn);
    });
    this.planetsPanel.replaceChildren(head, list);
  }

  renderDetail() {
    const b = this.focus;
    if (!b) {
      this.detail.replaceChildren(el('p', 'ms-sc-hint', 'Pick a planet to follow it. Drag to orbit, scroll to zoom; the tour resumes when idle.'));
      return;
    }
    const p = b.p;
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Planet'));
    const close = el('button', 'ms-icon-btn is-small');
    close.type = 'button';
    close.setAttribute('aria-label', 'Release planet');
    close.innerHTML = '<span class="codicon codicon-close"></span>';
    close.addEventListener('click', () => this.setFocus(null));
    head.appendChild(close);
    const title = el('h3', '', p.name);
    title.style.setProperty('--c', p.color);
    const meta = el('div', 'ms-so-facts');
    for (const [k, v] of [['Radius', `${Math.round(p.radiusKm).toLocaleString()} km`], ['Day', fmtHours(p.rotationHours)], ['Year', fmtYears(p.periodDays)], ['Tilt', `${p.tiltDeg}°`], ['Orbit', `${p.a.toFixed(2)} AU`]]) {
      meta.append(el('span', '', k), el('b', '', v));
    }
    this.detail.replaceChildren(head, title, el('p', '', p.text), meta);
  }

  /** Name tags beside each body, hidden behind the camera. */
  updateLabels() {
    if (!this.state.labels) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const spheres = [[this.sun.position, SUN.radius], ...this.bodies.map((b) => [b.pos, b.p.radius])];
    const ray = this._ray ??= new THREE.Ray();
    const sph = this._sph ??= new THREE.Sphere();
    /** Another body sits between the camera and pos. */
    const hiddenBehind = (pos) => {
      const d = cam.position.distanceTo(pos);
      ray.set(cam.position, this._w.copy(pos).sub(cam.position).normalize());
      return spheres.some(([c, r]) => c !== pos && cam.position.distanceTo(c) < d && ray.intersectsSphere(sph.set(c, r)));
    };
    const place = (label, pos, r) => {
      const p = this._v.copy(pos).project(cam);
      const off = p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1 || hiddenBehind(pos);
      label.hidden = off;
      if (off) return;
      const dist = cam.position.distanceTo(pos);
      const px = (r / (dist * Math.tan((cam.fov * Math.PI) / 360))) * (h / 2); // body radius on screen
      label.style.transform = `translate(${(p.x * 0.5 + 0.5) * w + px + 6}px, calc(${(-p.y * 0.5 + 0.5) * h}px - 50%))`;
      label.classList.toggle('is-selected', this.focus?.pos === pos);
    };
    place(this.labels[0], this.sun.position, SUN.radius);
    this.bodies.forEach((b, i) => place(this.labels[i + 1], b.pos, b.p.radius));
  }

  // ------------------------------------------------------------------ header

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
    wrap.append(tog('tour', 'device-camera-video', 'Camera tour (T)'), tog('orbits', 'circle-large-outline', 'Orbits (O)'), tog('labels', 'tag', 'Labels (L)'), tog('glow', 'sparkle', 'Glow'), frame);
    return [wrap];
  }

  getState() {
    const { tour, labels, glow, orbits } = this.state;
    return { tour, labels, glow, orbits };
  }

  dispose() {
    this.releaseGl();
    this.textures?.forEach((t) => t.dispose());
    this.scene?.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.scene = null;
    this.root?.remove();
    super.dispose();
  }
}
