#!/usr/bin/env node
/**
 * MillionScope intro video: records every scope (except Game) from a fresh production build in
 * system Chrome via a CDP screencast, then cuts it with ffmpeg to the welcome voice-over
 * (public/audio/raw/welcome-millionscope-speech.wav) over the welcome music handing off to the
 * Home soundtrack, as the in-app audio director does.
 *
 *   node scripts/make-intro.mjs            build, record, compose -> video/millionscope-intro.mp4
 *   node scripts/make-intro.mjs --shots    dry run: one screenshot per scope after it settles
 *   node scripts/make-intro.mjs --compose  re-cut from the clips already recorded
 */
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'video');
const CLIPS = join(OUT, 'clips');
const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;
const W = 1920, H = 1080, FPS = 30, XF = 0.5; // xfade length (s)
const SPEECH = join(ROOT, 'public/audio/raw/welcome-millionscope-speech.wav');
const MUSIC = join(ROOT, 'public/audio/raw/welcome-millionscope-music.wav');
const BED = join(ROOT, 'public/audio/science.mp3'); // Home track, follows the intro in the app

/** Voice clauses [start, end] in the speech WAV, cut at the middle of each pause (silencedetect + RMS dips). */
const C = {
  welcome: [0, 2.0], ask: [2.0, 6.27], language: [6.27, 8.55], math: [8.55, 10.88], holo: [10.88, 13.38],
  body: [13.38, 14.78], solar: [14.78, 16.17], city: [16.17, 17.45], molecules: [17.45, 19.14],
  explore: [19.14, 22.43], outro: [22.43, 26.0],
};

/** Shot list. editor: null = default layout (Home tab); settle = ms to wait after load before recording. */
const SHOTS = [
  { id: 'home', editor: null, dur: 7.5, settle: 9000, voice: ['welcome', 'ask'], lead: 0.6 },
  { id: 'graph', editor: 'graph', dur: 5.0, settle: 4000, voice: ['language', 'math'] },
  { id: 'space3d', editor: 'space3d', dur: 3.6, settle: 4000, voice: ['holo'] },
  { id: 'scope', editor: 'scope', dur: 2.5, settle: 14000, voice: ['body'] },
  { id: 'solar', editor: 'solar', dur: 2.5, settle: 6000, voice: ['solar'] },
  { id: 'city', editor: 'city', dur: 2.5, settle: 8000, voice: ['city'] },
  { id: 'protein', editor: 'protein', dur: 2.5, settle: 9000, voice: ['molecules'] },
  { id: 'atom', editor: 'atom', dur: 4.6, settle: 5000, voice: ['explore'] },
  { id: 'globe', editor: 'globe', dur: 4.0, settle: 7000 },
  { id: 'terrain', editor: 'terrain', dur: 4.0, settle: 8000 },
  { id: 'building', editor: 'building', dur: 4.0, settle: 7000 },
  { id: 'choropleth', editor: 'choropleth', dur: 4.0, settle: 6000 },
  { id: 'sp500', editor: 'sp500', dur: 4.0, settle: 5000 },
  { id: 'candlestick', editor: 'candlestick', dur: 4.0, settle: 5000 },
  { id: 'outro', card: true, dur: 6.0, settle: 300, voice: ['outro'], lead: 0.9 },
];
const SKIP = 0.4; // seconds dropped from the head of every clip (screencast warm-up)

const args = new Set(process.argv.slice(2));
const sh = (cmd, a) => execFileSync(cmd, a, { stdio: 'inherit', cwd: ROOT });

/** One workspace holding one full-size area of the given editor (shape per workspace/area-tree.js makeArea). */
const layoutFor = (editor) => JSON.stringify({
  schema: 2, activeId: 'rec', presets: ['home', 'model', 'scenarios', 'minds', 'verify', 'space', 'scope', 'solar'],
  workspaces: [{ id: 'rec', name: editor, icon: 'globe', preset: 'home', activeAreaId: 'ar_rec', tree: {
    schema: 1, maximizedId: 'ar_rec', fullscreen: true, // app's Fullscreen Area: no top bar or status bar
    root: { kind: 'area', id: 'ar_rec', editorType: editor, editorState: {}, regions: { tools: false, sidebar: false },
      pinnedScopeId: null, syncSelection: true, scenarioId: null, headerPos: 'top', headerCollapsed: true },
  } }],
});

const CARD = `<!doctype html><html><head><base href="${BASE}"><style>
@font-face{font-family:TTT;src:url(fonts/TTT_Bold.woff2) format('woff2')}
@font-face{font-family:TTTr;src:url(fonts/TTT.woff2) format('woff2')}
html,body{margin:0;height:100%;background:radial-gradient(ellipse at 50% 45%,#0b2a44 0%,#06111c 45%,#020407 100%);overflow:hidden}
.c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px}
img{width:220px;height:220px;filter:drop-shadow(0 0 40px #2aa7ff88);animation:in 1.4s ease-out both}
h1{margin:0;font:96px TTT,system-ui;color:#eaf6ff;letter-spacing:2px;text-shadow:0 0 30px #2aa7ff66;animation:in 1.4s .5s ease-out both}
p{margin:0;font:40px TTTr,system-ui;color:#8fc8ee;letter-spacing:1px;animation:in 1.4s 1.6s ease-out both}
@keyframes in{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:none}}
</style></head><body><div class="c"><img src="logo.svg"><h1>MillionScope</h1><p>See every possibility. Decide with confidence.</p></div></body></html>`;

async function record() {
  sh('npm', ['run', 'build']);
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const browser = await chromium.launch({
      channel: 'chrome', headless: false,
      args: ['--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'],
    });
    mkdirSync(CLIPS, { recursive: true });
    for (const s of SHOTS) {
      // fresh context per shot: clean storage, and no pile-up of WebGL contexts across 14 scenes
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'dark' });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.warn(`[${s.id}] pageerror: ${e.message}`));
      // Home keeps its 4-area layout; drop the shell chrome so it is full screen like the scopes
      if (!s.editor && !s.card) await page.addInitScript(() => addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: '.ms-topbar,.ms-statusbar{display:none!important}' }))));
      if (s.editor) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['millionscope.layout', layoutFor(s.editor)]);
      if (s.card) { await page.goto(BASE + 'robots.txt'); await page.setContent(CARD, { waitUntil: 'load' }); } // same origin, so the TTT fonts load
      else {
        await page.goto(BASE, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.mouse.move(W - 4, H / 2); // park the pointer off the scene
      }
      await page.waitForTimeout(s.settle);
      if (args.has('--shots')) {
        await page.screenshot({ path: join(OUT, `shot-${s.id}.png`) });
        console.log(`shot ${s.id}`);
      } else {
        if (s.card) { await page.goto(BASE + 'robots.txt'); await page.setContent(CARD, { waitUntil: 'load' }); } // restart the fade-in on camera
        await screencast(page, s.id, (s.dur + SKIP + 1.0) * 1000);
      }
      await ctx.close();
    }
    await browser.close();
  } finally { server.kill(); }
}

/** CDP screencast -> JPEG frames + ffconcat with real per-frame durations -> constant-30fps clip. */
async function screencast(page, id, ms) {
  const dir = join(CLIPS, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await page.waitForTimeout(ms);
  await cdp.send('Page.stopScreencast');
  if (!frames.length) throw new Error(`${id}: no frames captured`);
  const end = frames[0].t + ms / 1000;
  let list = 'ffconcat version 1.0\n';
  frames.forEach((f, i) => {
    const name = `${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(f.data, 'base64'));
    list += `file ${name}\nduration ${((frames[i + 1]?.t ?? end) - f.t).toFixed(4)}\n`;
  });
  list += `file ${String(frames.length - 1).padStart(5, '0')}.jpg\n`; // concat demuxer drops the last duration otherwise
  writeFileSync(join(dir, 'list.txt'), list);
  sh('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-vf', `scale=${W}:${H}:flags=lanczos,fps=${FPS},format=yuv420p`, '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', join(CLIPS, `${id}.mp4`)]);
  rmSync(dir, { recursive: true, force: true }); // drop the JPEGs: Spotlight indexing thousands of frames slows ffmpeg to a crawl
  console.log(`clip ${id}: ${frames.length} frames over ${(ms / 1000).toFixed(1)}s (${(frames.length / (ms / 1000)).toFixed(1)} fps captured)`);
}

function compose() {
  const inputs = [], vf = [], af = [];
  SHOTS.forEach((s, i) => {
    inputs.push('-i', join(CLIPS, `${s.id}.mp4`));
    vf.push(`[${i}:v]trim=start=${SKIP}:duration=${s.dur},setpts=PTS-STARTPTS,fps=${FPS},scale=${W}:${H},format=yuv420p,settb=AVTB[v${i}]`);
  });
  // xfade chain: shot i becomes visible at offset_i = sum(dur_<i) - i*XF
  const offsets = [];
  let acc = 0, last = 'v0';
  SHOTS.forEach((s, i) => {
    offsets.push(acc - i * XF);
    if (i > 0) {
      const out = i === SHOTS.length - 1 ? 'vx' : `x${i}`;
      vf.push(`[${last}][v${i}]xfade=transition=fade:duration=${XF}:offset=${(acc - i * XF).toFixed(3)}[${out}]`);
      last = out;
    }
    acc += s.dur;
  });
  const total = acc - (SHOTS.length - 1) * XF;
  vf.push(`[vx]fade=t=in:st=0:d=0.6,fade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[vout]`);

  // voice: clauses placed back-to-back from each shot's offset (+lead), so every line lands on its scene
  const sp = SHOTS.length, mu = sp + 1, bed = sp + 2;
  inputs.push('-i', SPEECH, '-i', MUSIC, '-i', BED);
  const clauses = [];
  SHOTS.forEach((s, i) => {
    let t = offsets[i] + (s.lead ?? 0.15);
    for (const k of s.voice || []) { clauses.push({ k, t }); t += C[k][1] - C[k][0]; }
  });
  af.push(`[${sp}:a]asplit=${clauses.length}${clauses.map((_, j) => `[s${j}]`).join('')}`);
  clauses.forEach(({ k, t }, j) => {
    const ms = Math.round(t * 1000);
    af.push(`[s${j}]atrim=${C[k][0]}:${C[k][1]},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${(C[k][1] - C[k][0] - 0.05).toFixed(3)}:d=0.05,adelay=${ms}|${ms}[c${j}]`);
  });
  af.push(`${clauses.map((_, j) => `[c${j}]`).join('')}amix=inputs=${clauses.length}:normalize=0,apad,atrim=0:${total.toFixed(3)},asplit=2[voice][sc]`);
  // music: welcome music hands off to the Home track, ducked under the voice, out with the picture
  af.push(`[${mu}:a]volume=1.0[m0]`, `[${bed}:a]volume=0.42,atrim=0:${total + 5}[m1]`,
    `[m0][m1]acrossfade=d=3:c1=tri:c2=tri,atrim=0:${total.toFixed(3)},afade=t=in:d=0.5,afade=t=out:st=${(total - 2.5).toFixed(3)}:d=2.5[music]`,
    `[music][sc]sidechaincompress=threshold=0.04:ratio=6:attack=25:release=450[duck]`,
    `[voice][duck]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);

  mkdirSync(OUT, { recursive: true });
  const dst = join(OUT, 'millionscope-intro.mp4');
  sh('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-stats', ...inputs, '-filter_complex', [...vf, ...af].join(';'),
    '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', '-t', total.toFixed(3), dst]);
  console.log(`\n${dst}  (${total.toFixed(1)}s)`);
}

if (!args.has('--compose')) await record();
if (!args.has('--shots')) {
  for (const s of SHOTS) if (!existsSync(join(CLIPS, `${s.id}.mp4`))) throw new Error(`missing clip ${s.id}; record first`);
  compose();
}
