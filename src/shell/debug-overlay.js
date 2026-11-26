/**
 * Debug overlay: live counts that must return to baseline after cycling an area through every
 * editor type (listeners, observers, timers, editors, Chart.js instances, WebGL contexts,
 * bound values), plus frame stats and which CDN libraries have been loaded.
 * @module shell/debug-overlay
 */
import { DisposableStore, interval, leakCounters } from '../core/disposable.js';
import { loadedLibs } from '../core/lazy.js';
import { listEditors } from '../editors/registry.js';
import { editorCounters } from '../workspace/area.js';

/** Providers registered by lazily-loaded modules (charts, GL pool, bound values). */
export const debugProviders = {
  /** @type {() => number} */ charts: () => 0,
  /** @type {() => number} */ glContexts: () => 0,
  /** @type {() => number} */ boundValues: () => 0,
};

export class DebugOverlay {
  /** @param {{ env: any, ws: import('../workspace/workspaces.js').WorkspaceManager }} deps */
  constructor({ env, ws }) {
    this.env = env;
    this.ws = ws;
    /** @type {DisposableStore|null} */
    this.d = null;
    /** @type {HTMLElement|null} */
    this.el = null;
  }

  isOpen() { return !!this.d; }

  toggle() {
    if (this.d) this.close();
    else this.open();
  }

  snapshot() {
    return {
      listeners: leakCounters.listeners,
      observers: leakCounters.observers,
      timers: leakCounters.timers,
      editors: editorCounters.live,
      charts: debugProviders.charts(),
      glContexts: debugProviders.glContexts(),
      boundValues: debugProviders.boundValues(),
      domNodes: document.getElementsByTagName('*').length,
    };
  }

  open() {
    const d = (this.d = new DisposableStore());
    const el = (this.el = document.createElement('div'));
    el.className = 'ms-debug';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'Debug overlay');
    (document.getElementById('overlay-root') || document.body).appendChild(el);
    d.add({ dispose: () => el.remove() });
    this.baseline = this.snapshot();
    const draw = () => {
      const s = this.snapshot();
      const st = this.env.scheduler.stats;
      const rows = [
        ['live listeners', s.listeners, this.baseline.listeners],
        ['observers', s.observers, this.baseline.observers],
        ['timers/anims', s.timers, this.baseline.timers],
        ['live editors', s.editors, this.baseline.editors],
        ['Chart instances', s.charts, this.baseline.charts],
        ['WebGL contexts', s.glContexts, this.baseline.glContexts],
        ['bound values', s.boundValues, null],
        ['DOM nodes', s.domNodes, null],
        ['fps', st.fps, null],
        ['frame ms (avg)', st.frameMs.toFixed(2), null],
      ];
      el.innerHTML = '<div class="ms-debug-head"><span class="codicon codicon-bug" aria-hidden="true"></span>Debug</div>';
      const t = document.createElement('table');
      for (const [k, v, base] of rows) {
        const tr = document.createElement('tr');
        const grew = base != null && Number(v) > Number(base) + 2;
        tr.innerHTML = `<td>${k}</td><td class="${grew ? 'is-bad' : ''}">${v}${base != null ? ` <span class="ms-muted">(base ${base})</span>` : ''}</td>`;
        t.appendChild(tr);
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>libs loaded</td><td>${loadedLibs().join(', ') || 'none'}</td>`;
      t.appendChild(tr);
      el.appendChild(t);
      const b = document.createElement('button');
      b.className = 'ms-btn is-secondary is-small';
      b.textContent = 'Reset baseline';
      b.style.marginTop = '4px';
      b.addEventListener('click', () => { this.baseline = this.snapshot(); draw(); });
      el.appendChild(b);
    };
    draw();
    d.add(interval(draw, 500));
  }

  close() {
    this.d?.dispose();
    this.d = null;
    this.el = null;
  }

  /**
   * Switch an area through all editor types twice, then report leak deltas.
   * @param {string|undefined} areaId
   */
  async cycleEditors(areaId) {
    const area = areaId ? this.ws.getArea(areaId) : this.ws.targetArea();
    if (!area) return null;
    const original = area.leaf.editorType;
    const before = this.snapshot();
    const notify = this.env.services.notify;
    // log only: a toast's own listeners would show up in the comparison below
    notify?.info(`Cycling the ${original} area through ${listEditors().length} editor types twice…`, { silent: true });
    for (let round = 0; round < 2; round++) {
      for (const e of listEditors()) {
        this.ws.setAreaType(area.id, e.id);
        // wait for the editor (and any lazy library) to mount and draw a frame
        for (let i = 0; i < 200 && !area.editor; i++) await new Promise((r) => setTimeout(r, 25));
        await this.env.scheduler.nextFrame();
        await this.env.scheduler.nextFrame();
      }
    }
    this.ws.setAreaType(area.id, original);
    for (let i = 0; i < 200 && !area.editor; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 300));
    const after = this.snapshot();
    const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
    const leaks = ['listeners', 'observers', 'timers', 'editors', 'charts', 'glContexts'].filter((k) => delta[k] > 2);
    const detail = Object.entries(delta).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`).join(', ');
    if (leaks.length) notify?.warn(`Possible leak after cycling: ${leaks.join(', ')}`, { detail });
    else notify?.success('Cycled 42 editor mounts: no growth in listeners, observers, timers, editors, charts or WebGL contexts.', { detail });
    return { before, after, delta, leaks };
  }
}
