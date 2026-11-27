/**
 * Globe: a sci-fi Earth with glowing country borders and a looping city tour (opened from Solar's Earth).
 *  - three-globe (the layer engine inside Globe.GL) on the shared three.js, rendered through the GL pool
 *    and UnrealBloom so borders, the raised country and city lights glow;
 *  - every border is one merged LineSegments (one draw call); three-globe only extrudes the active
 *    country (polygon layer), marks the cities (points) and pulses the active one (rings);
 *  - tour (loop): fly to the next city → zoom in, raise and light its country → hold → zoom out.
 *    Dragging pauses it; it resumes after a few idle seconds. Picking a city flies there and opens its Terrain.
 * @module editors/globe
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { acquire, release, touch, isLost, glAvailable } from '../shared/gl-pool.js';
import { surfaceOptions, ReadbackPresenter } from '../shared/gl-present.js';
import { loadCss } from '../../core/lazy.js';
import { CITIES, COUNTRIES_URL, fmtLatLng } from '../shared/cities.js';

/** three.js and add-ons, set from ctx.libs on mount. */
let THREE;
let OrbitControls;
let FX;
let ThreeGlobe;

const R = 100; // three-globe radius
const FAR = 1.9; // camera altitude between cities (globe radii above the surface)
const NEAR = 0.55; // camera altitude over a city
// one stop: [0, FLY) travel at FAR · [FLY, IN) zoom in · [IN, HOLD) hold · [HOLD, CYCLE) zoom out
const FLY = 3.2;
const IN = 5.6;
const HOLD = 9;
const CYCLE = 10.8;
const IDLE_RESUME_MS = 8000;
const BORDER = 0x2f8fff;
const LIGHT = '#ffb15c';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const ease = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** Angle b (deg) moved to within ±180 of a, so LA → Seoul crosses the Pacific. */
const nearDeg = (a, b) => a + ((((b - a) % 360) + 540) % 360) - 180;

export default class GlobeEditor extends BaseEditor {
  static id = 'globe';
  static label = 'Earth Globe';
  static icon = 'globe';
  static group = 'Scope';
  static needs = ['three', 'threefx', 'threeglobe'];

  async mount(ctx, state) {
    await Promise.all([loadCss(new URL('../scope/scope.css', import.meta.url)), loadCss(new URL('../solar/solar.css', import.meta.url)), loadCss(new URL('./globe.css', import.meta.url))]);
    ({ THREE, OrbitControls } = ctx.libs.three);
    FX = ctx.libs.threefx;
    ThreeGlobe = ctx.libs.threeglobe;
    const reduce = ctx.store?.get?.('ui.reducedMotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = { tour: state.tour ?? !reduce, labels: state.labels !== false, glow: state.glow !== false };
    this.tourT = FLY + 0.01; // open looking at the first city from afar, then zoom in
    this.touring = true;
    this.idleSince = 0;
    this.cityIdx = -1;

    const root = el('div', 'ms-ed ms-scope ms-globe');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'globe viewer');
    this.host.setAttribute('aria-label', 'Earth globe touring 20 cities. Drag to orbit, scroll to zoom, pick a city to fly there. T toggles the tour, L the labels, arrow keys step through cities, Home resets the camera.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!glAvailable()) {
      this.unavailable = true;
      this.host.replaceChildren(emptyState({ icon: 'warning', title: 'WebGL is not available', text: 'This browser or device cannot create a WebGL context, so the globe cannot render.' }));
      return;
    }
    this.buildScene();
    this.buildOverlay();
    this.tourPose(this.camera.position, this.target);
    this.camera.lookAt(this.target);
    this.loadCountries();

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
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.target = new THREE.Vector3();
    this.textures = [];
    const loader = new THREE.TextureLoader();
    const tex = (url) => {
      const t = loader.load(url, () => this.invalidate(), undefined, () => this.showMsg(`Could not load ${url}.`, false));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.textures.push(t);
      return t;
    };
    const stars = tex('/textures/solar/stars.jpg');
    stars.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = stars;
    scene.backgroundIntensity = 0.35;
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));

    // night side of the Earth on a navy base: dark oceans, orange city lights (bloom picks them up)
    this.globeMat = new THREE.MeshLambertMaterial({ map: tex('/textures/earth_nightmap.jpg'), emissive: 0x041128 });
    this.globe = new ThreeGlobe({ animateIn: false, waitForGlobeReady: false })
      .globeMaterial(this.globeMat)
      .showGraticules(true)
      .atmosphereColor('#3fa9ff')
      .atmosphereAltitude(0.2)
      // active country: raised, translucent cap, bright rim (strokes bloom)
      .polygonCapColor(() => 'rgba(30, 110, 220, 0.22)')
      .polygonSideColor(() => 'rgba(90, 200, 255, 0.4)')
      .polygonStrokeColor(() => '#d8fbff')
      .polygonAltitude(0.014)
      .polygonCapCurvatureResolution(2)
      .polygonsTransitionDuration(900)
      // all cities: small lights; the active one taller and brighter
      .pointsData(CITIES)
      .pointLat('lat').pointLng('lng')
      .pointColor((c) => (c === this.city ? '#ffe2b8' : LIGHT))
      .pointAltitude((c) => (c === this.city ? 0.018 : 0.006))
      .pointRadius((c) => (c === this.city ? 0.28 : 0.2))
      .pointsTransitionDuration(600)
      .ringLat('lat').ringLng('lng')
      .ringColor(() => (t) => `rgba(255, 190, 110, ${1 - t})`)
      .ringMaxRadius(4.5)
      .ringPropagationSpeed(2.2)
      .ringRepeatPeriod(900);
    scene.add(this.globe);
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._t = new THREE.Vector3();
  }

  async loadCountries() {
    this.renderLoading('Charting borders');
    try {
      const res = await fetch(COUNTRIES_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo = await res.json();
      if (!this.scene) return; // disposed while loading
      this.countries = new Map(geo.features.map((f) => [f.properties.a3, f]));
      this.scene.add((this.borders = this.borderLines(geo.features)));
      this.cityIdx = -1; // re-apply the active country now that it exists
      this.renderLoading(null);
      this.invalidate();
    } catch (err) {
      this.renderLoading(null);
      this.showMsg(`Could not load country borders: ${/** @type {Error} */ (err).message}.`, false);
    }
  }

  /** Every ring of every country as one LineSegments just above the surface. */
  borderLines(features) {
    const pts = [];
    const ring = (coords) => {
      for (let i = 1; i < coords.length; i++) pts.push(coords[i - 1], coords[i]);
    };
    for (const f of features) {
      const { type, coordinates } = f.geometry;
      for (const poly of type === 'Polygon' ? [coordinates] : coordinates) poly.forEach(ring);
    }
    const pos = new Float32Array(pts.length * 3);
    pts.forEach(([lng, lat], i) => {
      const c = this.globe.getCoords(lat, lng, 0.002);
      pos[i * 3] = c.x;
      pos[i * 3 + 1] = c.y;
      pos[i * 3 + 2] = c.z;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: BORDER, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  }

  /** Raise and light the country of city i; mark and pulse the city. */
  setCity(i) {
    if (i === this.cityIdx) return;
    this.cityIdx = i;
    this.city = CITIES[i];
    const f = this.countries?.get(this.city.a3);
    // a fresh points array re-runs the digest, restyling the active marker
    this.globe.polygonsData(f ? [f] : []).pointsData([...CITIES]).ringsData([this.city]);
    this.renderDetail();
    this.labels?.forEach((b, j) => b.classList.toggle('is-selected', j === i));
    this.cityBtns?.forEach((b, j) => (j === i ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  }

  // ------------------------------------------------------------------ camera

  /** Camera pose of the tour at this.tourT (position, look-at). Returns the phase name. */
  tourPose(pos, tgt) {
    const n = CITIES.length;
    const k = Math.floor(this.tourT / CYCLE);
    const u = this.tourT - k * CYCLE;
    const cur = CITIES[((k % n) + n) % n];
    const prev = CITIES[(((k - 1) % n) + n) % n];
    const s = ease(clamp01(u / FLY));
    const lat = lerp(prev.lat, cur.lat, s);
    const lng = lerp(prev.lng, nearDeg(prev.lng, cur.lng), s) + (u > FLY ? (u - FLY) * 0.6 : 0); // slow drift once there
    let alt = FAR;
    let phase = `Flying to ${cur.name}`;
    if (u < FLY) alt = FAR + 0.5 * Math.sin(Math.PI * s) * (Math.abs(cur.lng - prev.lng) > 60 ? 1 : 0.3);
    else if (u < IN) { alt = lerp(FAR, NEAR, ease((u - FLY) / (IN - FLY))); phase = `Zooming into ${cur.country}`; }
    else if (u < HOLD) { alt = NEAR; phase = `${cur.name}, ${cur.country}`; }
    else { alt = lerp(NEAR, FAR, ease((u - HOLD) / (CYCLE - HOLD))); phase = 'Zooming out'; }
    // close in: camera a little south of the city, looking at it, so the horizon tilts into view
    const zoom = clamp01((FAR - alt) / (FAR - NEAR));
    const c = this.globe.getCoords(lat - 9 * zoom, lng, alt);
    pos.set(c.x, c.y, c.z);
    const t = this.globe.getCoords(lat, lng, 0);
    tgt.set(t.x, t.y, t.z).multiplyScalar(0.85 * zoom);
    this.tourCity = ((k % n) + n) % n;
    return phase;
  }

  /** Fly to city i (zoom in and hold); the tour carries on from there when it is on. */
  goTo(i) {
    const n = CITIES.length;
    i = ((i % n) + n) % n;
    this.tourT = i * CYCLE + FLY - 0.6;
    this.startTour();
  }

  /** A clicked city (label or list): fly there and open its holographic terrain beside the globe. */
  pick(i) {
    this.goTo(i);
    this.ctx?.store.set('terrain.city', i);
    this.ctx?.commands.executeWith('area.openTerrain', { areaId: this.ctx.areaId });
  }

  startTour() {
    this.touring = true;
    this.fly = { t: 0, fromP: this.camera.position.clone(), fromT: (this.controls?.target ?? this.target).clone() };
    this.invalidate();
  }

  frameAll() {
    if (this.state.tour) return this.goTo(this.cityIdx < 0 ? 0 : this.cityIdx);
    this.touring = false;
    const c = this.globe.getCoords(20, this.city?.lng ?? 0, FAR);
    this.fly = { t: 0, fromP: this.camera.position.clone(), fromT: (this.controls?.target ?? this.target).clone(), to: { pos: new THREE.Vector3(c.x, c.y, c.z), tgt: new THREE.Vector3() } };
    this.invalidate();
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = Math.min(info.dt / 1000, 0.1);
    const moving = !info.reducedMotion;
    const tgt = this.controls ? this.controls.target : this.target;
    const cam = this.camera.position;
    if (this.state.tour && !this.touring && !this._dragging && moving && performance.now() - this.idleSince > IDLE_RESUME_MS) this.startTour();

    if (this.touring) {
      // tour off (or reduced motion): fly to the picked city and stay at its hold pose
      const hold = Math.floor(this.tourT / CYCLE) * CYCLE + IN;
      if (this.state.tour && moving) this.tourT += dt;
      else this.tourT = moving ? Math.min(this.tourT + dt, hold) : hold;
      if (!moving) this.fly = null;
      this.phase = this.tourPose(this._p, this._t);
      if (this.fly) this.blendFly(dt, this._p, this._t);
      else { cam.copy(this._p); tgt.copy(this._t); }
      this.camera.lookAt(tgt);
      this.setCity(this.tourCity);
    } else {
      if (this.fly?.to) this.blendFly(dt, this.fly.to.pos, this.fly.to.tgt);
      this.phase = this.state.tour && moving ? 'Manual · tour resumes' : 'Manual';
      this.controls?.update();
    }
    if (this.cityIdx < 0) this.setCity(this.tourCity ?? 0);
    this.invalidate();
  }

  /** Ease the camera from the fly start towards a (possibly moving) pose. */
  blendFly(dt, toP, toT) {
    const f = this.fly;
    f.t = Math.min(1, f.t + dt / 1.8);
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
    // low threshold: the borders, the raised country and city lights bloom; the dark globe does not
    this.bloom = new FX.UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.45, 0.32);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new FX.OutputPass());
    this.sizeRenderer();
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = R * 1.12;
    this.controls.maxDistance = R * 6;
    this.controls.rotateSpeed = 0.5;
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
    else if (k === 'home') this.frameAll();
    else if (k === 'arrowright' || k === 'arrowdown') this.goTo(this.cityIdx + 1);
    else if (k === 'arrowleft' || k === 'arrowup') this.goTo(this.cityIdx - 1);
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
    if (key === 'labels') this.labelLayer.hidden = !this.state.labels;
    if (key === 'tour' && this.state.tour) this.goTo(this.cityIdx < 0 ? 0 : this.cityIdx);
    this.ctx?.refreshHeader();
    this.save();
    this.invalidate();
  }

  // ------------------------------------------------------------------ overlay (HUD)

  buildOverlay() {
    this.labelLayer = el('div', 'ms-sc-anno');
    this.labelLayer.hidden = !this.state.labels;
    this.labels = CITIES.map((c, i) => {
      const b = el('button', 'ms-sc-label ms-gl-label');
      b.type = 'button';
      b.style.setProperty('--c', LIGHT);
      b.append(el('b', '', c.name), el('small', '', fmtLatLng(c.lat, c.lng)));
      b.addEventListener('click', () => this.pick(i));
      this.labelLayer.appendChild(b);
      return b;
    });
    this.cityPos = CITIES.map((c) => {
      const p = this.globe.getCoords(c.lat, c.lng, 0.01);
      return new THREE.Vector3(p.x, p.y, p.z);
    });

    const left = el('div', 'ms-sc-col is-left');
    this.telemetry = el('section', 'ms-sc-panel');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Telemetry'), el('span', 'ms-sc-tag', 'Live'));
    this.tele = {};
    const rows = [['phase', 'Camera'], ['stop', 'Stop'], ['view', 'View centre'], ['alt', 'Altitude']].map(([k, label]) => {
      const row = el('div', 'ms-so-row');
      this.tele[k] = el('b', '', '');
      row.append(el('span', '', label), this.tele[k]);
      return row;
    });
    this.telemetry.append(head, ...rows);
    this.detail = el('section', 'ms-sc-panel ms-sc-detail');
    this.detail.setAttribute('aria-live', 'polite');
    left.append(this.telemetry, this.detail);

    const right = el('div', 'ms-sc-col is-right');
    this.citiesPanel = el('section', 'ms-sc-panel ms-gl-cities');
    right.append(this.citiesPanel);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    this.loading = el('div', 'ms-sc-loading');
    this.loading.setAttribute('role', 'status');
    this.host.append(this.labelLayer, left, right, this.loading, this.msg);
    this.renderCities();
    this.renderDetail();
  }

  /** @param {string|null} text */
  renderLoading(text) {
    this.loading.hidden = !text;
    if (text) this.loading.innerHTML = `<span>${text}…</span>`;
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
    const cam = this.camera.position;
    const { lat, lng, altitude } = this.globe.toGeoCoords(cam);
    this.tele.phase.textContent = this.phase ?? '';
    this.tele.stop.textContent = this.cityIdx < 0 ? '–' : `${this.cityIdx + 1} / ${CITIES.length}`;
    this.tele.view.textContent = fmtLatLng(lat, lng).replace(/(\d+\.\d{2})\d+/g, '$1');
    this.tele.alt.textContent = `${Math.round(altitude * 6371).toLocaleString()} km`;
  }

  renderCities() {
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Cities'), el('span', 'ms-sc-tag', `${CITIES.length}`));
    const list = el('div', 'ms-sc-systems');
    this.cityBtns = CITIES.map((c, i) => {
      const btn = el('button', 'ms-sc-sys');
      btn.type = 'button';
      btn.title = `Fly to ${c.name}, ${c.country}`;
      btn.style.setProperty('--c', LIGHT);
      btn.append(el('i'), el('span', '', c.name), el('small', '', c.a3));
      btn.addEventListener('click', () => this.pick(i));
      list.appendChild(btn);
      return btn;
    });
    this.citiesPanel.replaceChildren(head, list);
  }

  renderDetail() {
    const c = this.city;
    if (!c) {
      this.detail.replaceChildren(el('p', 'ms-sc-hint', 'Pick a city to fly there. Drag to orbit, scroll to zoom; the tour resumes when idle.'));
      return;
    }
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Location'), el('span', 'ms-sc-tag', `${this.cityIdx + 1} / ${CITIES.length}`));
    const title = el('h3', '', c.name);
    title.style.setProperty('--c', LIGHT);
    const meta = el('div', 'ms-so-facts');
    for (const [k, v] of [['Country', c.country], ['ISO', c.a3], ['Latitude', `${Math.abs(c.lat).toFixed(4)}° ${c.lat < 0 ? 'S' : 'N'}`], ['Longitude', `${Math.abs(c.lng).toFixed(4)}° ${c.lng < 0 ? 'W' : 'E'}`]]) {
      meta.append(el('span', '', k), el('b', '', v));
    }
    this.detail.replaceChildren(head, title, meta);
  }

  /** City tags beside each marker; hidden behind the globe. The active one is the large callout. */
  updateLabels() {
    if (!this.state.labels) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const d = cam.position.length();
    const edge = (R * R) / d; // a surface point is visible when its projection on the view axis passes this
    const camDir = this._w.copy(cam.position).normalize();
    this.cityPos.forEach((pos, i) => {
      const label = this.labels[i];
      const p = this._v.copy(pos).project(cam);
      const off = pos.dot(camDir) < edge || p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05;
      label.hidden = off;
      if (off) return;
      label.style.transform = `translate(${(p.x * 0.5 + 0.5) * w + 10}px, calc(${(-p.y * 0.5 + 0.5) * h}px - 50%))`;
    });
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
    wrap.append(tog('tour', 'device-camera-video', 'City tour (T)'), tog('labels', 'tag', 'Labels (L)'), tog('glow', 'sparkle', 'Glow'), frame);
    return [wrap];
  }

  getState() {
    const { tour, labels, glow } = this.state;
    return { tour, labels, glow };
  }

  dispose() {
    this.releaseGl();
    this.globe?._destructor?.();
    this.textures?.forEach((t) => t.dispose());
    this.scene?.traverse((o) => {
      o.geometry?.dispose();
      [].concat(o.material ?? []).forEach((m) => m.dispose());
    });
    this.scene = null;
    this.root?.remove();
    super.dispose();
  }
}
