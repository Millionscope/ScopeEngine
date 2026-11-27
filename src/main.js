/**
 * Bootstrap: core -> theme -> model/mock -> services -> workspace -> shell -> restore layout.
 * @module main
 */
import { EventBus } from './core/events.js';
import { Store } from './core/store.js';
import { CommandRegistry } from './core/commands.js';
import { Keymap } from './core/keymap.js';
import { Scheduler } from './core/scheduler.js';
import { configureLazy, LIBS } from './core/lazy.js';
import { log, setLogSink } from './core/log.js';
import { ThemeService } from './theme/theme-service.js';
import { loadDemoGraph } from './model/loader.js';
import { JsEngine } from './model/engine.js';
import { ScenarioStore } from './model/scenarios.js';
import { NotifyService } from './services/notify.js';
import { SelectionService } from './services/selection.js';
import { HistoryService } from './services/history.js';
import { ScenarioService } from './services/scenario-service.js';
import { SwarmService } from './services/swarm.js';
import { EvidenceService } from './services/evidence-service.js';
import { VerifyService } from './services/verify.js';
import { Router } from './services/router.js';
import { GraphQuery } from './services/graph-query.js';
import { ChatService } from './services/chat.js';
import { CompilerService } from './services/compiler.js';
import { MindService } from './services/mind.js';
import { SimService } from './services/sim.js';
import { AudioDirector } from './services/audio.js';
import { WorkspaceManager } from './workspace/workspaces.js';
import { loadLayout, loadPrefs, savePrefs, loadDeltaLog, saveDeltaLog, clearDeltaLog } from './workspace/persistence.js';
import { MenuService } from './shell/context-menu.js';
import { TooltipService } from './shell/tooltip.js';
import { ToastHost } from './shell/toast.js';
import { TopBar } from './shell/topbar.js';
import { StatusBar } from './shell/statusbar.js';
import { Composer } from './shell/composer.js';
import { Palette } from './shell/palette.js';
import { registerAppCommands } from './shell/app-commands.js';
import { registerModelCommands } from './shell/model-commands.js';
import { ShortcutsOverlay } from './shell/shortcuts-overlay.js';
import { DebugOverlay, debugProviders } from './shell/debug-overlay.js';
import { makePreviewCardProvider } from './shell/preview-card.js';
import { boundValueCount } from './editors/shared/bound-value.js';
import { liveChartCount } from './theme/adapters/chartjs.js';
import { glContextCount } from './editors/shared/gl-pool.js';

async function boot() {
  const t0 = performance.now();

  // ---------------------------------------------------------------- core
  const events = new EventBus();
  setLogSink((entry) => events.emit('log:entry', { entry }));
  const prefs = loadPrefs();
  const store = new Store({
    ui: {
      mcSamples: [200, 1000, 5000].includes(prefs.mcSamples) ? prefs.mcSamples : 1000,
      composerMode: prefs.composerMode || 'answer',
      reducedMotion: !!prefs.reducedMotion,
      audioMuted: !!prefs.audioMuted,
    },
    status: { engine: 'js-mock', version: null, hash: null, recompute: null, tokens: { count: 0, local: true, touched: false }, swarm: { running: false, roles: 0, label: '' } },
  });
  const commands = new CommandRegistry();
  const keymap = new Keymap(commands);
  const scheduler = new Scheduler();
  if (prefs.reducedMotion) {
    document.documentElement.classList.add('ms-reduced-motion');
    scheduler.reducedMotion = true;
  }
  const notify = new NotifyService(events);
  commands.onRun = (id, args) => events.emit('command:run', { id, args });
  configureLazy({
    onLoaded: (name, ms) => {
      log.info('lazy', `loaded ${LIBS[name]?.version || name} in ${ms} ms`);
      events.emit('lazy:loaded', { name, ms });
    },
    onFailed: (name, error) => {
      events.emit('lazy:failed', { name, error });
      notify.error(`Could not load ${LIBS[name]?.version || name} from the CDN.`, {
        detail: `${error?.message || error}. Editors that need it show a Retry button.`,
        source: 'lazy',
      });
    },
  });

  // ---------------------------------------------------------------- theme
  const theme = new ThemeService(events);
  // TTT before any UI mounts, so DOM and canvas text never measure/render in a fallback face.
  // Capped at 3 s so a slow or missing font never blocks boot.
  const fonts = Promise.race([
    Promise.all(['400 14px TTT', '700 14px TTT'].map((f) => document.fonts.load(f))),
    new Promise((r) => setTimeout(r, 3000)),
  ]).catch(() => {});
  await Promise.all([theme.init(), fonts]);

  // ---------------------------------------------------------------- model
  const engine = new JsEngine({
    samples: store.get('ui.mcSamples'),
    onRecomputed: (p) => {
      store.batch(() => {
        store.set('status.version', p.version);
        store.set('status.hash', p.hash);
        store.set('status.recompute', { ms: p.ms, mcMs: p.mcMs, nodes: p.nodes, full: !!p.full });
      });
      events.emit('graph:recomputed', p);
    },
    onRejected: (p) => events.emit('delta:rejected', p),
  });
  const graph = loadDemoGraph();
  const loadRes = engine.load(graph);
  log.info('engine', `loaded ${graph.nodes.size} metrics in ${graph.scopes.size} scopes (${loadRes.ms.toFixed(1)} ms, ${engine.n} samples)`);
  for (const e of engine.errors) log.warn('compiler', e.message, { hint: e.hint, nodeId: e.nodeId });

  // ---------------------------------------------------------------- services
  const selection = new SelectionService(events, () => engine.graph);
  selection.focusScope = graph.rootId;
  const history = new HistoryService({ events, engine, persist: { load: loadDeltaLog, save: saveDeltaLog, clear: clearDeltaLog } });
  const scenarios = new ScenarioService({ events, engine, history });
  const swarm = new SwarmService({ events, store });
  const evidence = new EvidenceService({ events });
  const verify = new VerifyService({ events, store, getEngine: () => engine, evidence });
  const router = new Router({ getEngine: () => engine });
  const graphQuery = new GraphQuery(() => engine);
  /** @type {Record<string, any>} */
  const compiler = new CompilerService({ getEngine: () => engine, events });
  const mind = new MindService({ events, history, getEngine: () => engine });
  const sim = new SimService({ events, getEngine: () => engine, store });
  const services = { notify, selection, history, scenarios, swarm, evidence, verify, router, graphQuery, compiler, mind, sim };
  const chat = new ChatService({ events, store, getEngine: () => engine, history, router, swarm, scenarios, verify, notify, commands, services });
  services.chat = chat;
  const replayed = history.replay();
  if (replayed) engine.recomputeAll();
  chat.init();
  store.batch(() => {
    store.set('status.version', engine.graph.versionLabel);
    store.set('status.hash', engine.graph.shortHash);
    store.set('status.recompute', { ms: loadRes.ms, mcMs: loadRes.mcMs, nodes: engine.N, full: true });
    store.set('status.scenario', scenarios.label(scenarios.activeId));
  });
  verify.refresh();

  events.on('graph:recomputed', (p) => { if (p.structural) selection.prune(); });
  events.on('selection:changed', (s) => store.set('status.selection', s.primary ? engine.graph.path(s.primary) : null));
  events.on('scenario:changed', () => store.set('status.scenario', scenarios.label(scenarios.activeId)));
  events.on('delta:rejected', (p) => {
    for (const e of p.errors || []) log.warn('delta', `rejected (${p.author}): ${e.message}`, { hint: e.hint, nodeId: p.deltas?.[0]?.target });
  });

  /** Load a different graph (reset / stress tests). */
  const reload = (newGraph, opts = {}) => {
    engine.scenarios = new ScenarioStore();
    scenarios.activeId = 'base';
    const r = engine.load(newGraph);
    evidence.useGraph(newGraph);
    if (!opts.keepLog) history.reset();
    else history.reset({ keepSaved: true });
    const payload = { version: newGraph.versionLabel, hash: newGraph.shortHash, changed: [], ms: r.ms, mcMs: r.mcMs, nodes: engine.N, tokens: 0, author: 'user', kind: 'load', structural: true, full: true };
    store.batch(() => {
      store.set('status.version', payload.version);
      store.set('status.hash', payload.hash);
      store.set('status.recompute', { ms: r.ms, mcMs: r.mcMs, nodes: engine.N, full: true });
    });
    events.emit('graph:loaded', { version: payload.version, hash: payload.hash, nodes: engine.N, scopes: newGraph.scopes.size });
    events.emit('graph:recomputed', payload);
    // clear the selection only after editors rebuilt for the new graph
    selection.select([], { source: 'reload' });
    selection.focusScope = newGraph.rootId;
    events.emit('scenario:changed', { activeId: 'base', reason: 'reload' });
    verify.refresh();
  };

  // ---------------------------------------------------------------- workspace
  const menus = new MenuService({ commands });
  const ui = { showMenu: (items, anchor, opts) => menus.show(items, anchor, opts) };
  const env = { events, store, commands, keymap, scheduler, theme, services, engine, ui };
  const ws = new WorkspaceManager({ container: /** @type {HTMLElement} */ (document.getElementById('screen')), env });

  commands.setContextProvider(() => {
    const target = ws.targetArea();
    return {
      workspaceId: ws.activeId,
      areaId: target?.id || null,
      activeAreaId: ws.activeAreaId(),
      hoverAreaId: ws.hoverAreaId,
      editorType: target?.leaf.editorType || null,
      area: target,
      editor: target?.editor || null,
      selection: services.selection?.get().selected || [],
    };
  });

  // ---------------------------------------------------------------- shell
  new ToastHost({ events });
  const tooltip = new TooltipService();
  tooltip.setCardProvider(makePreviewCardProvider({ engine, services, commands }));
  ws.init(loadLayout());
  new TopBar({ el: /** @type {HTMLElement} */ (document.getElementById('topbar')), ws, commands, theme, events, menus });
  services.audio = new AudioDirector({ events, store, ws });
  new StatusBar({ el: /** @type {HTMLElement} */ (document.getElementById('statusbar')), store, commands, theme, events, menus, notify, services });
  const composer = new Composer({ el: /** @type {HTMLElement} */ (document.getElementById('composer')), env, ws, menus });
  const palette = new Palette({ env, ws });
  const shortcuts = new ShortcutsOverlay({ keymap, commands });
  const debug = new DebugOverlay({ env, ws });
  debugProviders.boundValues = boundValueCount;
  debugProviders.charts = liveChartCount;
  debugProviders.glContexts = glContextCount;
  registerAppCommands({ env, ws, keymap, palette, composer, menus, shortcuts, debug });
  registerModelCommands({ env, ws, keymap, reload });
  keymap.attach(window);

  store.select('ui', (u) => savePrefs({ mcSamples: u.mcSamples, composerMode: u.composerMode, reducedMotion: u.reducedMotion, audioMuted: u.audioMuted }));

  document.getElementById('app')?.removeAttribute('aria-busy');
  log.info('app', `workbench ready in ${Math.round(performance.now() - t0)} ms${replayed ? ` (replayed ${replayed} saved change(s))` : ''}`);

  // handle for tests and the browser console
  /** @type {any} */ (window).__ms = { env, ws, composer, palette, menus, tooltip, debug, keymap, engine, services, reload };
  events.emit('app:ready', {});
}

boot().catch((err) => {
  console.error(err);
  const screen = document.getElementById('screen');
  if (screen) {
    screen.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'ms-editor-error';
    box.setAttribute('role', 'alert');
    const t = document.createElement('strong');
    t.textContent = 'MillionScope Workbench failed to start';
    const p = document.createElement('pre');
    p.textContent = `${err && err.stack ? err.stack : err}\n\nServe this folder over HTTP, e.g. "npx serve ." or "python -m http.server".`;
    box.append(t, p);
    screen.appendChild(box);
  }
});
