/**
 * Stable ids and short hashes.
 *
 * Hashes are FNV-1a based stand-ins. They are formatted like the production BLAKE3 content
 * ids ("b3:9c0e…") so the UI matches the spec, but they are NOT cryptographic. The real engine
 * replaces them with BLAKE3.
 * @module core/ids
 */

let counter = 0;
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 32-bit FNV-1a. @param {string} str @param {number} [seed] */
export function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 64-bit-ish hash as 16 hex chars (two independent FNV lanes + avalanche).
 * @param {string} str
 */
export function hash64(str) {
  const a = avalanche(fnv1a(str, 0x811c9dc5));
  const b = avalanche(fnv1a(str, 0x01000193 ^ 0x9e3779b9));
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** murmur3 fmix32. @param {number} h */
export function avalanche(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Short display form, e.g. "b3:9c0e". @param {string} hex @param {number} [len] */
export function shortHash(hex, len = 4) {
  return `b3:${String(hex).slice(0, len)}`;
}

/** Stable hash of a JSON-able value (key order normalized). @param {any} value */
export function hashValue(value) {
  return hash64(stableStringify(value));
}

/** @param {any} value */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Unique (per session) id with a prefix: uid('ar') -> 'ar_k3f9a1'.
 * @param {string} prefix
 */
export function uid(prefix = 'id') {
  counter = (counter + 1) % 1e9;
  const rnd = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${prefix}_${(Date.now() % 1e6).toString(36)}${counter.toString(36)}${rnd}`;
}

/**
 * Deterministic short id from a seed string (stable across reloads): 'sc_7Q2f'.
 * @param {string} prefix @param {string} seed @param {number} [len]
 */
export function stableId(prefix, seed, len = 4) {
  let h = avalanche(fnv1a(seed));
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHA[h % ALPHA.length];
    h = avalanche(h + i + 1);
  }
  return `${prefix}_${out}`;
}

/** Slug for scope ids: 'Crumb & Co' -> 'crumb_co'. @param {string} name */
export function slug(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}
