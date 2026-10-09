/**
 * LNM Inference Worker (module worker).
 *
 * Runs ONNX model inference for the CALMaR pipeline:
 *   1. Load            — NIfTI parse + orient to RAS
 *   2. SynthStrip      — brain extraction (Phase 2a.1; ported from
 *                        neurodesk/vesselboost-webapp). Single-pass full-volume
 *                        inference; WASM execution provider only.
 *   3. (Phase 2a.2)    — lesion segmentation via patch-based sliding-window
 *                        inference (reuses inference-pipeline.js).
 *
 * Model bytes are cached in the Cache Storage API under MODEL_CACHE_NAME so
 * subsequent runs avoid the network round-trip.
 */

import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { cacheStorageCache, createWorkerEmitter, fetchModel as fetchModelAsset, getOptimalWasmThreads, installWorkerRouter, prepareRasWorkerInput } from '../vendor/webapp-components/src/worker/index.js';
import { createNiftiFromData, extractAffine, extractNiftiHeader, parseNiftiVolume } from '../vendor/webapp-components/src/file-io/NiftiUtils.js';
import {
  inverseOrient,
  resampleLabelsNearest,
  resampleVolume,
} from '../vendor/webapp-components/src/volume/geometry.js';
import { transposeXYZToZYX, transposeZYXToXYZ } from '../vendor/webapp-components/src/volume/layout.js';
import * as InferencePipeline from './inference-pipeline.js';
import { runSynthStrip } from './modules/brain-extraction.js';
import {
  integrateSvf,
  upsampleDisplacementField,
  displacementMagnitudeField,
  warpVolume,
  inverseWarpVolume
} from './modules/registration.js';
import { resampleAffine } from './modules/resample.js';
import {
  affinesClose,
  binaryMaskFromBuffer,
  collapseBinarySoftmaxLogits,
  dimsEqual,
  fOrderToNDHWC,
  foregroundMaskFromScalar,
  normaliseSynthMorphExecutionProviders,
  projectedVolumeToLabels,
  robustNormalizeMasked,
  runDeepIslesMultiChannelPipeline,
  shouldUseZYXModelAxisOrder,
  softmaxStrokeChannel
} from './modules/inference-numerics.js';

// nifti-reader-js is a UMD bundle that installs `self.nifti` as a side-
// effect. We do NOT await its import at module top level: Chromium drops
// any message posted while a module worker is suspended on top-level
// await, instead of queueing it (the spec-mandated behaviour). Loading
// nifti-js lazily and setting up onmessage immediately keeps the queue
// working.
let niftiReady;
let nifti = null;
function loadNifti() {
  niftiReady ||= import('../nifti-js/index.js').then(() => {
    if (!globalThis.nifti) {
      throw new Error('nifti-reader-js failed to install globalThis.nifti at worker boot');
    }
    nifti = globalThis.nifti;
    return nifti;
  });
  return niftiReady;
}

const MODEL_CACHE_NAME = 'lnm-models-v1';
const MAX_PROCESSING_VOXELS = 100 * 1024 * 1024;

// ==================== Shared Worker State ====================

let workerState = {
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
  // Unmasked segmentation labels in RAS space (before brain mask / CC cleanup)
  segLabelsRAS: null,
  segMinComponentSize: 10,
  // Phase 3 SynthMorph: integrated full-resolution displacement field stored
  // in workerState so a follow-up 'warp-mask' op can apply it to a mask
  // without re-running the registration. Float32Array, length 160*160*192*3,
  // NDHWC channel-last layout (matches the SynthMorph ONNX output).
  displacementField: null,
  displacementDims: null,
  referenceHeaderBytes: null,
  referenceDims: null,
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
    segLabelsRAS: null,
    segMinComponentSize: 10,
    displacementField: null,
    displacementDims: null,
    referenceHeaderBytes: null,
    referenceDims: null,
  };
}

// ==================== Message Helpers ====================

const workerMessages = createWorkerEmitter(self);
const {
  complete: postComplete,
  error: postError,
  log: postLog,
  progress: postProgress,
  stepComplete: postStepComplete,
  volumeInfo: postVolumeInfo,
} = workerMessages;

function postStageData(stage, niftiData, description) {
  workerMessages.stageData(stage, niftiData, description, { taskId: self._currentTaskId || null });
}

function postStateArtifact(artifact, payload) {
  workerMessages.emit('state-artifact', { artifact, payload });
}

function emitSegmentationStateArtifact() {
  const segLabelsRAS = workerState.segLabelsRAS ? new Uint8Array(workerState.segLabelsRAS).buffer : null;
  postStateArtifact('segmentationState', {
    segLabelsRAS,
    segMinComponentSize: workerState.segMinComponentSize ?? 10
  });
}

// ==================== NIfTI Parsing ====================

function parseNiftiInput(arrayBuffer) {
  return parseNiftiVolume(arrayBuffer, { decompress: buffer => nifti.decompress(buffer) });
}

function copyNiftiHeaderBytes(buffer) {
  return extractNiftiHeader(buffer);
}

function affineFromHeaderBytes(headerBytes) {
  return extractAffine(new DataView(headerBytes)).map(row => Array.from(row));
}

// ==================== NIfTI Output ====================

function createOutputNifti(labelData, sourceHeader, dims) {
  return createNiftiFromData(labelData, sourceHeader, { dims });
}

function createFloat32Nifti(float32Data, sourceHeader, dims, spacing) {
  return createNiftiFromData(float32Data, sourceHeader, { dims, spacing, range: "auto", clampCalMax: false });
}

// ==================== Preprocessing ====================








// ==================== 3D Sliding Window ====================

/** Direct-write patch into output (no weighting). For non-overlapping tiling. */

// ==================== Postprocessing ====================


/**
 * Keep only the largest connected component and fill interior holes.
 * Connected-component cleanup with hole filling.
 */

// ==================== Inverse Transform ====================







// ==================== Model Loading ====================

// Model byte cache backed by the Cache Storage API.
// Stored as Response objects keyed by the manifest entry's cacheKey (or by
// URL when no key is configured). Retrieving avoids re-downloading and is
// shared with web/js/modules/atlas-loader.js so the same cache works for
// atlases and connectomes too (different cache name there).
async function _openModelCache() {
  if (typeof caches === 'undefined') return null;
  return caches.open(MODEL_CACHE_NAME);
}

async function fetchModel(url, modelName, progressBase, progressSpan, localFallbackUrl = null) {
  const displayName = modelName || url.split("/").pop();
  const cacheKey = self._modelCacheKey || `${url}?v=${self._appVersion || ""}`;
  const store = await _openModelCache();
  const urls = localFallbackUrl ? [localFallbackUrl, url, url] : [url, url];
  const bytes = await fetchModelAsset(
    { url, urls, cacheKey, integrity: { minBytes: 100001 } },
    {
      cache: store ? cacheStorageCache(store) : null,
      onInvalidCache: error => postLog(`Discarding cached model: ${error.message}`),
      onCacheError: error => postLog(`Warning: could not cache model: ${error.message}`),
      onProgress: ({ received, total, fraction }) => {
        if (fraction === null) return;
        const mb = (received / 1048576).toFixed(1);
        const totalMb = (total / 1048576).toFixed(0);
        postProgress(progressBase + fraction * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
      }
    }
  );
  postLog(`Loaded: ${displayName} (${(bytes.byteLength / 1048576).toFixed(1)} MB)`);
  return bytes;
}

// ==================== Utility ====================


// ==================== Step Functions ====================

function prepareInputState(inputData, { emitUpdates = false } = {}) {
  if (emitUpdates) {
    postLog('Parsing input volume...');
    postProgress(0.02, 'Reading NIfTI...');
  }
  const prepared = prepareRasWorkerInput(parseNiftiInput(inputData));
  Object.assign(workerState, prepared);
  if (emitUpdates) {
    postLog(`Volume: ${prepared.origDims.join('x')}, spacing: ${prepared.rasSpacing.map(value => value.toFixed(3)).join('x')}mm`);
    postLog(`RAS dims: ${prepared.rasDims.join('x')}`);
  }

  workerState.segLabelsRAS = null;
  workerState.segMinComponentSize = 10;
  if (emitUpdates) postVolumeInfo({ rasDims: [...prepared.rasDims], rasSpacing: [...prepared.rasSpacing], totalSlices: prepared.rasDims[2] });
  return {
    ...prepared,
    origDims: [...prepared.origDims],
    headerBytes: prepared.headerBytes.slice(0),
    origHeaderBytes: prepared.origHeaderBytes.slice(0),
    affine: prepared.affine.map(row => Array.from(row)),
    perm: [...prepared.perm],
    flip: [...prepared.flip],
    rasData: new Float32Array(prepared.rasData),
    rasDims: [...prepared.rasDims],
    rasSpacing: [...prepared.rasSpacing],
  };
}
function stepLoad(inputData) {
  prepareInputState(inputData, { emitUpdates: true });

  postProgress(1.0, 'Volume loaded');
  postStepComplete('load');
}

async function restoreWorkerState(data) {
  resetState();
  prepareInputState(data.inputData, { emitUpdates: false });

  const hiddenArtifacts = data.hiddenArtifacts || {};
  workerState.segLabelsRAS = hiddenArtifacts.segmentationState?.segLabelsRAS
    ? new Uint8Array(hiddenArtifacts.segmentationState.segLabelsRAS)
    : null;
  workerState.segMinComponentSize = hiddenArtifacts.segmentationState?.segMinComponentSize ?? 10;

  postLog('Worker state restored');
  workerMessages.emit('state-restored', {}, { transfer: false });
}

async function stepInference(params) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }

  const {
    overlap = 0,
    threshold = 0.1,
    minComponentSize = 10,
    taskId,
    modelAssetId,
    modelName,
    patchSize = [64, 64, 64],
    modelBaseUrl,
    supportStatus = 'unvalidated',
    testTimeAugmentation = false,
    cacheKey,
    provenance = {},
    preprocessing = {}
  } = params;

  if (!taskId || !modelAssetId || !modelName) {
    throw new Error('run-inference requires taskId, modelAssetId, and modelName.');
  }
  if (supportStatus !== 'supported') {
    throw new Error(`Task "${taskId}" is ${supportStatus}. Convert and validate model asset "${modelAssetId}" before running inference.`);
  }
  self._currentTaskId = taskId;

  // Download + create ONNX session.
  self._modelCacheKey = cacheKey || `${taskId}:${modelAssetId}:${self._appVersion || ''}`;
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(modelUrl, modelName, 0.05, 0.15);
  self._modelCacheKey = null;

  postProgress(0.22, 'Loading ONNX model...');
  postLog('Creating ONNX InferenceSession (wasm - 3D ops require WASM backend)...');
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const inferenceStartTime = performance.now();
  let modelInputData = new Float32Array(workerState.rasData);
  let modelInputDims = [...workerState.rasDims];
  let modelOutputToRas = (labels, dims, OutputCtor) => ({ data: labels, dims, ctor: OutputCtor || Uint8Array });

  const targetSpacing = Array.isArray(preprocessing.targetSpacing)
    ? preprocessing.targetSpacing.map((value, index) => value == null ? workerState.rasSpacing[index] : Number(value))
    : null;
  if (targetSpacing) {
    const resampled = resampleVolume(modelInputData, modelInputDims, workerState.rasSpacing, targetSpacing);
    postLog(`Resampled for ${taskId}: ${modelInputDims.join('x')} -> ${resampled.dims.join('x')} at ${targetSpacing.map(v => v.toFixed(3)).join('x')}mm`);
    modelInputData = resampled.data;
    modelInputDims = resampled.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restored = previousOutputToRas(labels, dims, OutputCtor);
      return {
        data: resampleLabelsNearest(restored.data, restored.dims, workerState.rasDims),
        dims: [...workerState.rasDims],
        ctor: OutputCtor || Uint8Array
      };
    };
  }

  if (shouldUseZYXModelAxisOrder(preprocessing, modelInputDims, patchSize)) {
    const transposed = transposeXYZToZYX(modelInputData, modelInputDims, Float32Array);
    postLog(`Reordered for ${taskId}: ${modelInputDims.join('x')} xyz -> ${transposed.dims.join('x')} zyx`);
    modelInputData = transposed.data;
    modelInputDims = transposed.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restoredAxes = transposeZYXToXYZ(labels, dims, OutputCtor || Uint8Array);
      return previousOutputToRas(restoredAxes.data, restoredAxes.dims, OutputCtor || Uint8Array);
    };
  }

  // Delegate the per-patch inference + sliding-window orchestration to the
  // shared pipeline module, injecting an ORT-backed runPatch callback.
  const result = await InferencePipeline.runInferencePipeline(
    {
      data: modelInputData,
      dims: modelInputDims,
      patchSize
    },
    async (patch, patchDims) => {
      const [p0, p1, p2] = patchDims;
      const voxels = p0 * p1 * p2;
      const inputTensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
      const out = await session.run({ [inputName]: inputTensor });
      const raw = out[outputName].data;
      inputTensor.dispose();
      return collapseBinarySoftmaxLogits(raw, voxels, outputName);
    },
    {
      overlap, threshold, minComponentSize, testTimeAugmentation,
      onLog: (msg) => postLog(msg),
      onProgress: (stepsDone, totalSteps, label) => {
        const elapsed = (performance.now() - inferenceStartTime) / 1000;
        const eta = stepsDone > 0 ? (elapsed / stepsDone) * (totalSteps - stepsDone) : 0;
        const frac = totalSteps > 0 ? stepsDone / totalSteps : 0;
        postProgress(0.25 + 0.55 * frac, `${label} (ETA: ${eta.toFixed(0)}s)`);
      },
      onPatchStats: (pi, s) => {
        postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}, logit=[${s.oMin.toFixed(3)},${s.oMax.toFixed(3)}], prob=[${s.pMin.toFixed(4)},${s.pMax.toFixed(4)}] mean=${s.pMean.toFixed(4)}, n>thr=${s.pAbove}`);
      }
    }
  );
  await session.release();
  postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

  // Stash the unmasked (pre-CC) labels for downstream browser processing.
  postProgress(0.86, 'Inverse transform...');
  const preCleanupRAS = modelOutputToRas(result.preCleanupLabels, result.dims, Uint8Array);
  workerState.segLabelsRAS = new Uint8Array(preCleanupRAS.data);
  workerState.segMinComponentSize = minComponentSize;
  emitSegmentationStateArtifact();

  let outputLabels = modelOutputToRas(result.labels, result.dims, Uint8Array).data;

  // Inverse orient
  if (!workerState.isIdentity) {
    outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
  }

  // Create output NIfTI
  const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
  postStageData('segmentation', outputNifti, 'Lesion segmentation');

  let finalVoxels = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) finalVoxels++;
  }
  postLog(`Output: ${finalVoxels} foreground voxels`);
  if (finalVoxels === 0) {
    postLog(`WARNING: Segmentation is empty. Probability map max=${result.probStats.max.toFixed(4)} (threshold=${threshold}). Try lowering the probability threshold or check input contrast/orientation.`);
  }

  postProgress(1.0, 'Complete');
  postStepComplete('inference');
  postComplete();
}

async function stepDeepIslesInference(params) {
  const {
    overlap = 0.625,
    threshold = 0.5,
    minComponentSize = 30,
    taskId,
    modelAssetId,
    modelName,
    patchSize = [192, 192, 128],
    modelBaseUrl,
    supportStatus = 'unvalidated',
    cacheKey,
    channelOrder = ['ADC', 'TRACE'],
    dwiBuffer,
    adcBuffer
  } = params;

  if (!taskId || !modelAssetId || !modelName) {
    throw new Error('run-deepisles-inference requires taskId, modelAssetId, and modelName.');
  }
  if (!dwiBuffer || !adcBuffer) {
    throw new Error('DeepISLES requires DWI/TRACE and ADC input buffers.');
  }
  if (supportStatus !== 'supported') {
    throw new Error(
      `Task "${taskId}" is ${supportStatus}. DeepISLES browser seed remains benchmark-only until a validated ONNX asset is selected.`
    );
  }
  if (!Array.isArray(channelOrder) || channelOrder.join(',') !== 'ADC,TRACE') {
    throw new Error('DeepISLES channelOrder must be [ADC, TRACE].');
  }
  self._currentTaskId = taskId;

  postProgress(0.02, 'Reading DeepISLES inputs...');
  postLog('Loading DWI/TRACE input for DeepISLES...');
  const dwiState = prepareInputState(dwiBuffer, { emitUpdates: true });
  const dwiRasAffine = affineFromHeaderBytes(dwiState.headerBytes);
  postLog('Loading ADC input for DeepISLES...');
  const adcState = prepareInputState(adcBuffer, { emitUpdates: false });
  const adcRasAffine = affineFromHeaderBytes(adcState.headerBytes);

  let adcOnDwi = adcState.rasData;
  if (!dimsEqual(adcState.rasDims, dwiState.rasDims) || !affinesClose(adcRasAffine, dwiRasAffine, 1e-3)) {
    postLog('Resampling ADC onto DWI/TRACE grid for DeepISLES.');
    adcOnDwi = resampleAffine(
      adcState.rasData,
      adcState.rasDims,
      adcRasAffine,
      dwiState.rasDims,
      dwiRasAffine,
      'trilinear'
    );
  }

  // Keep the worker state anchored to the DWI/TRACE source so the output
  // NIfTI is written on that grid after inference.
  workerState.origDims = [...dwiState.origDims];
  workerState.affine = dwiState.affine;
  workerState.headerBytes = dwiState.headerBytes.slice(0);
  workerState.origHeaderBytes = dwiState.origHeaderBytes.slice(0);
  workerState.perm = [...dwiState.perm];
  workerState.flip = [...dwiState.flip];
  workerState.isIdentity = dwiState.isIdentity;
  workerState.rasData = new Float32Array(dwiState.rasData);
  workerState.rasDims = [...dwiState.rasDims];
  workerState.rasSpacing = [...dwiState.rasSpacing];

  self._modelCacheKey = cacheKey || `${taskId}:${modelAssetId}:${self._appVersion || ''}`;
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(modelUrl, modelName, 0.05, 0.15);
  self._modelCacheKey = null;

  postProgress(0.20, 'Loading DeepISLES ONNX model...');
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const inferenceStartTime = performance.now();
  const result = await runDeepIslesMultiChannelPipeline(
    {
      channels: [adcOnDwi, dwiState.rasData],
      dims: dwiState.rasDims,
      patchSize,
      channelOrder
    },
    async (patch, patchDims) => {
      const [p0, p1, p2] = patchDims;
      const voxels = p0 * p1 * p2;
      const inputTensor = new ort.Tensor('float32', patch, [1, 2, p0, p1, p2]);
      const out = await session.run({ [inputName]: inputTensor });
      const raw = out[outputName].data;
      inputTensor.dispose();
      return softmaxStrokeChannel(raw, voxels, 2, 1);
    },
    {
      overlap,
      threshold,
      minComponentSize,
      onLog: (msg) => postLog(msg),
      onProgress: (stepsDone, totalSteps, label) => {
        const elapsed = (performance.now() - inferenceStartTime) / 1000;
        const eta = stepsDone > 0 ? (elapsed / stepsDone) * (totalSteps - stepsDone) : 0;
        const frac = totalSteps > 0 ? stepsDone / totalSteps : 0;
        postProgress(0.25 + 0.55 * frac, `${label} (ETA: ${eta.toFixed(0)}s)`);
      }
    }
  );
  await session.release();
  postLog(`DeepISLES inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

  let outputLabels = result.labels;
  if (!workerState.isIdentity) {
    outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
  }
  const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
  postStageData('segmentation', outputNifti, 'DeepISLES lesion seed');

  let finalVoxels = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) finalVoxels++;
  }
  postLog(`DeepISLES output: ${finalVoxels} foreground voxels`);
  if (finalVoxels === 0) {
    postLog(`WARNING: DeepISLES seed is empty. Probability map max=${result.probStats.max.toFixed(4)} (threshold=${threshold}).`);
  }
  postProgress(1.0, 'Complete');
  postStepComplete('inference');
  postComplete();
}

// Phase 2a.1 brain extraction. The orchestration lives in
// web/js/modules/brain-extraction.js (a 1:1 port of vesselboost-webapp's
// stepSynthStrip); this adapter wires it into the worker protocol: pulls
// the RAS volume off workerState, fetches the SynthStrip model bytes via
// the shared Cache-Storage-backed fetchModel, runs the pipeline, and
// emits a `brainmask` stageData NIfTI to the orchestrator.
async function stepSynthStrip(params = {}) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }

  const {
    modelAssetId = 'lnm-synthstrip',
    modelName = 'synthstrip.onnx',
    modelBaseUrl,
    cacheKey,
    fast = false,
    dilate = false
  } = params;

  if (!modelBaseUrl) {
    throw new Error('run-synthstrip requires modelBaseUrl.');
  }

  self._currentTaskId = modelAssetId;
  self._modelCacheKey = cacheKey || `${modelAssetId}:${self._appVersion || ''}`;
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelArrayBuffer = await fetchModel(modelUrl, modelName, 0.02, 0.10);

  const { mask, voxelCount, coveragePct } = await runSynthStrip({
    rasData: workerState.rasData,
    rasDims: workerState.rasDims,
    rasSpacing: workerState.rasSpacing,
    modelArrayBuffer,
    ort,
    fast,
    dilate,
    onProgress: (frac, label) => postProgress(0.12 + 0.85 * frac, label),
    onLog: (msg) => postLog(msg)
  });

  // The mask comes back in RAS at workerState.rasDims; apply the inverse
  // RAS->native orientation so the saved NIfTI is in the input image's
  // original orientation (matches the segmentation stage).
  let outputMask = mask;
  if (!workerState.isIdentity) {
    outputMask = inverseOrient(
      outputMask,
      workerState.rasDims,
      workerState.perm,
      workerState.flip,
      workerState.origDims
    );
  }
  const outputNifti = createOutputNifti(
    outputMask,
    workerState.origHeaderBytes,
    workerState.origDims
  );
  postStageData('brainmask', outputNifti, 'SynthStrip brain mask');

  postLog(`SynthStrip brain mask: ${voxelCount} voxels (${coveragePct.toFixed(1)}% coverage)`);
  postProgress(1.0, 'Brain extraction complete');
  postStepComplete('brainmask');
}

// Phase 3.4 SynthMorph registration. Takes the patient T1 (already on
// workerState.rasData; *must* be at 160x160x192 1mm — the model's training
// resolution and the LNM webapp's MNI reference grid) and warps it into
// alignment with the lnm-mni160 reference. The integrated displacement
// field is stashed on workerState so a follow-up 'warp-mask' op can apply
// it to lesion / structural masks without re-running the network.
//
// The orchestrator is responsible for resampling / padding the source T1
// to 160x160x192 1mm BEFORE 'load' (e.g. via FSL FLIRT to MNI152 + crop).
// Documented in the lnm-yeo-auto pipeline preconditions; the worker
// surfaces a clear error if the source dims don't match.
async function stepRegister(params = {}) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }
  const expected = [160, 160, 192];
  const got = workerState.rasDims;
  if (got[0] !== expected[0] || got[1] !== expected[1] || got[2] !== expected[2]) {
    throw new Error(
      `SynthMorph registration requires source at 160x160x192; got ${got.join('x')}. ` +
      `Pre-process the T1 to this grid (e.g. FSL FLIRT to MNI152 + center-crop) before running.`
    );
  }

  const {
    modelAssetId = 'lnm-synthmorph-mni',
    modelName = 'lnm-synthmorph-mni.onnx',
    modelBaseUrl,
    modelCacheKey,
    referenceAssetId = 'lnm-mni160',
    referenceUrl,
    referenceCacheKey,
    modelLocalUrl,
    modelInputDims = [160, 160, 192],
    svfDims = null,
    executionProviders = ['wasm'],
    brainMaskBuffer = null,
    brainMaskDims = null,
    nbSteps = 7
  } = params;
  if (!modelBaseUrl) throw new Error('run-register requires modelBaseUrl');
  if (!referenceUrl) throw new Error('run-register requires referenceUrl');

  const src = workerState.rasData;

  // Fetch + decode the MNI reference target (cached).
  postProgress(0.10, 'Fetching MNI reference...');
  self._modelCacheKey = referenceCacheKey || `${referenceAssetId}:${self._appVersion || ''}`;
  const refBytes = await fetchModel(referenceUrl, 'lnm-mni160.nii.gz', 0.10, 0.10);
  const refUint8 = new Uint8Array(refBytes);
  let refBuf = refBytes;
  if (refUint8[0] === 0x1f && refUint8[1] === 0x8b) {
    refBuf = nifti.decompress(refBytes);
  }
  if (!nifti.isNIFTI(refBuf)) {
    throw new Error('MNI reference is not a valid NIfTI');
  }
  const refHeader = nifti.readHeader(refBuf);
  workerState.referenceHeaderBytes = copyNiftiHeaderBytes(refBuf);
  workerState.referenceDims = [
    Number(refHeader.dims[1]),
    Number(refHeader.dims[2]),
    Number(refHeader.dims[3])
  ];
  const refImage = nifti.readImage(refHeader, refBuf);
  // Reference was saved as float32 by the build pipeline.
  let targetData = new Float32Array(refImage);
  if (targetData.length !== 160 * 160 * 192) {
    throw new Error(`MNI reference has ${targetData.length} voxels; expected ${160 * 160 * 192}`);
  }

  postProgress(0.15, 'Normalising registration inputs...');
  let sourceNormalized;
  const sourceMask = binaryMaskFromBuffer(
    brainMaskBuffer,
    brainMaskDims,
    expected,
    'registration brain mask'
  );
  if (sourceMask) {
    const targetMask = foregroundMaskFromScalar(targetData, 0.05);
    const sourceNorm = robustNormalizeMasked(src, sourceMask.mask, { zeroOutside: true });
    const targetNorm = robustNormalizeMasked(targetData, targetMask.mask, { zeroOutside: true });
    sourceNormalized = sourceNorm.data;
    targetData = targetNorm.data;
    postLog(
      `SynthMorph masked normalization: source=${sourceMask.count.toLocaleString()} voxels ` +
      `(p01=${sourceNorm.lo.toFixed(3)}, p99=${sourceNorm.hi.toFixed(3)}), ` +
      `target=${targetMask.count.toLocaleString()} voxels ` +
      `(p01=${targetNorm.lo.toFixed(3)}, p99=${targetNorm.hi.toFixed(3)})`
    );
  } else {
    // Keep the no-mask path bit-compatible with existing self-pair smoke
    // coverage: source is min-max scaled and the MNI reference is already
    // stored in the expected [0, 1] range.
    let srcMin = Infinity, srcMax = -Infinity;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v < srcMin) srcMin = v;
      if (v > srcMax) srcMax = v;
    }
    const range = (srcMax - srcMin) || 1;
    sourceNormalized = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) sourceNormalized[i] = (src[i] - srcMin) / range;
  }

  // Fetch the SynthMorph SVF ONNX.
  postProgress(0.20, 'Fetching SynthMorph model...');
  self._modelCacheKey = modelCacheKey || `${modelAssetId}:${self._appVersion || ''}`;
  const modelArrayBuffer = await fetchModel(
    `${modelBaseUrl}/${modelName}`, modelName, 0.20, 0.30, modelLocalUrl
  );

  const providerOrder = normaliseSynthMorphExecutionProviders(executionProviders);

  // The model expects channel-last NDHWC: (1, 160, 160, 192, 1) per input.
  // Our F-order data needs a one-pass repack into row-major NDHWC.
  // F-order index: i_F = x + y*X + z*X*Y
  // Row-major NDHWC (C=1): i_R = (x*Y + y)*Z + z
  const X = 160, Y = 160, Z = 192;
  const modelDims = Array.isArray(modelInputDims) && modelInputDims.length === 3
    ? modelInputDims.map(v => Number(v))
    : [X, Y, Z];
  if (modelDims.some(v => !Number.isInteger(v) || v <= 0)) {
    throw new Error(`Invalid SynthMorph modelInputDims: ${modelInputDims}`);
  }

  function maybeResampleToModelGrid(fdata, label) {
    if (modelDims[0] === X && modelDims[1] === Y && modelDims[2] === Z) {
      return fdata;
    }
    const spacing = [X / modelDims[0], Y / modelDims[1], Z / modelDims[2]];
    const resampled = resampleVolume(fdata, [X, Y, Z], [1, 1, 1], spacing);
    if (resampled.dims[0] !== modelDims[0] ||
        resampled.dims[1] !== modelDims[1] ||
        resampled.dims[2] !== modelDims[2]) {
      throw new Error(
        `SynthMorph ${label} downsample produced ${resampled.dims.join('x')}; ` +
        `expected ${modelDims.join('x')}`
      );
    }
    return resampled.data;
  }

  const sourceModel = maybeResampleToModelGrid(sourceNormalized, 'source');
  const targetModel = maybeResampleToModelGrid(targetData, 'target');
  if (modelDims[0] !== X || modelDims[1] !== Y || modelDims[2] !== Z) {
    postLog(`SynthMorph browser grid: ${X}x${Y}x${Z} -> ${modelDims.join('x')}`);
  }
  const sourceNHWC = fOrderToNDHWC(sourceModel, modelDims);
  const targetNHWC = fOrderToNDHWC(targetModel, modelDims);

  postProgress(0.55, 'Building SynthMorph session...');
  postLog(`SynthMorph EP candidates=${providerOrder.join(',')}`);
  let svfFlat;
  let outputDims = svfDims;
  let chosenEp = null;
  let forwardSeconds = 0;
  let lastError = null;
  for (let i = 0; i < providerOrder.length && !svfFlat; i++) {
    const ep = providerOrder[i];
    let session;
    let sourceTensor;
    let targetTensor;
    try {
      session = await ort.InferenceSession.create(modelArrayBuffer, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all'
      });
      const inputNames = session.inputNames;
      const outputName = session.outputNames[0];
      postLog(`SynthMorph EP candidate=${ep}`);
      postLog(`SynthMorph session ready (inputs=${inputNames.join(',')}, output=${outputName})`);

      postProgress(0.60, 'Running SynthMorph (single-pass, ~30 s)...');
      sourceTensor = new ort.Tensor('float32', sourceNHWC, [1, ...modelDims, 1]);
      targetTensor = new ort.Tensor('float32', targetNHWC, [1, ...modelDims, 1]);
      const t0 = performance.now();
      const out = await session.run({
        [inputNames[0]]: sourceTensor,
        [inputNames[1]]: targetTensor
      });
      forwardSeconds = (performance.now() - t0) / 1000;
      const outputTensor = out[outputName];
      svfFlat = outputTensor.data;
      chosenEp = ep;
      postLog(`SynthMorph EP=${ep}`);
      if (Array.isArray(outputTensor.dims) && outputTensor.dims.length === 5) {
        outputDims = outputTensor.dims.slice(1, 4);
      }
    } catch (err) {
      lastError = err;
      const nextEp = providerOrder[i + 1];
      if (nextEp) {
        postLog(`SynthMorph EP ${ep} failed (${err?.message || err}); trying ${nextEp}.`);
      }
    } finally {
      sourceTensor?.dispose?.();
      targetTensor?.dispose?.();
      session?.release?.();
    }
  }
  if (!svfFlat) {
    throw lastError || new Error('SynthMorph failed for all execution providers.');
  }
  if (!Array.isArray(outputDims) || outputDims.length !== 3) {
    outputDims = modelDims.map(v => v / 2);
  }
  const halfDims = outputDims.map(v => Number(v));
  postLog(
    `SynthMorph forward in ${forwardSeconds.toFixed(1)}s (${chosenEp}); ` +
    `SVF shape=${halfDims.join('x')}x3`
  );

  // Integrate SVF (scaling-and-squaring) and upsample to full-res. Both
  // run in pure JS — see web/js/modules/registration.js. svfFlat is
  // already in row-major NDHWC, which is what registration.js expects.
  postProgress(0.85, 'Integrating SVF (scaling-and-squaring)...');
  const halfDisp = integrateSvf(svfFlat, halfDims, nbSteps);

  postProgress(0.95, 'Upsampling displacement to full resolution...');
  const fullDims = [X, Y, Z];
  const fullDisp = upsampleDisplacementField(halfDisp, halfDims, fullDims);

  workerState.displacementField = fullDisp;
  workerState.displacementDims = fullDims;
  postLog(`Displacement field: ${fullDisp.length.toLocaleString()} floats stored on worker state`);

  postProgress(0.98, 'Preparing registration QC outputs...');
  const registeredT1 = warpVolume(sourceNormalized, fullDims, fullDisp, fullDims);
  const registeredNifti = createFloat32Nifti(
    registeredT1,
    workerState.referenceHeaderBytes,
    workerState.referenceDims || fullDims,
    [1, 1, 1]
  );
  postStageData(
    'registered-t1-mni160',
    registeredNifti,
    'Moving T1 warped to the fixed MNI160 grid'
  );

  const displacementMagnitude = displacementMagnitudeField(fullDisp, fullDims);
  const displacementNifti = createFloat32Nifti(
    displacementMagnitude,
    workerState.referenceHeaderBytes,
    workerState.referenceDims || fullDims,
    [1, 1, 1]
  );
  postStageData(
    'registration-displacement-mag',
    displacementNifti,
    'SynthMorph displacement magnitude on the fixed MNI160 grid'
  );
  postProgress(1.0, 'Registration complete');
  postStepComplete('register');
}

// Phase 3.5 helper: apply the integrated displacement field (left on
// workerState by stepRegister) to a binary mask and emit the warped result.
// The mask is passed in as F-order voxel bytes via the message data; the
// orchestrator decodes a NIfTI before posting.
async function stepWarpMask(params = {}) {
  if (!workerState.displacementField) {
    throw new Error('No displacement available. Run Register first.');
  }
  const {
    maskBuffer,        // Uint8Array of F-order voxels, length = 160*160*192
    maskDims = [160, 160, 192]
  } = params;
  if (!maskBuffer) throw new Error('warp-mask requires maskBuffer');

  postProgress(0.10, 'Warping mask...');
  // warpVolume expects Float32Array; coerce.
  const mask = new Uint8Array(maskBuffer);
  const maskF32 = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) maskF32[i] = mask[i];
  const warped = warpVolume(maskF32, maskDims, workerState.displacementField, workerState.displacementDims);
  const warpedBin = new Uint8Array(warped.length);
  for (let i = 0; i < warped.length; i++) warpedBin[i] = warped[i] > 0.5 ? 1 : 0;

  // Wrap as NIfTI sharing the fixed MNI160 target header. The warped voxels
  // are on the SynthMorph reference grid, not the source/prealign affine.
  postProgress(0.85, 'Wrapping warped mask as NIfTI...');
  const outNifti = createOutputNifti(
    warpedBin,
    workerState.referenceHeaderBytes || workerState.origHeaderBytes,
    workerState.referenceDims || workerState.origDims
  );
  postStageData('mni-lesion', outNifti, 'Lesion mask warped to MNI 1mm');

  postProgress(1.0, 'Mask warp complete');
  postStepComplete('warp-mask');
}

async function stepInverseWarpMask(params = {}) {
  if (!workerState.displacementField) {
    throw new Error('No displacement available. Run Register first.');
  }
  const {
    maskBuffer,
    maskDims = [160, 160, 192],
    stage = 'threshold-patient',
    description = 'Threshold map projected to patient T1 space',
    labelMap = false,
    labelDataType = 'uint8',
    iterations = 8
  } = params;
  if (!maskBuffer) throw new Error('inverse-warp-mask requires maskBuffer');

  postProgress(0.10, 'Projecting threshold map to patient space...');
  const mask = labelMap && labelDataType === 'uint16'
    ? new Uint16Array(maskBuffer)
    : new Uint8Array(maskBuffer);
  const maskF32 = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) maskF32[i] = mask[i];
  const projected = inverseWarpVolume(
    maskF32,
    maskDims,
    workerState.displacementField,
    workerState.displacementDims,
    { mode: 'nearest', iterations }
  );
  const projectedOut = projectedVolumeToLabels(projected, { labelMap, labelDataType });

  postProgress(0.85, labelMap
    ? 'Wrapping patient-space atlas as NIfTI...'
    : 'Wrapping patient-space threshold map as NIfTI...');
  const outNifti = createOutputNifti(projectedOut, workerState.origHeaderBytes, workerState.origDims);
  postStageData(stage, outNifti, description);

  postProgress(1.0, labelMap ? 'Atlas projection complete' : 'Threshold projection complete');
  postStepComplete('inverse-warp-mask');
}

// ==================== Message Handler ====================

installWorkerRouter({
  scope: self,
  getServices: async () => ({ nifti: await loadNifti() }),
  onError: message => postError(`Worker boot failed: ${message}`),
  handle: async ({ type, data, ...message }) => {
  // nifti-reader-js is loaded lazily (see top-of-file comment) so the
  // module-worker's first messages don't get dropped during a top-level
  // await. Wait once per message so handlers can safely read `nifti`.
  try {
    await loadNifti();
  } catch (err) {
    postError(`Worker boot failed: ${err.message}`);
    return;
  }

  switch (type) {
    case 'init':
      try {
        self._appVersion = message.version || '';
        ort.env.wasm.numThreads = getOptimalWasmThreads();
        ort.env.wasm.wasmPaths = '../wasm/';
        postLog(`ORT WASM backend ready (${ort.env.wasm.numThreads} threads)`);
        workerMessages.initialized();
      } catch (error) {
        postError(`Initialization failed: ${error.message}`);
      }
      break;

    case 'load':
      try {
        stepLoad(data.inputData);
      } catch (error) {
        console.error('Load error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-inference':
      try {
        await stepInference(data || {});
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-deepisles-inference':
      try {
        await stepDeepIslesInference(data || {});
      } catch (error) {
        console.error('DeepISLES inference error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-synthstrip':
      try {
        await stepSynthStrip(data || {});
      } catch (error) {
        console.error('SynthStrip error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'run-register':
      try {
        await stepRegister(data || {});
      } catch (error) {
        console.error('Register error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'warp-mask':
      try {
        await stepWarpMask(data || {});
      } catch (error) {
        console.error('Warp-mask error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'inverse-warp-mask':
      try {
        await stepInverseWarpMask(data || {});
      } catch (error) {
        console.error('Inverse-warp-mask error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'reset-state':
      resetState();
      postLog('Worker state reset');
      break;

    case 'restore-state':
      try {
        await restoreWorkerState(data || {});
      } catch (error) {
        console.error('Restore error:', error);
        postError(error?.message || String(error));
      }
      break;
  }
  }
});
