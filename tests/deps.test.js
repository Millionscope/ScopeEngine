/**
 * Import-rule check (spec §7): crawl every module reachable from src/main.js (static imports,
 * re-exports and literal dynamic import() calls), classify each file into its layer, and fail
 * on any import a layer may not make. Also: heavy libraries only through core/lazy.js, no DOM in
 * model/ (and in services/ except notify.js), and every registered editor module exists.
 */
import { suite, assert } from './harness.js';

const test = suite('deps (import rules)');
const ROOT = new URL('../', import.meta.url);
const ENTRY = 'src/main.js';

/** Which layers each layer may import from. */
const ALLOWED = {
  core: ['core'],
  theme: ['core', 'theme', 'themes'],
  themes: ['themes'],
  model: ['core', 'model'],
  mock: ['core', 'model', 'mock'],
  services: ['core', 'model', 'mock', 'services'],
  workspace: ['core', 'theme', 'services', 'workspace', 'registry'],
  registry: ['core', 'editor-base', 'editor-shared', 'editor'],
  'editor-base': ['core', 'theme', 'model', 'services', 'editor-base', 'editor-shared'],
  'editor-shared': ['core', 'theme', 'model', 'services', 'editor-base', 'editor-shared'],
  editor: ['core', 'theme', 'model', 'services', 'editor-base', 'editor-shared', 'editor'],
  shell: ['core', 'theme', 'model', 'services', 'workspace', 'registry', 'editor-base', 'editor-shared', 'shell'],
  main: null, // composition root: may import anything
};

/** @param {string} rel path relative to the project root */
function layerOf(rel) {
  if (rel === 'src/main.js') return { layer: 'main' };
  if (rel.startsWith('src/core/')) return { layer: 'core' };
  if (rel.startsWith('src/theme/')) return { layer: 'theme' };
  if (rel.startsWith('themes/')) return { layer: 'themes' };
  if (rel.startsWith('src/model/')) return { layer: 'model' };
  if (rel.startsWith('src/mock/')) return { layer: 'mock' };
  if (rel.startsWith('src/services/')) return { layer: 'services' };
  if (rel.startsWith('src/workspace/')) return { layer: 'workspace' };
  if (rel.startsWith('src/shell/')) return { layer: 'shell' };
  if (rel === 'src/editors/registry.js') return { layer: 'registry' };
  if (rel === 'src/editors/base-editor.js') return { layer: 'editor-base' };
  if (rel.startsWith('src/editors/shared/')) return { layer: 'editor-shared' };
  const m = /^src\/editors\/([^/]+)\//.exec(rel);
  if (m) return { layer: 'editor', editor: m[1] };
  return { layer: 'other' };
}

/** Remove comments (JSDoc type imports must not count as imports). @param {string} src */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** @param {string} src @returns {Array<{spec: string, dynamic: boolean}>} */
function importsOf(src) {
  const code = stripComments(src);
  const out = [];
  const add = (re, dynamic) => {
    let m;
    while ((m = re.exec(code))) out.push({ spec: m[1], dynamic });
  };
  add(/^\s*import\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/gm, false);
  add(/^\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm, false);
  add(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, true);
  return out;
}

let crawled = null;

/** Crawl once; every test shares the result. */
function crawl() {
  if (crawled) return crawled;
  crawled = (async () => {
    /** @type {Map<string, {src: string, imports: Array<{spec: string, dynamic: boolean, rel: string|null}>}>} */
    const files = new Map();
    const failures = [];
    const queue = [ENTRY];
    while (queue.length) {
      const rel = /** @type {string} */ (queue.shift());
      if (files.has(rel)) continue;
      const res = await fetch(new URL(rel, ROOT), { cache: 'no-store' }).catch((e) => ({ ok: false, status: String(e) }));
      if (!res.ok) {
        failures.push(`${rel}: ${/** @type {any} */ (res).status}`);
        files.set(rel, { src: '', imports: [] });
        continue;
      }
      const src = await /** @type {Response} */ (res).text();
      const imports = importsOf(src).map((i) => {
        if (!i.spec.startsWith('.') && !i.spec.startsWith('/')) return { ...i, rel: null };
        const url = new URL(i.spec, new URL(rel, ROOT));
        return { ...i, rel: decodeURIComponent(url.pathname.slice(ROOT.pathname.length)) };
      });
      files.set(rel, { src, imports });
      for (const i of imports) if (i.rel && i.rel.endsWith('.js') && !files.has(i.rel)) queue.push(i.rel);
    }
    return { files, failures };
  })();
  return crawled;
}

test('crawls every module reachable from src/main.js (including lazy editors)', async () => {
  const { files, failures } = await crawl();
  assert.deepEqual(failures, [], 'modules that failed to load');
  assert.ok(files.size > 100, `found ${files.size} modules`);
  const editors = new Set([...files.keys()].map((f) => layerOf(f).editor).filter(Boolean));
  assert.ok(editors.size >= 21, `editor folders reached: ${[...editors].sort().join(', ')}`);
});

test('every import respects the layer rules', async () => {
  const { files } = await crawl();
  const violations = [];
  for (const [rel, f] of files) {
    const from = layerOf(rel);
    const allowed = ALLOWED[from.layer];
    if (allowed === null) continue;
    if (!allowed) { violations.push(`${rel}: file outside the known layers`); continue; }
    for (const i of f.imports) {
      if (!i.rel) continue; // bare specifiers are checked separately
      const to = layerOf(i.rel);
      let ok = allowed.includes(to.layer);
      // model/ may import mock/ only from its loader
      if (!ok && from.layer === 'model' && to.layer === 'mock' && rel === 'src/model/loader.js') ok = true;
      // editors never import other editors (their own folder is fine)
      if (ok && from.layer === 'editor' && to.layer === 'editor' && to.editor !== from.editor) ok = false;
      // the registry may reach concrete editors only through lazy import()
      if (ok && from.layer === 'registry' && to.layer === 'editor' && !i.dynamic) ok = false;
      if (!ok) violations.push(`${rel} (${from.layer}${from.editor ? `:${from.editor}` : ''}) → ${i.rel} (${to.layer}${to.editor ? `:${to.editor}` : ''})`);
    }
  }
  assert.deepEqual(violations, [], 'forbidden imports');
});

test('editors never import other editors; workspace and shell never import a concrete editor', async () => {
  const { files } = await crawl();
  const bad = [];
  for (const [rel, f] of files) {
    const from = layerOf(rel);
    for (const i of f.imports) {
      if (!i.rel) continue;
      const to = layerOf(i.rel);
      if (to.layer !== 'editor') continue;
      if ((from.layer === 'editor' && from.editor !== to.editor) || from.layer === 'workspace' || from.layer === 'shell') bad.push(`${rel} → ${i.rel}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('heavy libraries are never imported statically (only core/lazy.js loads them)', async () => {
  const { files } = await crawl();
  const bad = [];
  for (const [rel, f] of files) {
    for (const i of f.imports) if (!i.rel && rel !== 'src/core/lazy.js') bad.push(`${rel} imports "${i.spec}"${i.dynamic ? ' (dynamic)' : ''}`);
  }
  assert.deepEqual(bad, [], 'library imports outside core/lazy.js (theme adapters receive the library object instead)');
});

test('model/ has no DOM access; services/ only through notify.js events', async () => {
  const { files } = await crawl();
  const DOM = /\b(document|window|navigator|localStorage|sessionStorage|HTMLElement|requestAnimationFrame|getComputedStyle)\b/;
  const bad = [];
  for (const [rel, f] of files) {
    const layer = layerOf(rel).layer;
    if (layer !== 'model' && !(layer === 'services' && rel !== 'src/services/notify.js')) continue;
    const code = stripComments(f.src).replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
    const m = DOM.exec(code);
    if (m) bad.push(`${rel}: uses ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('mock/ is reached only from model/ loaders and services/', async () => {
  const { files } = await crawl();
  const bad = [];
  for (const [rel, f] of files) {
    const layer = layerOf(rel).layer;
    for (const i of f.imports) {
      if (!i.rel || layerOf(i.rel).layer !== 'mock') continue;
      if (layer === 'mock' || layer === 'services' || layer === 'main' || rel === 'src/model/loader.js') continue;
      bad.push(`${rel} → ${i.rel}`);
    }
  }
  assert.deepEqual(bad, []);
});
