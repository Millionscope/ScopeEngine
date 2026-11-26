/**
 * Area header, left to right: editor-type button, title, editor menus, editor tools, spacer,
 * scenario selector (editors that declare usesScenario), pin, sync selection, area menu.
 * Right-click on empty header space opens the area menu; double-click toggles maximize.
 * @module workspace/area-header
 */
import { DisposableStore, listen } from '../core/disposable.js';
import { getEditor } from '../editors/registry.js';
import { buildAreaMenu } from './area-menu.js';
import { openEditorTypeMenu } from './editor-type-menu.js';

/** @param {string} icon @param {string} label @param {string} [cls] */
function iconButton(icon, label, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `ms-icon-btn ${cls}`.trim();
  b.setAttribute('aria-label', label);
  b.dataset.tooltip = label;
  const i = document.createElement('span');
  i.className = `codicon codicon-${icon}`;
  i.setAttribute('aria-hidden', 'true');
  b.appendChild(i);
  return b;
}

export class AreaHeader {
  /** @param {import('./area.js').Area} area */
  constructor(area) {
    this.area = area;
    this.d = new DisposableStore();
    /** @type {DisposableStore} rebuilt on refresh */
    this.dyn = new DisposableStore();

    const el = document.createElement('div');
    el.className = 'ms-area-header';
    el.setAttribute('role', 'toolbar');
    this.el = el;

    this.typeBtn = iconButton('symbol-misc', 'Editor type', 'ms-area-type-btn');
    this.typeBtn.setAttribute('aria-haspopup', 'dialog');
    this.typeBtn.setAttribute('aria-expanded', 'false');
    this.typeIcon = /** @type {HTMLElement} */ (this.typeBtn.firstElementChild);
    const caret = document.createElement('span');
    caret.className = 'codicon codicon-chevron-down ms-caret';
    caret.setAttribute('aria-hidden', 'true');
    this.typeBtn.appendChild(caret);

    this.title = document.createElement('span');
    this.title.className = 'ms-area-title';

    this.menus = document.createElement('div');
    this.menus.className = 'ms-area-menus';
    this.menus.setAttribute('role', 'menubar');

    this.tools = document.createElement('div');
    this.tools.className = 'ms-area-tools';

    this.spacer = document.createElement('div');
    this.spacer.className = 'ms-spacer';

    this.controls = document.createElement('div');
    this.controls.className = 'ms-area-controls';

    this.scenarioSel = document.createElement('select');
    this.scenarioSel.className = 'ms-select is-small';
    this.scenarioSel.setAttribute('aria-label', 'Scenario shown in this area');
    this.scenarioSel.dataset.tooltip = 'Scenario shown in this area';

    this.pinBtn = iconButton('pin', 'Pin area to its current scope', 'is-small ms-toggle');
    this.syncBtn = iconButton('link', 'Sync selection with other areas', 'is-small ms-toggle');
    this.menuBtn = iconButton('ellipsis', 'Area menu', 'is-small');
    this.menuBtn.setAttribute('aria-haspopup', 'menu');

    this.expandBtn = iconButton('chevron-down', 'Expand header', 'ms-header-expand');

    this.controls.append(this.scenarioSel, this.pinBtn, this.syncBtn, this.menuBtn);
    el.append(this.typeBtn, this.title, this.menus, this.tools, this.spacer, this.controls, this.expandBtn);

    const ws = area.ws;
    this.d.add(listen(this.typeBtn, 'click', () => this.openTypeMenu()));
    this.d.add(listen(this.pinBtn, 'click', () => area.setPinned(!area.leaf.pinnedScopeId)));
    this.d.add(listen(this.syncBtn, 'click', () => area.setSync(!area.leaf.syncSelection)));
    this.d.add(listen(this.menuBtn, 'click', () => this.openAreaMenu(this.menuBtn)));
    this.d.add(listen(this.expandBtn, 'click', () => ws.toggleHeaderCollapsed(area.id)));
    this.d.add(listen(this.scenarioSel, 'change', () => area.setScenario(this.scenarioSel.value || null)));
    this.d.add(listen(el, 'contextmenu', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t !== el && t !== this.spacer && t !== this.title && t !== this.menus && t !== this.tools) return;
      e.preventDefault();
      const me = /** @type {MouseEvent} */ (e);
      area.ui.showMenu(buildAreaMenu(area, ws), { x: me.clientX, y: me.clientY }, { label: 'Area menu' });
    }));
    this.d.add(listen(el, 'dblclick', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t === el || t === this.spacer || t === this.title) ws.toggleMaximize(area.id);
    }));
  }

  openTypeMenu() {
    const area = this.area;
    if (this._typeMenu) { this._typeMenu.close(); return; }
    this._typeMenu = openEditorTypeMenu({
      anchor: this.typeBtn,
      current: area.leaf.editorType,
      onPick: (type) => area.ws.setAreaType(area.id, type),
      onClose: () => { this._typeMenu = null; },
    });
  }

  /** @param {HTMLElement} anchor */
  openAreaMenu(anchor) {
    const area = this.area;
    this.menuBtn.setAttribute('aria-expanded', 'true');
    area.ui.showMenu(buildAreaMenu(area, area.ws), anchor, {
      label: 'Area menu',
      onClose: () => this.menuBtn.setAttribute('aria-expanded', 'false'),
    });
  }

  /** Re-read the editor's menus/tools and the area flags. */
  refresh() {
    const area = this.area;
    const leaf = area.leaf;
    const entry = getEditor(leaf.editorType);
    const label = entry ? entry.label : leaf.editorType;
    this.typeIcon.className = `codicon codicon-${entry ? entry.icon : 'symbol-misc'}`;
    this.typeBtn.setAttribute('aria-label', `Editor type: ${label}. Change editor type`);
    this.typeBtn.dataset.tooltip = `Editor type: ${label}`;
    this.title.textContent = label;

    // editor menus and tools
    this.dyn.clear();
    this.menus.replaceChildren();
    this.tools.replaceChildren();
    const editor = area.editor;
    if (editor) {
      let menus = [];
      let tools = [];
      try { menus = editor.getHeaderMenus() || []; } catch (err) { console.error(err); }
      try { tools = editor.getHeaderTools() || []; } catch (err) { console.error(err); }
      for (const m of menus) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ms-area-menu-item';
        b.textContent = m.label;
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
        this.dyn.add(listen(b, 'click', () => {
          b.setAttribute('aria-expanded', 'true');
          const items = typeof m.items === 'function' ? m.items() : m.items;
          area.ui.showMenu(items, b, { label: m.label, onClose: () => b.setAttribute('aria-expanded', 'false') });
        }));
        this.menus.appendChild(b);
      }
      for (const t of tools) if (t) this.tools.appendChild(t);
    }

    // scenario selector
    const usesScenario = !!(entry?.usesScenario);
    const scen = area.env.services.scenarios;
    this.scenarioSel.hidden = !usesScenario || !scen;
    if (usesScenario && scen) {
      const cur = leaf.scenarioId || '';
      const opts = [{ value: '', label: `Follow global (${scen.label(scen.activeId)})` }];
      for (const s of scen.list()) opts.push({ value: s.id, label: s.name });
      this.scenarioSel.replaceChildren(...opts.map((o) => {
        const op = document.createElement('option');
        op.value = o.value;
        op.textContent = o.label;
        if (o.value === cur) op.selected = true;
        return op;
      }));
    }

    // toggles
    const pinned = !!leaf.pinnedScopeId;
    this.pinBtn.setAttribute('aria-pressed', String(pinned));
    const pinLabel = pinned ? `Pinned to ${area.env.services.selection?.label?.(leaf.pinnedScopeId) || leaf.pinnedScopeId} (click to unpin)` : 'Pin area to its current scope';
    this.pinBtn.setAttribute('aria-label', pinLabel);
    this.pinBtn.dataset.tooltip = pinLabel;
    /** @type {HTMLElement} */ (this.pinBtn.firstElementChild).className = `codicon codicon-${pinned ? 'pinned' : 'pin'}`;
    this.syncBtn.setAttribute('aria-pressed', String(leaf.syncSelection));
    const syncLabel = leaf.syncSelection ? 'Selection synced with other areas (click to stop)' : 'Selection not synced (click to sync)';
    this.syncBtn.setAttribute('aria-label', syncLabel);
    this.syncBtn.dataset.tooltip = syncLabel;
  }

  dispose() {
    this._typeMenu?.close();
    this.dyn.dispose();
    this.d.dispose();
  }
}
