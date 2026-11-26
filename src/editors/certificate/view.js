/**
 * Certificate helpers: status labels (never "true"), icons, and the plain-text certificate.
 * @module editors/certificate/view
 */

/** Display labels for ladder and item statuses. */
export const STATUS_LABEL = {
  pass: 'pass',
  fail: 'fail',
  na: 'n/a',
  not_proven: 'not proven',
  proven: 'proven',
  statistical: 'statistical',
  judgment: 'judgment',
  warn: 'warning',
};

/** @param {string} status */
export function ladderIcon(status) {
  switch (status) {
    case 'pass': return 'pass-filled';
    case 'proven': return 'verified-filled';
    case 'fail': return 'error';
    case 'not_proven': return 'warning';
    case 'statistical': return 'pulse';
    case 'judgment': return 'person';
    default: return 'circle-large-outline';
  }
}

/**
 * Plain-text certificate in the format of the specification.
 * @param {any} cert
 */
export function certificateText(cert) {
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  const pad = (s, w) => String(s).padEnd(w);
  const lpad = (s, w) => String(s).padStart(w);
  const claims = (list) => {
    const by = {};
    for (const c of list) (by[c.tool] = by[c.tool] || []).push(c.id);
    return Object.entries(by).map(([t, ids]) => `${t}: ${ids.join(', ')}`).join(' · ');
  };
  const est = cert.estimators.map((e) => `${e.name}, calibration error ${e.calibrationError} on backtests`).join('; ');
  const lines = [
    `certificate  answer ${cert.answerId}   graph ${cert.graphVersion} (b3:${cert.graphHash.slice(0, 4)}…)   engine ${cert.engineVersion}   seed ${cert.seed}`,
    `  ${pad('computed', 12)} ${lpad(n(cert.counts.computed), 5)} metrics   deterministic`,
    `  ${pad('observed', 12)} ${lpad(n(cert.counts.observed), 5)} metrics   ${cert.sources.matched}/${cert.sources.total} sources matched`,
    `  ${pad('estimated', 12)} ${lpad(n(cert.counts.estimated), 5)} metrics   ${est}`,
    `  ${pad('input', 12)} ${lpad(n(cert.counts.input), 5)} metrics   user`,
    `  ${pad('proven', 12)} ${lpad(n(cert.proven.length), 5)} claims    ${claims(cert.proven)}`,
    `  ${pad('not proven', 12)} ${lpad(n(cert.notProven.length), 5)} claims    ${claims(cert.notProven)}`,
    `  ${pad('failed', 12)} ${lpad(n(cert.failed.length), 5)} checks`,
    `  ${pad('top drivers (Sobol)', 29)}${cert.topDrivers.map((d) => `${d.name} ${d.sobol.toFixed(2)}`).join(' · ')}`,
    `  ${pad('not checked', 29)}${cert.notChecked.join('; ')}`,
    '',
    '  ladder',
    ...cert.ladder.map((l) => `  ${l.level}  ${pad(l.name, 26)} ${pad(STATUS_LABEL[l.status] || l.status, 12)} ${l.detail}`),
    '',
    '  Verified means the conclusions follow from the graph. Whether the graph matches reality is measured, not proven.',
  ];
  return lines.join('\n');
}
