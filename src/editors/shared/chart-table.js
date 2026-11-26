/**
 * "View as table" for charts: every chart offers its data as an accessible table.
 * @module editors/shared/chart-table
 */

/**
 * @param {{caption?: string, columns: Array<{label: string, align?: 'left'|'right'}>, rows: Array<Array<string|number|Node>>}} spec
 * @returns {HTMLElement}
 */
export function tableView(spec) {
  const wrap = document.createElement('div');
  wrap.className = 'ms-chart-table-wrap';
  const table = document.createElement('table');
  table.className = 'ms-table';
  if (spec.caption) {
    const cap = document.createElement('caption');
    cap.className = 'ms-sr-only';
    cap.textContent = spec.caption;
    table.appendChild(cap);
  }
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const c of spec.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = c.label;
    if (c.align === 'right') th.className = 'num';
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  const tbody = document.createElement('tbody');
  for (const r of spec.rows) {
    const row = document.createElement('tr');
    r.forEach((cell, i) => {
      const td = document.createElement('td');
      if (spec.columns[i]?.align === 'right') td.className = 'num';
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = String(cell);
      row.appendChild(td);
    });
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

/**
 * A small "Chart / Table" toggle for editor headers.
 * @param {boolean} asTable @param {(asTable: boolean) => void} onChange
 */
export function tableToggle(asTable, onChange) {
  const seg = document.createElement('div');
  seg.className = 'ms-seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Chart or table view');
  for (const [label, val] of [['Chart', false], ['Table', true]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(asTable === val));
    b.addEventListener('click', () => onChange(/** @type {boolean} */ (val)));
    seg.appendChild(b);
  }
  return seg;
}
