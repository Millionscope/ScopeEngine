/**
 * Commands that act on the graph and services: undo/redo, Monte Carlo samples, recompute,
 * certificate replay, exports, demo reset, stress graphs, rename (F2), attach evidence.
 * @module shell/model-commands
 */
import { loadDemoGraph, loadStressGraph } from '../model/loader.js';
import { clearDeltaLog, clearLayout, KEYS } from '../workspace/persistence.js';

/**
 * @param {{
 *   env: any,
 *   ws: import('../workspace/workspaces.js').WorkspaceManager,
 *   keymap: import('../core/keymap.js').Keymap,
 *   reload: (graph: any, opts?: {keepLog?: boolean}) => void,
 * }} deps
 */
export function registerModelCommands({ env, ws, keymap, reload }) {
  const { commands, services, store } = env;
  const engine = env.engine;
  const notify = services.notify;

  const download = (name, text, type) => {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  commands.registerAll([
    {
      id: 'edit.undo', title: 'Undo Graph Change', category: 'Edit', icon: 'discard',
      when: () => services.history.canUndo(),
      run: () => {
        const r = services.history.undo();
        if (r && !r.ok) notify.warn(`Undo rejected: ${r.errors?.[0]?.message}`);
        store.set('status.tokens', { count: 0, local: true, touched: true });
      },
    },
    {
      id: 'edit.redo', title: 'Redo Graph Change', category: 'Edit', icon: 'redo',
      when: () => services.history.canRedo(),
      run: () => {
        const r = services.history.redo();
        if (r && !r.ok) notify.warn(`Redo rejected: ${r.errors?.[0]?.message}`);
        store.set('status.tokens', { count: 0, local: true, touched: true });
      },
    },
    {
      id: 'editor.rename', title: 'Rename Selected Scope', category: 'Edit', icon: 'edit',
      when: () => (services.selection.get().selected.length || 0) > 0,
      run: (ctx) => {
        const id = services.selection.get().primary;
        const target = ctx.area?.editor?.rename ? ctx.area : ws.visibleAreasOfType('outliner')[0];
        if (target?.editor?.rename) target.editor.rename(id);
        else notify.info('Open an Outliner area to rename scopes (F2).');
      },
    },
    {
      id: 'engine.samples', title: 'Set Monte Carlo Samples', category: 'Graph', icon: 'pulse', hidden: true,
      checked: () => false,
      run: (_ctx, n) => {
        const samples = Number(n) || 1000;
        store.set('ui.mcSamples', samples);
        const t0 = performance.now();
        engine.setSamples(samples);
        notify.info(`Monte Carlo now uses ${samples.toLocaleString('en-US')} samples (full recompute in ${Math.round(performance.now() - t0)} ms).`);
      },
    },
    { id: 'graph.recompute', title: 'Recompute Everything', category: 'Graph', icon: 'refresh', run: () => engine.recomputeAll() },
    {
      id: 'certificate.replay', title: 'Replay Certificate from Hash and Seed', category: 'Graph', icon: 'debug-restart',
      run: () => {
        const r = services.verify.replay();
        if (r.identical) notify.success(`Replay matches: ${r.compared.toLocaleString('en-US')} samples identical (hash ${r.hash.slice(0, 8)}…, seed ${r.seed}).`);
        else notify.error('Replay differs from the live graph.', { detail: `hash ${r.hash}` });
        return r;
      },
    },
    {
      id: 'export.ir', title: 'Export Scope IR (JSON)', category: 'File', icon: 'export',
      run: () => download(`millionscope-${engine.graph.versionLabel}.json`, JSON.stringify(engine.graph.toIR(), null, 2), 'application/json'),
    },
    {
      id: 'export.scopelang', title: 'Export ScopeLang Source', category: 'File', icon: 'export',
      run: () => {
        const text = services.compiler ? services.compiler.source() : '// ScopeLang export is available once the compiler service is loaded\n';
        download(`millionscope-${engine.graph.versionLabel}.scope`, text, 'text/plain');
      },
    },
    {
      id: 'graph.resetDemo', title: 'Reset Demo Graph (discard local changes)', category: 'Graph', icon: 'discard',
      run: () => {
        clearDeltaLog();
        reload(loadDemoGraph());
        notify.info('Demo graph reset to v41; local changes discarded.');
      },
    },
    {
      id: 'debug.stress10k', title: 'Debug: Load Stress Graph (10k metrics)', category: 'Debug', icon: 'beaker',
      run: () => {
        const t0 = performance.now();
        reload(loadStressGraph(10000), { keepLog: true });
        notify.info(`Loaded ${engine.graph.nodes.size.toLocaleString('en-US')} metrics in ${Math.round(performance.now() - t0)} ms. Reset Demo Graph to go back.`);
      },
    },
    {
      id: 'debug.stress100k', title: 'Debug: Load Stress Graph (100k metrics)', category: 'Debug', icon: 'beaker',
      run: () => {
        const t0 = performance.now();
        reload(loadStressGraph(100000), { keepLog: true });
        notify.info(`Loaded ${engine.graph.nodes.size.toLocaleString('en-US')} metrics in ${Math.round(performance.now() - t0)} ms. Open the Space workspace for the 3D view.`);
      },
    },
    {
      id: 'data.clearLocal', title: 'Clear Local Data (layout, theme, delta log)', category: 'File', icon: 'trash',
      run: () => {
        for (const k of Object.values(KEYS)) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
        clearLayout();
        notify.info('Local data cleared. Reload the page for a fresh start.', { actions: [{ label: 'Reload', run: () => location.reload() }] });
      },
    },
    {
      id: 'chat.newQuestion', title: 'Ask a New Question', category: 'Chat', icon: 'comment',
      run: () => commands.execute('composer.insert', '', { replace: true }),
    },
    {
      id: 'evidence.attach', title: 'Attach Evidence…', category: 'File', icon: 'file-add',
      run: () => {
        const { source, extraction } = services.evidence.attach();
        notify.success(`Attached ${source.name}: found ${extraction.match} (mock extraction).`, {
          actions: [{ label: 'Open Evidence', run: () => commands.execute('view.reveal', 'evidence') }],
        });
      },
    },
  ]);

  keymap.bind('ctrl+z', 'edit.undo');
  keymap.bind('ctrl+shift+z', 'edit.redo');
  keymap.bind('ctrl+y', 'edit.redo');
  keymap.bind('f2', 'editor.rename');
}
