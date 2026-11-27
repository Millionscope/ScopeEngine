/**
 * Audio director: one soundtrack for the whole workbench, and only ever one track audible.
 *  - TRACKS are the files in public/audio (see CREDITS.txt); a long track is split into <4 MB chunks
 *    that play in order and loop. SCOPES maps every immersive editor to a track; scopes without their
 *    own download reuse the closest one, so two scopes can share a track (it just keeps playing).
 *  - INTRO (welcome music and welcome speech together, from public/speech) plays once, only when the
 *    page loads on the Home tab; it ends with its longest layer, and leaving Home cuts it short for good.
 *    Then HOME follows.
 *  - HOME (Science and Technology) plays on first load and on the Home tab (whose left area cycles
 *    scopes on its own). Once the user changes tab or scope, the active area's scope picks the track,
 *    else the current one keeps playing while its scope is visible, else the first visible scope,
 *    else HOME. Switching fades the old track out completely before the next one fades in.
 *  - the Game scope has its own audio: no music while it is visible. A missing file falls back to HOME.
 *  - browsers block autoplay until a gesture, so the first pointerdown / keydown unlocks the
 *    AudioContext and starts the pending track.
 *  - interaction SFX (click, hover tick, selection sweep, workspace whoosh) play
 *    public/audio/sfx/<name>.mp3 when present, else a synthesized hologram chirp.
 *  - an AnalyserNode drives the hologram: --ms-audio (level) and --ms-a0..4 (bands) are written each
 *    frame on the playing area and the status bar only (not :root, so the whole tree does not restyle).
 * Mute persists as ui.audioMuted; the current title is status.audio.
 * @module services/audio
 */

/** track -> { title, files, vols?, once?, layers? }: files play in order, then loop (once: stop after the
 *  last); with layers they all play together and the track ends when the longest one does.
 *  vols: per-file gain x MUSIC_VOL, from measured loudness: songs -17.6 LUFS play at about -24.5; the welcome
 *  speech (-19.2) sits ~3 dB above them with the welcome music (-25.5) ~10 dB under the voice. */
export const TRACKS = {
  intro: { title: 'Welcome to MillionScope', files: ['/speech/welcome-millionscope-music.mp3', '/speech/welcome-millionscope-speech.mp3'], vols: [1.2, 1.8], once: true, layers: true },
  science: { title: 'Science and Technology', files: ['science'] },
  ionosphere: { title: 'Ionosphere · Karl Casey', files: ['ionosphere'] },
  aetheris: { title: 'Aetheris · Deep Cosmic Ambient', files: ['aetheris'] },
  earth: { title: 'Epic Drone Music', files: ['earth-drone'] },
  mirrors: { title: 'Dream of Mirrors · Karl Casey', files: ['dream-of-mirrors'] },
  distance: { title: 'Distance · Karl Casey', files: ['distance'] },
  apex: { title: 'Apex', files: ['apex'] },
  bladerunner: { title: 'This is Blade Runner City', files: ['blade-runner-city-1', 'blade-runner-city-2', 'blade-runner-city-3'] },
};
const HOME = 'science';
const INTRO = 'intro';
/** @param {string} f */
const url = (f) => (f.startsWith('/') ? f : `/audio/${f}.mp3`);
const HOME_WORKSPACE = 'home';

/** editorId -> track. Panels (outliner, sheet, inspector) and game have none on purpose. */
export const SCOPES = {
  scope: 'science',
  solar: 'aetheris',
  space3d: 'aetheris',
  globe: 'earth',
  terrain: 'ionosphere',
  graph: 'ionosphere',
  city: 'bladerunner',
  protein: 'mirrors',
  atom: 'mirrors',
  building: 'apex',
  sp500: 'apex',
  choropleth: 'distance',
  candlestick: 'distance',
};

const MUSIC_VOL = 0.45;
const FADE_IN_S = 1.2;
const FADE_OUT_S = 0.8;
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
    /** @type {{key: string, els: HTMLAudioElement[], gain: GainNode}|null} */
    this.cur = null;
    /** track that is playing or about to (after the previous one has faded out) */
    this.curKey = /** @type {string|null} */ (null);
    /** track the layout asks for (before mute / missing files) */
    this.want = /** @type {string|null} */ (null);
    /** editor whose scope chose `want` (keeps it while that scope stays visible) */
    this.wantScope = /** @type {string|null} */ (null);
    /** false until the user changes tab or scope: HOME plays on first load */
    this.follow = false;
    /** the welcome plays only on a first load that lands on Home */
    this.introDone = ws.activeId !== HOME_WORKSPACE;
    this.missing = new Set();
    this._token = 0;
    this._quietAt = 0; // performance.now() when the last fade-out ends
    /** @type {Record<string, AudioBuffer|null>} */
    this.sfxBuf = {};
    /** @type {HTMLElement|null} */
    this.areaEl = null;
    this.sbEl = document.getElementById('statusbar');
    this._hoverAt = 0;
    this._hoverEl = null;
    this._raf = 0;

    const pick = () => setTimeout(() => this.pick()); // after the workspace settles visibility
    const userPick = () => { this.follow = true; pick(); };
    events.on('workspace:changed', userPick);
    events.on('area:typeChanged', userPick);
    events.on('area:focused', pick);
    events.on('layout:changed', pick);
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

  /** Choose the track the layout asks for, and the area that glows with it. */
  pick() {
    const areas = (this.ws.activeAreas?.() || []).filter((a) => a.isVisible());
    const types = areas.map((a) => a.leaf.editorType);
    const active = this.ws.activeArea();
    const at = active?.isVisible() ? active.leaf.editorType : null;
    let scope = null;
    let want = HOME;
    if (types.includes('game')) want = null;
    else if (!this.introDone && this.ws.activeId === HOME_WORKSPACE) want = INTRO;
    else if (this.follow && this.ws.activeId !== HOME_WORKSPACE) {
      if (at && SCOPES[at]) scope = at;
      else if (this.wantScope && types.includes(this.wantScope)) scope = this.wantScope;
      else scope = types.find((t) => SCOPES[t]) || null;
      if (scope) want = SCOPES[scope];
    }
    this.want = want;
    this.wantScope = scope;
    const owner = scope
      ? (at === scope ? active : areas.find((a) => a.leaf.editorType === scope))
      : (areas.find((a) => SCOPES[a.leaf.editorType] === want) || active);
    const el = want ? owner?.el || null : null;
    if (el !== this.areaEl) {
      this.areaEl?.classList.remove('is-audio');
      this.areaEl = el;
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

  /** Bring the playing track in line with want + mute: fade the old one out, then start the new one. */
  sync() {
    let key = this.muted ? null : this.want;
    if (key && this.missing.has(key)) key = this.missing.has(HOME) ? null : HOME;
    this.store.set('status.audio', key ? TRACKS[key].title : null);
    this.areaEl?.classList.toggle('is-audio', !!key);
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.curKey === key) return;
    this.curKey = key;
    const token = ++this._token;
    if (this.cur) {
      if (this.cur.key === INTRO) this.introDone = true; // cut short: never comes back
      this._fadeOut(this.cur);
      this.cur = null;
      this._quietAt = performance.now() + FADE_OUT_S * 1000;
    }
    if (!key) return;
    // start only once every earlier track has gone quiet: one track audible at a time
    setTimeout(() => { if (token === this._token) this._start(key); }, Math.max(0, this._quietAt - performance.now()));
  }

  /** @param {string} key */
  _start(key) {
    const ctx = /** @type {AudioContext} */ (this.ctx);
    const track = TRACKS[key];
    const files = track.files;
    const gain = ctx.createGain(); // track fader: fade in / out
    gain.gain.value = 0;
    gain.connect(/** @type {GainNode} */ (this.master));
    /** one element per layer, or one element that walks through the chunks */
    const els = (track.layers ? files : [files[0]]).map((f, k) => {
      const el = new Audio(url(f));
      const g = ctx.createGain(); // per-file level
      g.gain.value = track.vols?.[k] ?? 1;
      ctx.createMediaElementSource(el).connect(g).connect(gain);
      return { el, g };
    });
    const cur = { key, els: els.map((e) => e.el), gain };
    this.cur = cur;
    const finish = () => {
      if (key === INTRO) this.introDone = true;
      if (this.cur === cur) { this.cur = null; this.curKey = null; gain.disconnect(); }
      this.pick();
    };
    if (track.layers) {
      let left = els.length;
      for (const { el } of els) el.addEventListener('ended', () => { if (--left === 0) finish(); });
    } else {
      const { el, g } = els[0];
      el.loop = files.length === 1 && !track.once;
      let i = 0;
      // chunked track: next chunk on end, back to the first after the last (a `once` track ends instead)
      el.addEventListener('ended', () => {
        if (track.once && i === files.length - 1) return finish();
        i = (i + 1) % files.length;
        el.src = url(files[i]);
        g.gain.value = track.vols?.[i] ?? 1;
        el.play().catch(() => {});
      });
    }
    for (const { el } of els) {
      el.addEventListener('error', () => {
        this.missing.add(key);
        if (key === INTRO) this.introDone = true;
        if (this.cur !== cur) return;
        this._fadeOut(cur);
        this.cur = null;
        this.curKey = null;
        this.sync();
      }, { once: true });
    }
    Promise.all(els.map(({ el }) => el.play())).then(() => {
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(MUSIC_VOL, t + (track.once ? 0.3 : FADE_IN_S));
    }).catch(() => {});
  }

  /** @param {{els: HTMLAudioElement[], gain: GainNode}} c */
  _fadeOut(c) {
    const t = /** @type {AudioContext} */ (this.ctx).currentTime;
    c.gain.gain.cancelScheduledValues(t);
    c.gain.gain.setValueAtTime(c.gain.gain.value, t);
    c.gain.gain.linearRampToValueAtTime(0, t + FADE_OUT_S);
    setTimeout(() => {
      for (const el of c.els) { el.pause(); el.removeAttribute('src'); }
      c.gain.disconnect();
    }, FADE_OUT_S * 1000);
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
