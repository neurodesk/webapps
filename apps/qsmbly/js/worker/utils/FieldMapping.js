/**
 * Field Mapping Module
 *
 * Multi-echo field mapping: phase offset removal → bipolar correction →
 * phase unwrapping → B0 estimation.
 *
 * Shared by standard, TGV, and field map pipelines.
 */

import { computeB0FromUnwrapped } from './PhaseUtils.js';
import { findSeedPoint } from './MaskUtils.js';

/**
 * Compute a B0 field map from multi-echo phase + magnitude data.
 *
 * @param {Object} wasmModule - Loaded WASM module
 * @param {Object} params
 * @param {Array<Float64Array>} params.phase4d - Per-echo phase arrays (wrapped, radians)
 * @param {Array<Float64Array>} params.magnitude4d - Per-echo magnitude arrays
 * @param {number[]} params.echoTimes - Echo times in ms
 * @param {Uint8Array} params.mask - Binary mask
 * @param {number[]} params.dims - [nx, ny, nz]
 * @param {number[]} params.voxelSize - [vsx, vsy, vsz] in mm
 * @param {Float64Array} params.affine - 4x4 affine matrix (16 elements)
 * @param {Object} params.settings - Pipeline settings
 * @param {Function} params.postLog - Log function
 * @param {Function} params.postProgress - Progress function
 * @param {Function} params.sendStageData - Stage data sender
 * @returns {{ b0Fieldmap: Float64Array, phaseOffset: Float64Array|null }}
 */
export function computeFieldMap(wasmModule, {
  phase4d, magnitude4d, echoTimes, mask,
  dims, voxelSize, affine, settings,
  postLog, postProgress, sendStageData,
}) {
  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const nEchoes = echoTimes.length;
  const voxelCount = nx * ny * nz;

  const unwrapping_algorithm = settings?.unwrapping_algorithm || 'romeo';
  const phase_offset_method = settings?.phase_offset_method || 'mcpc3ds';
  const b0_estimation = settings?.b0_estimation || 'weighted_avg';
  const mcpc3dsSettings = settings?.mcpc3ds || { sigma: [10, 10, 5] };
  const b0_weight_type = settings?.b0_weight_type || 'phase_snr';
  const linearFitSettings = settings?.linearFit || { estimate_offset: true };
  const doBipolar = settings?.bipolar_correction === true && nEchoes >= 3;
  const romeoIndividual = settings?.romeo?.individual ?? true;
  const romeoCorrectGlobal = settings?.romeo?.correct_global ?? true;

  let b0Fieldmap;
  let phaseOffset = null;

  if (nEchoes > 1 && phase_offset_method === 'mcpc3ds') {
    // ---- Phase offset removal + unwrap + B0 (single WASM call) ----
    postProgress(0.15, 'Field mapping...');
    const parts = [`Phase offset removal (sigma=[${mcpc3dsSettings.sigma.join(',')}])`];
    if (doBipolar) parts[0] += ', bipolar correction';
    postLog(parts[0]);

    const { phasesFlat, magsFlat } = flattenEchoes(phase4d, magnitude4d, nEchoes, voxelCount);

    const result = wasmModule.mcpc3ds_b0_pipeline_wasm(
      phasesFlat, magsFlat,
      new Float64Array(echoTimes),
      mask,
      nx, ny, nz, vsx, vsy, vsz,
      mcpc3dsSettings.sigma[0], mcpc3dsSettings.sigma[1], mcpc3dsSettings.sigma[2],
      b0_weight_type, doBipolar, unwrapping_algorithm,
      romeoIndividual, romeoCorrectGlobal
    );

    b0Fieldmap = new Float64Array(result.slice(0, voxelCount));
    phaseOffset = new Float64Array(result.slice(voxelCount, 2 * voxelCount));

    if (sendStageData) {
      sendStageData('phaseOffset', phaseOffset, dims, voxelSize, affine, 'Phase Offset (rad)', false);
    }

    const unwrapLabel = unwrapping_algorithm === 'laplacian'
      ? 'Laplacian (per-echo + echo alignment)'
      : `ROMEO (${romeoIndividual ? 'individual' : 'template'}, correct_global=${romeoCorrectGlobal})`;
    postLog(`Phase unwrapping: ${unwrapLabel}`);
    postLog(`B0 estimation: weighted averaging (weight=${b0_weight_type})`);

  } else {
    // ---- Direct unwrapping (no phase offset removal) ----
    b0Fieldmap = computeFieldMapDirect(wasmModule, {
      phase4d, magnitude4d, echoTimes, mask,
      dims, voxelSize, settings,
      postLog, postProgress,
    });
  }

  // Apply mask and compute range
  for (let i = 0; i < voxelCount; i++) {
    if (!mask[i]) b0Fieldmap[i] = 0;
  }

  let b0Min = Infinity, b0Max = -Infinity;
  for (let i = 0; i < voxelCount; i++) {
    if (mask[i]) {
      if (b0Fieldmap[i] < b0Min) b0Min = b0Fieldmap[i];
      if (b0Fieldmap[i] > b0Max) b0Max = b0Fieldmap[i];
    }
  }
  postLog(`B0 range: [${b0Min.toFixed(1)}, ${b0Max.toFixed(1)}] Hz`);

  postProgress(0.40, 'Field mapping complete');
  return { b0Fieldmap, phaseOffset };
}

/**
 * Direct field mapping without phase offset removal.
 * Per-echo unwrapping → echo alignment → B0 estimation.
 */
function computeFieldMapDirect(wasmModule, {
  phase4d, magnitude4d, echoTimes, mask,
  dims, voxelSize, settings,
  postLog, postProgress,
}) {
  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const nEchoes = echoTimes.length;
  const voxelCount = nx * ny * nz;

  const unwrapping_algorithm = settings?.unwrapping_algorithm || 'romeo';
  const b0_estimation = settings?.b0_estimation || 'weighted_avg';
  const linearFitSettings = settings?.linearFit || { estimate_offset: true };

  // Unwrap first echo
  const phase1 = new Float64Array(phase4d[0]);
  let unwrappedPhase;

  if (unwrapping_algorithm === 'laplacian') {
    postProgress(0.20, 'Phase unwrapping (Laplacian)...');
    postLog('Phase unwrapping: Laplacian');
    unwrappedPhase = new Float64Array(wasmModule.laplacian_unwrap_wasm(
      phase1, mask, nx, ny, nz, vsx, vsy, vsz
    ));
  } else {
    postProgress(0.20, 'Phase unwrapping (ROMEO)...');
    postLog('Phase unwrapping: ROMEO');
    const mag1 = new Float64Array(magnitude4d[0]);
    const phase2 = nEchoes > 1 ? new Float64Array(phase4d[1]) : new Float64Array(0);
    const te1 = echoTimes[0];
    const te2 = nEchoes > 1 ? echoTimes[1] : 0;

    const weights = wasmModule.calculate_weights_romeo_wasm(
      phase1, mag1, phase2, te1, te2, mask, nx, ny, nz
    );
    const [seedI, seedJ, seedK] = findSeedPoint(mask, nx, ny, nz);
    unwrappedPhase = new Float64Array(phase1);
    const workMask = new Uint8Array(mask);
    wasmModule.grow_region_unwrap_wasm(
      unwrappedPhase, weights, workMask,
      nx, ny, nz, seedI, seedJ, seedK
    );
  }

  // Multi-echo: unwrap remaining echoes and compute B0
  if (nEchoes > 1) {
    const allUnwrapped = new Float64Array(voxelCount * nEchoes);
    allUnwrapped.set(unwrappedPhase, 0);

    postLog(`Unwrapping ${nEchoes} echoes...`);
    const [seedI, seedJ, seedK] = findSeedPoint(mask, nx, ny, nz);

    for (let e = 1; e < nEchoes; e++) {
      postProgress(0.25 + (e / nEchoes) * 0.05, `Unwrapping echo ${e + 1}/${nEchoes}...`);
      if (unwrapping_algorithm === 'laplacian') {
        const phaseE = new Float64Array(phase4d[e]);
        const unwrappedE = new Float64Array(wasmModule.laplacian_unwrap_wasm(
          phaseE, mask, nx, ny, nz, vsx, vsy, vsz
        ));
        allUnwrapped.set(unwrappedE, e * voxelCount);
      } else {
        const magE = new Float64Array(magnitude4d[e]);
        const phaseE = new Float64Array(phase4d[e]);
        const phaseNext = (e + 1 < nEchoes) ? new Float64Array(phase4d[e + 1]) : new Float64Array(0);
        const teE = echoTimes[e];
        const teNext = (e + 1 < nEchoes) ? echoTimes[e + 1] : 0;
        const weightsE = wasmModule.calculate_weights_romeo_wasm(
          phaseE, magE, phaseNext, teE, teNext, mask, nx, ny, nz
        );
        const unwrappedE = new Float64Array(phaseE);
        const workMaskE = new Uint8Array(mask);
        wasmModule.grow_region_unwrap_wasm(
          unwrappedE, weightsE, workMaskE,
          nx, ny, nz, seedI, seedJ, seedK
        );
        allUnwrapped.set(unwrappedE, e * voxelCount);
      }
    }

    // Inter-echo 2π alignment (mean-based)
    for (let e = 1; e < nEchoes; e++) {
      const teRatio = echoTimes[e] / echoTimes[0];
      let sumDiff = 0, count = 0;
      for (let i = 0; i < voxelCount; i++) {
        if (mask[i]) {
          sumDiff += allUnwrapped[e * voxelCount + i] - unwrappedPhase[i] * teRatio;
          count++;
        }
      }
      const correction = Math.round((sumDiff / count) / (2 * Math.PI)) * (2 * Math.PI);
      if (Math.abs(correction) > 0.1) {
        for (let i = 0; i < voxelCount; i++) {
          if (mask[i]) allUnwrapped[e * voxelCount + i] -= correction;
        }
      }
    }

    // B0 estimation
    postProgress(0.35, 'B0 estimation...');
    if (b0_estimation === 'linear_fit') {
      postLog(`B0 estimation: linear fit (offset=${linearFitSettings.estimate_offset})`);
      const magsFlat = new Float64Array(nEchoes * voxelCount);
      for (let e = 0; e < nEchoes; e++) magsFlat.set(magnitude4d[e], e * voxelCount);
      const tesSec = echoTimes.map(te => te / 1000);
      const result = wasmModule.multi_echo_linear_fit_wasm(
        allUnwrapped, magsFlat, new Float64Array(tesSec), mask,
        voxelCount, linearFitSettings.estimate_offset, 0
      );
      return new Float64Array(result.slice(0, voxelCount));
    } else {
      postLog('B0 estimation: weighted averaging');
      return computeB0FromUnwrapped(allUnwrapped, echoTimes, nx, ny, nz, 'ols_offset');
    }
  } else {
    // Single echo: phase / (2π * TE)
    const te = echoTimes[0] / 1000;
    const b0 = new Float64Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      if (mask[i]) b0[i] = unwrappedPhase[i] / (2 * Math.PI * te);
    }
    return b0;
  }
}

/**
 * Flatten per-echo arrays into contiguous buffers for WASM.
 */
function flattenEchoes(phase4d, magnitude4d, nEchoes, voxelCount) {
  const phasesFlat = new Float64Array(nEchoes * voxelCount);
  const magsFlat = new Float64Array(nEchoes * voxelCount);
  for (let e = 0; e < nEchoes; e++) {
    phasesFlat.set(phase4d[e], e * voxelCount);
    magsFlat.set(magnitude4d[e], e * voxelCount);
  }
  return { phasesFlat, magsFlat };
}
