/**
 * Chat view helpers: swarm progress strip, certificate chip, receipts, in-simulation speech.
 * @module editors/chat/view
 */
import { renderTemplateInto } from '../shared/bound-value.js';

const ROLE_ABBR = { Lead: 'Ld', Modeler: 'Mo', Researcher: 'Re', 'Estimator 1': 'E1', 'Estimator 2': 'E2', 'Estimator 3': 'E3', Skeptic: 'Sk', 'Mind sim': 'Ms', Explainer: 'Ex', Verifier: 'Vf' };
const STATE_ICON = { thinking: 'loading ms-spin', proposed: 'circle-filled', accepted: 'check', rejected: 'close', done: 'check', idle: '' };

/**
 * @param {any} build
 * @param {{expanded?: boolean, onSelect?: (id: string) => void}} opts
 */
export function renderSwarmStrip(build, opts = {}) {
  const strip = document.createElement('div');
  strip.className = 'ms-swarm-strip' + (opts.expanded ? ' is-expanded' : '');
  const head = document.createElement('button');
  head.className = 'ms-swarm-head';
  head.setAttribute('aria-expanded', String(!!opts.expanded));
  const running = !build.ended;
  const rejected = build.events.filter((e) => e.outcome === 'rejected').length;
  const accepted = build.events.filter((e) => e.outcome === 'accepted').length;
  head.innerHTML = `<span class="codicon codicon-${running ? 'loading ms-spin' : 'hubot'}" aria-hidden="true"></span>`;
  const label = document.createElement('span');
  label.className = 'ms-grow ms-ellipsis';
  label.textContent = running ? `Swarm building · ${build.events.length} events` : `Swarm · ${accepted} accepted · ${rejected} rejected by verifiers`;
  head.appendChild(label);
  const avatars = document.createElement('span');
  avatars.className = 'ms-swarm-avatars';
  for (const [role, st] of Object.entries(build.roles)) {
    if (st === 'idle') continue;
    const a = document.createElement('span');
    a.className = `ms-swarm-av is-${st}`;
    a.title = `${role}: ${st}`;
    a.setAttribute('aria-label', `${role}: ${st}`);
    a.textContent = ROLE_ABBR[role] || role.slice(0, 2);
    if (STATE_ICON[st]) {
      const i = document.createElement('span');
      i.className = `codicon codicon-${STATE_ICON[st]} ms-swarm-av-state`;
      i.setAttribute('aria-hidden', 'true');
      a.appendChild(i);
    }
    avatars.appendChild(a);
  }
  head.appendChild(avatars);
  const chev = document.createElement('span');
  chev.className = 'codicon codicon-chevron-down ms-swarm-chev';
  chev.setAttribute('aria-hidden', 'true');
  head.appendChild(chev);
  strip.appendChild(head);
  const body = document.createElement('ol');
  body.className = 'ms-swarm-events';
  for (const e of build.events) {
    const li = document.createElement('li');
    li.className = `is-${e.outcome}`;
    const role = document.createElement('span');
    role.className = 'ms-swarm-role';
    role.textContent = e.role;
    const text = document.createElement('span');
    text.className = 'ms-swarm-text';
    text.textContent = e.text;
    const out = document.createElement('span');
    out.className = `ms-status`;
    out.dataset.status = e.outcome === 'accepted' ? 'pass' : e.outcome === 'rejected' ? 'fail' : 'na';
    out.textContent = e.outcome === 'rejected' ? `rejected${e.level != null ? ` · L${e.level}` : ''}` : e.outcome;
    li.append(role, text, out);
    if (e.reason && e.outcome === 'rejected') {
      const r = document.createElement('div');
      r.className = 'ms-swarm-reason';
      r.textContent = `${e.reason}${e.hint ? `; ${e.hint}` : ''}`;
      li.appendChild(r);
    }
    if (e.nodeId && opts.onSelect) {
      li.tabIndex = 0;
      li.addEventListener('click', () => opts.onSelect?.(e.nodeId));
    }
    body.appendChild(li);
  }
  strip.appendChild(body);
  head.addEventListener('click', () => {
    const exp = strip.classList.toggle('is-expanded');
    head.setAttribute('aria-expanded', String(exp));
  });
  return strip;
}

/**
 * @param {any} cert
 * @param {{onOpen: () => void, expanded?: boolean}} opts
 */
export function renderCertChip(cert, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'ms-cert-chip' + (opts.expanded ? ' is-expanded' : '');
  if (!cert) {
    wrap.textContent = 'certificate pending';
    return wrap;
  }
  const btn = document.createElement('button');
  btn.className = 'ms-cert-chip-head';
  btn.setAttribute('aria-expanded', String(!!opts.expanded));
  const failed = cert.failed.length;
  const icon = failed ? 'error' : cert.notProven.length ? 'verified' : 'verified-filled';
  const c = cert.counts;
  btn.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
  const text = document.createElement('span');
  text.className = 'ms-tabular';
  text.textContent = `${c.computed.toLocaleString('en-US')} computed · ${cert.sources.matched}/${cert.sources.total} sources · ${c.estimated} estimated · ${c.proven} proven · ${failed} failed`;
  btn.appendChild(text);
  const chev = document.createElement('span');
  chev.className = 'codicon codicon-chevron-down';
  chev.setAttribute('aria-hidden', 'true');
  btn.appendChild(chev);
  wrap.appendChild(btn);
  const body = document.createElement('div');
  body.className = 'ms-cert-chip-body';
  const ul = document.createElement('ul');
  for (const l of cert.ladder) {
    const li = document.createElement('li');
    const st = document.createElement('span');
    st.className = 'ms-status';
    st.dataset.status = l.status === 'pass' || l.status === 'proven' ? (l.status === 'proven' ? 'proven' : 'pass') : l.status;
    st.textContent = l.status.replace('_', ' ');
    const name = document.createElement('span');
    name.textContent = `${l.level} · ${l.name}`;
    const det = document.createElement('span');
    det.className = 'ms-muted ms-small';
    det.textContent = l.detail;
    li.append(st, name, det);
    ul.appendChild(li);
  }
  body.appendChild(ul);
  const note = document.createElement('p');
  note.className = 'ms-small ms-muted';
  note.textContent = 'Verified means the conclusions follow from the graph. Whether the graph matches reality is measured, not proven.';
  const open = document.createElement('button');
  open.className = 'ms-btn is-secondary is-small';
  open.textContent = 'Open full certificate';
  open.addEventListener('click', opts.onOpen);
  body.append(note, open);
  wrap.appendChild(body);
  btn.addEventListener('click', () => {
    const exp = wrap.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', String(exp));
  });
  return wrap;
}

/**
 * @param {any} m
 * @param {{engine: any, bv: any}} ctx
 */
export function renderReceipt(m, ctx) {
  const row = document.createElement('div');
  row.className = 'ms-receipt';
  const icon = document.createElement('span');
  icon.className = `codicon codicon-${m.kind === 'error' ? 'error' : m.meta?.local ? 'zap' : 'info'}`;
  icon.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  body.className = 'ms-receipt-body';
  if (m.template) renderTemplateInto(body, m.template, { engine: ctx.engine, bv: ctx.bv });
  else body.textContent = m.text || '';
  row.append(icon, body);
  if (m.meta?.local) {
    const meta = document.createElement('span');
    meta.className = 'ms-receipt-meta';
    meta.textContent = `local · 0 tokens · ${m.meta.ms < 10 ? m.meta.ms.toFixed(1) : Math.round(m.meta.ms)} ms · ${m.meta.version}`;
    row.appendChild(meta);
  }
  return row;
}

/**
 * In-simulation speech: always visually distinct from the assistant's voice.
 * @param {{who: string, text: string}} q
 */
export function renderSimVoice(q) {
  const box = document.createElement('div');
  box.className = 'ms-sim-voice';
  box.setAttribute('role', 'note');
  box.setAttribute('aria-label', `Simulated speech by ${q.who}`);
  const av = document.createElement('span');
  av.className = 'ms-sim-voice-avatar';
  av.textContent = q.who.slice(0, 1);
  av.setAttribute('aria-hidden', 'true');
  const label = document.createElement('div');
  label.innerHTML = '<span class="ms-sim-voice-label"><span class="codicon codicon-beaker" aria-hidden="true"></span>simulation</span>';
  const who = document.createElement('span');
  who.className = 'ms-sim-voice-who';
  who.textContent = q.who;
  label.appendChild(who);
  const text = document.createElement('q');
  text.textContent = q.text;
  box.append(av, label, text);
  return box;
}
