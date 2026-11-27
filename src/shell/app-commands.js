/**
 * Application commands and their keybindings. Area commands target the area under the pointer,
 * falling back to the active area (Blender rule).
 * @module shell/app-commands
 */
import { listen } from '../core/disposable.js';
import { listEditors, getEditor } from '../editors/registry.js';

/** Editors that implement Home (frame all) and "." (frame selected). */
const FRAMEABLE = new Set(['graph', 'space3d']);

/**
 * @param {{
 *   env: any,
 *   ws: import('../workspace/workspaces.js').WorkspaceManager,
 *   keymap: import('../core/keymap.js').Keymap,
 *   palette: import('./palette.js').Palette,
 *   composer: import('./composer.js').Composer,
 *   menus: import('./context-menu.js').MenuService,
 *   shortcuts: { open: () => void },
 *   debug: { toggle: () => void, cycleEditors: () => Promise<any>, isOpen: () => boolean },
 * }} deps
 */
export function registerAppCommands({ env, ws, keymap, palette, composer, menus, shortcuts, debug }) {
  const { commands, theme, services, store } = env;
  /** last pointer position, used to anchor choosers opened from the keyboard */
  const pointer = { x: window.innerWidth / 2, y: 120 };
  listen(window, 'pointermove', (e) => { pointer.x = /** @type {PointerEvent} */ (e).clientX; pointer.y = /** @type {PointerEvent} */ (e).clientY; }, { passive: true });

  const target = (ctx) => (ctx.areaId ? ws.getArea(ctx.areaId) : ws.targetArea());
  const hasArea = (ctx) => !!target(ctx);
  const openBeside = (ctx, type) => {
    const a = target(ctx);
    if (!a) return;
    const open = ws.treeOf(a.id)?.leaves().find((l) => l.editorType === type);
    if (open) ws.setActiveArea(open.id);
    else ws.splitArea(a.id, 'row', 0.5, { type });
  };

  /** @type {import('../core/commands.js').Command[]} */
  const list = [
    // ---------------------------------------------------------------- areas
    { id: 'area.maximize', title: 'Maximize / Restore Area', category: 'Area', icon: 'screen-full', when: hasArea, run: (ctx) => { const a = target(ctx); if (a) ws.toggleMaximize(a.id); } },
    { id: 'area.fullscreen', title: 'Fullscreen Area', category: 'Area', icon: 'screen-full', when: hasArea, run: (ctx) => { const a = target(ctx); if (a) ws.toggleFullscreen(a.id); } },
    { id: 'area.toggleTools', title: 'Toggle Tool Region', category: 'Area', icon: 'layout-sidebar-left', when: hasArea, checked: (ctx) => !!target(ctx)?.leaf.regions.tools, run: (ctx) => { const a = target(ctx); if (a) ws.toggleRegion(a.id, 'tools'); } },
    { id: 'area.toggleSidebar', title: 'Toggle Sidebar', category: 'Area', icon: 'layout-sidebar-right', when: hasArea, checked: (ctx) => !!target(ctx)?.leaf.regions.sidebar, run: (ctx) => { const a = target(ctx); if (a) ws.toggleRegion(a.id, 'sidebar'); } },
    { id: 'area.splitVertical', title: 'Split Area Vertically', category: 'Area', icon: 'split-horizontal', when: hasArea, run: (ctx) => { const a = target(ctx); if (a) ws.splitArea(a.id, 'row'); } },
    { id: 'area.splitHorizontal', title: 'Split Area Horizontally', category: 'Area', icon: 'split-vertical', when: hasArea, run: (ctx) => { const a = target(ctx); if (a) ws.splitArea(a.id, 'col'); } },
    // Solar → Earth opens the globe, Globe → city opens its terrain: beside the area, or focus the one already open
    { id: 'area.openGlobe', title: 'Open Earth Globe', category: 'Area', icon: 'globe', when: hasArea, run: (ctx) => openBeside(ctx, 'globe') },
    { id: 'area.openTerrain', title: 'Open Holographic Terrain', category: 'Area', icon: 'map', when: hasArea, run: (ctx) => openBeside(ctx, 'terrain') },
    { id: 'area.duplicate', title: 'Duplicate Area', category: 'Area', icon: 'copy', when: hasArea, run: (ctx) => { const a = target(ctx); if (a) ws.duplicateArea(a.id); } },
    { id: 'area.close', title: 'Close Area', category: 'Area', icon: 'close', when: (ctx) => (ws.activeTree()?.size || 0) > 1 && hasArea(ctx), run: (ctx) => { const a = target(ctx); if (a) ws.closeArea(a.id); } },
    { id: 'area.typeMenu', title: 'Change Editor Type…', category: 'Area', icon: 'window', when: hasArea, run: (ctx) => target(ctx)?.header.openTypeMenu() },
    { id: 'area.menu', title: 'Open Area Menu', category: 'Area', icon: 'ellipsis', when: hasArea, run: (ctx) => { const a = target(ctx); if (a) a.header.openAreaMenu(a.header.menuBtn); } },
    { id: 'area.focusLeft', title: 'Focus Area Left', category: 'Area', hidden: true, run: () => ws.moveFocus('left') },
    { id: 'area.focusRight', title: 'Focus Area Right', category: 'Area', hidden: true, run: () => ws.moveFocus('right') },
    { id: 'area.focusUp', title: 'Focus Area Above', category: 'Area', hidden: true, run: () => ws.moveFocus('up') },
    { id: 'area.focusDown', title: 'Focus Area Below', category: 'Area', hidden: true, run: () => ws.moveFocus('down') },

    // ---------------------------------------------------------------- workspaces
    { id: 'workspace.next', title: 'Next Workspace', category: 'Workspace', icon: 'arrow-right', run: () => ws.cycle(1) },
    { id: 'workspace.prev', title: 'Previous Workspace', category: 'Workspace', icon: 'arrow-left', run: () => ws.cycle(-1) },
    { id: 'workspace.new', title: 'New Workspace (Answer preset)', category: 'Workspace', icon: 'add', run: () => ws.addWorkspace('answer') },
    { id: 'workspace.duplicate', title: 'Duplicate Workspace', category: 'Workspace', icon: 'copy', run: () => ws.activeId && ws.duplicateWorkspace(ws.activeId) },
    { id: 'workspace.delete', title: 'Delete Workspace', category: 'Workspace', icon: 'trash', when: () => ws.workspaces.length > 1, run: () => ws.activeId && ws.removeWorkspace(ws.activeId) },
    { id: 'layout.reset', title: 'Reset Layout', category: 'Workspace', icon: 'discard', run: () => { ws.resetLayout(); services.notify?.info('Layout reset to the default workspaces.'); } },

    // ---------------------------------------------------------------- view
    { id: 'theme.toggle', title: 'Toggle Dark / Light Theme', category: 'View', icon: 'color-mode', run: () => theme.toggle() },
    { id: 'theme.dark', title: 'Theme: Dark Modern', category: 'View', icon: 'color-mode', checked: () => theme.mode === 'dark', run: () => theme.setMode('dark') },
    { id: 'theme.light', title: 'Theme: Light Modern', category: 'View', icon: 'color-mode', checked: () => theme.mode === 'light', run: () => theme.setMode('light') },
    { id: 'theme.auto', title: 'Theme: Auto (follow system)', category: 'View', icon: 'color-mode', checked: () => theme.mode === 'auto', run: () => theme.setMode('auto') },
    { id: 'theme.cycle', title: 'Cycle Theme Dark → Light → Auto', category: 'View', icon: 'color-mode', run: () => theme.cycle() },
    {
      id: 'view.reducedMotion', title: 'Reduce Motion', category: 'View', icon: 'eye-closed',
      checked: () => !!store.get('ui.reducedMotion'),
      run: () => {
        const on = !store.get('ui.reducedMotion');
        store.set('ui.reducedMotion', on);
        document.documentElement.classList.toggle('ms-reduced-motion', on);
        env.scheduler.reducedMotion = on || matchMedia('(prefers-reduced-motion: reduce)').matches;
      },
    },
    { id: 'palette.open', title: 'Command Palette', category: 'View', icon: 'search', run: () => palette.open('all') },
    { id: 'palette.quickOpen', title: 'Quick Open Scope…', category: 'View', icon: 'go-to-file', run: () => palette.open('scopes') },
    { id: 'composer.focus', title: 'Focus Composer', category: 'Chat', icon: 'comment', run: () => composer.focus() },
    { id: 'composer.insert', title: 'Insert into Composer', category: 'Chat', hidden: true, run: (_ctx, text, opts) => composer.insert(String(text || ''), opts || {}) },
    { id: 'help.shortcuts', title: 'Keyboard Shortcuts', category: 'Help', icon: 'keyboard', run: () => shortcuts.open() },
    {
      id: 'help.about', title: 'About MillionScope Workbench', category: 'Help', icon: 'info',
      run: () => services.notify?.info('MillionScope Workbench prototype: static, front-end only. Every number is bound to a live scope graph; edits recompute in the browser at zero model tokens. The model, swarm, simulator and verifiers are mocks behind adapters.', { timeout: 12000 }),
    },
    { id: 'debug.overlay', title: 'Debug: Toggle Leak Overlay', category: 'Debug', icon: 'bug', checked: () => debug.isOpen(), run: () => debug.toggle() },
    { id: 'debug.cycleEditors', title: 'Debug: Cycle Area Through All Editor Types ×2', category: 'Debug', icon: 'debug-restart', when: hasArea, run: (ctx) => debug.cycleEditors(target(ctx)?.id) },

    // ---------------------------------------------------------------- selection & editors
    {
      id: 'selection.clear', title: 'Clear Selection', category: 'Edit', icon: 'clear-all',
      when: () => (services.selection?.get().selected.length || 0) > 0,
      run: () => services.selection?.clear(),
    },
    { id: 'editor.frameAll', title: 'Frame All', category: 'View', icon: 'screen-normal', when: (ctx) => FRAMEABLE.has(target(ctx)?.leaf.editorType), run: (ctx) => target(ctx)?.editor?.frameAll() },
    { id: 'editor.frameSelected', title: 'Frame Selected', category: 'View', icon: 'target', when: (ctx) => FRAMEABLE.has(target(ctx)?.leaf.editorType), run: (ctx) => target(ctx)?.editor?.frameSelected() },
    { id: 'editor.search', title: 'Search in Area', category: 'View', icon: 'search', when: hasArea, run: (ctx) => target(ctx)?.editor?.focusSearch() },
    {
      id: 'view.reveal', title: 'Reveal in Editor', category: 'View', hidden: true,
      run: (_ctx, type, nodeId, opts = {}) => {
        if (nodeId) services.selection?.select([nodeId], { source: 'reveal' });
        const areas = ws.visibleAreasOfType(type);
        if (areas.length) {
          ws.setActiveArea(areas[0].id);
          areas[0].flash();
          return true;
        }
        if (opts.quiet) return false;
        const entry = getEditor(type);
        const items = [
          { header: `Open ${entry?.label || type} in…` },
          ...ws.activeAreas().map((a) => ({
            label: `${getEditor(a.leaf.editorType)?.label || a.leaf.editorType} area`,
            icon: getEditor(a.leaf.editorType)?.icon,
            run: () => ws.setAreaType(a.id, type),
          })),
        ];
        menus.show(items, { x: pointer.x, y: pointer.y }, { label: `Open ${entry?.label || type}` });
        return false;
      },
    },
  ];

  // editor-type switching (Shift+F-keys) for every editor; listed in the palette as editor types
  for (const e of listEditors()) {
    list.push({
      id: `area.setType.${e.id}`,
      title: `Switch Area to ${e.label}`,
      category: 'Area',
      icon: e.icon,
      hidden: true,
      when: hasArea,
      run: (ctx) => { const a = target(ctx); if (a) ws.setAreaType(a.id, e.id); },
    });
  }

  commands.registerAll(list);

  // ---------------------------------------------------------------- keybindings
  const k = (key, cmd, opts) => keymap.bind(key, cmd, opts);
  k('ctrl+space', 'area.maximize', { allowInInput: true });
  k('ctrl+alt+space', 'area.fullscreen', { allowInInput: true });
  k('t', 'area.toggleTools');
  k('n', 'area.toggleSidebar');
  k('ctrl+alt+left', 'area.focusLeft');
  k('ctrl+alt+right', 'area.focusRight');
  k('ctrl+alt+up', 'area.focusUp');
  k('ctrl+alt+down', 'area.focusDown');
  k('ctrl+pagedown', 'workspace.next', { allowInInput: true });
  k('ctrl+pageup', 'workspace.prev', { allowInInput: true });
  k('alt+pagedown', 'workspace.next', { allowInInput: true });
  k('alt+pageup', 'workspace.prev', { allowInInput: true });
  k('f3', 'palette.open', { allowInInput: true });
  k('ctrl+shift+p', 'palette.open', { allowInInput: true });
  k('ctrl+p', 'palette.quickOpen', { allowInInput: true });
  k('/', 'composer.focus');
  k('?', 'help.shortcuts');
  k('ctrl+/', 'help.shortcuts', { allowInInput: true });
  k('ctrl+alt+d', 'debug.overlay', { allowInInput: true });
  k('escape', 'selection.clear');
  // bound after selection.clear so it is checked first (later bindings win)
  k('escape', 'area.maximize', { when: () => !!ws.activeTree()?.fullscreen });
  k('home', 'editor.frameAll');
  k('.', 'editor.frameSelected');
  k('ctrl+f', 'editor.search', { when: (ctx) => !!(ctx.areaId && ws.getArea(ctx.areaId)?.editor?.focusSearch) });
  for (const e of listEditors()) if (e.shortcut) k(e.shortcut, `area.setType.${e.id}`, { allowInInput: true });
}
