/**
 * Mask Processing Utilities
 *
 * Pure functions for mask creation and seed point finding.
 */

/**
 * Create threshold-based mask from magnitude data
 *
 * @param {Float64Array|Float32Array} magnitude - Magnitude data
 * @param {number} thresholdFraction - Threshold as fraction of max (0-1)
 * @returns {Uint8Array} Binary mask
 */
export function createThresholdMask(magnitude, thresholdFraction) {
  let maxVal = 0;
  for (let i = 0; i < magnitude.length; i++) {
    if (magnitude[i] > maxVal) maxVal = magnitude[i];
  }

  const threshold = maxVal * thresholdFraction;
  const mask = new Uint8Array(magnitude.length);
  for (let i = 0; i < magnitude.length; i++) {
    mask[i] = magnitude[i] > threshold ? 1 : 0;
  }
  return mask;
}

/**
 * Find seed point (center of mass of mask)
 *
 * @param {Uint8Array} mask - Binary mask
 * @param {number} nx - X dimension
 * @param {number} ny - Y dimension
 * @param {number} nz - Z dimension
 * @returns {number[]} [x, y, z] coordinates of seed point
 */
export function findSeedPoint(mask, nx, ny, nz) {
  let sumX = 0, sumY = 0, sumZ = 0, count = 0;

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const idx = i * ny * nz + j * nz + k;
        if (mask[idx]) {
          sumX += i;
          sumY += j;
          sumZ += k;
          count++;
        }
      }
    }
  }

  if (count === 0) {
    return [Math.floor(nx / 2), Math.floor(ny / 2), Math.floor(nz / 2)];
  }

  return [
    Math.floor(sumX / count),
    Math.floor(sumY / count),
    Math.floor(sumZ / count)
  ];
}

// Make available globally for non-module contexts (workers)
if (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined') {
  self.MaskUtils = { createThresholdMask, findSeedPoint };
} else if (typeof window !== 'undefined') {
  window.MaskUtils = { createThresholdMask, findSeedPoint };
}
