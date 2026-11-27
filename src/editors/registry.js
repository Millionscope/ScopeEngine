/**
 * Editor registry: id -> { label, icon, group, needs, kind, shortcut, loader }.
 * The workspace layer only knows this file; concrete editors are loaded lazily with import().
 * `needs` lists the heavy libraries an editor requires; they are loaded in parallel with the
 * editor module so the initial page load never fetches them.
 *
 * kind: 'editor' -> editor-like body (editor.background); 'panel' -> panel-like (sideBar.background)
 * @module editors/registry
 */

/**
 * @typedef {Object} EditorEntry
 * @property {string} id
 * @property {string} label
 * @property {string} icon          codicon name
 * @property {string} group         editor-type menu column
 * @property {string[]} needs       ['d3'] | ['chartjs'] | ['three'] | [] | ['mermaid'] | ['katex']
 * @property {'editor'|'panel'} kind
 * @property {string|null} shortcut
 * @property {boolean} usesScenario
 * @property {() => Promise<{default: any}>} loader
 */

export const GROUPS = ['General', 'Scope', 'Analysis', 'Minds & Sim', 'Verify & Source'];

/**
 * Lazy loader with a scaffolding fallback: if an editor's module does not exist yet (fetch
 * failure), the area shows a placeholder with the editor's name and icon. Any other error
 * (syntax, runtime) propagates so the area can show it with Retry.
 * @param {string} id @param {() => Promise<any>} load
 */
const lazy = (id, load) => () => load().catch((err) => {
  if (err instanceof TypeError && /fetch|import/i.test(String(err.message))) {
    return import('./shared/placeholder.js').then((m) => ({ default: m.makePlaceholder(getEditor(id) || { id }) }));
  }
  throw err;
});

/** @type {EditorEntry[]} */
export const EDITORS = [
  // General
  { id: 'chat', label: 'Chat', icon: 'comment-discussion', group: 'General', needs: [], kind: 'editor', shortcut: 'shift+f1', usesScenario: false, loader: lazy('chat', () => import('./chat/index.js')) },
  { id: 'console', label: 'Console', icon: 'terminal', group: 'General', needs: [], kind: 'panel', shortcut: 'shift+f4', usesScenario: false, loader: lazy('console', () => import('./console/index.js')) },
  { id: 'history', label: 'History', icon: 'history', group: 'General', needs: [], kind: 'panel', shortcut: null, usesScenario: false, loader: lazy('history', () => import('./history/index.js')) },
  // Scope
  { id: 'outliner', label: 'Outliner', icon: 'list-tree', group: 'Scope', needs: [], kind: 'panel', shortcut: 'shift+f2', usesScenario: false, loader: lazy('outliner', () => import('./outliner/index.js')) },
  { id: 'graph', label: 'Scope Graph', icon: 'type-hierarchy-sub', group: 'Scope', needs: ['d3'], kind: 'editor', shortcut: 'shift+f3', usesScenario: false, loader: lazy('graph', () => import('./graph/index.js')) },
  { id: 'space3d', label: '3D Scope Space', icon: 'globe', group: 'Scope', needs: ['three'], kind: 'editor', shortcut: 'shift+f5', usesScenario: false, loader: lazy('space3d', () => import('./space3d/index.js')) },
  { id: 'scope', label: 'Human Atlas', icon: 'pulse', group: 'Scope', needs: ['three', 'threefx'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('scope', () => import('./scope/index.js')) },
  { id: 'solar', label: 'Solar System', icon: 'globe', group: 'Scope', needs: ['three', 'threefx'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('solar', () => import('./solar/index.js')) },
  { id: 'globe', label: 'Earth Globe', icon: 'globe', group: 'Scope', needs: ['three', 'threefx', 'threeglobe'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('globe', () => import('./globe/index.js')) },
  { id: 'terrain', label: 'Terrain', icon: 'map', group: 'Scope', needs: ['mapbox'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('terrain', () => import('./terrain/index.js')) },
  { id: 'city', label: 'Holo City', icon: 'layers', group: 'Scope', needs: ['mapbox'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('city', () => import('./city/index.js')) },
  { id: 'protein', label: 'Protein', icon: 'beaker', group: 'Scope', needs: ['molstar'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('protein', () => import('./protein/index.js')) },
  { id: 'building', label: 'Building', icon: 'home', group: 'Scope', needs: ['three', 'threefx', 'gltf'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('building', () => import('./building/index.js')) },
  { id: 'atom', label: 'Atom', icon: 'symbol-misc', group: 'Scope', needs: ['three', 'threefx'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('atom', () => import('./atom/index.js')) },
  { id: 'sheet', label: 'Sheet', icon: 'table', group: 'Scope', needs: [], kind: 'editor', shortcut: 'shift+f6', usesScenario: true, loader: lazy('sheet', () => import('./sheet/index.js')) },
  { id: 'inspector', label: 'Properties', icon: 'symbol-property', group: 'Scope', needs: [], kind: 'panel', shortcut: 'shift+f7', usesScenario: true, loader: lazy('inspector', () => import('./inspector/index.js')) },
  // Analysis
  { id: 'controls', label: 'Controls', icon: 'settings', group: 'Analysis', needs: ['chartjs'], kind: 'panel', shortcut: 'shift+f8', usesScenario: true, loader: lazy('controls', () => import('./controls/index.js')) },
  { id: 'distribution', label: 'Distributions', icon: 'graph', group: 'Analysis', needs: ['chartjs'], kind: 'editor', shortcut: 'shift+f9', usesScenario: true, loader: lazy('distribution', () => import('./distribution/index.js')) },
  { id: 'sensitivity', label: 'Sensitivity', icon: 'graph-left', group: 'Analysis', needs: ['d3'], kind: 'editor', shortcut: 'shift+f10', usesScenario: true, loader: lazy('sensitivity', () => import('./sensitivity/index.js')) },
  { id: 'scenarios', label: 'Scenarios', icon: 'repo-forked', group: 'Analysis', needs: ['chartjs', 'd3'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('scenarios', () => import('./scenarios/index.js')) },
  // Minds & Sim
  { id: 'minds', label: 'Minds', icon: 'organization', group: 'Minds & Sim', needs: ['d3'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('minds', () => import('./minds/index.js')) },
  { id: 'simulation', label: 'Simulation', icon: 'play-circle', group: 'Minds & Sim', needs: ['chartjs'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('simulation', () => import('./simulation/index.js')) },
  { id: 'swarm', label: 'Swarm', icon: 'hubot', group: 'Minds & Sim', needs: [], kind: 'panel', shortcut: null, usesScenario: false, loader: lazy('swarm', () => import('./swarm/index.js')) },
  // Verify & Source
  { id: 'certificate', label: 'Certificate', icon: 'verified', group: 'Verify & Source', needs: [], kind: 'editor', shortcut: 'shift+f12', usesScenario: false, loader: lazy('certificate', () => import('./certificate/index.js')) },
  { id: 'proofs', label: 'Proofs', icon: 'law', group: 'Verify & Source', needs: ['katex'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('proofs', () => import('./proofs/index.js')) },
  { id: 'formula', label: 'Formula', icon: 'symbol-operator', group: 'Verify & Source', needs: ['katex'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('formula', () => import('./formula/index.js')) },
  { id: 'scopelang', label: 'ScopeLang', icon: 'code', group: 'Verify & Source', needs: [], kind: 'editor', shortcut: 'shift+f11', usesScenario: false, loader: lazy('scopelang', () => import('./scopelang/index.js')) },
  { id: 'evidence', label: 'Evidence', icon: 'book', group: 'Verify & Source', needs: [], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('evidence', () => import('./evidence/index.js')) },
  { id: 'diagram', label: 'Diagram', icon: 'type-hierarchy', group: 'Verify & Source', needs: ['mermaid'], kind: 'editor', shortcut: null, usesScenario: false, loader: lazy('diagram', () => import('./diagram/index.js')) },
];

const BY_ID = new Map(EDITORS.map((e) => [e.id, e]));

/** @param {string} id @returns {EditorEntry|null} */
export function getEditor(id) {
  return BY_ID.get(id) || null;
}

/** @returns {EditorEntry[]} */
export function listEditors() {
  return EDITORS;
}

export function editorIds() {
  return new Set(EDITORS.map((e) => e.id));
}

/** @returns {Array<{group: string, items: EditorEntry[]}>} */
export function byGroup() {
  return GROUPS.map((g) => ({ group: g, items: EDITORS.filter((e) => e.group === g) }));
}

/**
 * Register an editor at runtime (plugins, tests). Returns false if the id exists.
 * @param {EditorEntry} entry
 */
export function registerEditor(entry) {
  if (BY_ID.has(entry.id)) return false;
  EDITORS.push(entry);
  BY_ID.set(entry.id, entry);
  return true;
}
