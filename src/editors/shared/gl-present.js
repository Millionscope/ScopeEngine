/**
 * WebGL presentation without synchronous read-backs on software GL.
 *
 * On a software rasterizer (SwiftShader, llvmpipe: headless CI, VMs, remote desktops) the
 * browser composites in software and copies every presented WebGL frame back to the CPU with a
 * synchronous glReadPixels, which stalls and logs "GPU stall due to ReadPixels" on the console
 * (a bare canvas that only calls gl.clear() does it too). There, the renderer draws into an
 * OffscreenCanvas that is never presented, and finished frames reach a visible 2D canvas
 * through an asynchronous pixel-buffer read-back: a fresh PIXEL_PACK_BUFFER per frame, a fence,
 * and a read once the fence has signaled (a later frame). On hardware GPUs the renderer's own
 * canvas is used unchanged.
 * Shared by every WebGL editor (3D Scope Space, Simulation agent field) through the GL pool's users.
 * @module editors/shared/gl-present
 */

/** @type {boolean|null} */
let software = null;

/** Is WebGL 2 running on a software rasterizer (and can we present through a 2D canvas)? */
export function isSoftwareGl() {
  if (software !== null) return software;
  software = false;
  try {
    if (typeof OffscreenCanvas === 'undefined') return software;
    const c = document.createElement('canvas');
    const gl = /** @type {WebGL2RenderingContext|null} */ (c.getContext('webgl2'));
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      software = /swiftshader|llvmpipe|softpipe|software rasterizer|basic render driver/i.test(name);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    software = false;
  }
  return software;
}

/**
 * Renderer options for the GL pool: an OffscreenCanvas on software GL, nothing otherwise.
 * (The pool removes `renderer.domElement` on release; an OffscreenCanvas has no remove(), so a
 * no-op is provided.)
 * @returns {Record<string, any>}
 */
export function surfaceOptions() {
  if (!isSoftwareGl()) return {};
  const canvas = /** @type {any} */ (new OffscreenCanvas(1, 1));
  canvas.remove = () => {};
  return { canvas };
}

/** Copies finished frames of an offscreen WebGL 2 renderer to a visible 2D canvas. */
export class ReadbackPresenter {
  /** @param {any} renderer THREE.WebGLRenderer drawing into an OffscreenCanvas */
  constructor(renderer) {
    /** @type {WebGL2RenderingContext} */
    this.gl = renderer.getContext();
    this.canvas = document.createElement('canvas');
    this.ctx2d = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d', { alpha: false }));
    /** @type {Array<{buf: WebGLBuffer, sync: WebGLSync, w: number, h: number}>} */
    this.queue = [];
    /** @type {Uint8Array|null} */
    this.px = null;
    /** @type {ImageData|null} */
    this.img = null;
  }

  /** Queue an asynchronous copy of the frame just rendered. */
  capture() {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = /** @type {WebGLBuffer} */ (gl.createBuffer());
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = /** @type {WebGLSync} */ (gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
    gl.flush();
    this.queue.push({ buf, sync, w, h });
    while (this.queue.length > 3) this.drop(/** @type {any} */ (this.queue.shift()));
  }

  /** Show the newest finished frame. @returns {boolean} true when nothing is pending any more */
  poll() {
    const gl = this.gl;
    if (gl.isContextLost()) {
      this.queue = [];
      return true;
    }
    let ready = -1;
    for (let k = this.queue.length - 1; k >= 0; k--) {
      if (gl.clientWaitSync(this.queue[k].sync, 0, 0) !== gl.TIMEOUT_EXPIRED) { ready = k; break; }
    }
    if (ready < 0) return this.queue.length === 0;
    for (let k = 0; k < ready; k++) this.drop(this.queue[k]);
    const f = this.queue[ready];
    this.queue = this.queue.slice(ready + 1);
    const { w, h } = f;
    if (!this.px || this.px.length !== w * h * 4) {
      this.px = new Uint8Array(w * h * 4);
      this.img = new ImageData(w, h);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, f.buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.px);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.drop(f);
    // GL rows run bottom-up
    const row = w * 4;
    const dst = /** @type {ImageData} */ (this.img).data;
    for (let y = 0; y < h; y++) dst.set(this.px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx2d.putImageData(/** @type {ImageData} */ (this.img), 0, 0);
    return this.queue.length === 0;
  }

  /** @param {{buf: WebGLBuffer, sync: WebGLSync}} f */
  drop(f) {
    try {
      this.gl.deleteSync(f.sync);
      this.gl.deleteBuffer(f.buf);
    } catch { /* context gone */ }
  }

  dispose() {
    for (const f of this.queue) this.drop(f);
    this.queue = [];
    this.canvas.remove();
    this.px = null;
    this.img = null;
  }
}
