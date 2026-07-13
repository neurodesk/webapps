/**
 * Preprocessing utilities for 3D medical image volumes.
 * Matches the preprocessing in prostate/scripts/inference/consensus_inference.py
 */

/**
 * Calculate padded dimensions (each dimension rounded up to nearest multiple of factor)
 * @param {number[]} dims - [nx, ny, nz]
 * @param {number} factor - Padding factor (default 32)
 * @returns {number[]} Padded dimensions
 */
export function findPaddedDims(dims, factor = 32) {
  return dims.map(d => Math.ceil(d / factor) * factor);
}

/**
 * Pad 3D volume with zeros to target dimensions (centered).
 * Matches pad_or_crop_numpy() from consensus_inference.py
 * @param {Float32Array} data - Source volume data (flat, row-major)
 * @param {number[]} srcDims - [nx, ny, nz] source dimensions
 * @param {number[]} tgtDims - [nx, ny, nz] target dimensions
 * @returns {Float32Array} Padded volume
 */
export function padVolume(data, srcDims, tgtDims) {
  const [sx, sy, sz] = srcDims;
  const [tx, ty, tz] = tgtDims;
  const result = new Float32Array(tx * ty * tz);

  const ox = Math.floor((tx - sx) / 2);
  const oy = Math.floor((ty - sy) / 2);
  const oz = Math.floor((tz - sz) / 2);

  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      const srcOffset = z * sy * sx + y * sx;
      const tgtOffset = (z + oz) * ty * tx + (y + oy) * tx + ox;
      result.set(data.subarray(srcOffset, srcOffset + sx), tgtOffset);
    }
  }
  return result;
}

/**
 * Crop padded volume back to original dimensions (inverse of padVolume).
 * @param {Float32Array} data - Padded volume
 * @param {number[]} paddedDims - [nx, ny, nz] padded dimensions
 * @param {number[]} origDims - [nx, ny, nz] original dimensions
 * @returns {Float32Array} Cropped volume
 */
export function cropVolume(data, paddedDims, origDims) {
  const [px, py, pz] = paddedDims;
  const [ox, oy, oz] = origDims;
  const result = new Float32Array(ox * oy * oz);

  const offX = Math.floor((px - ox) / 2);
  const offY = Math.floor((py - oy) / 2);
  const offZ = Math.floor((pz - oz) / 2);

  for (let z = 0; z < oz; z++) {
    for (let y = 0; y < oy; y++) {
      const srcOffset = (z + offZ) * py * px + (y + offY) * px + offX;
      const tgtOffset = z * oy * ox + y * ox;
      result.set(data.subarray(srcOffset, srcOffset + ox), tgtOffset);
    }
  }
  return result;
}

/**
 * Z-score normalization (mean=0, std=1 per volume).
 * Matches TorchIO ZNormalization transform.
 * @param {Float32Array} data - Volume data
 * @returns {Float32Array} Normalized volume
 */
export function zScoreNormalize(data) {
  const n = data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - mean;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / n) || 1;

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = (data[i] - mean) / std;
  }
  return result;
}
