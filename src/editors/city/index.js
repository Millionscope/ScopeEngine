/**
 * Holo City: a holographic 3D city of one of the globe's 20 cities (mapbox-gl v3), opened from the
 * Terrain scope when a city is clicked.
 *  - Mapbox Streets buildings extruded as glowing glass: colour by height and building type, the
 *    tallest towers (the tour stops) highlighted, flood light at their feet, outlines on the ground;
 *  - a custom WebGL layer draws traffic: every road is a ribbon of two opposing lanes with glowing
 *    streaks running along them, coloured by road class (additive blending);
 *  - the camera loops on its own along a spline through the tallest towers (an orbit until the
 *    buildings have loaded); dragging or scrolling pauses it for a few idle seconds.
 * The city comes from the store key `terrain.city`, shared with the Globe and Terrain.
 * @module editors/city
 */
import { BaseEditor } from '../base-editor.js';
import { emptyState } from '../shared/empty-state.js';
import { loadCss } from '../../core/lazy.js';
import { CITIES, fmtLatLng } from '../shared/cities.js';
import { pickStops, loopAt, ribbons, STRIDE } from './tour.js';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const KEY = 'terrain.city';
const ZOOM = 15.6; // buildings only exist in the tiles from z15
const PITCH = 62;
const SPEED = 70; // camera, m/s along the tour
const ROT_DEG_S = 4; // orbit fallback
const IDLE_RESUME_MS = 6000;
const RADIUS = 2600; // metres around the centre that get traffic and tour stops
const LIGHT = '#3fd8ff';

/** road class → [kind (shader colour), half-width in metres] */
const ROADS = { motorway: [0, 13], trunk: [0, 12], primary: [1, 10], secondary: [2, 8], tertiary: [2, 7], street: [3, 5], street_limited: [3, 4] };
const ROAD_CLASSES = Object.keys(ROADS);

let mapboxgl;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const heightOf = ['to-number', ['get', 'height'], 0];
const style = () => ({
  version: 8,
  projection: { name: 'mercator' },
  sources: { streets: { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' } },
  lights: [
    { id: 'amb', type: 'ambient', properties: { color: '#d6ecff', intensity: 0.6 } },
    { id: 'key', type: 'directional', properties: { color: '#bfe9ff', intensity: 0.5, direction: [210, 40], 'cast-shadows': false } },
  ],
  fog: { range: [1.5, 9], color: '#04102a', 'high-color': '#0c2d66', 'horizon-blend': 0.12, 'space-color': '#01030a', 'star-intensity': 0.35 },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#020814' } },
    { id: 'water', type: 'fill', source: 'streets', 'source-layer': 'water', paint: { 'fill-color': '#06205e', 'fill-opacity': 0.9 } },
    { id: 'water-edge', type: 'line', source: 'streets', 'source-layer': 'water', paint: { 'line-color': '#3fb4ff', 'line-width': 2, 'line-blur': 2, 'line-opacity': 0.6 } },
    { id: 'park', type: 'fill', source: 'streets', 'source-layer': 'landuse', filter: ['match', ['get', 'class'], ['park', 'grass', 'pitch'], true, false], paint: { 'fill-color': '#0b3d2c', 'fill-opacity': 0.55 } },
    { id: 'road-glow', type: 'line', source: 'streets', 'source-layer': 'road', filter: ['match', ['get', 'class'], ROAD_CLASSES, true, false], paint: { 'line-color': '#1d5fd6', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 14, 3, 18, 28], 'line-blur': 6, 'line-opacity': 0.35 } },
    { id: 'road', type: 'line', source: 'streets', 'source-layer': 'road', filter: ['match', ['get', 'class'], ROAD_CLASSES, true, false], paint: { 'line-color': '#5c8fd6', 'line-width': 0.6, 'line-opacity': 0.5 } },
    { id: 'footprint', type: 'line', source: 'streets', 'source-layer': 'building', paint: { 'line-color': '#3fd8ff', 'line-width': 0.8, 'line-opacity': 0.35 } },
    {
      id: 'bld', type: 'fill-extrusion', source: 'streets', 'source-layer': 'building', filter: ['==', ['get', 'extrude'], 'true'],
      paint: {
        // holographic glass: blue → cyan → ice by height; shops violet, industry amber
        'fill-extrusion-color': ['match', ['get', 'type'],
          ['retail', 'commercial', 'shop', 'supermarket'], '#b26bff',
          ['industrial', 'warehouse', 'garage', 'garages'], '#ffaa4a',
          ['interpolate', ['linear'], heightOf, 0, '#2f7fe0', 25, '#4eb4ff', 70, '#7fdcff', 150, '#bff2ff', 300, '#f0fdff']],
        'fill-extrusion-height': heightOf,
        'fill-extrusion-base': ['to-number', ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.68,
        'fill-extrusion-vertical-gradient': true,
        'fill-extrusion-emissive-strength': 0.85,
      },
    },
    {
      // the tour's towers (filter set once the stops are known), lime like a selected BIM model
      id: 'bld-hi', type: 'fill-extrusion', source: 'streets', 'source-layer': 'building', filter: ['>=', heightOf, 1e9],
      paint: {
        'fill-extrusion-color': '#c8ff4a',
        'fill-extrusion-height': heightOf,
        'fill-extrusion-base': ['to-number', ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.9,
        'fill-extrusion-emissive-strength': 0.9,
        'fill-extrusion-flood-light-color': '#c8ff4a',
        'fill-extrusion-flood-light-intensity': 0.8,
        'fill-extrusion-flood-light-ground-radius': 40,
        'fill-extrusion-flood-light-wall-radius': 30,
      },
    },
  ],
});

const VS = `
uniform mat4 u_matrix;
attribute vec2 a_pos; attribute vec4 a_lane; // across, dist, kind, seed
varying vec4 v_lane;
void main() {
  v_lane = a_lane;
  gl_Position = u_matrix * vec4(a_pos, 1.5, 1.0); // 1.5 m above the street
}`;
const FS = `
precision highp float;
uniform float u_time;
varying vec4 v_lane;
vec3 col(float k) { return k < 0.5 ? vec3(1.0, 0.72, 0.22) : k < 1.5 ? vec3(0.25, 0.92, 1.0) : k < 2.5 ? vec3(1.0, 0.32, 0.85) : vec3(0.35, 1.0, 0.62); }
void main() {
  float across = v_lane.x, kind = v_lane.z, seed = v_lane.w;
  float dir = across > 0.0 ? 1.0 : -1.0;               // two lanes, opposite traffic
  float lane = exp(-pow((abs(across) - 0.5) * 3.5, 2.0)); // soft glow around each lane's centre
  float speed = 34.0 - kind * 5.0 + seed * 10.0;          // m/s
  float period = 90.0 + seed * 110.0;                     // metres between cars
  float ph = fract((dir * v_lane.y - u_time * speed) / period + seed * 7.0 + (dir > 0.0 ? 0.0 : 0.5));
  float streak = ph < 0.35 ? pow(ph / 0.35, 3.0) : 0.0;  // bright head, fading tail
  float a = lane * (0.07 + 1.6 * streak);
  gl_FragColor = vec4(col(kind) * a, a);
}`;

/** Mapbox custom layer: the traffic ribbons (rebuilt from road features by the editor). */
class TrafficLayer {
  constructor() {
    this.id = 'traffic';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.count = 0;
    this.time = 0;
    this.origin = [0, 0];
    this.unit = 1;
    this.m = new Float32Array(16);
  }

  onAdd(map, gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'traffic shader');
      return s;
    };
    const p = (this.prog = gl.createProgram());
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.loc = { pos: gl.getAttribLocation(p, 'a_pos'), lane: gl.getAttribLocation(p, 'a_lane'), matrix: gl.getUniformLocation(p, 'u_matrix'), time: gl.getUniformLocation(p, 'u_time') };
    this.buf = gl.createBuffer();
    this.gl = gl;
  }

  /** @param {Float32Array} verts */
  upload(verts) {
    if (!this.gl) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.count = verts.length / STRIDE;
  }

  render(gl, matrix) {
    if (!this.count) return;
    // vertices are metres from the city centre (float32 mercator would jitter at street zoom):
    // compose matrix · translate(origin) · scale(unit) here, in float64
    const [ox, oy] = this.origin;
    const s = this.unit;
    const m = this.m;
    for (let r = 0; r < 4; r++) {
      m[r] = matrix[r] * s;
      m[4 + r] = matrix[4 + r] * s;
      m[8 + r] = matrix[8 + r] * s;
      m[12 + r] = matrix[r] * ox + matrix[4 + r] * oy + matrix[12 + r];
    }
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.matrix, false, m);
    gl.uniform1f(this.loc.time, this.time);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(this.loc.lane);
    gl.vertexAttribPointer(this.loc.lane, 4, gl.FLOAT, false, STRIDE * 4, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive: crossings glow
    gl.depthMask(false); // hidden behind buildings, never occludes
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.depthMask(true);
  }

  onRemove(map, gl) {
    gl.deleteBuffer(this.buf);
    gl.deleteProgram(this.prog);
    this.gl = null;
  }
}

export default class CityEditor extends BaseEditor {
  static id = 'city';
  static label = 'Holo City';
  static icon = 'layers';
  static group = 'Scope';
  static needs = ['mapbox'];

  async mount(ctx, state) {
    await Promise.all(['../scope/scope.css', '../solar/solar.css', '../globe/globe.css', '../terrain/terrain.css'].map((p) => loadCss(new URL(p, import.meta.url))));
    mapboxgl = ctx.libs.mapbox;
    this.reduce = ctx.store?.get?.('ui.reducedMotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = { tour: state.tour ?? !this.reduce, traffic: state.traffic !== false };
    const stored = ctx.store?.get(KEY);
    this.cityIdx = Number.isInteger(stored) ? stored : Number.isInteger(state.city) ? state.city : 0;
    this.idleSince = 0;

    const root = el('div', 'ms-ed ms-scope ms-globe ms-terrain ms-city');
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'city viewer');
    this.host.setAttribute('aria-label', 'Holographic 3D city with live traffic. Drag to orbit, scroll to zoom. R toggles the camera loop, T the traffic, arrow keys step through cities, Home resets the camera.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    if (!TOKEN) {
      this.host.replaceChildren(emptyState({ icon: 'key', title: 'Mapbox access token needed', text: 'Mapbox GL JS v3 only renders with a Mapbox access token. Add VITE_MAPBOX_TOKEN=pk.… to .env.local (or to the Pages build environment) and restart the dev server.' }));
      return;
    }
    this.mapEl = el('div', 'ms-tr-map');
    this.host.appendChild(this.mapEl);
    this.buildOverlay();
    this.createMap();

    this.disposables.add(ctx.scheduler.animate(this, (info) => this.tick(info)));
    this.disposables.add(ctx.store.select(KEY, (i) => { if (Number.isInteger(i)) this.setCity(i); }));
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    const touch = () => { this.idleSince = performance.now(); this.resume = true; };
    this.listen(this.mapEl, 'pointerdown', () => { this._down = true; touch(); }, { capture: true });
    this.listen(window, 'pointerup', () => { if (this._down) { this._down = false; touch(); } });
    this.listen(this.mapEl, 'wheel', touch, { capture: true, passive: true });
  }

  // ------------------------------------------------------------------ map

  createMap() {
    if (this.map) return;
    mapboxgl.accessToken = TOKEN;
    const c = CITIES[this.cityIdx];
    const map = (this.map = new mapboxgl.Map({ container: this.mapEl, style: style(), center: [c.lng, c.lat], zoom: ZOOM, pitch: PITCH, bearing: -30, maxPitch: 80, antialias: true }));
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.traffic = new TrafficLayer();
    this.resetData();
    map.on('style.load', () => {
      map.addLayer(this.traffic);
      map.setLayoutProperty('traffic', 'visibility', this.state.traffic ? 'visible' : 'none');
    });
    map.on('load', () => this.renderLoading(null));
    map.on('error', (e) => {
      const err = e.error;
      if (err?.status === 401 || /access token/i.test(String(err?.message))) this.showMsg(`Mapbox rejected the access token: ${err.message}`);
      else console.warn('[city]', err?.message ?? err);
    });
    this.renderLoading('Raising the city');
    this.renderDetail();
  }

  dropMap() {
    this.map?.remove();
    this.map = null;
    this.traffic = null;
  }

  /** Forget the previous city's stops and traffic; tick() rebuilds them as tiles land. */
  resetData() {
    this.stops = null;
    this.tourT = 0;
    this.roadCount = 0;
    this.stats = null;
    this.dataTries = 0;
    this.resume = true; // glide onto the new loop once it exists
    this.traffic?.upload(new Float32Array(0));
    if (this.map?.getLayer('bld-hi')) this.map.setFilter('bld-hi', ['>=', heightOf, 1e9]);
  }

  /** Fly to city i; the tour starts again from its towers once they load. */
  setCity(i) {
    const n = CITIES.length;
    i = ((i % n) + n) % n;
    const same = i === this.cityIdx;
    this.cityIdx = i;
    this.cityBtns?.forEach((b, j) => (j === i ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    this.save();
    if (!same) this.resetData();
    this.renderDetail();
    const map = this.map;
    if (!map) return;
    const c = CITIES[i];
    this.resume = true;
    map.flyTo({ center: [c.lng, c.lat], zoom: ZOOM, pitch: PITCH, bearing: map.getBearing(), duration: this.reduce ? 0 : 4000, essential: true });
  }

  /** @param {number} i */
  pick(i) {
    const n = CITIES.length;
    i = ((i % n) + n) % n;
    if (this.ctx?.store.get(KEY) === i) this.setCity(i);
    else this.ctx?.store.set(KEY, i);
  }

  /** Metres (east, south) from the city centre, for a [lng, lat]. */
  toLocal(lngLat) {
    const p = mapboxgl.MercatorCoordinate.fromLngLat(lngLat);
    return [(p.x - this.origin.x) / this.unit, (p.y - this.origin.y) / this.unit];
  }

  /**
   * Read the loaded road and building tiles around the centre: traffic ribbons from the roads,
   * tour stops from the tallest buildings. Returns the number of road segments found.
   */
  buildData() {
    const map = this.map;
    const c = CITIES[this.cityIdx];
    this.origin = mapboxgl.MercatorCoordinate.fromLngLat([c.lng, c.lat]);
    this.unit = this.origin.meterInMercatorCoordinateUnits();
    const near = ([x, y]) => x * x + y * y < RADIUS * RADIUS;

    const roads = [];
    let segs = 0;
    for (const f of map.querySourceFeatures('streets', { sourceLayer: 'road', filter: ['match', ['get', 'class'], ROAD_CLASSES, true, false] })) {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      const [kind, hw] = ROADS[f.properties.class];
      for (const line of lines) {
        const pts = line.map((ll) => this.toLocal(ll));
        if (pts.length < 2 || !pts.some(near)) continue;
        roads.push({ pts, hw, kind, seed: Math.random() });
        segs += pts.length - 1;
      }
    }
    // tiles only grow while the camera moves: keep the larger set so traffic never thins out
    if (segs > this.roadCount && this.traffic) {
      this.roadCount = segs;
      this.traffic.origin = [this.origin.x, this.origin.y];
      this.traffic.unit = this.unit;
      this.traffic.upload(ribbons(roads));
    }

    let count = 0;
    let tallest = 0;
    const bs = [];
    for (const f of map.querySourceFeatures('streets', { sourceLayer: 'building', filter: ['==', ['get', 'extrude'], 'true'] })) {
      count++;
      const h = Number(f.properties.height) || 0;
      if (h > tallest) tallest = h;
      if (h < 30 || f.geometry.type !== 'Polygon') continue;
      const ring = f.geometry.coordinates[0];
      let x = 0;
      let y = 0;
      for (const ll of ring) { const p = this.toLocal(ll); x += p[0]; y += p[1]; }
      const p = [x / ring.length, y / ring.length];
      if (near(p)) bs.push({ x: p[0], y: p[1], h });
    }
    if (!this.stats || count > this.stats.count) this.stats = { count, tallest, roads: roads.length };
    if (!this.stops) {
      this.stops = pickStops(bs);
      // highlight the towers the camera visits
      if (this.stops) map.setFilter('bld-hi', ['>=', heightOf, Math.min(...this.stops.map((s) => s.h)) - 0.5]);
    }
    this.renderDetail();
    return segs;
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const map = this.map;
    if (!map || !this.traffic?.gl) return;
    const now = performance.now();
    const dt = Math.min(info.dt / 1000, 0.1);
    const moving = !info.reducedMotion;
    const easing = map.isEasing();
    if (moving) this.traffic.time += dt;

    // read tiles: often at first, then every few seconds as the tour reveals more of the city
    const every = this.dataTries < 6 ? 1200 : 6000;
    if (!easing && now - (this._lastBuild ?? 0) > every && this.dataTries < 40) {
      this._lastBuild = now;
      this.dataTries++;
      this.buildData();
    }

    const idle = !this._down && now - this.idleSince > IDLE_RESUME_MS;
    if (this.state.tour && moving && !easing && idle) this.tour(dt);
    else if (this.state.traffic && moving) map.triggerRepaint(); // keep the streaks running

    if (!this._lastHud || now - this._lastHud > 250) {
      this._lastHud = now;
      this.updateTelemetry();
    }
  }

  /** Advance the camera loop (or orbit while there are no stops yet). @param {number} dt */
  tour(dt) {
    const map = this.map;
    if (!this.stops) {
      map.setBearing(map.getBearing() + ROT_DEG_S * dt);
      return;
    }
    const q = loopAt(this.stops, this.tourT);
    const ll = new mapboxgl.MercatorCoordinate(this.origin.x + q.x * this.unit, this.origin.y + q.y * this.unit).toLngLat();
    const want = (Math.atan2(q.dx, -q.dy) * 180) / Math.PI; // y points south: bearing from north, clockwise
    if (this.resume) {
      // back from a user drag or a city change: glide onto the loop instead of jumping
      this.resume = false;
      map.easeTo({ center: ll, bearing: want, pitch: PITCH, zoom: ZOOM, duration: this.reduce ? 0 : 2500 });
      return;
    }
    const b = map.getBearing();
    const turn = ((((want - b) % 360) + 540) % 360) - 180;
    map.jumpTo({ center: ll, bearing: b + turn * (1 - Math.exp(-dt * 1.2)) });
    this.tourT += (SPEED * dt) / (this.stops.length * Math.max(q.len, 50));
  }

  frameAll() {
    this.idleSince = performance.now();
    this.setCity(this.cityIdx);
  }

  /** @param {boolean} visible */
  onVisibility(visible) {
    if (!TOKEN) return;
    // mapbox owns a WebGL context outside the GL pool: give it back while hidden
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
    if (k === 'r') this.toggle('tour');
    else if (k === 't') this.toggle('traffic');
    else if (k === 'home') this.frameAll();
    else if (k === 'arrowright' || k === 'arrowdown') this.pick(this.cityIdx + 1);
    else if (k === 'arrowleft' || k === 'arrowup') this.pick(this.cityIdx - 1);
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
    if (key === 'traffic' && this.map?.getLayer('traffic')) this.map.setLayoutProperty('traffic', 'visibility', this.state.traffic ? 'visible' : 'none');
    if (key === 'tour') { this.idleSince = 0; this.resume = true; }
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
    listHead.append(el('span', '', 'Cities'), el('span', 'ms-sc-tag', `${CITIES.length}`));
    const list = el('div', 'ms-sc-systems');
    this.cityBtns = CITIES.map((c, i) => {
      const btn = el('button', 'ms-sc-sys');
      btn.type = 'button';
      btn.title = `Fly to ${c.name}, ${c.country}`;
      btn.style.setProperty('--c', LIGHT);
      if (i === this.cityIdx) btn.setAttribute('aria-current', 'true');
      btn.append(el('i'), el('span', '', c.name), el('small', '', c.a3));
      btn.addEventListener('click', () => this.pick(i));
      list.appendChild(btn);
      return btn;
    });
    panel.append(listHead, list);
    right.append(panel);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    this.loading = el('div', 'ms-sc-loading');
    this.loading.setAttribute('role', 'status');
    this.host.append(left, right, this.loading, this.msg);
  }

  /** @param {string|null} text */
  renderLoading(text) {
    this.loading.hidden = !text;
    if (text) this.loading.innerHTML = `<span>${text}…</span>`;
  }

  /** @param {string} text */
  showMsg(text) {
    this.msg.textContent = text;
    this.msg.hidden = false;
    this.msg.setAttribute('role', 'status');
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
    head.append(el('span', '', 'City'), el('span', 'ms-sc-tag', `${this.cityIdx + 1} / ${CITIES.length}`));
    const title = el('h3', '', c.name);
    title.style.setProperty('--c', LIGHT);
    const meta = el('div', 'ms-so-facts');
    const s = this.stats;
    const rows = [['Country', c.country], ['Buildings', s ? s.count.toLocaleString() : '–'], ['Tallest', s ? `${Math.round(s.tallest)} m` : '–'], ['Traffic lanes', s ? (2 * s.roads).toLocaleString() : '–'], ['Tour stops', this.stops ? String(this.stops.length) : 'orbit']];
    for (const [k, v] of rows) meta.append(el('span', '', k), el('b', '', v));
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
    wrap.append(tog('tour', 'debug-restart', 'Camera loop (R)'), tog('traffic', 'pulse', 'Traffic (T)'), frame);
    return [wrap];
  }

  getState() {
    const { tour, traffic } = this.state ?? {};
    return { tour, traffic, city: this.cityIdx };
  }

  dispose() {
    this.dropMap();
    this.root?.remove();
    super.dispose();
  }
}
