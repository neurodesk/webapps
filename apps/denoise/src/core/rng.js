// Deterministic pseudo-random number generator (Mulberry32) and Gaussian sampling
// so self-supervised training, feature subsampling and validation splits are reproducible
// byte for byte across Node and browser workers.

/**
 * Creates a deterministic uniform PRNG on [0, 1) from a 32-bit integer seed.
 * @param {number} [seed=42]
 * @returns {() => number}
 */
export function createRng(seed = 42) {
  let state = (seed | 0) >>> 0;
  return function nextUniform() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a standard normal N(0, 1) generator using Box-Muller.
 * @param {() => number} rng
 * @returns {() => number}
 */
export function createNormalRng(rng) {
  let spare = null;
  return function nextNormal() {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    while (u <= 1e-12) u = rng();
    v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = mag * Math.sin(angle);
    return mag * Math.cos(angle);
  };
}

/**
 * In-place Fisher-Yates shuffle of a typed or plain array using the given PRNG.
 * @template {ArrayLike<number>} T
 * @param {T} array
 * @param {() => number} rng
 * @returns {T}
 */
export function shuffleInPlace(array, rng) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}
