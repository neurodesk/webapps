/**
 * Phase Processing Utilities
 *
 * Pure functions for phase data manipulation, B0 computation,
 * and weighted echo fitting.
 */

/**
 * Scale phase to [-π, +π] range
 *
 * @param {Float64Array|Float32Array} phase - Input phase data
 * @returns {Float64Array} Scaled phase in radians
 */
export function scalePhase(phase) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < phase.length; i++) {
    if (phase[i] < min) min = phase[i];
    if (phase[i] > max) max = phase[i];
  }

  const range = max - min;
  const pi = Math.PI;

  // Check if phase needs scaling
  if (range > 2 * pi * 1.1 || max > pi * 1.5 || min < -pi * 1.5) {
    // Linear scale from [min, max] to [-π, +π]
    const scaled = new Float64Array(phase.length);
    for (let i = 0; i < phase.length; i++) {
      scaled[i] = (phase[i] - min) / range * 2 * pi - pi;
    }
    return scaled;
  }

  // Wrap to ensure exactly [-π, +π]
  const wrapped = new Float64Array(phase.length);
  for (let i = 0; i < phase.length; i++) {
    wrapped[i] = Math.atan2(Math.sin(phase[i]), Math.cos(phase[i]));
  }
  return wrapped;
}

/**
 * Compute B0 fieldmap from unwrapped phase
 *
 * @param {Float64Array} unwrappedPhase - Unwrapped phase data (interleaved for multi-echo)
 * @param {number[]} echoTimes - Echo times in milliseconds
 * @param {number} nx - X dimension
 * @param {number} ny - Y dimension
 * @param {number} nz - Z dimension
 * @param {string} method - 'ols' (through origin) or 'ols_offset' (estimates phase offset)
 * @returns {Float64Array} B0 fieldmap in Hz
 */
export function computeB0FromUnwrapped(unwrappedPhase, echoTimes, nx, ny, nz, method = 'ols') {
  const nEchoes = echoTimes.length;
  const voxelCount = nx * ny * nz;

  // Convert echo times from ms to seconds
  const teSec = echoTimes.map(t => t / 1000);

  if (nEchoes === 1) {
    // Single echo: B0 = phase / (2π * TE)
    const b0 = new Float64Array(voxelCount);
    const factor = 1 / (2 * Math.PI * teSec[0]);
    for (let i = 0; i < voxelCount; i++) {
      b0[i] = unwrappedPhase[i] * factor;
    }
    return b0;
  }

  const b0 = new Float64Array(voxelCount);

  if (method === 'ols_offset') {
    // OLS with phase offset estimation (matching QSM.jl _multi_echo_linear_fit! with α)
    // Model: phase = α + β * TE
    // Solve using centered data to avoid numerical issues

    // Compute mean TE
    let teMean = 0;
    for (let e = 0; e < nEchoes; e++) {
      teMean += teSec[e];
    }
    teMean /= nEchoes;

    // Compute centered TE and sum of squared centered TEs
    const teCentered = teSec.map(t => t - teMean);
    let sumTeCenteredSq = 0;
    for (let e = 0; e < nEchoes; e++) {
      sumTeCenteredSq += teCentered[e] * teCentered[e];
    }

    for (let v = 0; v < voxelCount; v++) {
      // Compute mean phase for this voxel
      let phaseMean = 0;
      for (let e = 0; e < nEchoes; e++) {
        phaseMean += unwrappedPhase[e * voxelCount + v];
      }
      phaseMean /= nEchoes;

      // Compute slope β = Σ((TE - TE_mean) * (phase - phase_mean)) / Σ((TE - TE_mean)²)
      let sumTeCenteredPhase = 0;
      for (let e = 0; e < nEchoes; e++) {
        const phaseIdx = e * voxelCount + v;
        sumTeCenteredPhase += teCentered[e] * (unwrappedPhase[phaseIdx] - phaseMean);
      }

      const b0RadPerSec = sumTeCenteredPhase / (sumTeCenteredSq + 1e-10);
      b0[v] = b0RadPerSec / (2 * Math.PI);
    }
  } else {
    // Simple OLS through origin (default, matching QSM.jl _multi_echo_linear_fit! without α)
    // Model: phase = β * TE (assumes zero phase at TE=0)
    // Slope: β = Σ(TE * phase) / Σ(TE²)

    // Precompute sum of TE² (same for all voxels)
    let sumTeSq = 0;
    for (let e = 0; e < nEchoes; e++) {
      sumTeSq += teSec[e] * teSec[e];
    }

    for (let v = 0; v < voxelCount; v++) {
      let sumTePhase = 0;

      for (let e = 0; e < nEchoes; e++) {
        const phaseIdx = e * voxelCount + v;
        sumTePhase += teSec[e] * unwrappedPhase[phaseIdx];
      }

      const b0RadPerSec = sumTePhase / (sumTeSq + 1e-10);
      b0[v] = b0RadPerSec / (2 * Math.PI);
    }
  }

  return b0;
}

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
 * @param {Function} boxFilter3dFn - Box filter function to use
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
  fitThreshPercentile = null,
  boxFilter3dFn = null
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

  let blurredResidual;
  if (boxFilter3dFn) {
    blurredResidual = boxFilter3dFn(residual, nx, ny, nz, kx, ky, kz);
  } else {
    // Fallback: no blurring
    blurredResidual = residual;
  }

  // Compute statistics on blurred residuals within mask
  const nonZeroResiduals = [];
  for (let i = 0; i < voxelCount; i++) {
    if (mask[i] && blurredResidual[i] > 0) nonZeroResiduals.push(blurredResidual[i]);
  }
  nonZeroResiduals.sort((a, b) => a - b);

  // Threshold: fixed or adaptive percentile
  let threshold;
  if (fitThreshPercentile !== null) {
    threshold = nonZeroResiduals.length > 0
      ? nonZeroResiduals[Math.min(Math.floor(nonZeroResiduals.length * fitThreshPercentile / 100), nonZeroResiduals.length - 1)]
      : Infinity;
  } else {
    threshold = fitThreshold;
  }

  // R_0: binary reliability map (only within mask)
  const R_0 = new Uint8Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    if (mask[i] && blurredResidual[i] < threshold) {
      R_0[i] = 1;
    }
  }

  return { tfs, R_0 };
}

// Make available globally for non-module contexts (workers)
if (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined') {
  self.PhaseUtils = { scalePhase, computeB0FromUnwrapped, computeWeightedEchoFit };
} else if (typeof window !== 'undefined') {
  window.PhaseUtils = { scalePhase, computeB0FromUnwrapped, computeWeightedEchoFit };
}
