/**
 * Scope chip: compact pill with a prototype icon and name; draggable into the composer
 * (dataTransfer type "text/x-ms-node") to add context.
 * @module editors/shared/scope-chip
 */

const KIND_ICON = {
  business: 'symbol-class', location: 'location', person: 'person', mind: 'organization', group: 'folder',
  month: 'calendar', loan: 'credit-card', market: 'graph-line', population: 'globe', lease: 'file-text',
  equipment: 'tools', projection: 'graph-line', entity: 'symbol-namespace',
};

/** Codicon for a scope kind. @param {string|undefined} kind */
export function kindIcon(kind) {
  return KIND_ICON[kind || 'entity'] || 'symbol-namespace';
}

/**
 * @param {import('../../model/graph.js').ScopeGraph} graph
 * @param {string} id scope or node id
 * @param {{onClick?: (id: string, e: MouseEvent) => void, label?: string}} [opts]
 */
export function scopeChip(graph, id, opts = {}) {
  const chip = document.createElement('span');
  chip.className = 'ms-chip';
  chip.draggable = true;
  chip.tabIndex = 0;
  chip.setAttribute('role', 'button');
  const isScope = graph.isScope(id);
  const scope = graph.scopeOf(id);
  const icon = document.createElement('span');
  icon.className = `codicon codicon-${isScope ? kindIcon(scope?.kind) : 'symbol-field'}`;
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'ms-ellipsis';
  label.textContent = opts.label || (isScope ? scope?.name || id : graph.path(id).split('.').slice(-2).join('.'));
  chip.append(icon, label);
  chip.title = `${graph.path(id)}${scope ? ` · ${graph.protoChainNames(scope.id).join(' → ')}` : ''}\nDrag into the composer to add as context`;
  chip.setAttribute('aria-label', `${graph.path(id)}. Drag into the composer to add as context.`);
  chip.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/x-ms-node', id);
    e.dataTransfer?.setData('text/plain', `@${graph.path(id)}`);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  });
  if (opts.onClick) {
    chip.addEventListener('click', (e) => opts.onClick?.(id, e));
    chip.addEventListener('keydown', (e) => { if (e.key === 'Enter') opts.onClick?.(id, /** @type {any} */ (e)); });
  }
  return chip;
}
