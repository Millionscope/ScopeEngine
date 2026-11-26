/**
 * Lazy loading for third-party libraries, editor modules and stylesheets.
 * Libraries are only fetched through dynamic import() the first time an editor that declares
 * them in `needs` mounts; results are cached, failures are reported and retryable.
 *
 * Library specifiers resolve through the import map in index.html (exact pinned versions).
 * @module core/lazy
 */

/**
 * @typedef {Object} LibSpec
 * @property {string} specifier            bare specifier mapped by the import map
 * @property {string} version              documented pin
 * @property {string=} css                 stylesheet to load alongside
 * @property {Record<string,string>=} extras additional modules (name -> specifier)
 * @property {(mod: any, extras: Record<string, any>) => any=} init
 */

/** @type {Record<string, LibSpec>} */
export const LIBS = {
  d3: { specifier: 'd3', version: 'd3@7.9.0' },
  chartjs: {
    specifier: 'chart.js',
    version: 'chart.js@4.4.1',
    init: (m) => {
      m.Chart.register(...m.registerables);
      return m;
    },
  },
  three: {
    specifier: 'three',
    version: 'three@0.160.0',
    extras: { OrbitControls: 'three/addons/controls/OrbitControls.js' },
    init: (m, extras) => ({ THREE: m, OrbitControls: extras.OrbitControls.OrbitControls }),
  },
  mermaid: { specifier: 'mermaid', version: 'mermaid@10.9.1', init: (m) => m.default },
  katex: {
    specifier: 'katex',
    version: 'katex@0.16.9',
    css: 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
    init: (m) => m.default,
  },
  highcharts: { specifier: 'highcharts', version: 'highcharts@11.4.8', init: (m) => m.default },
};

/** @type {Map<string, Promise<any>>} */
const libCache = new Map();
/** @type {Map<string, Promise<any>>} */
const moduleCache = new Map();
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

/** Dynamic import with caching. @param {string} specifier */
export function loadModule(specifier) {
  let p = moduleCache.get(specifier);
  if (!p) {
    p = import(/* @vite-ignore */ specifier);
    moduleCache.set(specifier, p);
    p.catch(() => moduleCache.delete(specifier));
  }
  return p;
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
    const [mod, extras] = await Promise.all([
      loadModule(spec.specifier),
      (async () => {
        const out = {};
        for (const [k, s] of Object.entries(spec.extras || {})) out[k] = await loadModule(s);
        return out;
      })(),
      spec.css ? loadCss(spec.css) : Promise.resolve(),
    ]);
    const api = spec.init ? spec.init(mod, extras) : mod;
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
