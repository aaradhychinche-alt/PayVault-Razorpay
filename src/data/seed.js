'use strict';
/**
 * src/data/seed.js
 *
 * Deterministic pseudo-random number generation and Razorpay-style ID helpers.
 * A fixed seed guarantees the same dataset every time the generator runs.
 */

const SEED_BASE = 20260830; // YYYYMMDD — changes intentionally only with new releases

/**
 * Mulberry32 — a fast, seedable 32-bit PRNG.
 * Returns a function that yields floats in [0, 1).
 */
function createPRNG(seed) {
  let s = seed >>> 0;
  return function rand() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Create a fresh PRNG seeded from SEED_BASE.
 * Call this once per generator run so the sequence is always identical.
 */
function makePRNG() {
  return createPRNG(SEED_BASE);
}

// ── Razorpay-style ID generation ─────────────────────────────────────────────

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 14;

/**
 * Generate a Razorpay-style ID: prefix + '_' + 14 alphanumeric chars.
 * @param {string} prefix  e.g. 'order', 'pay', 'rfnd', 'setl', 'adj'
 * @param {Function} rand  PRNG function (must be passed in for reproducibility)
 */
function makeId(prefix, rand) {
  let suffix = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    suffix += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
  }
  return `${prefix}_${suffix}`;
}

/**
 * Generate a Razorpay-style UTR string.
 * Real format: <unix_timestamp><6_alphanumeric>
 */
function makeUTR(ts, rand) {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let tail = '';
  for (let i = 0; i < 6; i++) tail += alpha[Math.floor(rand() * alpha.length)];
  return `${ts}${tail}`;
}

/**
 * Return a random integer in [min, max] inclusive.
 */
function randInt(min, max, rand) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

/**
 * Pick a random element from an array.
 */
function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

/**
 * Pick from an array using cumulative weights.
 * weights must sum to 1.
 */
function pickWeighted(arr, weights, rand) {
  const r = rand();
  let cum = 0;
  for (let i = 0; i < arr.length; i++) {
    cum += weights[i];
    if (r <= cum) return arr[i];
  }
  return arr[arr.length - 1];
}

/**
 * Generate a simple sequential local ID (not a Razorpay ID).
 */
function makeLocalId(prefix, seq) {
  return `${prefix}_${String(seq).padStart(6, '0')}`;
}

module.exports = {
  SEED_BASE,
  createPRNG,
  makePRNG,
  makeId,
  makeUTR,
  randInt,
  pick,
  pickWeighted,
  makeLocalId,
};
