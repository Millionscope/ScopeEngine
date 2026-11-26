/**
 * BodyParts3D anatomy atlas (public/models): one download per page, shared by every Scope editor.
 * Chunks stream in; subscribers are notified after each one so the body assembles while loading.
 * Each part keeps its index in a `partIndex` vertex attribute, so a ray hit on a merged mesh
 * resolves to the exact part without one picker mesh per part.
 * @module editors/scope/atlas
 */
/** three.js and mergeGeometries, handed in by the first subscriber (libraries load through core/lazy.js). */
let THREE = null;
let mergeGeometries = null;

/** Hologram palette per system (BodyParts3D system ids). */
export const SYSTEMS = [
  { id: 'nervous', name: 'Nervous', color: '#ffc845', text: 'Brain, spinal cord and nerves carry and process signals for sensation, movement and regulation.' },
  { id: 'cardiac', name: 'Heart', color: '#ff3d5a', text: 'A four-chamber muscular pump driving the pulmonary and systemic circulation.' },
  { id: 'arterial', name: 'Arteries', color: '#ff4b3a', text: 'Arteries carry blood away from the heart to the tissues and lungs.' },
  { id: 'venous', name: 'Veins', color: '#3d8bff', text: 'Veins return blood toward the heart from the tissues and lungs.' },
  { id: 'respiratory', name: 'Respiratory', color: '#38c6ff', text: 'Airways conduct air to the lungs, where oxygen and carbon dioxide exchange with blood.' },
  { id: 'digestive', name: 'Digestive', color: '#ff8a2a', text: 'The digestive tract breaks down food, absorbs nutrients and water and moves waste onward.' },
  { id: 'urinary', name: 'Urinary', color: '#ffd166', text: 'Kidneys filter blood and balance fluids and electrolytes; urine leaves through the bladder.' },
  { id: 'endocrine', name: 'Endocrine', color: '#c58cff', text: 'Endocrine organs release hormones that coordinate metabolism, growth and stress responses.' },
  { id: 'lymphatic', name: 'Lymphatic', color: '#4ade80', text: 'Lymphatic organs return tissue fluid and support immune surveillance.' },
  { id: 'reproductive', name: 'Reproductive', color: '#f472b6', text: 'Reproductive structures produce gametes and sex hormones.' },
  { id: 'sensory', name: 'Sensory', color: '#67e8f9', text: 'Special sense organs for sight, hearing and balance.' },
  { id: 'skeletal', name: 'Skeleton', color: '#bfe6ff', text: 'Bones support the body, protect organs and anchor muscles.' },
  { id: 'muscular', name: 'Muscles', color: '#ff7a6b', text: 'Skeletal muscles pull on their attachments to move joints and hold posture.' },
  { id: 'connective', name: 'Connective', color: '#9fb6c8', text: 'Cartilage and ligaments connect, support and separate structures.' },
  { id: 'integumentary', name: 'Body surface', color: '#3ab8ff', text: 'The skin: a protective barrier for sensation and temperature regulation.' },
];
export const SYSTEM_BY_ID = new Map(SYSTEMS.map((s) => [s.id, s]));

/**
 * Annotations: atlas concept name -> label. Anchors are the centers of the concept's part bounds.
 * `mode` picks the view the label belongs to; `system` colors it (concepts also include vessels).
 */
export const ANNOTATIONS = [
  { mode: 'body', system: 'nervous', concept: 'brain', title: 'Brain', text: 'Central organ of the nervous system: perception, movement, memory, language and regulation of the body.' },
  { mode: 'body', system: 'respiratory', concept: 'trachea', title: 'Trachea', text: 'Main airway from the larynx to the bronchi, held open by rings of cartilage.' },
  { mode: 'body', system: 'cardiac', concept: 'heart', title: 'Heart', text: 'Muscular pump: the right side sends blood to the lungs, the left side to the whole body (about 100,000 beats a day).' },
  { mode: 'body', system: 'respiratory', concept: 'right lung', title: 'Right lung', text: 'Three lobes. Air reaches the alveoli, where oxygen enters the blood and carbon dioxide leaves it.' },
  { mode: 'body', system: 'respiratory', concept: 'left lung', title: 'Left lung', text: 'Two lobes, leaving room for the heart. Gas exchange happens across ~300 million alveoli shared by both lungs.' },
  { mode: 'body', system: 'arterial', concept: 'aorta', title: 'Aorta', text: 'The largest artery: carries oxygenated blood from the left ventricle to the systemic circulation.' },
  { mode: 'body', system: 'digestive', concept: 'liver', title: 'Liver', text: 'Processes absorbed nutrients, produces bile and synthesizes many blood proteins.' },
  { mode: 'body', system: 'digestive', concept: 'stomach', title: 'Stomach', text: 'Stores food and mixes it with acid and enzymes before releasing it into the duodenum.' },
  { mode: 'body', system: 'lymphatic', concept: 'spleen', title: 'Spleen', text: 'Filters blood, removes aging red cells and takes part in immune responses.' },
  { mode: 'body', system: 'digestive', concept: 'pancreas', title: 'Pancreas', text: 'Supplies digestive enzymes and releases insulin and glucagon into the blood.' },
  { mode: 'body', system: 'urinary', concept: 'kidney', title: 'Kidneys', text: 'Filter about 180 L of blood plasma a day, regulating fluid, electrolytes and acid–base balance.' },
  { mode: 'body', system: 'digestive', concept: 'small intestine', title: 'Small intestine', text: 'Where most digestion and nutrient absorption happens; about 6 m long.' },
  { mode: 'body', system: 'digestive', concept: 'large intestine', title: 'Large intestine', text: 'Absorbs water and salts and forms stool from undigested material.' },
  { mode: 'body', system: 'urinary', concept: 'urinary bladder', title: 'Bladder', text: 'Muscular reservoir that stores urine arriving from the kidneys through the ureters.' },
  { mode: 'brain', system: 'nervous', concept: 'left frontal lobe', title: 'Frontal lobe', text: 'Planning, decision making, personality and voluntary movement (motor cortex).' },
  { mode: 'brain', system: 'nervous', concept: 'left parietal lobe', title: 'Parietal lobe', text: 'Integrates touch, temperature and body position into spatial awareness.' },
  { mode: 'brain', system: 'nervous', concept: 'left temporal lobe', title: 'Temporal lobe', text: 'Hearing, language comprehension and memory.' },
  { mode: 'brain', system: 'nervous', concept: 'right occipital lobe', title: 'Occipital lobe', text: 'Primary visual cortex: processes everything the eyes see.' },
  { mode: 'brain', system: 'nervous', concept: 'corpus callosum', title: 'Corpus callosum', text: 'About 200 million axons linking the left and right hemispheres.' },
  { mode: 'brain', system: 'nervous', concept: 'thalamus', title: 'Thalamus', text: 'Relay station that routes sensory and motor signals to the cortex.' },
  { mode: 'brain', system: 'nervous', concept: 'hippocampus', title: 'Hippocampus', text: 'Forms new memories and supports spatial navigation.' },
  { mode: 'brain', system: 'nervous', concept: 'cerebellum', title: 'Cerebellum', text: 'Coordinates balance, posture and the timing of fine movements.' },
  { mode: 'brain', system: 'nervous', concept: 'brainstem', title: 'Brainstem', text: 'Controls breathing, heart rate, sleep and arousal; connects brain and spinal cord.' },
];

/**
 * @typedef {Object} AtlasState
 * @property {any} atlas                      atlas.json
 * @property {Map<string, number>} index      part id -> part index
 * @property {Array<{system: string, geometry: any}>} meshes  merged per chunk and system
 * @property {number} progress                0..100
 * @property {Error|null} error
 * @property {boolean} done
 */

/** @type {AtlasState} */
const state = { atlas: null, index: new Map(), meshes: [], progress: 0, error: null, done: false };
/** @type {Set<() => void>} */
const listeners = new Set();
let started = false;
const notify = () => listeners.forEach((fn) => fn());

/**
 * Static hosts may serve .gz as a compressed response (fetch already decoded it) or as a raw
 * gzip file: inspect the magic bytes so it is never decoded twice.
 * @param {Response} response @param {number} expectedBytes @param {boolean} compressed
 */
export async function decodeModelResponse(response, expectedBytes, compressed) {
  if (!response.ok) throw new Error(`anatomy chunk: HTTP ${response.status}`);
  const payload = await response.arrayBuffer();
  const sig = new Uint8Array(payload, 0, Math.min(2, payload.byteLength));
  const gzip = compressed && sig[0] === 0x1f && sig[1] === 0x8b;
  const buffer = gzip ? await new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : payload;
  if (buffer.byteLength !== expectedBytes) throw new Error('An anatomy chunk was incomplete. Reload to retry.');
  return buffer;
}

async function loadChunk(ci) {
  const { atlas } = state;
  const chunk = atlas.chunks[ci];
  const compressed = !!chunk.gzip && typeof DecompressionStream !== 'undefined';
  const buffer = await decodeModelResponse(await fetch(compressed ? chunk.gzip : chunk.url), chunk.bytes, compressed);
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  atlas.parts.forEach((p, i) => {
    if (p.chunk !== ci) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, p.positions, p.vertexCount * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int16Array(buffer, p.normals, p.vertexCount * 3), 3, true));
    g.setAttribute('partIndex', new THREE.BufferAttribute(new Float32Array(p.vertexCount).fill(i), 1));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, p.indices, p.indexCount), 1));
    const list = groups.get(p.system) ?? [];
    list.push(g);
    groups.set(p.system, list);
  });
  for (const [system, gs] of groups) {
    const geometry = mergeGeometries(gs, false);
    if (!geometry) throw new Error('Could not assemble anatomy geometry.');
    geometry.computeBoundingSphere();
    gs.forEach((g) => g.dispose());
    state.meshes.push({ system, geometry });
  }
  state.progress = Math.round(((state.loaded = (state.loaded || 0) + 1) / atlas.chunks.length) * 100);
  notify();
}

async function start() {
  started = true;
  Object.assign(state, { error: null, progress: 0, loaded: 0, done: false });
  try {
    if (!state.atlas) {
      const res = await fetch('/models/atlas.json');
      if (!res.ok) throw new Error(`atlas.json: HTTP ${res.status}`);
      state.atlas = await res.json();
      state.atlas.parts.forEach((p, i) => state.index.set(p.id, i));
      notify();
    }
    // ponytail: geometry is kept for the page lifetime (~60 MB) so reopening the editor is instant.
    state.meshes = [];
    let cursor = 0;
    const n = state.atlas.chunks.length;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (cursor < n) await loadChunk(cursor++);
    }));
    state.done = true;
  } catch (err) {
    state.error = /** @type {Error} */ (err);
    started = false; // a later subscribe or retry() starts over
  }
  notify();
}

/**
 * Subscribe to atlas progress; starts the download on first use.
 * @param {() => void} fn @param {{THREE: any, mergeGeometries: Function}} libs
 */
export function subscribeAtlas(fn, libs) {
  THREE ??= libs.THREE;
  mergeGeometries ??= libs.mergeGeometries;
  listeners.add(fn);
  if (!started) start();
  else fn();
  return () => listeners.delete(fn);
}

export function retryAtlas() {
  if (!started) start();
}

/** @returns {AtlasState} */
export function atlasState() {
  return state;
}

/**
 * Part indices and world bounds of a concept (case-insensitive name), or null.
 * @param {string} name
 */
export function conceptInfo(name) {
  const atlas = state.atlas;
  const c = atlas?.concepts.find((x) => x.name.toLowerCase() === name);
  if (!c) return null;
  const box = new THREE.Box3();
  const parts = [];
  for (const id of c.elements) {
    const i = state.index.get(id);
    if (i === undefined) continue;
    parts.push(i);
    const b = atlas.parts[i].bounds;
    box.expandByPoint(new THREE.Vector3().fromArray(b[0])).expandByPoint(new THREE.Vector3().fromArray(b[1]));
  }
  return { id: c.id, name: c.name, parts, box, center: box.getCenter(new THREE.Vector3()) };
}
