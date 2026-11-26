/**
 * localStorage persistence with schema versions and migrations: layout (workspaces + area
 * trees + editor states), UI prefs, and the delta log. Every read is defensive: corrupted or
 * unavailable storage falls back to defaults.
 * @module workspace/persistence
 */

export const KEYS = {
  layout: 'millionscope.layout',
  prefs: 'millionscope.prefs',
  deltas: 'millionscope.deltas',
  theme: 'millionscope.theme',
};
export const LAYOUT_SCHEMA = 2;

/** @param {string} key */
function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** @param {string} key @param {any} value */
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/**
 * Migrations from older layout schemas. Each takes state of version n and returns n+1.
 * @type {Record<number, (s: any) => any>}
 */
const MIGRATIONS = {
  // v1 stored a single tree; v2 stores workspaces[]
  1: (s) => ({
    schema: 2,
    activeId: 'answer',
    workspaces: [{ id: 'answer', name: 'Answer', icon: 'comment-discussion', preset: 'answer', tree: s.tree }],
  }),
};

/** @returns {any|null} */
export function loadLayout() {
  let s = read(KEYS.layout);
  if (!s || typeof s !== 'object') return null;
  let guard = 0;
  while (s && s.schema < LAYOUT_SCHEMA && MIGRATIONS[s.schema] && guard++ < 10) s = MIGRATIONS[s.schema](s);
  if (!s || s.schema !== LAYOUT_SCHEMA || !Array.isArray(s.workspaces)) return null;
  return s;
}

/** @param {any} state */
export function saveLayout(state) {
  return write(KEYS.layout, { ...state, schema: LAYOUT_SCHEMA, savedAt: Date.now() });
}

export function clearLayout() {
  remove(KEYS.layout);
}

export function loadPrefs() {
  return read(KEYS.prefs) || {};
}

/** @param {object} prefs */
export function savePrefs(prefs) {
  return write(KEYS.prefs, prefs);
}

/** @returns {{schema:number, baseVersion:string, entries:any[]}|null} */
export function loadDeltaLog() {
  const s = read(KEYS.deltas);
  if (!s || s.schema !== 1 || !Array.isArray(s.entries)) return null;
  return s;
}

/** @param {{baseVersion:string, entries:any[]}} log */
export function saveDeltaLog(log) {
  return write(KEYS.deltas, { schema: 1, ...log });
}

export function clearDeltaLog() {
  remove(KEYS.deltas);
}
