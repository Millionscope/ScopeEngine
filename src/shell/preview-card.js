/**
 * Scope preview card for bound values (hover): name, prototype chain, value with p10–p90,
 * provenance (with the source span for observed values), and "open in…" actions.
 * @module shell/preview-card
 */
import { provMark } from '../editors/shared/prov-mark.js';
import { sparkline } from '../editors/shared/sparkline.js';
import { statValue, defaultFmt } from '../model/binding.js';
import { describe } from '../model/distributions.js';
import { toScopeLang } from '../model/expr.js';
import { formatAs, unitValue } from '../model/format.js';
import { PROVENANCE } from '../theme/tokens.js';

/**
 * @param {{ engine: any, services: any, commands: import('../core/commands.js').CommandRegistry }} env
 * @returns {(el: HTMLElement) => HTMLElement|null}
 */
export function makePreviewCardProvider(env) {
  return (el) => {
    const engine = env.engine;
    const g = engine.graph;
    const id = el.dataset.node;
    if (!id) return null;
    const n = g.node(id);
    if (!n) return null;
    const scen = el.dataset.scenario || null;
    const view = engine.view(scen);
    const prov = g.displayProv(id);
    const scope = g.scope(n.scope);
    const card = document.createElement('div');
    card.setAttribute('aria-label', `Preview of ${g.path(id)}`);

    const head = document.createElement('div');
    head.className = 'ms-card-head';
    const title = document.createElement('div');
    title.className = 'ms-card-title';
    title.textContent = n.label || n.name;
    head.append(provMark(prov), title);
    if (scen && scen !== 'base') {
      const b = document.createElement('span');
      b.className = 'ms-chip is-lod';
      b.textContent = engine.scenarios.get(scen)?.name || scen;
      head.appendChild(b);
    }
    card.appendChild(head);

    const proto = document.createElement('div');
    proto.className = 'ms-card-proto';
    proto.textContent = `${g.path(id)} · ${g.protoChainNames(scope.id).join(' → ')}`;
    card.appendChild(proto);

    const st = view.stats(id);
    const stat = el.dataset.stat || 'value';
    const v = statValue(view, id, stat);
    const value = document.createElement('div');
    value.className = 'ms-card-value';
    value.textContent = formatAs(v, el.dataset.fmt || defaultFmt(n.type.unit), n.type.unit);
    const unit = document.createElement('span');
    unit.className = 'ms-card-unit';
    unit.textContent = `${n.type.unit}${stat !== 'value' ? ` · ${stat}` : ''}`;
    value.appendChild(unit);
    card.appendChild(value);

    if (st && !st.deterministic) {
      const iv = document.createElement('div');
      iv.className = 'ms-card-interval';
      iv.textContent = `p10–p90 ${unitValue(st.p10, n.type.unit, { bare: true })}–${unitValue(st.p90, n.type.unit, { bare: true })} · mean ${unitValue(st.mean, n.type.unit, { bare: true })} · ${engine.n.toLocaleString('en-US')} samples`;
      card.appendChild(iv);
      const sp = document.createElement('div');
      sp.className = 'ms-card-spark';
      sp.appendChild(sparkline(view.sample(id), { width: 296, height: 34, color: `var(${PROVENANCE[prov]?.var || '--ms-prov-computed'})`, label: 'distribution of samples' }));
      card.appendChild(sp);
    }

    const row = (k, text) => {
      const r = document.createElement('div');
      r.className = 'ms-card-row';
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      b.textContent = text;
      r.append(a, b);
      card.appendChild(r);
    };
    row('provenance', `${PROVENANCE[prov]?.label || prov}: ${PROVENANCE[prov]?.description || ''}`);
    if (n.dist && n.dist.family !== 'Point') row('uncertainty', describe(n.dist));
    if (n.kind === 'computed' && n.expr !== undefined) row('formula', `${n.name} = ${toScopeLang(n.expr)}`);
    if (n.prov?.by) row('estimator', `${n.prov.by}${n.prov.calib != null ? ` · calibration error ${n.prov.calib}` : ''}`);
    if (n.prov?.overriddenFrom) row('override', `you overrode a ${n.prov.overriddenFrom} value`);
    if (n.kind === 'observed') {
      const ev = env.services.evidence?.forNode(id)[0];
      if (ev) {
        const src = env.services.evidence.source(ev.source);
        const q = document.createElement('div');
        q.className = 'ms-card-source';
        q.textContent = `“${ev.span}” (${src?.name || ev.source}, p${ev.page})`;
        card.appendChild(q);
      } else if (n.prov?.src) row('source', `${n.prov.src}${n.prov.page ? ` p${n.prov.page}` : ''}`);
    }

    const actions = document.createElement('div');
    actions.className = 'ms-card-actions';
    for (const [type, label] of [['inspector', 'Properties'], ['graph', 'Graph'], ['formula', 'Formula']]) {
      const b = document.createElement('button');
      b.className = 'ms-btn is-secondary is-small';
      b.textContent = `Open in ${label}`;
      b.addEventListener('click', () => {
        card.remove();
        env.commands.execute('view.reveal', type, id);
      });
      actions.appendChild(b);
    }
    card.appendChild(actions);
    return card;
  };
}
