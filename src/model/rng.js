/**
 * Counter-based random numbers: every draw is a pure function of
 * (seedKey, nodeKey, sampleIndex), so results are identical on any machine, thread count or
 * evaluation order, and a node's samples never depend on which other nodes were recomputed.
 *
 * seedKey is derived from the graph lineage id and the seed (stable across value edits, which
 * gives common random numbers: moving a slider never re-rolls the dice).
 * No DOM.
 * @module model/rng
 */
import { fnv1a } from '../core/ids.js';
import { phiInv, phi } from './distributions.js';

/** lowbias32 integer hash. @param {number} x */
export function mix32(x) {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** @param {string} s */
export function keyOf(s) {
  return mix32(fnv1a(s));
}

/**
 * Uniform in the open interval (0, 1) with 53-bit resolution.
 * @param {number} seedKey @param {number} nodeKey @param {number} i
 */
export function u01(seedKey, nodeKey, i) {
  const a = mix32(seedKey ^ mix32(nodeKey ^ mix32(i + 0x9e3779b9)));
  const b = mix32(a ^ 0x85ebca6b ^ mix32(i * 2 + 1));
  return ((a >>> 5) * 67108864 + (b >>> 6) + 0.5) / 9007199254740992;
}

/**
 * Seeded permutation of 0..n-1 (Fisher-Yates driven by u01).
 * @param {number} seedKey @param {number} nodeKey @param {number} n
 */
export function permutation(seedKey, nodeKey, n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const k2 = mix32(nodeKey ^ 0x5bd1e995);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(u01(seedKey, k2, i) * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}

/**
 * Latin hypercube uniforms for one input: one draw per stratum, strata shuffled.
 * @param {number} seedKey @param {number} nodeKey @param {number} n
 * @returns {Float64Array}
 */
export function lhsUniforms(seedKey, nodeKey, n) {
  const p = permutation(seedKey, nodeKey, n);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (p[i] + u01(seedKey, nodeKey, i)) / n;
  return out;
}

/**
 * Plain (unstratified) uniforms.
 * @param {number} seedKey @param {number} nodeKey @param {number} n
 */
export function uniforms(seedKey, nodeKey, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = u01(seedKey, nodeKey, i);
  return out;
}

/**
 * Gaussian-copula uniforms: inputs sharing a latent factor move together.
 * z = sqrt(rho) * Z_factor + sqrt(1 - rho) * Z_own, u = Phi(z).
 * @param {number} seedKey @param {number} nodeKey @param {number} factorKey @param {number} rho @param {number} n
 */
export function copulaUniforms(seedKey, nodeKey, factorKey, rho, n) {
  const own = lhsUniforms(seedKey, nodeKey, n);
  const fac = lhsUniforms(seedKey, factorKey, n);
  const a = Math.sqrt(Math.max(0, Math.min(1, rho)));
  const b = Math.sqrt(1 - a * a);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const z = a * phiInv(fac[i]) + b * phiInv(own[i]);
    out[i] = Math.min(1 - 1e-12, Math.max(1e-12, phi(z)));
  }
  return out;
}
