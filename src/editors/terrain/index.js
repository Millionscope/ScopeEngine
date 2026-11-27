/**
 * Terrain: a futuristic holographic 3D terrain of one of the globe's 20 cities (maplibre-gl, no token).
 *  - AWS Terrarium DEM as 3D terrain, tinted by elevation (`color-relief`), neon hillshade,
 *    OpenFreeMap rivers and roads, dark sky fog;
 *  - a custom WebGL layer draws a holographic lattice draped on the relief, coloured by height, with
 *    a scan wave pulsing out from the city centre (additive blending, so it glows);
 *  - the camera orbits the city on its own; dragging or scrolling pauses it for a few idle seconds.
 * The city comes from the store key `terrain.city`, which the Globe sets when a city is clicked.
 * Clicking the city (its marker on the map or the list) opens its Holo City in place of this area.
 * @module editors/terrain
 */
import { BaseEditor } from '../base-editor.js';
import { loadCss } from '../../core/lazy.js';
import { CITIES, fmtLatLng } from '../shared/cities.js';
import { VIEWS } from './views.js';

const KEY = 'terrain.city';
const PITCH = 64;
const ROT_DEG_S = 5; // auto-orbit speed
const IDLE_RESUME_MS = 6000;
const GRID = 160; // lattice samples per side
const GRID_EVERY = 4; // a lattice line every N samples
const GRID_TILES = 1.6; // lattice half-size in tiles at the city's zoom
const LIGHT = '#ffb15c';

let maplibregl;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Elevation colours from lowland to summit, like a sci-fi relief table: blue, teal, green, amber, ember. */
const RAMP = ['#0a2470', '#0e7fa0', '#22b35a', '#b9d23a', '#f0a32a', '#c2531a', '#3a1206'];
/** `color-relief-color` over [lo, hi] metres. @param {number} lo @param {number} hi */
const ramp = (lo, hi) => ['interpolate', ['linear'], ['elevation'], ...RAMP.flatMap((c, i) => [lo + ((hi - lo) * i) / (RAMP.length - 1), c])];

/** @param {number} exag */
const DEM = { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen Terrain Tiles</a>' };
/** @param {number} exag */
const style = (exag) => ({
  version: 8,
  sources: {
    dem: DEM,
    // hillshade and colour relief get their own copy: sharing the terrain source degrades them
    relief: DEM,
    streets: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  },
  terrain: { source: 'dem', exaggeration: exag },
  sky: { 'sky-color': '#01030a', 'horizon-color': '#1a4f9c', 'fog-color': '#071a33', 'fog-ground-blend': 0.6, 'horizon-fog-blend': 0.3, 'sky-horizon-blend': 0.5, 'atmosphere-blend': 0 },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#020a16' } },
    { id: 'hypso', type: 'color-relief', source: 'relief', paint: { 'color-relief-color': ramp(0, 500), 'color-relief-opacity': 0.92 } },
    { id: 'shade', type: 'hillshade', source: 'relief', paint: { 'hillshade-shadow-color': 'rgba(2, 4, 12, 0.85)', 'hillshade-highlight-color': 'rgba(255, 170, 80, 0.55)', 'hillshade-accent-color': 'rgba(63, 216, 255, 0.35)', 'hillshade-exaggeration': 0.75, 'hillshade-illumination-anchor': 'map' } },
    { id: 'water', type: 'fill', source: 'streets', 'source-layer': 'water', paint: { 'fill-color': '#0a3fb8', 'fill-opacity': 0.8 } },
    { id: 'water-edge', type: 'line', source: 'streets', 'source-layer': 'water', paint: { 'line-color': '#3fb4ff', 'line-width': 5, 'line-blur': 5, 'line-opacity': 0.55 } },
    { id: 'river-glow', type: 'line', source: 'streets', 'source-layer': 'waterway', paint: { 'line-color': '#2f8fff', 'line-width': 9, 'line-blur': 7, 'line-opacity': 0.6 } },
    { id: 'river', type: 'line', source: 'streets', 'source-layer': 'waterway', paint: { 'line-color': '#8fd8ff', 'line-width': 1.4 } },
    { id: 'road-glow', type: 'line', source: 'streets', 'source-layer': 'transportation', filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false], paint: { 'line-color': '#ff8a2a', 'line-width': 7, 'line-blur': 6, 'line-opacity': 0.5 } },
    { id: 'road', type: 'line', source: 'streets', 'source-layer': 'transportation', filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'], true, false], paint: { 'line-color': '#ffe0b0', 'line-width': ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 1.3, 0.5], 'line-opacity': 0.75 } },
  ],
});

const VS = `
uniform mat4 u_matrix; uniform vec2 u_center; uniform float u_span;
attribute vec4 a_pos; // mercator x, y, z and normalised height
varying float v_h; varying float v_d;
void main() {
  v_h = a_pos.w;
  v_d = length(a_pos.xy - u_center) / u_span;
  gl_Position = u_matrix * vec4(a_pos.xyz, 1.0);
}`;
const FS = `
precision highp float;
uniform float u_time;
varying float v_h; varying float v_d;
void main() {
  vec3 c = mix(vec3(0.15, 0.78, 1.0), vec3(1.0, 0.62, 0.22), smoothstep(0.3, 0.9, v_h));
  float wave = exp(-pow((fract(u_time * 0.16) * 1.3 - v_d) * 12.0, 2.0)); // ring sweeping outwards
  float a = (0.2 + 0.35 * v_h + 1.3 * wave) * (1.0 - smoothstep(0.72, 1.0, v_d));
  gl_FragColor = vec4(c * a, a);
}`;

/** MapLibre custom layer: the holographic lattice (rebuilt from terrain samples by the editor). */
class HoloLayer {
  constructor() {
    this.id = 'holo';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.count = 0;
    this.center = [0, 0];
    this.span = 1;
    this.time = 0;
  }

  onAdd(map, gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'holo shader');
      return s;
    };
    const p = (this.prog = gl.createProgram());
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.loc = { pos: gl.getAttribLocation(p, 'a_pos'), matrix: gl.getUniformLocation(p, 'u_matrix'), center: gl.getUniformLocation(p, 'u_center'), span: gl.getUniformLocation(p, 'u_span'), time: gl.getUniformLocation(p, 'u_time') };
    this.buf = gl.createBuffer();
    this.gl = gl;
  }

  /** @param {Float32Array} verts */
  upload(verts) {
    if (!this.gl) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.count = verts.length / 4;
  }

  render(gl, args) {
    if (!this.count) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.matrix, false, args.defaultProjectionData.mainMatrix);
    gl.uniform2f(this.loc.center, this.center[0], this.center[1]);
    gl.uniform1f(this.loc.span, this.span);
    gl.uniform1f(this.loc.time, this.time);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 4, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive: overlaps glow
    gl.depthMask(false); // hidden behind ridges, but never occludes
    gl.drawArrays(gl.LINES, 0, this.count);
    gl.depthMask(true);
  }

  onRemove(map, gl) {
    gl.deleteBuffer(this.buf);
    gl.deleteProgram(this.prog);
    this.gl = null;
  }
}

export default class TerrainEditor extends BaseEditor {
  static id = 'terrain';
  static label = 'Terrain';
  static icon = 'map';
  static group = 'Scope';
  static needs = ['maplibre'];

  async mount(ctx, state) {
    await Promise.all([
      loadCss(new URL('../scope/scope.css', import.meta.url)),
      loadCss(new URL('../solar/solar.css', import.meta.url)),
      loadCss(new URL('../globe/globe.css', import.meta.url)),
      loadCss(new URL('./terrain.css', import.meta.url)),
    ]);
    maplibregl = ctx.libs.maplibre;
    this.reduce = ctx.store?.get?.('ui.reducedMotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = { rotate: state.rotate ?? !this.reduce, holo: state.holo !== false };
    const stored = ctx.store?.get(KEY);
    this.cityIdx = Number.isInteger(stored) ? stored : Number.isInteger(state.city) ? state.city : 0;
    this.idleSince = 0;

    const root = el('div', 'ms-ed ms-scope ms-globe ms-terrain');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'terrain viewer');
    this.host.setAttribute('aria-label', 'Holographic 3D terrain of a city. Drag to orbit, scroll to zoom, click the city marker or pick a city to open its holographic city. R toggles auto-rotation, G the holographic grid, arrow keys step through cities, Home resets the camera.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    this.mapEl = el('div', 'ms-tr-map');
    this.host.appendChild(this.mapEl);
    this.buildOverlay();
    this.createMap();

    this.disposables.add(ctx.scheduler.animate(this, (info) => this.tick(info)));
    this.disposables.add(ctx.store.select(KEY, (i) => { if (Number.isInteger(i)) this.setCity(i); }));
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    const touch = () => { this.idleSince = performance.now(); };
    this.listen(this.mapEl, 'pointerdown', () => { this._down = true; touch(); }, { capture: true });
    this.listen(window, 'pointerup', () => { if (this._down) { this._down = false; touch(); } });
    this.listen(this.mapEl, 'wheel', touch, { capture: true, passive: true });
  }

  // ------------------------------------------------------------------ map

  get view() { return VIEWS[CITIES[this.cityIdx].name]; }

  createMap() {
    if (this.map) return;
    const c = CITIES[this.cityIdx];
    const map = (this.map = new maplibregl.Map({
      container: this.mapEl,
      style: style(this.view.exag),
      center: [c.lng, c.lat],
      zoom: this.view.zoom,
      pitch: PITCH,
      bearing: -20,
      maxPitch: 80,
      antialias: true,
    }));
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    const pin = el('button', 'ms-tr-pin');
    pin.type = 'button';
    pin.append(el('i'), (this.pinLabel = el('span', '', '')));
    pin.addEventListener('click', () => this.enter(this.cityIdx));
    this.pin = new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat([c.lng, c.lat]).addTo(map);
    this.renderPin();
    this.holo = new HoloLayer();
    this.holoTries = 0;
    this.holoDirty = true;
    map.on('style.load', () => {
      map.addLayer(this.holo);
      map.setLayoutProperty('holo', 'visibility', this.state.holo ? 'visible' : 'none');
    });
    map.on('load', () => this.renderLoading(null));
    map.on('error', (e) => console.warn('[terrain]', e.error?.message ?? e.error));
    this.renderLoading('Raising terrain');
    this.renderDetail();
  }

  dropMap() {
    this.map?.remove();
    this.map = null;
    this.holo = null;
  }

  /** Fly to city i, with its own exaggeration; the lattice and colour range follow once tiles land. */
  setCity(i) {
    const n = CITIES.length;
    i = ((i % n) + n) % n;
    const same = i === this.cityIdx;
    this.cityIdx = i;
    this.renderDetail();
    this.cityBtns?.forEach((b, j) => (j === i ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    this.save();
    const map = this.map;
    if (!map) return;
    const c = CITIES[i];
    this.pin?.setLngLat([c.lng, c.lat]);
    this.renderPin();
    if (!same) map.setTerrain({ source: 'dem', exaggeration: this.view.exag });
    map.flyTo({ center: [c.lng, c.lat], zoom: this.view.zoom, pitch: PITCH, bearing: map.getBearing(), duration: this.reduce ? 0 : 4000, essential: true });
    this.holoDirty = true;
    this.holoTries = 0;
  }

  /** Pick a city: through the store, so a Globe-driven pick and this one take the same path. */
  pick(i) {
    const n = CITIES.length;
    i = ((i % n) + n) % n;
    if (this.ctx?.store.get(KEY) === i) this.setCity(i); // re-centre on the same city
    else this.ctx?.store.set(KEY, i);
  }

  /** A clicked city (map marker or list): open its holographic city in place of this terrain. @param {number} i */
  enter(i) {
    this.pick(i);
    this.ctx?.commands.executeWith('area.openCity', { areaId: this.ctx.areaId, replace: true });
  }

  renderPin() {
    const c = CITIES[this.cityIdx];
    if (!this.pinLabel) return;
    this.pinLabel.textContent = `${c.name} · enter city`;
    this.pin.getElement().setAttribute('aria-label', `Open the holographic city of ${c.name}`);
  }

  /**
   * Sample the terrain around the city into a (GRID+1)² height field, then rebuild the lattice and
   * fit the elevation colours to its range. Returns true when every sample had terrain loaded.
   */
  buildHolo() {
    const map = this.map;
    const M = maplibregl.MercatorCoordinate;
    const exag = this.view.exag;
    const c = CITIES[this.cityIdx];
    const mc = M.fromLngLat([c.lng, c.lat]);
    const half = GRID_TILES / 2 ** this.view.zoom; // mercator units: a tile at zoom z spans 1/2^z
    const step = (2 * half) / GRID;
    const S = GRID + 1;
    const h = new Float32Array(S * S);
    let lo = Infinity;
    let hi = -Infinity;
    let missing = 0;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        // drawn surface only: queryTerrainElevation gives 0 where no DEM has loaded yet
        const ex = map.terrain?.getDrawnElevationForLngLat(new M(mc.x - half + i * step, mc.y - half + j * step).toLngLat());
        if (ex == null) { h[j * S + i] = NaN; missing++; continue; }
        const e = ex / exag;
        h[j * S + i] = e;
        if (e < lo) lo = e;
        if (e > hi) hi = e;
      }
    }
    if (!Number.isFinite(lo)) return false;
    hi = Math.max(hi, lo + 20);
    const unit = mc.meterInMercatorCoordinateUnits();
    const lift = 12 * exag; // metres above the surface so the lines do not z-fight it
    const out = [];
    const push = (i, j) => {
      const v = h[j * S + i];
      out.push(mc.x - half + i * step, mc.y - half + j * step, (v * exag + lift) * unit, (v - lo) / (hi - lo));
    };
    for (let l = 0; l < S; l += GRID_EVERY) {
      for (let s = 0; s < GRID; s++) {
        if (!Number.isNaN(h[l * S + s]) && !Number.isNaN(h[l * S + s + 1])) { push(s, l); push(s + 1, l); }
        if (!Number.isNaN(h[s * S + l]) && !Number.isNaN(h[(s + 1) * S + l])) { push(l, s); push(l, s + 1); }
      }
    }
    this.holo.upload(new Float32Array(out));
    this.holo.center = [mc.x, mc.y];
    this.holo.span = half;
    this.range = [lo, hi];
    map.setPaintProperty('hypso', 'color-relief-color', ramp(lo, hi));
    this.renderDetail();
    return missing === 0;
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const map = this.map;
    if (!map || !this.holo?.gl) return; // not isStyleLoaded(): it is false whenever tiles stream in
    const now = performance.now();
    const dt = Math.min(info.dt / 1000, 0.1);
    const moving = !info.reducedMotion;
    const easing = map.isMoving();
    if (moving) this.holo.time += dt;
    if (this.state.rotate && moving && !easing && !this._down && now - this.idleSince > IDLE_RESUME_MS) {
      map.setBearing(map.getBearing() + ROT_DEG_S * dt);
      this.spun = (this.spun ?? 0) + ROT_DEG_S * dt;
      this.loopCheck(this.spun - ROT_DEG_S * dt, this.spun, 360);
    }
    else if (this.state.holo && moving) map.triggerRepaint(); // keep the scan wave going
    // retry while terrain tiles are still streaming in (capped: tiles far off-screen may never load)
    if (this.holoDirty && !easing && now - (this._lastBuild ?? 0) > 1200 && this.holoTries < 15) {
      this._lastBuild = now;
      this.holoTries++;
      if (this.buildHolo()) this.holoDirty = false;
    }
    if (!this._lastHud || now - this._lastHud > 250) {
      this._lastHud = now;
      this.updateTelemetry();
    }
  }

  frameAll() {
    this.idleSince = performance.now();
    this.setCity(this.cityIdx);
  }

  /** @param {boolean} visible */
  onVisibility(visible) {
    // maplibre owns a WebGL context outside the GL pool: give it back while hidden
    if (!visible) this.dropMap();
    else this.createMap();
  }

  resize() {
    this.map?.resize();
  }

  // ------------------------------------------------------------------ input

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (e.target !== this.host) return;
    const k = e.key.toLowerCase();
    if (k === 'r') this.toggle('rotate');
    else if (k === 'g') this.toggle('holo');
    else if (k === 'home') this.frameAll();
    else if (k === 'arrowright' || k === 'arrowdown') this.pick(this.cityIdx + 1);
    else if (k === 'arrowleft' || k === 'arrowup') this.pick(this.cityIdx - 1);
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
    if (key === 'holo' && this.map?.getLayer('holo')) this.map.setLayoutProperty('holo', 'visibility', this.state.holo ? 'visible' : 'none');
    if (key === 'rotate') this.idleSince = 0;
    this.ctx?.refreshHeader();
    this.save();
  }

  // ------------------------------------------------------------------ overlay (HUD)

  buildOverlay() {
    const left = el('div', 'ms-sc-col is-left');
    this.telemetry = el('section', 'ms-sc-panel');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Telemetry'), el('span', 'ms-sc-tag', 'Live'));
    this.tele = {};
    const rows = [['bearing', 'Bearing'], ['pitch', 'Pitch'], ['zoom', 'Zoom'], ['view', 'View centre']].map(([k, label]) => {
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
    const panel = el('section', 'ms-sc-panel ms-gl-cities');
    const listHead = el('header', 'ms-sc-head');
    listHead.append(el('span', '', 'Terrains'), el('span', 'ms-sc-tag', `${CITIES.length}`));
    const list = el('div', 'ms-sc-systems');
    this.cityBtns = CITIES.map((c, i) => {
      const btn = el('button', 'ms-sc-sys');
      btn.type = 'button';
      btn.title = `Open the holographic city of ${c.name}, ${c.country}`;
      btn.style.setProperty('--c', LIGHT);
      if (i === this.cityIdx) btn.setAttribute('aria-current', 'true');
      btn.append(el('i'), el('span', '', c.name), el('small', '', `×${VIEWS[c.name].exag}`));
      btn.addEventListener('click', () => this.enter(i));
      list.appendChild(btn);
      return btn;
    });
    panel.append(listHead, list);
    right.append(panel);

    this.loading = el('div', 'ms-sc-loading');
    this.loading.setAttribute('role', 'status');
    this.host.append(left, right, this.loading);
  }

  /** @param {string|null} text */
  renderLoading(text) {
    this.loading.hidden = !text;
    if (text) this.loading.innerHTML = `<span>${text}…</span>`;
  }

  updateTelemetry() {
    const map = this.map;
    if (!map || !this.tele) return;
    const { lng, lat } = map.getCenter();
    this.tele.bearing.textContent = `${((map.getBearing() + 360) % 360).toFixed(1)}°`;
    this.tele.pitch.textContent = `${map.getPitch().toFixed(1)}°`;
    this.tele.zoom.textContent = map.getZoom().toFixed(2);
    this.tele.view.textContent = fmtLatLng(lat, lng).replace(/(\d+\.\d{2})\d+/g, '$1');
  }

  renderDetail() {
    if (!this.detail) return;
    const c = CITIES[this.cityIdx];
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Terrain'), el('span', 'ms-sc-tag', `${this.cityIdx + 1} / ${CITIES.length}`));
    const title = el('h3', '', c.name);
    title.style.setProperty('--c', LIGHT);
    const meta = el('div', 'ms-so-facts');
    const r = this.range;
    for (const [k, v] of [['Country', c.country], ['Lowest', r ? `${Math.round(r[0]).toLocaleString()} m` : '–'], ['Highest', r ? `${Math.round(r[1]).toLocaleString()} m` : '–'], ['Exaggeration', `×${this.view.exag}`]]) {
      meta.append(el('span', '', k), el('b', '', v));
    }
    this.detail.replaceChildren(head, title, meta);
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
    wrap.append(tog('rotate', 'sync', 'Auto-rotate (R)'), tog('holo', 'sparkle', 'Holographic grid (G)'), frame);
    return [wrap];
  }

  getState() {
    const { rotate, holo } = this.state ?? {};
    return { rotate, holo, city: this.cityIdx };
  }

  dispose() {
    this.dropMap();
    this.root?.remove();
    super.dispose();
  }
}
