/**
 * Audio director: one soundtrack for the whole workbench.
 *  - every immersive scope has a looping track at public/audio/<editorId>.mp3 (see CREDITS.txt there);
 *    the active area's scope wins, else the current track keeps playing while its scope is still
 *    visible, else the first visible scope; tracks crossfade. A missing file just stays silent.
 *  - the Game scope has its own audio: no music while it is visible.
 *  - browsers block autoplay until a gesture, so the first pointerdown / keydown unlocks the
 *    AudioContext and starts the pending track.
 *  - interaction SFX (click, hover tick, selection sweep, workspace whoosh) play
 *    public/audio/sfx/<name>.mp3 when present, else a synthesized hologram chirp.
 *  - an AnalyserNode drives the hologram: --ms-audio (level) and --ms-a0..4 (bands) are written each
 *    frame on the playing area and the status bar only (not :root, so the whole tree does not restyle).
 * Mute persists as ui.audioMuted; the current title is status.audio.
 * @module services/audio
 */

/** editorId -> title. Panels (outliner, sheet, inspector) and game have none on purpose. */
export const TRACKS = {
  graph: 'Archetype · Karl Casey',
  space3d: 'Space Ambience · Alexander Nakarada',
  scope: 'Science and Technology',
  solar: 'Aetheris · Deep Cosmic Ambient',
  globe: 'Epic Drone Music',
  terrain: 'Ionosphere · Karl Casey',
  city: 'This is Blade Runner City',
  protein: 'Dream of Mirrors · Karl Casey',
  building: 'Apex',
  atom: 'SINGULARIS',
  choropleth: 'Distance · Karl Casey',
  candlestick: 'Trading Synthwave',
  sp500: 'Wall Street Synthwave',
};

const MUSIC_VOL = 0.45;
const FADE_S = 1.5;
/** synth fallback: [f0, f1, seconds, gain, wave] */
const SYNTH = {
  click: [1900, 700, 0.07, 0.06, 'triangle'],
  hover: [3200, 2900, 0.03, 0.012, 'sine'],
  select: [420, 1700, 0.22, 0.035, 'sine'],
  whoosh: [90, 1100, 0.45, 0.05, 'sine'],
};
const HOVERABLE = 'button, [role="menuitem"], [role="tab"], .ms-sb-item, a[href]';

export class AudioDirector {
  /** @param {{ events: any, store: any, ws: any }} deps */
  constructor({ events, store, ws }) {
    this.events = events;
    this.store = store;
    this.ws = ws;
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {{id: string, el: HTMLAudioElement, gain: GainNode, src: MediaElementAudioSourceNode}|null} */
    this.cur = null;
    this.want = /** @type {string|null} */ (null);
    this.missing = new Set();
    /** @type {Record<string, AudioBuffer|null>} */
    this.sfxBuf = {};
    /** @type {HTMLElement|null} */
    this.areaEl = null;
    this.sbEl = document.getElementById('statusbar');
    this._hoverAt = 0;
    this._hoverEl = null;
    this._raf = 0;

    const pick = () => setTimeout(() => this.pick()); // after the workspace settles visibility
    for (const t of ['area:focused', 'area:typeChanged', 'workspace:changed', 'layout:changed']) events.on(t, pick);
    events.on('workspace:changed', () => this.sfx('whoosh'));
    events.on('selection:changed', (s) => { if (s?.source !== 'reload') this.sfx('select'); });
    store.select('ui', () => this.sync());

    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', (e) => {
      unlock();
      if (/** @type {Element} */ (e.target).closest?.(HOVERABLE)) this.sfx('click');
    }, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('pointerover', (e) => {
      const el = /** @type {Element} */ (e.target).closest?.(HOVERABLE);
      const now = performance.now();
      if (!el || el === this._hoverEl || now - this._hoverAt < 80) return;
      this._hoverEl = el;
      this._hoverAt = now;
      this.sfx('hover');
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume().then(() => this._loop());
    });
    this.pick();
  }

  get muted() { return !!this.store.get('ui.audioMuted'); }

  /** Choose the scope whose track should play. */
  pick() {
    const areas = (this.ws.activeAreas?.() || []).filter((a) => a.isVisible());
    const types = areas.map((a) => a.leaf.editorType);
    const active = this.ws.activeArea();
    const at = active?.isVisible() ? active.leaf.editorType : null;
    let id = null;
    if (types.includes('game')) id = null;
    else if (at && TRACKS[at]) id = at;
    else if (this.want && types.includes(this.want)) id = this.want;
    else id = types.find((t) => TRACKS[t]) || null;
    this.want = id;
    const owner = (at === id ? active : areas.find((a) => a.leaf.editorType === id))?.el || null;
    if (owner !== this.areaEl) {
      this.areaEl?.classList.remove('is-audio');
      this.areaEl = owner;
    }
    this.sync();
  }

  /** First gesture: create / resume the context, then start whatever is pending. */
  unlock() {
    if (this.ctx?.state === 'running') return;
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.8;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      this.master.connect(this.analyser).connect(ctx.destination);
      for (const name of Object.keys(SYNTH)) this._loadSfx(name);
    }
    this.ctx.resume().then(() => { this.sync(); this._loop(); }).catch(() => {});
  }

  /** @param {string} name */
  _loadSfx(name) {
    fetch(`/audio/sfx/${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((b) => /** @type {AudioContext} */ (this.ctx).decodeAudioData(b))
      .then((buf) => { this.sfxBuf[name] = buf; })
      .catch(() => { this.sfxBuf[name] = null; });
  }

  /** Bring the playing track in line with want + mute (crossfade). */
  sync() {
    const id = this.muted || this.missing.has(/** @type {string} */ (this.want)) ? null : this.want;
    this.store.set('status.audio', id ? TRACKS[id] : null);
    this.areaEl?.classList.toggle('is-audio', !!id);
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.cur?.id === id) return;
    if (this.cur) this._fadeOut(this.cur);
    this.cur = null;
    if (!id) return;
    const el = new Audio(`/audio/${id}.mp3`);
    el.loop = true;
    const src = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(/** @type {GainNode} */ (this.master));
    const cur = { id, el, gain, src };
    this.cur = cur;
    el.addEventListener('error', () => {
      this.missing.add(id);
      if (this.cur === cur) { this.cur = null; this.sync(); }
    }, { once: true });
    el.play().then(() => {
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(MUSIC_VOL, t + FADE_S);
    }).catch(() => {});
  }

  /** @param {{el: HTMLAudioElement, gain: GainNode, src: MediaElementAudioSourceNode}} c */
  _fadeOut(c) {
    const t = /** @type {AudioContext} */ (this.ctx).currentTime;
    c.gain.gain.cancelScheduledValues(t);
    c.gain.gain.setValueAtTime(c.gain.gain.value, t);
    c.gain.gain.linearRampToValueAtTime(0, t + FADE_S);
    setTimeout(() => { c.el.pause(); c.el.removeAttribute('src'); c.src.disconnect(); }, FADE_S * 1000 + 100);
  }

  /** @param {keyof typeof SYNTH} name */
  sfx(name) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.muted) return;
    const t = ctx.currentTime;
    const buf = this.sfxBuf[name];
    if (buf) {
      const s = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = name === 'hover' ? 0.25 : 0.6;
      s.buffer = buf;
      s.connect(g).connect(/** @type {GainNode} */ (this.master));
      s.start(t);
      return;
    }
    const [f0, f1, d, v, wave] = SYNTH[name];
    // two detuned voices read as a shimmering hologram chirp rather than a plain beep
    for (const detune of [0, 7]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = /** @type {OscillatorType} */ (wave);
      o.detune.value = detune * 100;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + d);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(/** @type {GainNode} */ (this.master));
      o.start(t);
      o.stop(t + d + 0.02);
    }
  }

  /** Analyser -> CSS vars on the playing area and the status bar. */
  _loop() {
    if (this._raf) return;
    const targets = () => [this.areaEl, this.sbEl].filter(Boolean);
    const tick = () => {
      this._raf = 0;
      const still = document.documentElement.classList.contains('ms-reduced-motion');
      if (!this.ctx || this.ctx.state !== 'running' || this.muted || still) {
        for (const el of targets()) el.style.setProperty('--ms-audio', '0');
        if (this.ctx?.state === 'running') this._raf = requestAnimationFrame(tick); // resume after unmute
        return;
      }
      const b = /** @type {Uint8Array} */ (this.bins);
      /** @type {AnalyserNode} */ (this.analyser).getByteFrequencyData(b);
      const n = b.length;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += b[i];
      const bands = [0, 1, 2, 3, 4].map((k) => {
        let s = 0;
        const lo = Math.floor((k / 5) ** 2 * n), hi = Math.max(lo + 1, Math.floor(((k + 1) / 5) ** 2 * n));
        for (let i = lo; i < hi; i++) s += b[i];
        return (s / (hi - lo) / 255).toFixed(3);
      });
      const level = (sum / n / 255).toFixed(3);
      for (const el of targets()) {
        el.style.setProperty('--ms-audio', level);
        bands.forEach((v, k) => el.style.setProperty(`--ms-a${k}`, v));
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
}
