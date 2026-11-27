/**
 * Protein: an AlphaFold protein model as a sci-fi hologram (@rcsb/rcsb-molstar).
 *  - the model and its metadata come live from AlphaFold DB (API -> BinaryCIF); the RCSB preset
 *    colours a single-chain model by pLDDT, like the AlphaFold viewer;
 *  - Mol* shading: emissive cartoon with bloom, cyan outline, transparent background, slow spin;
 *  - a glow pass (own WebGL canvas, screen-blended over Mol*'s) reads Mol*'s frame and adds a
 *    light band sweeping from the bottom to the top of the structure, a rim glow and scanlines;
 *  - a targeting reticle locks on to what the camera is focused on;
 *  - a zoom tour flies into each confident part of the chain and back out to the whole model.
 * Mol* owns a WebGL context outside the GL pool: it is dropped while the area is hidden.
 * @module editors/protein
 */
import { BaseEditor } from '../base-editor.js';
import { loadCss } from '../../core/lazy.js';
import { API, PROTEINS, PLDDT, plddtBand, pickModel, tourParts } from './afdb.js';

const BG = 0x02060d;
const SPIN = 0.05; // rotations per second
const SWEEP_S = 4.5; // one bottom-to-top pass
const FLY_MS = 1800;
const OVERVIEW_MS = 4500;
const INTRO_MS = 1500; // establishing shot after a load, then the tour opens with a zoom-in
const PART_MS = 5500;
const IDLE_RESUME_MS = 8000;

/** rcsb-molstar viewer with every piece of its own UI hidden: the HUD is ours. */
const VIEWER_PROPS = {
  layoutIsExpanded: false,
  layoutShowControls: false,
  layoutShowSequence: false,
  layoutShowLog: false,
  layoutShowRightPanel: false,
  viewportShowExpand: false,
  viewportShowControls: false,
  viewportShowSettings: false,
  viewportShowScreenshotControls: false,
  viewportShowSelectionMode: false,
  viewportShowSelectionTools: false,
  viewportShowTrajectoryControls: false,
  showWelcomeToast: false,
  detachedFromSierra: true,
  backgroundColor: BG,
};

let rcsbMolstar;
/** accession -> Promise<{model, parts}> (kept across areas: AFDB answers do not change in a session) */
const cache = new Map();

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** @param {string} url */
const getJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

/** Model metadata and tour parts for a UniProt accession. @param {string} acc */
function fetchEntry(acc) {
  let p = cache.get(acc);
  if (!p) {
    p = (async () => {
      const model = pickModel(await getJson(API + encodeURIComponent(acc)));
      if (!model) throw new Error('no AlphaFold model in the API response');
      const scores = model.plddtUrl ? await getJson(model.plddtUrl).then((d) => d.confidenceScore).catch(() => null) : null;
      const parts = tourParts(Array.isArray(scores) ? scores : new Array(model.length).fill(model.plddt));
      return { model, parts };
    })();
    cache.set(acc, p);
    p.catch(() => cache.delete(acc));
  }
  return p;
}

// ------------------------------------------------------------------ glow pass

const VS = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
const FS = `
precision mediump float;
uniform sampler2D u_tex; uniform vec2 u_res; uniform float u_time; uniform float u_sweep; uniform vec2 u_span;
float A(vec2 uv) { return texture2D(u_tex, uv).a; }
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 px = 1.0 / u_res;
  float a = A(uv);
  // rim: alpha gradient across the silhouette
  float rim = clamp(length(vec2(A(uv + vec2(2.0 * px.x, 0.0)) - A(uv - vec2(2.0 * px.x, 0.0)), A(uv + vec2(0.0, 2.0 * px.y)) - A(uv - vec2(0.0, 2.0 * px.y)))), 0.0, 1.0);
  // halo: a ring of taps, outside the molecule only
  float halo = 0.0;
  for (int i = 0; i < 12; i++) { float t = float(i) * 0.5236; halo += A(uv + vec2(cos(t), sin(t)) * px * 9.0); }
  halo = halo / 12.0 * (1.0 - a);
  // sweep: h is 0 at the bottom of the focused structure, 1 at its top
  float h = (gl_FragCoord.y - u_span.x) / max(u_span.y - u_span.x, 1.0);
  float band = exp(-pow((h - u_sweep) * 14.0, 2.0));
  float trail = h < u_sweep ? exp((h - u_sweep) * 6.0) : 0.0;
  float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 1.4 - u_time * 7.0);
  float flicker = 0.94 + 0.06 * sin(u_time * 31.0) * sin(u_time * 7.3);
  vec3 cyan = vec3(0.25, 0.85, 1.0);
  vec3 hot = vec3(0.75, 1.0, 1.0);
  vec3 col = a * (hot * band * 0.85 + cyan * trail * 0.16 + cyan * scan * 0.05)
    + cyan * rim * (0.3 + band * 1.3)
    + cyan * halo * (0.18 + band * 0.9);
  gl_FragColor = vec4(col * flicker, 1.0); // opaque: black is a no-op under mix-blend-mode: screen
}`;

/** Post glow over Mol*'s frame. Throws when WebGL is unavailable (then Mol* is shown as is). */
class Glow {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false });
    if (!gl) throw new Error('no WebGL');
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'glow shader');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // bottom-up, like gl_FragCoord and Mol*'s camera.project
    this.u = Object.fromEntries(['u_tex', 'u_res', 'u_time', 'u_sweep', 'u_span'].map((n) => [n, gl.getUniformLocation(p, n)]));
    this.gl = gl;
    this.canvas = canvas;
  }

  /** @param {HTMLCanvasElement} src Mol*'s canvas (preserveDrawingBuffer is on by default) */
  draw(src, time, sweep, y0, y1) {
    const { gl, canvas, u } = this;
    if (!src.width || !src.height) return;
    if (canvas.width !== src.width || canvas.height !== src.height) {
      canvas.width = src.width;
      canvas.height = src.height;
      gl.viewport(0, 0, src.width, src.height);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform2f(u.u_res, src.width, src.height);
    gl.uniform1f(u.u_time, time);
    gl.uniform1f(u.u_sweep, sweep);
    gl.uniform2f(u.u_span, y0, y1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Targeting reticle (viewBox centred on 0): spinning tick ring, counter-spinning dashes, lock arcs, brackets. */
const RETICLE = `<svg viewBox="-110 -110 220 220" aria-hidden="true">
  <g class="ms-pr-r1"><circle r="98" class="is-thin"/><circle r="98" pathLength="360" stroke-dasharray="0.6 4.4" class="is-ticks"/></g>
  <g class="ms-pr-r2"><circle r="88" pathLength="100" stroke-dasharray="16 6 2 6"/></g>
  <g class="ms-pr-r3"><circle r="76" pathLength="100" stroke-dasharray="18 7" class="is-lock"/></g>
  <path d="M0 -108v14M0 108v-14M-108 0h14M108 0h-14M-6 0h12M0 -6v12" class="is-cross"/>
  <path d="M-108 -84v-24h24M108 -84v-24h-24M-108 84v24h24M108 84v24h-24" class="is-bracket"/>
</svg>`;

export default class ProteinEditor extends BaseEditor {
  static id = 'protein';
  static label = 'Protein';
  static icon = 'beaker';
  static group = 'Scope';
  static needs = ['molstar'];

  async mount(ctx, state) {
    // literal new URL(...) calls: Vite only emits the CSS assets it can see statically
    await Promise.all([
      loadCss(new URL('../scope/scope.css', import.meta.url)),
      loadCss(new URL('../solar/solar.css', import.meta.url)),
      loadCss(new URL('../globe/globe.css', import.meta.url)),
      loadCss(new URL('./protein.css', import.meta.url)),
    ]);
    rcsbMolstar = ctx.libs.molstar;
    this.reduce = ctx.store?.get?.('ui.reducedMotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.state = { rotate: state.rotate ?? !this.reduce, tour: state.tour ?? !this.reduce, fx: state.fx !== false };
    this.idx = Number.isInteger(state.protein) && PROTEINS[state.protein] ? state.protein : 0;
    this.entry = null; // { model, parts } of the loaded protein
    this.part = -1; // focused part, -1 = whole model
    this.step = 0; // tour step: even = overview, odd = part (step - 1) / 2
    this.tourUntil = 0;
    this.idleSince = 0;
    this.time = 0;
    this.proj = [0, 0, 0, 0];
    this.sproj = [0, 0, 0, 0];

    const root = el('div', 'ms-ed ms-scope ms-globe ms-protein');
    root.classList.toggle('is-nofx', !this.state.fx);
    root.classList.toggle('is-still', this.reduce);
    this.root = root;
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'application');
    this.host.setAttribute('aria-roledescription', 'protein viewer');
    this.host.setAttribute('aria-label', 'Holographic AlphaFold protein model coloured by pLDDT confidence. Drag to rotate, scroll to zoom. R toggles auto-rotation, T the zoom tour, G the glow, arrow keys step through proteins, Home shows the whole model.');
    root.appendChild(this.host);
    ctx.el.appendChild(root);

    this.glowEl = el('canvas', 'ms-pr-glow');
    try { this.glow = new Glow(this.glowEl); } catch (err) { console.warn('[protein] glow pass off:', err); this.glow = null; }
    this.reticle = el('div', 'ms-pr-reticle');
    this.reticle.innerHTML = RETICLE;
    this.retTop = el('span', 'ms-pr-rt is-top', 'Acquiring target');
    this.retBottom = el('span', 'ms-pr-rt is-bottom', '');
    this.reticle.append(this.retTop, this.retBottom);
    this.caption = el('span', 'ms-pr-rt ms-pr-caption', '');
    this.host.append(this.glowEl, this.reticle, this.caption);
    this.buildOverlay();
    this.createViewer();

    this.disposables.add(ctx.scheduler.animate(this, (info) => this.tick(info)));
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
    // only input on the molecule pauses the tour, not clicks on the HUD
    const touch = (e) => { if (this.molEl?.contains(e.target)) this.idleSince = performance.now(); };
    this.listen(this.host, 'pointerdown', touch, { capture: true });
    this.listen(this.host, 'wheel', touch, { capture: true, passive: true });
  }

  // ------------------------------------------------------------------ Mol*

  get plugin() { return this.viewer?.plugin ?? null; }

  async createViewer() {
    if (this.viewer || !this.host) return;
    const molEl = el('div', 'ms-pr-mol');
    this.host.prepend(molEl);
    const viewer = new rcsbMolstar.Viewer(molEl, VIEWER_PROPS);
    this.viewer = viewer;
    this.molEl = molEl;
    await viewer.plugin.canvas3dInitialized;
    if (this.viewer !== viewer) return;
    this.applyCanvas();
    this.load(this.idx);
  }

  dropViewer() {
    if (!this.viewer) return;
    // ponytail: rcsb-molstar's Viewer has no dispose and keeps its React root private; the plugin
    // (and its WebGL context) is disposed, the detached React tree is left to GC
    this.viewer.plugin.dispose();
    this.molEl.remove();
    this.viewer = null;
    this.ready = false;
    this.loadTok = (this.loadTok ?? 0) + 1; // cancel an in-flight load
  }

  /** Hologram shading of the whole canvas. postprocessing merges one level deep: full params. */
  applyCanvas() {
    this.plugin?.canvas3d?.setProps({
      transparentBackground: true,
      renderer: { selectColor: 0xffb15c, highlightColor: 0xeafcff },
      postprocessing: {
        bloom: { name: 'on', params: { strength: 1.4, radius: 0.6, threshold: 0, mode: 'emissive', transparency: true } },
        outline: { name: 'on', params: { scale: 1, threshold: 0.33, color: 0x3fd8ff, includeTransparent: true } },
      },
      trackball: { animate: this.state.rotate ? { name: 'spin', params: { speed: SPIN, axis: [0, -1, 0] } } : { name: 'off', params: {} } },
    });
  }

  /** Make every representation glow a little (feeds the emissive bloom). */
  async applyHolo() {
    const plugin = this.plugin;
    if (!plugin) return;
    const b = plugin.build();
    for (const s of plugin.managers.structure.hierarchy.current.structures) {
      for (const c of s.components) {
        for (const r of c.representations) b.to(r.cell).update((old) => ({ ...old, type: { ...old.type, params: { ...old.type.params, emissive: 0.32 } } }));
      }
    }
    await b.commit();
  }

  /** Load protein i from AlphaFold DB. @param {number} i */
  async load(i) {
    const tok = (this.loadTok = (this.loadTok ?? 0) + 1);
    const p = PROTEINS[i];
    this.ready = false;
    this.entry = null;
    this.part = -1;
    this.msg.hidden = true;
    this.renderDetail();
    this.renderParts();
    this.renderLoading(`Fetching ${p.name} from AlphaFold DB`);
    this.retTop.textContent = 'Acquiring target';
    this.retBottom.textContent = p.acc;
    try {
      const entry = await fetchEntry(p.acc);
      if (tok !== this.loadTok || !this.viewer) return;
      this.renderLoading(`Folding ${entry.model.id}`);
      await this.viewer.clear();
      await this.viewer.loadStructureFromUrl(entry.model.url, 'mmcif', entry.model.binary);
      if (tok !== this.loadTok) return;
      await this.applyHolo();
      if (tok !== this.loadTok) return;
      this.entry = entry;
      this.ready = true;
      this.step = 0;
      this.atoms = null; // the load cleared the state, ball & stick included
      this.tourUntil = performance.now() + INTRO_MS;
      this.renderLoading(null);
      this.renderDetail();
      this.renderParts();
      this.lock();
    } catch (err) {
      if (tok !== this.loadTok) return;
      this.renderLoading(null);
      this.showMsg(`Could not load ${p.name} (${p.acc}) from AlphaFold DB: ${err?.message ?? err}`);
    }
  }

  /** Pick protein i (wraps). @param {number} i */
  pick(i) {
    const n = PROTEINS.length;
    this.idx = ((i % n) + n) % n;
    this.listBtns?.forEach((b, j) => (j === this.idx ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    this.save();
    if (this.viewer) this.load(this.idx);
  }

  // ------------------------------------------------------------------ zoom tour

  /** Fly into part i, highlighted. @param {number} i */
  focusPart(i) {
    const part = this.entry?.parts[i];
    const plugin = this.plugin;
    const structure = plugin?.managers.structure.hierarchy.current.structures[0]?.cell.obj?.data;
    if (!part || !structure) return;
    const target = { labelAsymId: this.entry.model.chain, labelSeqRange: { beg: part.beg, end: part.end } };
    this.viewer.select(target, 'select', 'set');
    const loci = plugin.managers.structure.selection.getLoci(structure);
    // tighter than the part's bounding sphere: close enough to read atoms and bonds
    plugin.managers.camera.focusLoci(loci, { durationMs: this.reduce ? 0 : FLY_MS, extraRadius: -6, minRadius: 6 });
    this.viewer.clearSelection('select'); // only needed for the loci; its tint would hide the element colours
    this.showAtoms(target);
    this.part = i;
    this.lock();
  }

  /**
   * The zoomed part's atoms as ball & stick over its cartoon (null clears). One at a time:
   * rcsb-molstar keys these by label, which is the same for every range.
   * @param {object|null} target
   */
  showAtoms(target) {
    const v = this.viewer;
    const prev = this.atoms;
    this.atoms = target;
    (async () => {
      if (prev) await v.setBallAndStick(prev, 'off');
      if (target && this.atoms === target && this.viewer === v) await v.setBallAndStick(target, 'on');
    })().catch((err) => console.warn('[protein] ball & stick:', err));
  }

  /** Back out to the whole model. */
  overview() {
    if (!this.viewer || !this.ready) return;
    this.viewer.clearSelection('select');
    this.showAtoms(null);
    this.viewer.resetCamera(this.reduce ? 0 : FLY_MS);
    this.part = -1;
    this.lock();
  }

  /** A part (or the whole model, -1) picked by hand: the tour carries on from there after an idle pause. @param {number} i */
  goTo(i) {
    this.idleSince = performance.now();
    this.step = i < 0 ? 0 : 2 * i + 1;
    this.tourUntil = 0;
    if (i < 0) this.overview();
    else this.focusPart(i);
  }

  /** @param {number} now */
  tourTick(now) {
    const parts = this.entry?.parts;
    if (!this.state.tour || !this.ready || !parts?.length || now < this.tourUntil || now - this.idleSince < IDLE_RESUME_MS) return;
    this.step = (this.step + 1) % (parts.length * 2);
    if (this.step % 2) {
      this.focusPart((this.step - 1) / 2);
      this.tourUntil = now + PART_MS;
    } else {
      this.overview();
      this.tourUntil = now + OVERVIEW_MS;
    }
  }

  /** Show the reticle (whole model) or the part caption (zoomed in), and replay the lock-on. */
  lock() {
    const m = this.entry?.model;
    const part = this.entry?.parts[this.part];
    // the reticle frames the whole model only; zoomed into a part, a caption names it instead
    this.root.classList.toggle('is-zoomed', !!part);
    this.retTop.textContent = m ? `Target lock · ${m.id}` : 'Acquiring target';
    this.retBottom.textContent = m ? `Full structure · ${m.length} aa · pLDDT ${m.plddt.toFixed(1)}` : '';
    this.caption.textContent = part ? `Residues ${part.beg}–${part.end} · pLDDT ${part.plddt.toFixed(1)} · atoms` : '';
    this.reticle.classList.remove('is-locking');
    void this.reticle.offsetWidth; // restart the CSS animation
    this.reticle.classList.add('is-locking');
    this.partBtns?.forEach((b, j) => (j - 1 === this.part ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  }

  // ------------------------------------------------------------------ per-frame

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const c3d = this.plugin?.canvas3d;
    const src = this.plugin?.canvas3dContext?.canvas;
    if (!c3d || !src) return;
    const now = performance.now();
    const moving = !info.reducedMotion && !this.reduce;
    if (moving) this.time += Math.min(info.dt / 1000, 0.1);
    this.tourTick(now);

    // what the camera looks at, in Mol*'s drawing-buffer pixels (bottom-up)
    const cam = c3d.camera;
    const { target, radius } = cam.state;
    if (!(radius > 0)) return;
    cam.project(this.proj, target);
    const r = radius / cam.getPixelSize(target);
    const [x, y] = this.proj;

    // the sweep spans the whole structure, even while the camera is zoomed into a part
    if (this.glow && this.state.fx) {
      const sph = c3d.boundingSphereVisible;
      const sweep = moving ? ((this.time % SWEEP_S) / SWEEP_S) * 1.3 - 0.15 : -10;
      const sy = cam.project(this.sproj, sph.center)[1];
      const sr = sph.radius / cam.getPixelSize(sph.center);
      this.glow.draw(src, this.time, sweep, sy - sr, sy + sr);
    }

    // reticle in CSS pixels, kept inside the viewport
    const k = src.clientWidth / (cam.viewport.width || 1);
    const w = src.clientWidth;
    const h = src.clientHeight;
    const rr = Math.min(Math.max(r * k * 1.08, 60), 0.46 * Math.min(w, h));
    const cx = Math.min(Math.max(x * k, rr), w - rr);
    const cy = Math.min(Math.max(h - y * k, rr), h - rr);
    const s = this.reticle.style;
    s.left = `${cx.toFixed(1)}px`;
    s.top = `${cy.toFixed(1)}px`;
    s.width = s.height = `${(2 * rr).toFixed(1)}px`;
  }

  frameAll() { this.goTo(-1); }

  /** @param {boolean} visible */
  onVisibility(visible) {
    if (!visible) this.dropViewer();
    else this.createViewer();
  }

  resize() {
    this.plugin?.canvas3d?.handleResize();
  }

  // ------------------------------------------------------------------ input

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (e.target !== this.host) return;
    const k = e.key.toLowerCase();
    if (k === 'r') this.toggle('rotate');
    else if (k === 't') this.toggle('tour');
    else if (k === 'g') this.toggle('fx');
    else if (k === 'home') this.frameAll();
    else if (k === 'arrowright' || k === 'arrowdown') this.pick(this.idx + 1);
    else if (k === 'arrowleft' || k === 'arrowup') this.pick(this.idx - 1);
    else return;
    e.preventDefault();
  }

  toggle(key) {
    this.state[key] = !this.state[key];
    if (key === 'rotate') this.applyCanvas();
    if (key === 'fx') this.root.classList.toggle('is-nofx', !this.state.fx);
    if (key === 'tour') { this.idleSince = 0; this.tourUntil = 0; this.renderParts(); }
    this.ctx?.refreshHeader();
    this.save();
  }

  // ------------------------------------------------------------------ overlay (HUD)

  buildOverlay() {
    const left = el('div', 'ms-sc-col is-left');
    this.detail = el('section', 'ms-sc-panel');
    this.detail.setAttribute('aria-live', 'polite');
    this.conf = el('section', 'ms-sc-panel ms-sc-detail');
    left.append(this.detail, this.conf);

    const right = el('div', 'ms-sc-col is-right');
    const panel = el('section', 'ms-sc-panel ms-gl-cities');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Proteins'), el('span', 'ms-sc-tag', `${PROTEINS.length}`));
    const list = el('div', 'ms-sc-systems');
    this.listBtns = PROTEINS.map((p, i) => {
      const b = el('button', 'ms-sc-sys');
      b.type = 'button';
      b.title = `Load the AlphaFold model of ${p.name} (${p.acc})`;
      b.style.setProperty('--c', '#3fd8ff');
      if (i === this.idx) b.setAttribute('aria-current', 'true');
      b.append(el('i'), el('span', '', p.name), el('small', '', p.acc));
      b.addEventListener('click', () => this.pick(i));
      list.appendChild(b);
      return b;
    });
    panel.append(head, list);
    this.partsPanel = el('section', 'ms-sc-panel ms-pr-parts');
    right.append(panel, this.partsPanel);

    this.msg = el('div', 'ms-sc-msg');
    this.msg.hidden = true;
    this.loading = el('div', 'ms-sc-loading');
    this.loading.setAttribute('role', 'status');
    this.host.append(left, right, this.loading, this.msg);
  }

  /** @param {string|null} text */
  renderLoading(text) {
    this.loading.hidden = !text;
    if (text) this.loading.innerHTML = '<span></span>';
    if (text) this.loading.firstChild.textContent = `${text}…`;
  }

  /** @param {string} text */
  showMsg(text) {
    this.msg.textContent = text;
    this.msg.hidden = false;
    this.msg.setAttribute('role', 'status');
  }

  renderDetail() {
    const p = PROTEINS[this.idx];
    const m = this.entry?.model;
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Target'), el('span', 'ms-sc-tag', m?.version ? `AFDB v${m.version}` : 'AFDB'));
    const title = el('h3', '', m?.name || p.name);
    title.style.setProperty('--c', '#3fd8ff');
    const facts = el('div', 'ms-so-facts');
    for (const [k, v] of [['UniProt', p.acc], ['Gene', m?.gene ?? '–'], ['Organism', m?.organism ?? '–'], ['Residues', m ? String(m.length) : '–'], ['Model', m?.id ?? '–']]) facts.append(el('span', '', k), el('b', '', v));
    const link = el('a', 'ms-pr-link', 'Open in AlphaFold DB');
    link.href = `https://alphafold.ebi.ac.uk/entry/${encodeURIComponent(p.acc)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    this.detail.replaceChildren(head, title, facts, link);

    const chead = el('header', 'ms-sc-head');
    chead.append(el('span', '', 'Model confidence'), el('span', 'ms-sc-tag', m ? `pLDDT ${m.plddt.toFixed(1)}` : 'pLDDT'));
    const rows = PLDDT.map((b, i) => {
      const row = el('div', 'ms-pr-band');
      row.style.setProperty('--c', b.color);
      row.style.setProperty('--w', `${((m?.bands[i] ?? 0) * 100).toFixed(1)}%`);
      const bar = el('span', 'ms-pr-bar');
      bar.appendChild(el('b'));
      row.append(el('i'), el('span', '', `${b.label} (${b.range})`), el('b', '', m ? `${Math.round(m.bands[i] * 100)}%` : '–'), bar);
      return row;
    });
    this.conf.replaceChildren(chead, ...rows);
  }

  renderParts() {
    const parts = this.entry?.parts ?? [];
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', 'Zoom tour'), el('span', 'ms-sc-tag', this.state.tour ? 'Auto' : 'Manual'));
    const list = el('div', 'ms-sc-systems');
    const btn = (label, sub, color, i) => {
      const b = el('button', 'ms-sc-sys');
      b.type = 'button';
      b.style.setProperty('--c', color);
      b.append(el('i'), el('span', '', label), el('small', '', sub));
      b.addEventListener('click', () => this.goTo(i));
      if (i === this.part) b.setAttribute('aria-current', 'true');
      return b;
    };
    const whole = btn('Full structure', this.entry ? `${this.entry.model.length} aa` : '–', '#3fd8ff', -1);
    whole.title = 'Zoom out to the whole model (Home)';
    // [whole, ...parts]: button j is part j - 1
    this.partBtns = [whole, ...parts.map((p, i) => {
      const b = btn(`Residues ${p.beg}–${p.end}`, p.plddt.toFixed(0), plddtBand(p.plddt).color, i);
      b.title = `Zoom into residues ${p.beg}–${p.end} (mean pLDDT ${p.plddt.toFixed(1)})`;
      return b;
    })];
    list.append(...this.partBtns);
    this.partsPanel.replaceChildren(head, list);
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
    frame.setAttribute('aria-label', 'Whole model (Home)');
    frame.dataset.tooltip = 'Whole model (Home)';
    frame.innerHTML = '<span class="codicon codicon-screen-full"></span>';
    frame.addEventListener('click', () => this.frameAll());
    wrap.append(tog('rotate', 'sync', 'Auto-rotate (R)'), tog('tour', 'zoom-in', 'Zoom tour (T)'), tog('fx', 'sparkle', 'Holographic glow (G)'), frame);
    return [wrap];
  }

  getState() {
    const { rotate, tour, fx } = this.state ?? {};
    return { rotate, tour, fx, protein: this.idx };
  }

  dispose() {
    this.dropViewer();
    this.glow?.dispose();
    this.root?.remove();
    super.dispose();
  }
}
