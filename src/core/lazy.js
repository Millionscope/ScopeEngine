/**
 * Lazy loading for third-party libraries, editor modules and stylesheets.
 * Libraries are only fetched through dynamic import() the first time an editor that declares
 * them in `needs` mounts; results are cached, failures are reported and retryable.
 *
 * Libraries are npm dependencies (exact pins in package.json); Vite splits each into its own chunk.
 * @module core/lazy
 */

/**
 * @typedef {Object} LibSpec
 * @property {() => Promise<any>} load     dynamic import of the library (and its stylesheet)
 * @property {string} version              documented pin
 * @property {(mod: any) => any=} init
 */

/** @type {Record<string, LibSpec>} */
export const LIBS = {
  d3: { load: () => import('d3'), version: 'd3@7.9.0' },
  chartjs: {
    load: () => import('chart.js'),
    version: 'chart.js@4.4.1',
    init: (m) => {
      m.Chart.register(...m.registerables);
      return m;
    },
  },
  three: {
    load: () => Promise.all([import('three'), import('three/examples/jsm/controls/OrbitControls.js')]),
    version: 'three@0.160.0',
    init: ([THREE, oc]) => ({ THREE, OrbitControls: oc.OrbitControls }),
  },
  // three.js add-ons for the Scope anatomy viewer: bloom post-processing and geometry merging
  threefx: {
    load: () => Promise.all([
      import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/RenderPass.js'),
      import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
      import('three/examples/jsm/postprocessing/OutputPass.js'),
      import('three/examples/jsm/utils/BufferGeometryUtils.js'),
    ]),
    version: 'three@0.160.0 addons',
    init: ([ec, rp, ub, op, bgu]) => ({ EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass, UnrealBloomPass: ub.UnrealBloomPass, OutputPass: op.OutputPass, mergeGeometries: bgu.mergeGeometries }),
  },
  // Building editor: glTF model loader
  gltf: { load: () => import('three/examples/jsm/loaders/GLTFLoader.js'), version: 'three@0.160.0 addons', init: (m) => m.GLTFLoader },
  // three-globe (Globe.GL's layer engine). 2.40.0 is the last release without a `three/webgpu` import,
  // which three 0.160 lacks; globe.gl itself needs three >= 0.179.
  threeglobe: { load: () => import('three-globe'), version: 'three-globe@2.40.0', init: (m) => m.default },
  // Terrain editor: open-source, renders free tiles without a token
  maplibre: {
    // its worker is found next to import.meta.url, which Vite's bundling moves: point it there explicitly
    load: () => Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'), import('maplibre-gl/dist/maplibre-gl.css')]),
    version: 'maplibre-gl@6.19.0',
    init: ([m, worker]) => {
      m.setWorkerUrl(worker.default);
      return m;
    },
  },
  // Holo City editor; v3 renders only with a Mapbox access token (VITE_MAPBOX_TOKEN)
  mapbox: {
    load: () => Promise.all([import('mapbox-gl'), import('mapbox-gl/dist/mapbox-gl.css')]).then(([m]) => m),
    version: 'mapbox-gl@3.35.2',
    init: (m) => m.default,
  },
  // Protein editor: the prebuilt UMD bundle (Mol* + React inside) as a classic script; it sets
  // self.rcsbMolstar. The package's CJS sources are not consumable by Vite as-is.
  molstar: {
    load: () => Promise.all([
      import('@rcsb/rcsb-molstar/build/dist/viewer/rcsb-molstar.js?url').then((m) => loadScript(m.default)),
      import('@rcsb/rcsb-molstar/build/dist/viewer/rcsb-molstar.css'),
    ]).then(() => /** @type {any} */ (self).rcsbMolstar),
    version: '@rcsb/rcsb-molstar@2.15.2',
  },
  mermaid: { load: () => import('mermaid'), version: 'mermaid@10.9.1', init: (m) => m.default },
  katex: {
    load: () => Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m),
    version: 'katex@0.16.9',
    init: (m) => m.default,
  },
  highcharts: { load: () => import('highcharts'), version: 'highcharts@11.4.8', init: (m) => m.default },
};

/** @type {Map<string, Promise<any>>} */
const libCache = new Map();
/** @type {Map<string, Promise<void>>} */
const cssCache = new Map();
/** names of libraries that finished loading */
const loaded = new Set();
/** names of libraries that were requested (even if pending) */
const requested = new Set();

let hooks = {
  /** @param {string} name @param {number} ms */
  onLoaded: (name, ms) => {},
  /** @param {string} name @param {Error} error */
  onFailed: (name, error) => {},
};

/** @param {Partial<typeof hooks>} h */
export function configureLazy(h) {
  hooks = { ...hooks, ...h };
}

/**
 * Inject a stylesheet once. Resolves on load (or after a short timeout so a slow CDN never
 * blocks mounting).
 * @param {string|URL} href
 */
export function loadCss(href) {
  const url = String(href);
  let p = cssCache.get(url);
  if (p) return p;
  p = new Promise((resolve) => {
    const existing = document.querySelector(`link[data-lazy-css="${CSS.escape(url)}"]`);
    if (existing) return resolve();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.lazyCss = url;
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 2500);
    document.head.appendChild(link);
  });
  cssCache.set(url, p);
  return p;
}

/** Run a classic (non-module) script once; rejects on a load error. @param {string} src */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(undefined);
    s.onerror = () => { s.remove(); reject(new TypeError(`failed to fetch script ${src}`)); };
    document.head.appendChild(s);
  });
}

/**
 * Load a named library (see LIBS) and return its initialized API.
 * @param {string} name
 */
export function loadLib(name) {
  const spec = LIBS[name];
  if (!spec) return Promise.reject(new Error(`unknown library "${name}"`));
  let p = libCache.get(name);
  if (p) return p;
  requested.add(name);
  const t0 = performance.now();
  p = (async () => {
    const mod = await spec.load();
    const api = spec.init ? spec.init(mod) : mod;
    loaded.add(name);
    hooks.onLoaded(name, Math.round(performance.now() - t0));
    return api;
  })();
  libCache.set(name, p);
  p.catch((err) => {
    libCache.delete(name);
    hooks.onFailed(name, err);
  });
  return p;
}

/**
 * Load several libraries; resolves to { name: api }.
 * @param {string[]} names
 */
export async function loadLibs(names) {
  const out = {};
  const apis = await Promise.all(names.map((n) => loadLib(n)));
  names.forEach((n, i) => { out[n] = apis[i]; });
  return out;
}

/** Libraries already loaded (debug overlay, lazy-loading tests). */
export function loadedLibs() { return [...loaded]; }
/** Libraries requested so far. */
export function requestedLibs() { return [...requested]; }
/** @param {string} name */
export function isLoaded(name) { return loaded.has(name); }
