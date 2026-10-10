import { managedRuntime } from './runtime.js';
import { prepareRasWorkerInput } from '@neurodesk/webapp-components/worker';
import { createNiftiFromData } from '@neurodesk/webapp-components/file-io/nifti';
import {
  keepLargestComponentAndFill,
  removeSmallComponents,
} from '@neurodesk/webapp-components/volume';
import {
  inverseOrient,
  resampleLabelsNearest,
  resampleVolume,
} from '@neurodesk/webapp-components/volume';
import { zScoreNormalize } from '@neurodesk/webapp-components/volume';

import * as n4Policy from './n4-shrink-policy.js';

const MAX_PROCESSING_VOXELS = 100 * 1024 * 1024;

function padToPatchMultiple(data, dims, patchSize) {
  const [nx, ny, nz] = dims;
  const pad = (d, p) => (d > p && d % p !== 0 ? Math.ceil(d / p) * p : d < p ? p : d);
  const nnx = pad(nx, patchSize);
  const nny = pad(ny, patchSize);
  const nnz = pad(nz, patchSize);

  if (nnx === nx && nny === ny && nnz === nz) {
    return { data, dims: [nx, ny, nz] };
  }

  // Nearest-neighbor resize matching scipy.ndimage.zoom(order=0, mode='nearest')
  // scipy uses half-pixel center mapping: source = floor((output + 0.5) * inputSize / outputSize)
  const result = new Float32Array(nnx * nny * nnz);

  for (let z = 0; z < nnz; z++) {
    const sz = Math.min(Math.max(0, Math.floor(((z + 0.5) * nz) / nnz)), nz - 1);
    for (let y = 0; y < nny; y++) {
      const sy = Math.min(Math.max(0, Math.floor(((y + 0.5) * ny) / nny)), ny - 1);
      for (let x = 0; x < nnx; x++) {
        const sx = Math.min(Math.max(0, Math.floor(((x + 0.5) * nx) / nnx)), nx - 1);
        result[x + y * nnx + z * nnx * nny] = data[sx + sy * nx + sz * nx * ny];
      }
    }
  }

  return { data: result, dims: [nnx, nny, nnz] };
}

// ==================== 3D Sliding Window ====================

function computeGaussianWeightMap3D(dim0, dim1, dim2, sigma) {
  if (!sigma) sigma = Math.min(dim0, dim1, dim2) / 8;
  const weights = new Float32Array(dim0 * dim1 * dim2);
  const c0 = (dim0 - 1) / 2;
  const c1 = (dim1 - 1) / 2;
  const c2 = (dim2 - 1) / 2;
  const s2 = 2 * sigma * sigma;
  for (let i0 = 0; i0 < dim0; i0++) {
    const d0 = i0 - c0;
    for (let i1 = 0; i1 < dim1; i1++) {
      const d1 = i1 - c1;
      for (let i2 = 0; i2 < dim2; i2++) {
        const d2 = i2 - c2;
        weights[i0 * dim1 * dim2 + i1 * dim2 + i2] = Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2) / s2);
      }
    }
  }
  return weights;
}

function computePatchPositions3D(volumeDims, patchDims, overlap) {
  const positions = [];
  const seen = new Set();

  const steps = patchDims.map((p) => Math.max(1, Math.round(p * (1 - overlap))));

  const counts = volumeDims.map((vd, i) => {
    if (vd <= patchDims[i]) return 1;
    return Math.max(1, Math.ceil((vd - patchDims[i]) / steps[i]) + 1);
  });

  for (let iz = 0; iz < counts[2]; iz++) {
    let z = iz * steps[2];
    if (z + patchDims[2] > volumeDims[2]) z = Math.max(0, volumeDims[2] - patchDims[2]);

    for (let iy = 0; iy < counts[1]; iy++) {
      let y = iy * steps[1];
      if (y + patchDims[1] > volumeDims[1]) y = Math.max(0, volumeDims[1] - patchDims[1]);

      for (let ix = 0; ix < counts[0]; ix++) {
        let x = ix * steps[0];
        if (x + patchDims[0] > volumeDims[0]) x = Math.max(0, volumeDims[0] - patchDims[0]);

        const key = `${x},${y},${z}`;
        if (!seen.has(key)) {
          seen.add(key);
          positions.push([x, y, z]);
        }
      }
    }
  }

  return positions;
}

function extractPatch3D(volume, volumeDims, position, patchDims) {
  const [v0, v1, v2] = volumeDims;
  const [p0, p1, p2] = patchDims;
  const [o0, o1, o2] = position;
  const patch = new Float32Array(p0 * p1 * p2);

  for (let i0 = 0; i0 < p0; i0++) {
    const g0 = o0 + i0;
    if (g0 < 0 || g0 >= v0) continue;
    for (let i1 = 0; i1 < p1; i1++) {
      const g1 = o1 + i1;
      if (g1 < 0 || g1 >= v1) continue;
      for (let i2 = 0; i2 < p2; i2++) {
        const g2 = o2 + i2;
        if (g2 < 0 || g2 >= v2) continue;

        const srcIdx = g0 + g1 * v0 + g2 * v0 * v1;
        const dstIdx = i0 * p1 * p2 + i1 * p2 + i2;
        patch[dstIdx] = volume[srcIdx];
      }
    }
  }

  return patch;
}

function accumulatePatch3D(
  probAccum,
  weightAccum,
  volumeDims,
  position,
  output,
  weights,
  patchDims
) {
  const [v0, v1, v2] = volumeDims;
  const [p0, p1, p2] = patchDims;
  const [o0, o1, o2] = position;

  for (let i0 = 0; i0 < p0; i0++) {
    const g0 = o0 + i0;
    if (g0 < 0 || g0 >= v0) continue;
    for (let i1 = 0; i1 < p1; i1++) {
      const g1 = o1 + i1;
      if (g1 < 0 || g1 >= v1) continue;
      for (let i2 = 0; i2 < p2; i2++) {
        const g2 = o2 + i2;
        if (g2 < 0 || g2 >= v2) continue;

        const patchIdx = i0 * p1 * p2 + i1 * p2 + i2;
        const globalIdx = g0 + g1 * v0 + g2 * v0 * v1;
        const w = weights[patchIdx];
        probAccum[globalIdx] += output[patchIdx] * w;
        weightAccum[globalIdx] += w;
      }
    }
  }
}

/** Direct-write patch into output (no weighting). For non-overlapping tiling. */

// ==================== Postprocessing ====================

/**
 * Keep only the largest connected component and fill interior holes.
 * Matches FreeSurfer SynthStrip: connected_component_mask(k=1, fill=True).
 */

// ==================== Inverse Transform ====================

export function createVesselBoostPipeline({
  ort,
  preprocessingWasm,
  parseVolume,
  fetchModel,
  events,
  sessionOptions = {},
  modelBaseUrl = '',
  state: initialState,
  signal,
}) {
  if (!preprocessingWasm)
    throw new Error('Required VesselBoost preprocessing WASM is not initialized');
  const sessions = new Set();
  ort = managedRuntime(ort, sessions);
  let workerState = initialState || {
    headerBytes: null,
    origHeaderBytes: null,
    origDims: null,
    affine: null,
    perm: null,
    flip: null,
    isIdentity: null,
    rasData: null,
    rasDims: null,
    rasSpacing: null,
    nativeRasSpacing: null,
    brainMask: null,
    denoisedData: null,
    // Unmasked segmentation labels in RAS space (before brain mask / CC cleanup)
    segLabelsRAS: null,
    segMinComponentSize: 10,
    // Backups for skip-undo
    preDownsampleData: null,
    preDownsampleDims: null,
    preDownsampleSpacing: null,
    preDownsampleHeaderBytes: null,
    preDownsampleOrigDims: null,
    preDownsampleOrigHeaderBytes: null,
    preDownsamplePerm: null,
    preDownsampleFlip: null,
    preDownsampleIsIdentity: null,
    preN4Data: null,
    preBETMask: null,
    preDenoiseData: null,
  };

  function resetState() {
    workerState = {
      headerBytes: null,
      origHeaderBytes: null,
      origDims: null,
      affine: null,
      perm: null,
      flip: null,
      isIdentity: null,
      rasData: null,
      rasDims: null,
      rasSpacing: null,
      nativeRasSpacing: null,
      brainMask: null,
      denoisedData: null,
      segLabelsRAS: null,
      segMinComponentSize: 10,
      preDownsampleData: null,
      preDownsampleDims: null,
      preDownsampleSpacing: null,
      preDownsampleHeaderBytes: null,
      preDownsampleOrigDims: null,
      preDownsampleOrigHeaderBytes: null,
      preDownsamplePerm: null,
      preDownsampleFlip: null,
      preDownsampleIsIdentity: null,
      preN4Data: null,
      preBETMask: null,
      preDenoiseData: null,
    };
  }

  const {
    complete: postComplete,
    log: postLog,
    progress: postProgress,
    stepComplete: postStepComplete,
    volumeInfo: postVolumeInfo,
  } = events;

  function postStageData(stage, niftiData, description) {
    events.stageData(stage, niftiData, description);
  }

  function postStateArtifact(artifact, payload) {
    events.emit('state-artifact', { artifact, payload });
  }

  function emitN4StateArtifact() {
    const preN4Data = workerState.preN4Data ? new Float32Array(workerState.preN4Data).buffer : null;
    postStateArtifact('n4State', { preN4Data });
  }

  function emitBETStateArtifact() {
    const brainMask = workerState.brainMask ? new Uint8Array(workerState.brainMask).buffer : null;
    const preBETMask = workerState.preBETMask
      ? new Uint8Array(workerState.preBETMask).buffer
      : null;
    postStateArtifact('betState', { brainMask, preBETMask });
  }

  function emitDenoiseStateArtifact() {
    const preDenoiseData = workerState.preDenoiseData
      ? new Float32Array(workerState.preDenoiseData).buffer
      : null;
    postStateArtifact('denoiseState', { preDenoiseData });
  }

  function emitSegmentationStateArtifact() {
    const segLabelsRAS = workerState.segLabelsRAS
      ? new Uint8Array(workerState.segLabelsRAS).buffer
      : null;
    postStateArtifact('segmentationState', {
      segLabelsRAS,
      segMinComponentSize: workerState.segMinComponentSize ?? 10,
    });
  }

  function parseNiftiInput(arrayBuffer) {
    return parseVolume(arrayBuffer);
  }

  // ==================== NIfTI Output ====================

  function createOutputNifti(uint8Data, sourceHeader, dims) {
    return createNiftiFromData(uint8Data, sourceHeader, { dims });
  }

  function createFloat32Nifti(float32Data, sourceHeader, dims, spacing) {
    return createNiftiFromData(float32Data, sourceHeader, {
      dims,
      spacing,
      range: 'auto',
      clampCalMax: false,
    });
  }

  function prepareInputState(inputData, { emitUpdates = false } = {}) {
    if (emitUpdates) {
      postLog('Parsing input volume...');
      postProgress(0.02, 'Reading NIfTI...');
    }
    const prepared = prepareRasWorkerInput(parseNiftiInput(inputData));
    Object.assign(workerState, prepared);
    if (emitUpdates) {
      postLog(
        `Volume: ${prepared.origDims.join('x')}, spacing: ${prepared.rasSpacing
          .map((value) => value.toFixed(3))
          .join('x')}mm`
      );
      postLog(`RAS dims: ${prepared.rasDims.join('x')}`);
    }

    workerState.nativeRasSpacing = [...prepared.rasSpacing];
    workerState.brainMask = null;
    workerState.preBETMask = null;
    workerState.denoisedData = null;
    workerState.preDenoiseData = null;
    workerState.segLabelsRAS = null;
    workerState.segMinComponentSize = 10;
    postVolumeInfo({
      rasDims: [...prepared.rasDims],
      rasSpacing: [...prepared.rasSpacing],
      totalSlices: prepared.rasDims[2],
    });
  }
  function stepLoad(inputData) {
    prepareInputState(inputData, { emitUpdates: true });

    postProgress(1.0, 'Volume loaded');
    postStepComplete('load');
  }

  function restorePreDownsampleState() {
    if (!workerState.preDownsampleData) return false;
    workerState.rasData = workerState.preDownsampleData;
    workerState.rasDims = workerState.preDownsampleDims;
    workerState.rasSpacing = workerState.preDownsampleSpacing;
    workerState.nativeRasSpacing = workerState.preDownsampleSpacing
      ? [...workerState.preDownsampleSpacing]
      : workerState.nativeRasSpacing;
    workerState.headerBytes = workerState.preDownsampleHeaderBytes;
    workerState.origDims = workerState.preDownsampleOrigDims;
    workerState.origHeaderBytes = workerState.preDownsampleOrigHeaderBytes;
    workerState.perm = workerState.preDownsamplePerm;
    workerState.flip = workerState.preDownsampleFlip;
    workerState.isIdentity = workerState.preDownsampleIsIdentity;
    workerState.preDownsampleData = null;
    workerState.preDownsampleDims = null;
    workerState.preDownsampleSpacing = null;
    workerState.preDownsampleHeaderBytes = null;
    workerState.preDownsampleOrigDims = null;
    workerState.preDownsampleOrigHeaderBytes = null;
    workerState.preDownsamplePerm = null;
    workerState.preDownsampleFlip = null;
    workerState.preDownsampleIsIdentity = null;
    return true;
  }

  function stepDownsample(factor) {
    if (restorePreDownsampleState()) {
      postLog('Restored original resolution before applying new downsample factor');
    }

    const srcSpacing = workerState.rasSpacing;
    const tgtSpacing = srcSpacing.map((s) => s * factor);
    const srcDims = workerState.rasDims;

    // Save pre-downsample state for undo
    workerState.preDownsampleData = new Float32Array(workerState.rasData);
    workerState.preDownsampleDims = [...srcDims];
    workerState.preDownsampleSpacing = [...srcSpacing];
    workerState.preDownsampleHeaderBytes = workerState.headerBytes.slice(0);
    workerState.preDownsampleOrigDims = [...workerState.origDims];
    workerState.preDownsampleOrigHeaderBytes = workerState.origHeaderBytes.slice(0);
    workerState.preDownsamplePerm = [...workerState.perm];
    workerState.preDownsampleFlip = [...workerState.flip];
    workerState.preDownsampleIsIdentity = workerState.isIdentity;

    postLog(
      `Downsampling ${factor}x: spacing ${srcSpacing
        .map((v) => v.toFixed(3))
        .join('x')}mm -> ${tgtSpacing.map((v) => v.toFixed(3)).join('x')}mm`
    );
    postProgress(0.3, 'Resampling...');

    const resampled = resampleVolume(workerState.rasData, srcDims, srcSpacing, tgtSpacing);
    workerState.rasData = resampled.data;
    workerState.rasDims = resampled.dims;
    workerState.rasSpacing = resampled.spacing;

    // Update header spacing
    const hdrView = new DataView(workerState.headerBytes);
    hdrView.setFloat32(80, resampled.spacing[0], true);
    hdrView.setFloat32(84, resampled.spacing[1], true);
    hdrView.setFloat32(88, resampled.spacing[2], true);
    // Update header dims
    hdrView.setInt16(42, resampled.dims[0], true);
    hdrView.setInt16(44, resampled.dims[1], true);
    hdrView.setInt16(46, resampled.dims[2], true);

    // Update sform origin to account for new spacing
    const sformCode = hdrView.getInt16(254, true);
    if (sformCode > 0) {
      // Update diagonal elements for new spacing (keep signs)
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const offset = 280 + r * 16 + c * 4;
          const val = hdrView.getFloat32(offset, true);
          if (val !== 0) {
            hdrView.setFloat32(offset, val * factor, true);
          }
        }
      }
    }

    // Update origDims/origHeaderBytes so inverse transforms map back to
    // the downsampled space (which is what the viewer displays).
    // Data is already RAS-oriented, so set identity orientation.
    workerState.origDims = [...resampled.dims];
    workerState.origHeaderBytes = workerState.headerBytes.slice(0);
    workerState.perm = [0, 1, 2];
    workerState.flip = [false, false, false];
    workerState.isIdentity = true;

    postLog(`Downsampled: ${srcDims.join('x')} -> ${resampled.dims.join('x')}`);

    // Emit NIfTI for viewer
    const nifti = createFloat32Nifti(
      resampled.data,
      workerState.headerBytes,
      resampled.dims,
      resampled.spacing
    );
    postStageData('downsample', nifti, `Downsampled ${factor}x`);

    // Emit updated volume info
    postVolumeInfo({
      rasDims: [...resampled.dims],
      rasSpacing: [...resampled.spacing],
      totalSlices: resampled.dims[2],
    });

    postProgress(1.0, 'Downsample complete');
    postStepComplete('downsample');
  }

  async function restoreWorkerState(data) {
    resetState();
    prepareInputState(data.inputData, { emitUpdates: false });

    if (data.downsampleResultData) {
      const restoredDownsample = parseNiftiInput(data.downsampleResultData);
      workerState.rasData = restoredDownsample.imageData;
      workerState.rasDims = restoredDownsample.dims;
      workerState.rasSpacing = restoredDownsample.voxelSize;
      workerState.headerBytes = restoredDownsample.headerBytes;
      workerState.origDims = [...restoredDownsample.dims];
      workerState.origHeaderBytes = restoredDownsample.headerBytes.slice(0);
      workerState.perm = [0, 1, 2];
      workerState.flip = [false, false, false];
      workerState.isIdentity = true;
    }

    if (data.n4ResultData) {
      const restoredN4 = parseNiftiInput(data.n4ResultData);
      workerState.rasData = restoredN4.imageData;
    }

    if (data.denoiseResultData) {
      const restoredDenoise = parseNiftiInput(data.denoiseResultData);
      workerState.denoisedData = restoredDenoise.imageData;
    }

    const hiddenArtifacts = data.hiddenArtifacts || {};
    workerState.preN4Data = hiddenArtifacts.n4State?.preN4Data
      ? new Float32Array(hiddenArtifacts.n4State.preN4Data)
      : null;
    workerState.brainMask = hiddenArtifacts.betState?.brainMask
      ? new Uint8Array(hiddenArtifacts.betState.brainMask)
      : null;
    workerState.preBETMask = hiddenArtifacts.betState?.preBETMask
      ? new Uint8Array(hiddenArtifacts.betState.preBETMask)
      : null;
    workerState.preDenoiseData = hiddenArtifacts.denoiseState?.preDenoiseData
      ? new Float32Array(hiddenArtifacts.denoiseState.preDenoiseData)
      : null;
    workerState.segLabelsRAS = hiddenArtifacts.segmentationState?.segLabelsRAS
      ? new Uint8Array(hiddenArtifacts.segmentationState.segLabelsRAS)
      : null;
    workerState.segMinComponentSize = hiddenArtifacts.segmentationState?.segMinComponentSize ?? 10;

    postLog('Worker state restored');
    events.emit('state-restored', {}, { transfer: false });
  }

  function stepN4() {
    if (!workerState.rasData) {
      throw new Error('No volume loaded. Run Load first.');
    }
    if (!preprocessingWasm) {
      throw new Error('Preprocessing WASM not available');
    }

    const { rasData, rasDims, rasSpacing, headerBytes } = workerState;
    const fullVoxels = rasDims[0] * rasDims[1] * rasDims[2];
    if (fullVoxels > MAX_PROCESSING_VOXELS) {
      postLog(
        `Warning: Full-volume N4 input is large (${(fullVoxels / 1e6).toFixed(0)}M voxels). ` +
          'Bias correction may run slowly or fail.'
      );
    }

    postProgress(0.1, 'Bias field correction (N4ITK)...');
    postLog('Running N4ITK bias field correction on full RAS volume...');

    // Log input stats for diagnostic comparison
    let inMin = Infinity,
      inMax = -Infinity,
      inSum = 0,
      inNonzero = 0;
    for (let i = 0; i < rasData.length; i++) {
      const v = rasData[i];
      if (v < inMin) inMin = v;
      if (v > inMax) inMax = v;
      if (v !== 0) {
        inSum += v;
        inNonzero++;
      }
    }
    postLog(
      `N4 input stats: min=${inMin.toFixed(2)}, max=${inMax.toFixed(2)}, mean_nz=${
        inNonzero ? (inSum / inNonzero).toFixed(2) : 'N/A'
      }, nonzero=${inNonzero}/${rasData.length}`
    );

    // Save backup for skip-undo
    workerState.preN4Data = new Float32Array(rasData);

    const chosenN4Policy = n4Policy.chooseN4ShrinkFactor(
      rasSpacing,
      workerState.nativeRasSpacing,
      rasDims
    );
    if (
      chosenN4Policy.shrinkFactor !== chosenN4Policy.baseShrinkFactor ||
      chosenN4Policy.externalDownsampleFactor > 1.05
    ) {
      postLog(
        `N4 shrink factor: ${chosenN4Policy.shrinkFactor} ` +
          `(native-equivalent ${chosenN4Policy.effectiveShrinkFactor.toFixed(2)}x, ` +
          `external downsample ${chosenN4Policy.externalDownsampleFactor.toFixed(2)}x)`
      );
    }

    const corrected = preprocessingWasm.n4_bias_correct(
      rasData,
      rasDims[0],
      rasDims[1],
      rasDims[2],
      rasSpacing[0],
      rasSpacing[1],
      rasSpacing[2],
      chosenN4Policy.shrinkFactor,
      10,
      0.005
    );

    // Log output stats
    let outMin = Infinity,
      outMax = -Infinity,
      outSum = 0,
      outNonzero = 0;
    for (let i = 0; i < corrected.length; i++) {
      const v = corrected[i];
      if (v < outMin) outMin = v;
      if (v > outMax) outMax = v;
      if (v !== 0) {
        outSum += v;
        outNonzero++;
      }
    }
    postLog(
      `N4 output stats: min=${outMin.toFixed(2)}, max=${outMax.toFixed(2)}, mean_nz=${
        outNonzero ? (outSum / outNonzero).toFixed(2) : 'N/A'
      }, nonzero=${outNonzero}/${corrected.length}`
    );

    workerState.rasData = corrected;
    postLog('Bias field correction complete');

    const n4Nifti = createFloat32Nifti(
      new Float32Array(corrected),
      headerBytes,
      rasDims,
      rasSpacing
    );
    postStageData('n4', n4Nifti, 'Bias field correction (N4ITK)');

    // Clear downstream state (BET + downstream invalidated)
    workerState.brainMask = null;
    workerState.preBETMask = null;
    workerState.denoisedData = null;
    workerState.preDenoiseData = null;
    workerState.segLabelsRAS = null;
    workerState.segMinComponentSize = 10;

    emitN4StateArtifact();
    emitBETStateArtifact();
    emitDenoiseStateArtifact();
    emitSegmentationStateArtifact();

    postProgress(1.0, 'N4 complete');
    postStepComplete('n4');
  }

  /**
   * Re-apply brain mask to stored segmentation labels and re-emit the segmentation result.
   * Called after BET completes when segmentation already exists.
   */
  function emitBrainMaskOverlay() {
    if (!workerState.brainMask) return;
    const mask = workerState.brainMask;
    let maskOrig = mask;
    if (!workerState.isIdentity) {
      maskOrig = inverseOrient(
        new Uint8Array(mask),
        workerState.rasDims,
        workerState.perm,
        workerState.flip,
        workerState.origDims
      );
    }
    const maskNifti = createOutputNifti(
      maskOrig,
      workerState.origHeaderBytes,
      workerState.origDims
    );
    events.emit('brain-mask-overlay', { niftiData: maskNifti });
  }

  function dilateBrainMask3D(mask, dims) {
    const [nx, ny, nz] = dims;
    const out = new Uint8Array(mask);
    // 6-connected dilation (faces only)
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (mask[x + y * nx + z * nx * ny]) continue;
          if (
            (x > 0 && mask[x - 1 + y * nx + z * nx * ny]) ||
            (x < nx - 1 && mask[x + 1 + y * nx + z * nx * ny]) ||
            (y > 0 && mask[x + (y - 1) * nx + z * nx * ny]) ||
            (y < ny - 1 && mask[x + (y + 1) * nx + z * nx * ny]) ||
            (z > 0 && mask[x + y * nx + (z - 1) * nx * ny]) ||
            (z < nz - 1 && mask[x + y * nx + (z + 1) * nx * ny])
          ) {
            out[x + y * nx + z * nx * ny] = 1;
          }
        }
      }
    }
    return out;
  }

  function erodeBrainMask3D(mask, dims) {
    const [nx, ny, nz] = dims;
    const out = new Uint8Array(mask);
    // 6-connected erosion: a voxel is removed if any neighbor is background
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (!mask[x + y * nx + z * nx * ny]) continue;
          if (
            x === 0 ||
            x === nx - 1 ||
            y === 0 ||
            y === ny - 1 ||
            z === 0 ||
            z === nz - 1 ||
            !mask[x - 1 + y * nx + z * nx * ny] ||
            !mask[x + 1 + y * nx + z * nx * ny] ||
            !mask[x + (y - 1) * nx + z * nx * ny] ||
            !mask[x + (y + 1) * nx + z * nx * ny] ||
            !mask[x + y * nx + (z - 1) * nx * ny] ||
            !mask[x + y * nx + (z + 1) * nx * ny]
          ) {
            out[x + y * nx + z * nx * ny] = 0;
          }
        }
      }
    }
    return out;
  }

  function reemitBETPreview(mask, label) {
    const { rasData, rasDims } = workerState;
    const maskedPreview = new Float32Array(rasData.length);
    for (let i = 0; i < rasData.length; i++) {
      maskedPreview[i] = mask[i] ? rasData[i] : 0;
    }
    let betPreview = maskedPreview;
    if (!workerState.isIdentity) {
      betPreview = inverseOrient(
        maskedPreview,
        rasDims,
        workerState.perm,
        workerState.flip,
        workerState.origDims
      );
    }
    const betNifti = createFloat32Nifti(
      betPreview,
      workerState.origHeaderBytes,
      workerState.origDims
    );
    postStageData('bet', betNifti, label);
    emitBrainMaskOverlay();
    emitBETStateArtifact();
  }

  function reapplyBrainMaskToSegmentation() {
    if (!workerState.segLabelsRAS) return;

    // Start from the unmasked labels
    const outputLabels = new Uint8Array(workerState.segLabelsRAS);

    // Apply brain mask if present
    if (workerState.brainMask) {
      postLog('Applying brain mask to existing segmentation...');
      let maskedOut = 0;
      for (let i = 0; i < outputLabels.length; i++) {
        if (outputLabels[i] && !workerState.brainMask[i]) {
          outputLabels[i] = 0;
          maskedOut++;
        }
      }
      if (maskedOut > 0) {
        postLog(`Brain mask removed ${maskedOut} vessel voxels outside brain`);
      }
    } else {
      postLog('Removing brain mask from segmentation...');
    }

    // Re-run CC cleanup
    const rasDims = workerState.rasDims;
    const minComponentSize = workerState.segMinComponentSize;
    const cleanedLabels = removeSmallComponents(outputLabels, rasDims, minComponentSize);

    // Inverse orient
    let finalLabels = cleanedLabels;
    if (!workerState.isIdentity) {
      finalLabels = inverseOrient(
        finalLabels,
        workerState.rasDims,
        workerState.perm,
        workerState.flip,
        workerState.origDims
      );
    }

    let finalVoxels = 0;
    for (let i = 0; i < finalLabels.length; i++) {
      if (finalLabels[i] > 0) finalVoxels++;
    }
    postLog(`Updated segmentation: ${finalVoxels} vessel voxels`);

    // Re-emit segmentation
    const outputNifti = createOutputNifti(
      finalLabels,
      workerState.origHeaderBytes,
      workerState.origDims
    );
    postStageData('segmentation', outputNifti, 'Vessel segmentation');
  }

  function stepBET(params) {
    if (!workerState.rasData) {
      throw new Error('No volume loaded. Run Load first.');
    }
    if (!preprocessingWasm) {
      throw new Error('Preprocessing WASM not available');
    }

    const fractionalIntensity = params.fractionalIntensity ?? 0.5;
    const { rasData, rasDims, rasSpacing, headerBytes } = workerState;

    postProgress(0.1, 'Brain extraction (BET)...');
    postLog(`Running BET brain extraction (fi=${fractionalIntensity})...`);

    const progressCb = (current, total) => {
      const pct = Math.round((current / total) * 100);
      if (pct % 10 === 0) {
        postProgress(0.1 + 0.8 * (current / total), `BET: ${pct}%`);
      }
    };

    const brainMask = preprocessingWasm.bet_brain_extract(
      rasData,
      rasDims[0],
      rasDims[1],
      rasDims[2],
      rasSpacing[0],
      rasSpacing[1],
      rasSpacing[2],
      fractionalIntensity,
      progressCb
    );

    let maskCount = 0;
    for (let i = 0; i < brainMask.length; i++) {
      if (brainMask[i]) maskCount++;
    }
    const coverage = ((100 * maskCount) / rasData.length).toFixed(1);
    postLog(`Brain mask: ${maskCount} voxels (${coverage}% coverage)`);

    // Save previous mask for skip-undo (null if no previous mask)
    workerState.preBETMask = workerState.brainMask;

    // Auto-dilate by 1 voxel to ensure brain boundary vessels are included
    postLog('Auto-dilating brain mask by 1 voxel...');
    workerState.brainMask = dilateBrainMask3D(brainMask, rasDims);

    // BET does NOT modify rasData or invalidate downstream - mask is independent

    reemitBETPreview(workerState.brainMask, 'Brain extraction (BET)');

    postProgress(1.0, 'BET complete');
    postStepComplete('bet');
  }

  async function stepSynthStrip(params) {
    if (!workerState.rasData) {
      throw new Error('No volume loaded. Run Load first.');
    }

    const { rasData, rasDims, rasSpacing, headerBytes } = workerState;
    const fast = !!params.fast;
    let TARGET_SPACING;
    if (fast) {
      // Adaptive spacing: ensure smallest resampled dimension >= 48 voxels
      // This prevents excessive downsampling of high-resolution data (e.g., 0.3mm TOF)
      const MIN_RESAMPLED_DIM = 48;
      const physicalExtents = rasDims.map((d, i) => d * rasSpacing[i]);
      const minExtent = Math.min(...physicalExtents);
      const maxSpacing = Math.min(2.0, minExtent / MIN_RESAMPLED_DIM);
      const sp = Math.max(1.0, maxSpacing);
      TARGET_SPACING = [sp, sp, sp];
    } else {
      TARGET_SPACING = [1.0, 1.0, 1.0];
    }
    const modeLabel = fast ? 'SynthStrip Fast' : 'SynthStrip';

    postProgress(0.02, `${modeLabel}: resampling to ${TARGET_SPACING[0].toFixed(2)}mm...`);
    postLog(
      `Running ${modeLabel} brain extraction (target spacing: ${TARGET_SPACING[0].toFixed(2)}mm)...`
    );

    // 0. Reorient RAS → LIA (SynthStrip model was trained on LIA-oriented data)
    //    LIA[0]=flip(RAS[0]), LIA[1]=flip(RAS[2]), LIA[2]=RAS[1]
    const liaPerm = [0, 2, 1];
    const liaFlip = [true, true, false];
    const liaDims = [rasDims[liaPerm[0]], rasDims[liaPerm[1]], rasDims[liaPerm[2]]];
    const liaSpacing = [rasSpacing[liaPerm[0]], rasSpacing[liaPerm[1]], rasSpacing[liaPerm[2]]];
    const liaData = new Float32Array(rasData.length);
    {
      const [dx, dy, dz] = liaDims;
      for (let oz = 0; oz < dz; oz++) {
        for (let oy = 0; oy < dy; oy++) {
          for (let ox = 0; ox < dx; ox++) {
            const coords = [ox, oy, oz];
            const src = [0, 0, 0];
            for (let i = 0; i < 3; i++) {
              src[liaPerm[i]] = liaFlip[i] ? liaDims[i] - 1 - coords[i] : coords[i];
            }
            const srcIdx = src[0] + src[1] * rasDims[0] + src[2] * rasDims[0] * rasDims[1];
            liaData[ox + oy * dx + oz * dx * dy] = rasData[srcIdx];
          }
        }
      }
    }
    postLog(`Reoriented RAS -> LIA: ${rasDims.join('x')} -> ${liaDims.join('x')}`);

    // 1. Resample to target spacing
    const needsResample =
      liaSpacing[0] !== TARGET_SPACING[0] ||
      liaSpacing[1] !== TARGET_SPACING[1] ||
      liaSpacing[2] !== TARGET_SPACING[2];
    let currentData, currentDims;
    if (needsResample) {
      const resampled = resampleVolume(liaData, liaDims, liaSpacing, TARGET_SPACING);
      currentData = resampled.data;
      currentDims = resampled.dims;
      postLog(
        `Resampled: ${liaDims.join('x')} -> ${currentDims.join('x')} (${
          TARGET_SPACING[0]
        }mm isotropic)`
      );
    } else {
      currentData = liaData;
      currentDims = [...liaDims];
    }

    // 2. Crop to bounding box + center-pad to model shape (FreeSurfer conform pipeline)
    //    SynthStrip requires dimensions clamped to [192, 320] in multiples of 64,
    //    with the brain centered in the padded volume.
    postProgress(0.05, `${modeLabel}: conforming volume...`);
    const resampledDims = [...currentDims];
    const resampledLen = currentDims[0] * currentDims[1] * currentDims[2];

    // 2a. Crop to bounding box of non-zero voxels
    const [rnx, rny, rnz] = currentDims;
    let bboxMin = [rnx, rny, rnz],
      bboxMax = [0, 0, 0];
    for (let z = 0; z < rnz; z++) {
      for (let y = 0; y < rny; y++) {
        for (let x = 0; x < rnx; x++) {
          if (currentData[x + y * rnx + z * rnx * rny] > 0) {
            if (x < bboxMin[0]) bboxMin[0] = x;
            if (y < bboxMin[1]) bboxMin[1] = y;
            if (z < bboxMin[2]) bboxMin[2] = z;
            if (x > bboxMax[0]) bboxMax[0] = x;
            if (y > bboxMax[1]) bboxMax[1] = y;
            if (z > bboxMax[2]) bboxMax[2] = z;
          }
        }
      }
    }
    bboxMax = [bboxMax[0] + 1, bboxMax[1] + 1, bboxMax[2] + 1];
    const cropDims = [bboxMax[0] - bboxMin[0], bboxMax[1] - bboxMin[1], bboxMax[2] - bboxMin[2]];
    const croppedData = new Float32Array(cropDims[0] * cropDims[1] * cropDims[2]);
    for (let z = 0; z < cropDims[2]; z++) {
      for (let y = 0; y < cropDims[1]; y++) {
        for (let x = 0; x < cropDims[0]; x++) {
          const srcIdx = bboxMin[0] + x + (bboxMin[1] + y) * rnx + (bboxMin[2] + z) * rnx * rny;
          croppedData[x + y * cropDims[0] + z * cropDims[0] * cropDims[1]] = currentData[srcIdx];
        }
      }
    }
    postLog(`Cropped to bbox: ${currentDims.join('x')} -> ${cropDims.join('x')}`);

    // 2b. Compute target shape: multiples of 64, clamped to [192, 320]
    const targetDims = cropDims.map((s) => Math.min(320, Math.max(192, Math.ceil(s / 64) * 64)));
    // Center offsets for placing cropped data in target volume
    const centerOffsets = targetDims.map((t, i) => Math.floor((t - cropDims[i]) / 2));
    const conformedData = new Float32Array(targetDims[0] * targetDims[1] * targetDims[2]);
    for (let z = 0; z < cropDims[2]; z++) {
      for (let y = 0; y < cropDims[1]; y++) {
        for (let x = 0; x < cropDims[0]; x++) {
          const dx = x + centerOffsets[0];
          const dy = y + centerOffsets[1];
          const dz = z + centerOffsets[2];
          conformedData[dx + dy * targetDims[0] + dz * targetDims[0] * targetDims[1]] =
            croppedData[x + y * cropDims[0] + z * cropDims[0] * cropDims[1]];
        }
      }
    }
    currentData = conformedData;
    currentDims = targetDims;
    postLog(
      `Conformed (center+pad): ${cropDims.join('x')} -> ${targetDims.join(
        'x'
      )} (offsets: ${centerOffsets.join(',')})`
    );

    // 3. Normalize to [0,1] AFTER conform (matches FreeSurfer: normalize the conformed volume)
    postProgress(0.07, `${modeLabel}: normalizing...`);
    const totalConformed = currentDims[0] * currentDims[1] * currentDims[2];
    let vMin = Infinity;
    for (let i = 0; i < totalConformed; i++) {
      if (currentData[i] < vMin) vMin = currentData[i];
    }
    // Subtract min
    for (let i = 0; i < totalConformed; i++) {
      currentData[i] -= vMin;
    }
    // Compute 99th percentile (of non-zero voxels to avoid bias from padding)
    let p99;
    {
      // Collect non-zero voxels (brain region only, excluding padding)
      let nonZeroCount = 0;
      for (let i = 0; i < totalConformed; i++) {
        if (currentData[i] > 0) nonZeroCount++;
      }
      const nonZero = new Float32Array(nonZeroCount);
      let idx = 0;
      for (let i = 0; i < totalConformed; i++) {
        if (currentData[i] > 0) nonZero[idx++] = currentData[i];
      }
      nonZero.sort();
      p99 = nonZeroCount > 0 ? nonZero[Math.floor(nonZeroCount * 0.99)] : 1;
    }
    const vRange = p99 || 1;
    for (let i = 0; i < totalConformed; i++) {
      currentData[i] = Math.min(1, Math.max(0, currentData[i] / vRange));
    }
    postLog(`Normalized to [0,1]: min=${vMin.toFixed(2)}, p99=${p99.toFixed(2)}`);
    // 4. Download model
    const modelBaseUrl = params.modelBaseUrl;
    const modelUrl = `${modelBaseUrl}/synthstrip.onnx`;
    const modelData = await fetchModel(modelUrl, 'synthstrip.onnx', 0.08, 0.2);

    // 5. Create ONNX session (WASM — WebGPU lacks 3D pooling support)
    postProgress(0.28, `${modeLabel}: loading model...`);
    postLog(`Creating ONNX InferenceSession for ${modeLabel} (wasm)...`);
    const session = await ort.InferenceSession.create(modelData, {
      ...sessionOptions,
      graphOptimizationLevel: 'all',
    });
    postLog(
      `${modeLabel} session created. Input: ${session.inputNames}, Output: ${session.outputNames}`
    );

    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const totalVoxels = currentDims[0] * currentDims[1] * currentDims[2];

    // 6. Single-pass full-volume inference (SynthStrip requires full brain context)
    //    ONNX expects row-major (C-order) data but the worker uses column-major
    //    (x + y*nx + z*nx*ny). Transpose before inference, transpose output back.
    postProgress(0.3, `${modeLabel}: running inference on ${currentDims.join('x')} volume...`);
    postLog(
      `${modeLabel} single-pass inference: ${currentDims.join('x')} (${(totalVoxels / 1e6).toFixed(
        1
      )}M voxels)`
    );
    const [cnx, cny, cnz] = currentDims;

    // Column-major → row-major (C-order) for ONNX
    const cOrderInput = new Float32Array(totalVoxels);
    for (let z = 0; z < cnz; z++) {
      for (let y = 0; y < cny; y++) {
        for (let x = 0; x < cnx; x++) {
          cOrderInput[x * cny * cnz + y * cnz + z] = currentData[x + y * cnx + z * cnx * cny];
        }
      }
    }

    const inputTensor = new ort.Tensor('float32', cOrderInput, [1, 1, ...currentDims]);
    const results = await session.run({ [inputName]: inputTensor });
    signal?.throwIfAborted();
    const sdtRaw = results[outputName].data;
    await session.release();

    // Row-major → column-major for the rest of the pipeline
    const sdtData = new Float32Array(totalVoxels);
    for (let z = 0; z < cnz; z++) {
      for (let y = 0; y < cny; y++) {
        for (let x = 0; x < cnx; x++) {
          sdtData[x + y * cnx + z * cnx * cny] = sdtRaw[x * cny * cnz + y * cnz + z];
        }
      }
    }

    // 7. Threshold SDT -> brain mask (SDT < border means inside brain; FreeSurfer default border=1)
    const SDT_BORDER = 1;
    postProgress(0.87, `${modeLabel}: creating brain mask...`);
    let sdtMin = Infinity,
      sdtMax = -Infinity;
    for (let i = 0; i < totalVoxels; i++) {
      if (sdtData[i] < sdtMin) sdtMin = sdtData[i];
      if (sdtData[i] > sdtMax) sdtMax = sdtData[i];
    }
    postLog(`${modeLabel} SDT range: [${sdtMin.toFixed(3)}, ${sdtMax.toFixed(3)}]`);
    const paddedMask = new Uint8Array(totalVoxels);
    let maskCount = 0;
    for (let i = 0; i < totalVoxels; i++) {
      if (sdtData[i] < SDT_BORDER) {
        paddedMask[i] = 1;
        maskCount++;
      }
    }

    // Reverse center+pad: extract the cropped region from the conformed mask
    const croppedMask = new Uint8Array(cropDims[0] * cropDims[1] * cropDims[2]);
    for (let z = 0; z < cropDims[2]; z++) {
      for (let y = 0; y < cropDims[1]; y++) {
        for (let x = 0; x < cropDims[0]; x++) {
          const sx = x + centerOffsets[0];
          const sy = y + centerOffsets[1];
          const sz = z + centerOffsets[2];
          croppedMask[x + y * cropDims[0] + z * cropDims[0] * cropDims[1]] =
            paddedMask[sx + sy * targetDims[0] + sz * targetDims[0] * targetDims[1]];
        }
      }
    }

    // Reverse crop: place cropped mask back into resampled volume
    let resampledMask = new Uint8Array(resampledLen);
    for (let z = 0; z < cropDims[2]; z++) {
      for (let y = 0; y < cropDims[1]; y++) {
        for (let x = 0; x < cropDims[0]; x++) {
          const dstIdx = bboxMin[0] + x + (bboxMin[1] + y) * rnx + (bboxMin[2] + z) * rnx * rny;
          resampledMask[dstIdx] = croppedMask[x + y * cropDims[0] + z * cropDims[0] * cropDims[1]];
        }
      }
    }

    // 8. Keep largest connected component and fill holes (matches FreeSurfer)
    postProgress(0.89, `${modeLabel}: cleaning mask...`);
    resampledMask = keepLargestComponentAndFill(resampledMask, resampledDims);

    // 9. Resample mask back to LIA original dims, then reorient to RAS
    postProgress(0.9, `${modeLabel}: resampling mask...`);
    let liaMask;
    if (needsResample) {
      liaMask = resampleLabelsNearest(resampledMask, resampledDims, liaDims);
    } else {
      liaMask = resampledMask;
    }
    // Reorient LIA → RAS (inverse of RAS → LIA)
    const finalMask = new Uint8Array(rasData.length);
    {
      const [dx, dy, dz] = liaDims;
      for (let oz = 0; oz < dz; oz++) {
        for (let oy = 0; oy < dy; oy++) {
          for (let ox = 0; ox < dx; ox++) {
            if (!liaMask[ox + oy * dx + oz * dx * dy]) continue;
            const coords = [ox, oy, oz];
            const dst = [0, 0, 0];
            for (let i = 0; i < 3; i++) {
              dst[liaPerm[i]] = liaFlip[i] ? liaDims[i] - 1 - coords[i] : coords[i];
            }
            finalMask[dst[0] + dst[1] * rasDims[0] + dst[2] * rasDims[0] * rasDims[1]] = 1;
          }
        }
      }
    }

    let finalCount = 0;
    for (let i = 0; i < finalMask.length; i++) {
      if (finalMask[i]) finalCount++;
    }
    const coverage = ((100 * finalCount) / rasData.length).toFixed(1);
    postLog(`${modeLabel} brain mask: ${finalCount} voxels (${coverage}% coverage)`);

    // 10. Store brain mask (save previous for skip-undo)
    workerState.preBETMask = workerState.brainMask;

    // Auto-dilate by 1 voxel to ensure brain boundary vessels are included
    postLog('Auto-dilating brain mask by 1 voxel...');
    workerState.brainMask = dilateBrainMask3D(finalMask, rasDims);

    // 11. Post masked preview
    reemitBETPreview(workerState.brainMask, `${modeLabel} brain extraction`);

    postProgress(1.0, `${modeLabel} complete`);
    postStepComplete('bet');
  }

  function stepDenoise(params) {
    if (!workerState.rasData) {
      throw new Error('No volume loaded. Run Load first.');
    }
    if (!preprocessingWasm) {
      throw new Error('Preprocessing WASM not available');
    }

    const method = (params && params.method) || 'bilateral';
    const { rasData, rasDims, rasSpacing, headerBytes } = workerState;

    // Save backup for skip-undo (null if no previous denoise)
    workerState.preDenoiseData = workerState.denoisedData;

    let denoised;
    let methodLabel;

    if (method === 'bilateral') {
      methodLabel = 'Bilateral';
      postProgress(0.1, 'Denoising (Bilateral)...');
      postLog('Running bilateral filter denoising on volume...');
      denoised = preprocessingWasm.bilateral_denoise(
        rasData,
        rasDims[0],
        rasDims[1],
        rasDims[2],
        2,
        1.5,
        0.0
      );
    } else if (method === 'nlm-fast') {
      methodLabel = 'NLM Fast';
      postProgress(0.1, 'Denoising (NLM Fast)...');
      postLog('Running non-local means (fast) denoising on volume...');
      denoised = preprocessingWasm.nlm_denoise(
        rasData,
        rasDims[0],
        rasDims[1],
        rasDims[2],
        3,
        1,
        0.0
      );
    } else {
      methodLabel = 'NLM';
      postProgress(0.1, 'Denoising (NLM)...');
      postLog('Running non-local means denoising on volume...');
      denoised = preprocessingWasm.nlm_denoise(
        rasData,
        rasDims[0],
        rasDims[1],
        rasDims[2],
        5,
        1,
        0.0
      );
    }

    workerState.denoisedData = denoised;
    workerState.segLabelsRAS = null;
    workerState.segMinComponentSize = 10;
    postLog('Denoising complete');

    const nlmNifti = createFloat32Nifti(
      new Float32Array(denoised),
      headerBytes,
      rasDims,
      rasSpacing
    );
    postStageData('nlm', nlmNifti, `Denoising (${methodLabel})`);

    emitDenoiseStateArtifact();
    emitSegmentationStateArtifact();

    postProgress(1.0, 'Denoising complete');
    postStepComplete('denoise');
  }

  async function stepInference(params) {
    if (!workerState.rasData) {
      throw new Error('No volume loaded. Run Load first.');
    }

    const {
      overlap = 0,
      threshold = 0.1,
      minComponentSize = 10,
      modelName = 'vesselboost.onnx',
      patchSize = [64, 64, 64],
      modelBaseUrl,
    } = params;

    const [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2] = patchSize;

    // Use denoised data if available, otherwise full RAS volume data
    let currentData = workerState.denoisedData
      ? new Float32Array(workerState.denoisedData)
      : new Float32Array(workerState.rasData);
    let currentDims = [...workerState.rasDims];
    let currentSpacing = [...workerState.rasSpacing];

    // Pad to multiples of patch size (matching Python: nearest-neighbor zoom)
    postProgress(0.05, 'Padding to patch grid...');
    const prePadDims = [...currentDims];
    const padded = padToPatchMultiple(currentData, currentDims, PATCH_DIM0);
    if (
      padded.dims[0] !== currentDims[0] ||
      padded.dims[1] !== currentDims[1] ||
      padded.dims[2] !== currentDims[2]
    ) {
      postLog(`Padded: ${currentDims.join('x')} -> ${padded.dims.join('x')} (nearest-neighbor)`);
      currentData = padded.data;
      currentDims = padded.dims;
    }
    const processingDims = [...currentDims];

    // Normalize (z-score over ALL voxels, matching Python standardiser)
    postProgress(0.1, 'Normalizing...');
    postLog('Z-score normalizing (all voxels)...');
    currentData = zScoreNormalize(currentData);
    postLog(
      `Volume: ${currentDims.join('x')}, range: [${Math.min(...currentData.slice(0, 1000)).toFixed(
        3
      )}, ...]`
    );

    // Download and load model
    const modelUrl = `${modelBaseUrl}/${modelName}`;
    const modelData = await fetchModel(modelUrl, modelName, 0.12, 0.15);

    postProgress(0.27, 'Loading ONNX model...');
    const executionProviders = sessionOptions.executionProviders;
    postLog('Creating ONNX InferenceSession (wasm - 3D ops require WASM backend)...');
    const session = await ort.InferenceSession.create(modelData, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
    postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

    // 3D Sliding Window Inference
    const gaussianWeights = computeGaussianWeightMap3D(PATCH_DIM0, PATCH_DIM1, PATCH_DIM2, 8);
    const positions = computePatchPositions3D(
      currentDims,
      [PATCH_DIM0, PATCH_DIM1, PATCH_DIM2],
      overlap
    );
    const totalPatches = positions.length;
    postLog(
      `Starting 3D inference: ${totalPatches} patches (${PATCH_DIM0}x${PATCH_DIM1}x${PATCH_DIM2}), overlap=${overlap}, backend=wasm`
    );

    const totalVoxels = currentDims[0] * currentDims[1] * currentDims[2];
    const probAccum = new Float32Array(totalVoxels);
    const weightAccum = new Float32Array(totalVoxels);

    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    const patchVoxels = PATCH_DIM0 * PATCH_DIM1 * PATCH_DIM2;

    const inferenceStartTime = performance.now();

    for (let pi = 0; pi < totalPatches; pi++) {
      signal?.throwIfAborted();
      const pos = positions[pi];
      const patch = extractPatch3D(currentData, currentDims, pos, [
        PATCH_DIM0,
        PATCH_DIM1,
        PATCH_DIM2,
      ]);

      const inputTensor = new ort.Tensor('float32', patch, [
        1,
        1,
        PATCH_DIM0,
        PATCH_DIM1,
        PATCH_DIM2,
      ]);
      const results = await session.run({ [inputName]: inputTensor });
      signal?.throwIfAborted();
      const output = results[outputName].data;

      const probabilities = new Float32Array(patchVoxels);
      for (let i = 0; i < patchVoxels; i++) {
        probabilities[i] = 1.0 / (1.0 + Math.exp(-output[i]));
      }

      // Log first 5 patches and any with vessels for comparison with Python
      if (pi < 5) {
        let pMin = Infinity,
          pMax = -Infinity,
          pMean = 0,
          pAbove = 0;
        let oMin = Infinity,
          oMax = -Infinity;
        let inMin = Infinity,
          inMax = -Infinity,
          inMean = 0;
        for (let i = 0; i < patchVoxels; i++) {
          if (probabilities[i] < pMin) pMin = probabilities[i];
          if (probabilities[i] > pMax) pMax = probabilities[i];
          pMean += probabilities[i];
          if (probabilities[i] >= threshold) pAbove++;
          if (output[i] < oMin) oMin = output[i];
          if (output[i] > oMax) oMax = output[i];
          if (patch[i] < inMin) inMin = patch[i];
          if (patch[i] > inMax) inMax = patch[i];
          inMean += patch[i];
        }
        pMean /= patchVoxels;
        inMean /= patchVoxels;
        postLog(
          `Patch ${pi} pos=[${pos}]: in=[${inMin.toFixed(3)},${inMax.toFixed(
            3
          )}] mean=${inMean.toFixed(3)}, logit=[${oMin.toFixed(3)},${oMax.toFixed(
            3
          )}], prob=[${pMin.toFixed(4)},${pMax.toFixed(4)}] mean=${pMean.toFixed(
            4
          )}, n>thr=${pAbove}`
        );
      }

      accumulatePatch3D(probAccum, weightAccum, currentDims, pos, probabilities, gaussianWeights, [
        PATCH_DIM0,
        PATCH_DIM1,
        PATCH_DIM2,
      ]);

      if (pi % 5 === 0 || pi === totalPatches - 1) {
        const elapsed = (performance.now() - inferenceStartTime) / 1000;
        const eta = (elapsed / (pi + 1)) * (totalPatches - pi - 1);
        postProgress(
          0.3 + 0.5 * ((pi + 1) / totalPatches),
          `Patch ${pi + 1}/${totalPatches} (ETA: ${eta.toFixed(0)}s)`
        );
      }
    }

    const totalTime = ((performance.now() - inferenceStartTime) / 1000).toFixed(1);
    postLog(`Inference complete: ${totalPatches} patches in ${totalTime}s`);
    await session.release();

    // Log probability map stats for comparison with Python
    let probMin = Infinity,
      probMax = -Infinity,
      probSum = 0,
      probAboveThresh = 0;
    for (let i = 0; i < totalVoxels; i++) {
      const p = weightAccum[i] > 0 ? probAccum[i] / weightAccum[i] : 0;
      if (p < probMin) probMin = p;
      if (p > probMax) probMax = p;
      probSum += p;
      if (p >= threshold) probAboveThresh++;
    }
    postLog(
      `Prob map (padded ${currentDims.join('x')}): range=[${probMin.toFixed(4)},${probMax.toFixed(
        4
      )}], mean=${(probSum / totalVoxels).toFixed(6)}, voxels>=${threshold}=${probAboveThresh}`
    );

    // Threshold and binarize
    postProgress(0.82, 'Thresholding...');
    postLog(`Thresholding at p=${threshold}...`);
    const binaryMask = new Uint8Array(totalVoxels);
    for (let i = 0; i < totalVoxels; i++) {
      if (weightAccum[i] > 0) {
        const prob = probAccum[i] / weightAccum[i];
        if (prob >= threshold) {
          binaryMask[i] = 1;
        }
      }
    }

    // Count vessel voxels in padded space for diagnostic comparison
    let paddedVesselCount = 0;
    for (let i = 0; i < totalVoxels; i++) {
      if (binaryMask[i]) paddedVesselCount++;
    }
    postLog(`Vessel voxels (padded space): ${paddedVesselCount}`);

    // Inverse transform: resize back to pre-pad dimensions FIRST
    postProgress(0.86, 'Inverse transform...');
    postLog('Applying inverse transforms...');
    let outputLabels = binaryMask;
    if (
      prePadDims[0] !== processingDims[0] ||
      prePadDims[1] !== processingDims[1] ||
      prePadDims[2] !== processingDims[2]
    ) {
      outputLabels = resampleLabelsNearest(outputLabels, processingDims, prePadDims);
    }

    // Store unmasked labels so BET can re-apply mask later
    workerState.segLabelsRAS = new Uint8Array(outputLabels);
    workerState.segMinComponentSize = minComponentSize;
    emitSegmentationStateArtifact();

    // Apply brain mask BEFORE CC cleanup (same dimensions as rasDims)
    // This prevents the brain mask boundary from fragmenting connected vessel trees
    if (workerState.brainMask) {
      let maskedOut = 0;
      for (let i = 0; i < outputLabels.length; i++) {
        if (outputLabels[i] && !workerState.brainMask[i]) {
          outputLabels[i] = 0;
          maskedOut++;
        }
      }
      if (maskedOut > 0) {
        postLog(`Brain mask removed ${maskedOut} vessel voxels outside brain`);
      }
    }

    // Remove small connected components AFTER brain mask
    postProgress(0.9, 'Removing small components...');
    postLog(`Removing components smaller than ${minComponentSize} voxels...`);
    const rasDims = workerState.rasDims;
    const cleanedLabels = removeSmallComponents(outputLabels, rasDims, minComponentSize);
    let totalSegmented = 0;
    for (let i = 0; i < cleanedLabels.length; i++) {
      if (cleanedLabels[i]) totalSegmented++;
    }
    postLog(`Segmented voxels after CC: ${totalSegmented}`);
    outputLabels = cleanedLabels;

    // Inverse orient
    if (!workerState.isIdentity) {
      outputLabels = inverseOrient(
        outputLabels,
        workerState.rasDims,
        workerState.perm,
        workerState.flip,
        workerState.origDims
      );
    }

    // Create output NIfTI
    const outputNifti = createOutputNifti(
      outputLabels,
      workerState.origHeaderBytes,
      workerState.origDims
    );
    postStageData('segmentation', outputNifti, 'Vessel segmentation');

    let finalVoxels = 0;
    for (let i = 0; i < outputLabels.length; i++) {
      if (outputLabels[i] > 0) finalVoxels++;
    }
    postLog(`Output: ${finalVoxels} vessel voxels`);

    postProgress(1.0, 'Complete');
    postStepComplete('inference');
    postComplete();
  }

  async function dispatchStep(type, data = {}) {
    switch (type) {
      case 'load':
        stepLoad(data.inputData);

        break;

      case 'downsample':
        stepDownsample(data.factor);

        break;

      case 'downsample-from-input':
        prepareInputState(data.inputData, { emitUpdates: false });
        stepDownsample(data.factor);

        break;

      case 'skip-downsample':
        if (data?.inputData) {
          prepareInputState(data.inputData, { emitUpdates: false });
          workerState.preDownsampleData = null;
          workerState.preDownsampleDims = null;
          workerState.preDownsampleSpacing = null;
          workerState.preDownsampleHeaderBytes = null;
          workerState.preDownsampleOrigDims = null;
          workerState.preDownsampleOrigHeaderBytes = null;
          workerState.preDownsamplePerm = null;
          workerState.preDownsampleFlip = null;
          workerState.preDownsampleIsIdentity = null;
          workerState.preN4Data = null;
          workerState.brainMask = null;
          workerState.preBETMask = null;
          workerState.denoisedData = null;
          workerState.preDenoiseData = null;
          workerState.segLabelsRAS = null;
          workerState.segMinComponentSize = 10;
          postLog('Downsample skipped — restored original resolution');
          postVolumeInfo({
            rasDims: [...workerState.rasDims],
            rasSpacing: [...workerState.rasSpacing],
            totalSlices: workerState.rasDims[2],
          });
        } else if (restorePreDownsampleState()) {
          // Clear downstream state
          workerState.preN4Data = null;
          workerState.brainMask = null;
          workerState.preBETMask = null;
          workerState.denoisedData = null;
          workerState.preDenoiseData = null;
          workerState.segLabelsRAS = null;
          workerState.segMinComponentSize = 10;
          postLog('Downsample undone — reverted to original resolution');
          postVolumeInfo({
            rasDims: [...workerState.rasDims],
            rasSpacing: [...workerState.rasSpacing],
            totalSlices: workerState.rasDims[2],
          });
        } else {
          postLog('Downsample skipped');
        }
        postStepComplete('downsample');
        break;

      case 'run-n4':
        stepN4();

        break;

      case 'run-bet':
        const betParams = data || {};
        if (betParams.method === 'synthstrip' || betParams.method === 'synthstrip-fast') {
          // SynthStrip needs modelBaseUrl - derive from app version
          if (!betParams.modelBaseUrl) {
            betParams.modelBaseUrl = modelBaseUrl;
          }
          betParams.fast = betParams.method === 'synthstrip-fast';
          await stepSynthStrip(betParams);
        } else {
          stepBET(betParams);
        }

        break;

      case 'run-denoise':
        stepDenoise(data);

        break;

      case 'skip-n4':
        if (workerState.preN4Data) {
          workerState.rasData = workerState.preN4Data;
          workerState.preN4Data = null;
          workerState.brainMask = null;
          workerState.preBETMask = null;
          workerState.denoisedData = null;
          workerState.preDenoiseData = null;
          workerState.segLabelsRAS = null;
          workerState.segMinComponentSize = 10;
          postLog('N4 undone — reverted to original data');
        } else {
          postLog('N4 skipped');
        }
        emitN4StateArtifact();
        emitBETStateArtifact();
        emitDenoiseStateArtifact();
        emitSegmentationStateArtifact();
        postStepComplete('n4');
        break;

      case 'skip-bet':
        workerState.brainMask = workerState.preBETMask || null;
        workerState.preBETMask = null;
        postLog(
          workerState.brainMask
            ? 'BET undone — reverted to previous mask'
            : 'BET skipped — no brain mask'
        );
        // Re-apply updated mask (or no mask) to segmentation
        reapplyBrainMaskToSegmentation();
        emitBETStateArtifact();
        postStepComplete('bet');
        break;

      case 'apply-brain-mask':
        reapplyBrainMaskToSegmentation();
        postStepComplete('apply-brain-mask');
        break;

      case 'dilate-brain-mask': {
        if (!workerState.brainMask) {
          throw new Error('No brain mask to dilate');
        }
        const dilateIter = (data && data.iterations) || 1;
        postLog(`Dilating brain mask (${dilateIter} iteration${dilateIter > 1 ? 's' : ''})...`);
        let dilated = workerState.brainMask;
        for (let i = 0; i < dilateIter; i++) {
          dilated = dilateBrainMask3D(dilated, workerState.rasDims);
        }
        workerState.brainMask = dilated;
        let dilCount = 0;
        for (let j = 0; j < dilated.length; j++) {
          if (dilated[j]) dilCount++;
        }
        postLog(
          `Dilated brain mask: ${dilCount} voxels (${((100 * dilCount) / dilated.length).toFixed(
            1
          )}% coverage)`
        );
        reemitBETPreview(dilated, 'Brain extraction (dilated)');
        postStepComplete('dilate-brain-mask');
        break;
      }

      case 'erode-brain-mask': {
        if (!workerState.brainMask) {
          throw new Error('No brain mask to erode');
        }
        const erodeIter = (data && data.iterations) || 1;
        postLog(`Eroding brain mask (${erodeIter} iteration${erodeIter > 1 ? 's' : ''})...`);
        let eroded = workerState.brainMask;
        for (let i = 0; i < erodeIter; i++) {
          eroded = erodeBrainMask3D(eroded, workerState.rasDims);
        }
        workerState.brainMask = eroded;
        let eroCount = 0;
        for (let j = 0; j < eroded.length; j++) {
          if (eroded[j]) eroCount++;
        }
        postLog(
          `Eroded brain mask: ${eroCount} voxels (${((100 * eroCount) / eroded.length).toFixed(
            1
          )}% coverage)`
        );
        reemitBETPreview(eroded, 'Brain extraction (eroded)');
        postStepComplete('erode-brain-mask');
        break;
      }

      case 'skip-denoise':
        workerState.denoisedData = workerState.preDenoiseData || null;
        workerState.preDenoiseData = null;
        workerState.segLabelsRAS = null;
        workerState.segMinComponentSize = 10;
        postLog(
          workerState.denoisedData
            ? 'Denoising undone — reverted to previous data'
            : 'Denoising skipped'
        );
        emitDenoiseStateArtifact();
        emitSegmentationStateArtifact();
        postStepComplete('denoise');
        break;

      case 'run-inference':
        await stepInference(data || {});

        break;

      case 'reset-state':
        resetState();
        postLog('Worker state reset');
        break;

      case 'restore-state':
        await restoreWorkerState(data || {});

        break;

      default:
        throw new Error(`Unknown VesselBoost step: ${type}`);
    }
  }
  async function dispatch(type, data = {}) {
    try {
      signal?.throwIfAborted();
      await dispatchStep(type, data);
      signal?.throwIfAborted();
    } finally {
      for (const session of sessions) await session.release();
    }
  }
  return {
    dispatch,
    get state() {
      return workerState;
    },
  };
}
