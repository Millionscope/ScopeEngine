/**
 * WebGL renderer pool. Browsers cap live WebGL contexts (often ~16), so 3D editors acquire
 * renderers here: at most MAX live renderers; hidden editors release theirs (dispose +
 * forceContextLoss) and re-acquire when shown; the least recently used renderer is evicted
 * when the cap is reached. Context loss/restore is forwarded to the owner.
 * @module editors/shared/gl-pool
 */

let MAX = 4;
/**
 * @typedef {Object} GlOwner
 * @property {() => void} onContextEvicted   drop the renderer reference and show a paused state
 * @property {() => boolean=} isVisible
 */
/** @type {Map<GlOwner, {renderer: any, lastUsed: number, lost: boolean}>} */
const live = new Map();

/** Number of live WebGL renderers (debug overlay). */
export function glContextCount() {
  return live.size;
}

/** @param {number} n */
export function setMaxContexts(n) {
  MAX = Math.max(1, n);
}

let available = null;
/** Is WebGL available at all? */
export function glAvailable() {
  if (available !== null) return available;
  try {
    const c = document.createElement('canvas');
    available = !!(c.getContext('webgl2') || c.getContext('webgl'));
    const ext = /** @type {any} */ (c.getContext('webgl2') || c.getContext('webgl'))?.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  } catch {
    available = false;
  }
  return available;
}

/**
 * Acquire (or reuse) a renderer for an owner.
 * @param {GlOwner} owner
 * @param {any} THREE
 * @param {Record<string, any>} [opts] WebGLRenderer options
 */
export function acquire(owner, THREE, opts = {}) {
  const hit = live.get(owner);
  if (hit && !hit.lost) {
    hit.lastUsed = performance.now();
    return hit.renderer;
  }
  if (hit) release(owner);
  while (live.size >= MAX) {
    // evict hidden owners first, then the least recently used
    let victim = null;
    let oldest = Infinity;
    for (const [o, rec] of live) {
      const hidden = o.isVisible ? !o.isVisible() : false;
      const score = (hidden ? 0 : 1e12) + rec.lastUsed;
      if (score < oldest) { oldest = score; victim = o; }
    }
    if (!victim) break;
    release(victim);
    try { victim.onContextEvicted(); } catch (err) { console.error(err); }
  }
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', ...opts });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const rec = { renderer, lastUsed: performance.now(), lost: false };
  const canvas = renderer.domElement;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    rec.lost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    rec.lost = false;
  });
  live.set(owner, rec);
  return renderer;
}

/** Mark an owner's renderer as recently used. @param {GlOwner} owner */
export function touch(owner) {
  const rec = live.get(owner);
  if (rec) rec.lastUsed = performance.now();
}

/** Is this owner's context lost? @param {GlOwner} owner */
export function isLost(owner) {
  return !!live.get(owner)?.lost;
}

/**
 * Release an owner's renderer and its WebGL context.
 * @param {GlOwner} owner
 */
export function release(owner) {
  const rec = live.get(owner);
  if (!rec) return;
  live.delete(owner);
  try {
    rec.renderer.dispose();
    rec.renderer.forceContextLoss();
  } catch { /* already gone */ }
  // an OffscreenCanvas (software-GL presentation) has no remove()
  rec.renderer.domElement?.remove?.();
}
