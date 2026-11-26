/**
 * Placeholder editor used while an editor type is not implemented yet (milestone scaffolding).
 * Shows the editor's name and icon and fully participates in the lifecycle.
 * @module editors/shared/placeholder
 */
import { BaseEditor } from '../base-editor.js';

/** @param {{id: string, label?: string, icon?: string, group?: string}} entry registry entry */
export function makePlaceholder(entry) {
  const id = entry.id;
  return class PlaceholderEditor extends BaseEditor {
    static id = id;
    static label = entry?.label || id;
    static icon = entry?.icon || 'symbol-misc';
    static group = entry?.group || '';

    async mount(ctx) {
      this.el = document.createElement('div');
      this.el.className = 'ms-empty ms-placeholder';
      const icon = document.createElement('span');
      icon.className = `codicon codicon-${PlaceholderEditor.icon}`;
      icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('div');
      title.className = 'ms-empty-title';
      title.textContent = PlaceholderEditor.label;
      const idEl = document.createElement('div');
      idEl.className = 'ms-placeholder-id';
      idEl.textContent = `editor type "${id}" · ${PlaceholderEditor.group}`;
      this.sizeEl = document.createElement('div');
      this.sizeEl.className = 'ms-empty-text ms-tabular';
      this.el.append(icon, title, idEl, this.sizeEl);
      ctx.el.append(this.el);
    }

    resize(w, h) {
      this.w = w;
      this.h = h;
      this.invalidate();
    }

    render() {
      if (this.sizeEl) this.sizeEl.textContent = `${Math.round(this.w || 0)} × ${Math.round(this.h || 0)} px`;
    }

    dispose() {
      this.el?.remove();
      super.dispose();
    }
  };
}
