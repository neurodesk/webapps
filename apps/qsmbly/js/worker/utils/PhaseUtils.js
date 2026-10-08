/**
 * Phase Processing Utilities
 *
 * QSMART's weighted echo fit and the ppm → phase conversion TGV needs. Phase scaling,
 * field mapping and unit conversions are qsm-core's (see the worker).
 */

import { boxFilter3dSeparable } from './FilterUtils.js';

/**
 * Magnitude-weighted echo fitting with R_0 reliability map computation
 * Matches QSMART echofit.m: magnitude-weighted OLS through origin,
 * residual blurring, and adaptive thresholding
 *
 * @param {Float64Array} allUnwrapped - All unwrapped phase data (nEchoes * voxelCount)
 * @param {Array<number[]>} magnitude4d - Magnitude data per echo
 * @param {number[]} echoTimes - Echo times in ms
 * @param {number} nx - X dimension
 * @param {number} ny - Y dimension
 * @param {number} nz - Z dimension
 * @param {number[]} voxelSize - [vsx, vsy, vsz] in mm
 * @param {Uint8Array} mask - Binary mask
 * @param {number} fitThreshold - Fixed threshold (default 40)
 * @param {number|null} fitThreshPercentile - Adaptive percentile (overrides fixed)
 * @returns {Object} { tfs: Float64Array, R_0: Uint8Array }
 */
export function computeWeightedEchoFit(
  allUnwrapped,
  magnitude4d,
  echoTimes,
  nx, ny, nz,
  voxelSize,
  mask,
  fitThreshold = 40,
  fitThreshPercentile = null
) {
  const nEchoes = echoTimes.length;
  const voxelCount = nx * ny * nz;
  const teSec = echoTimes.map(t => t / 1000);

  const tfs = new Float64Array(voxelCount);
  const residual = new Float64Array(voxelCount);

  if (nEchoes <= 1) {
    // Single echo: simple division, R_0 = all ones
    const te = teSec[0];
    const factor = 1 / (2 * Math.PI * te);
    for (let v = 0; v < voxelCount; v++) {
      tfs[v] = mask[v] ? allUnwrapped[v] * factor : 0;
    }
    return { tfs, R_0: new Uint8Array(voxelCount).fill(1) };
  }

  // Multi-echo: magnitude-weighted OLS through origin
  // Model: phase_rad = slope * TE_sec
  // Weighted: slope = Σ(mag * phase * TE) / Σ(mag * TE²)
  for (let v = 0; v < voxelCount; v++) {
    if (!mask[v]) continue;

    let sumMagPhaseTE = 0;
    let sumMagTESq = 0;

    for (let e = 0; e < nEchoes; e++) {
      const mag = magnitude4d[e][v];
      const phase = allUnwrapped[e * voxelCount + v];
      const te = teSec[e];
      sumMagPhaseTE += mag * phase * te;
      sumMagTESq += mag * te * te;
    }

    // slope in rad/s
    const slope = sumMagPhaseTE / (sumMagTESq + 1e-20);

    // Convert to Hz
    tfs[v] = slope / (2 * Math.PI);

    // Compute magnitude-weighted fitting residual
    let sumMagResidSq = 0;
    let sumMag = 0;
    for (let e = 0; e < nEchoes; e++) {
      const mag = magnitude4d[e][v];
      const phase = allUnwrapped[e * voxelCount + v];
      const predicted = slope * teSec[e];
      const diff = phase - predicted;
      sumMagResidSq += mag * diff * diff;
      sumMag += mag;
    }

    residual[v] = sumMag > 0 ? (sumMagResidSq / sumMag) * nEchoes : 0;
  }

  // Clean residuals
  for (let i = 0; i < voxelCount; i++) {
    if (!isFinite(residual[i])) residual[i] = 0;
  }

  // Blur residuals with 3D box filter
  // Kernel per axis: round(1/voxelSize)*2+1
  const kx = Math.round(1 / voxelSize[0]) * 2 + 1;
  const ky = Math.round(1 / voxelSize[1]) * 2 + 1;
  const kz = Math.round(1 / voxelSize[2]) * 2 + 1;
  const blurredResidual = boxFilter3dSeparable(residual, nx, ny, nz, kx, ky, kz);

  // Compute statistics on blurred residuals within mask
  const nonZeroResiduals = [];
  for (let i = 0; i < voxelCount; i++) {
    if (mask[i] && blurredResidual[i] > 0) nonZeroResiduals.push(blurredResidual[i]);
  }
  nonZeroResiduals.sort((a, b) => a - b);

  if (nonZeroResiduals.length > 0) {
    const minRes = nonZeroResiduals[0];
    const maxRes = nonZeroResiduals[nonZeroResiduals.length - 1];
    const medianRes = nonZeroResiduals[Math.floor(nonZeroResiduals.length / 2)];
    const p90Res = nonZeroResiduals[Math.floor(nonZeroResiduals.length * 0.9)];
    const p99Res = nonZeroResiduals[Math.floor(nonZeroResiduals.length * 0.99)];
    console.log(`[EchoFit] Blurred residual stats: min=${minRes.toFixed(4)}, median=${medianRes.toFixed(4)}, p90=${p90Res.toFixed(4)}, p99=${p99Res.toFixed(4)}, max=${maxRes.toFixed(4)}`);
  }

  // Threshold: fixed or adaptive percentile
  let threshold;
  if (fitThreshPercentile !== null) {
    threshold = nonZeroResiduals.length > 0
      ? nonZeroResiduals[Math.min(Math.floor(nonZeroResiduals.length * fitThreshPercentile / 100), nonZeroResiduals.length - 1)]
      : Infinity;
  } else {
    threshold = fitThreshold;
  }
  console.log(`[EchoFit] Using threshold=${threshold.toFixed(4)} (mode: ${fitThreshPercentile !== null ? 'adaptive p' + fitThreshPercentile : 'fixed'})`);

  // R_0: binary reliability map (only within mask)
  const R_0 = new Uint8Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    if (mask[i] && blurredResidual[i] < threshold) {
      R_0[i] = 1;
    }
  }

  return { tfs, R_0 };
}

/**
 * Convert a B0 field map in ppm to the equivalent phase in radians at one echo time.
 *
 * qsm-core's field-mapping stage returns ppm; TGV takes phase and divides this
 * straight back out. `gyromagneticRatio` must be the same gamma qsm-core's
 * hz_to_ppm used (42.576e6 Hz/T), or the round trip does not close.
 *
 * @param {Float64Array} b0Ppm - B0 field map in ppm
 * @param {number} fieldStrength - B0 in Tesla
 * @param {number} te - Echo time in SECONDS
 * @param {number} gyromagneticRatio - Proton gamma in Hz/T
 * @returns {Float64Array} Phase in radians
 */
export function ppmFieldToPhase(b0Ppm, fieldStrength, te, gyromagneticRatio) {
  const ppmToHz = (gyromagneticRatio * fieldStrength) / 1e6;
  const scale = 2 * Math.PI * ppmToHz * te;
  const phase = new Float64Array(b0Ppm.length);
  for (let i = 0; i < b0Ppm.length; i++) {
    phase[i] = b0Ppm[i] * scale;
  }
  return phase;
}
