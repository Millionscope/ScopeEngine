/**
 * The area menu (codicon "ellipsis" in every header, or right-click on empty header space):
 * split, join, swap, duplicate, regions, header position, maximize, fullscreen, close.
 * Items are plain descriptors rendered by the shell's menu widget (injected as ui.showMenu).
 * @module workspace/area-menu
 */
import { getEditor } from '../editors/registry.js';

/**
 * @typedef {Object} MenuItem
 * @property {string=} label
 * @property {string=} icon
 * @property {string=} key            keybinding label
 * @property {boolean=} checked
 * @property {boolean=} disabled
 * @property {string=} title          tooltip / reason when disabled
 * @property {boolean=} separator
 * @property {string=} header
 * @property {(() => void)=} run
 * @property {(MenuItem[] | (() => MenuItem[]))=} submenu
 */

/**
 * @param {import('./area.js').Area} area
 * @param {import('./workspaces.js').WorkspaceManager} ws
 * @returns {MenuItem[]}
 */
export function buildAreaMenu(area, ws) {
  const id = area.id;
  const leaf = area.leaf;
  const tree = ws.treeOf(id);
  const keys = (cmd) => ws.commands.keyLabel(cmd);
  const describe = (a) => {
    const e = getEditor(a.editorType);
    return `${e ? e.label : a.editorType}`;
  };
  const sibling = tree ? tree.siblingLeaf(id) : null;
  const others = tree ? tree.leaves().filter((l) => l.id !== id) : [];
  const maximized = tree?.maximizedId === id;

  /** @type {MenuItem[]} */
  const items = [
    { label: 'Split Vertical', icon: 'split-horizontal', run: () => ws.splitArea(id, 'row') },
    { label: 'Split Horizontal', icon: 'split-vertical', run: () => ws.splitArea(id, 'col') },
    {
      label: 'Join with…',
      icon: 'combine',
      disabled: !sibling,
      title: sibling ? '' : 'Areas must share a full edge to join (split siblings)',
      submenu: sibling
        ? [{ label: `${describe(sibling)} (${ws.relativePosition(id, sibling.id)})`, run: () => ws.joinAreas(id, sibling.id) }]
        : [],
    },
    {
      label: 'Swap with…',
      icon: 'arrow-swap',
      disabled: others.length === 0,
      submenu: others.map((o) => ({ label: `${describe(o)} (${ws.relativePosition(id, o.id)})`, run: () => ws.swapAreas(id, o.id) })),
    },
    { label: 'Duplicate Area', icon: 'copy', run: () => ws.duplicateArea(id) },
    { separator: true },
    { label: 'Toggle Tool Region', icon: 'layout-sidebar-left', key: 'T', checked: leaf.regions.tools, run: () => ws.toggleRegion(id, 'tools') },
    { label: 'Toggle Sidebar', icon: 'layout-sidebar-right', key: 'N', checked: leaf.regions.sidebar, run: () => ws.toggleRegion(id, 'sidebar') },
    { label: 'Header at Top', checked: leaf.headerPos === 'top', run: () => ws.setHeaderPos(id, 'top') },
    { label: 'Header at Bottom', checked: leaf.headerPos === 'bottom', run: () => ws.setHeaderPos(id, 'bottom') },
    { label: 'Collapse Header', checked: leaf.headerCollapsed, run: () => ws.toggleHeaderCollapsed(id) },
    { separator: true },
    { label: maximized && !tree?.fullscreen ? 'Restore Area' : 'Maximize Area', icon: maximized ? 'screen-normal' : 'screen-full', key: keys('area.maximize'), run: () => ws.toggleMaximize(id) },
    { label: tree?.fullscreen && maximized ? 'Exit Fullscreen Area' : 'Fullscreen Area', icon: 'screen-full', key: keys('area.fullscreen'), run: () => ws.toggleFullscreen(id) },
    { separator: true },
    { label: 'Close Area', icon: 'close', disabled: (tree?.size ?? 1) <= 1, title: 'A workspace keeps at least one area', run: () => ws.closeArea(id) },
  ];
  return items;
}
