/**
 * SpinalCordToolbox Inference Worker
 *
 * Runs ONNX model inference for 3D patch-based SCT segmentation.
 * Pipeline is split into interactive steps:
 *   1. Load (NIfTI parse + orient to RAS)
 *   2. Inference (resample → normalize → crop → sliding window → threshold → CC → inverse)
 */

import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { createWorkerEmitter, fetchModel as fetchModelAsset, getOptimalWasmThreads, installWorkerRouter, localForageCache, prepareRasWorkerInput } from '../vendor/webapp-components/src/worker/index.js';
import { createNiftiFromData, parseNiftiVolume } from '../vendor/webapp-components/src/file-io/NiftiUtils.js';
import {
  inverseOrient,
  resampleLabelsNearest,
  resampleVolume,
} from '../vendor/webapp-components/src/volume/geometry.js';
import { flipVolumeAxes, transposeXYZToZYX, transposeZYXToXYZ } from '../vendor/webapp-components/src/volume/layout.js';

let localforage;
let nifti;
let SCTInferencePipeline;
let SCTLesionAnalysis;
let TotalSpineSeg;
let dependenciesReady;

function loadDependencies() {
  dependenciesReady ||= Promise.all([
    import('https://cdn.jsdelivr.net/npm/localforage@1.10.0/+esm'),
    import('../nifti-js/index.js'),
    import('./inference-pipeline.js'),
    import('./modules/lesion-analysis.js'),
    import('./modules/vertebrae.js'),
    import('./modules/totalspineseg.js')
  ]).then(([localForageModule]) => {
    localforage = localForageModule.default;
    nifti = globalThis.nifti;
    SCTInferencePipeline = globalThis.SCTInferencePipeline;
    SCTLesionAnalysis = globalThis.SCTLesionAnalysis;
    TotalSpineSeg = globalThis.TotalSpineSeg;
    if (!localforage || !nifti || !SCTInferencePipeline || !SCTLesionAnalysis || !globalThis.SCTVertebrae || !TotalSpineSeg) {
      throw new Error('SCT worker dependencies failed to initialize');
    }
    return { localforage, nifti };
  });
  return dependenciesReady;
}

const FIXED_TARGET_SPACING = [0.3, 0.3, 0.3];
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
  lesionLabelsRAS: null,
  segMinComponentSize: 10,
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
    lesionLabelsRAS: null,
    segMinComponentSize: 10,
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

// postLog writes the technical log. postAnalysis writes the analysis log: input, results and
// the warnings that change how a result should be read.
function postAnalysis(message, level = 'info') {
  postLog(message, { channel: 'analysis', level });
}

// Result summary for the analysis log. Returns the labelled voxel count.
function postMaskSummary(stage, labels) {
  const seen = new Set();
  let voxels = 0;
  let last = 0;
  for (let i = 0; i < labels.length; i++) {
    const value = labels[i];
    if (value > 0) {
      voxels++;
      if (value !== last) seen.add(value);
    }
    last = value;
  }
  const [dx, dy, dz] = workerState.rasSpacing || [1, 1, 1];
  const labelText = seen.size > 1 ? `${seen.size} labels, ` : '';
  postAnalysis(`${stage}: ${labelText}${voxels} voxels (${(voxels * dx * dy * dz).toFixed(1)} mm^3)`);
  return voxels;
}

function postStageData(stage, niftiData, description) {
  workerMessages.stageData(stage, niftiData, description, {
    kind: 'nifti',
    taskId: self._currentTaskId || 'spinalcord',
  });
}

function postMetricsData(stage, metrics, description) {
  workerMessages.emit('stageData', {
    kind: 'metrics',
    stage,
    rows: metrics.rows || [],
    summary: metrics.summary || null,
    csv: metrics.csv || '',
    filename: metrics.filename,
    description,
    taskId: self._currentTaskId || 'spinalcord'
  }, { transfer: false });
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

// ==================== NIfTI Output ====================

function createOutputNifti(uint8Data, sourceHeader, dims) {
  return createNiftiFromData(uint8Data, sourceHeader, { dims });
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






function orientationFlipAxesFromRAS(modelOrientation) {
  if (!modelOrientation || modelOrientation === 'RAS') return [];
  if (modelOrientation === 'RPI') return [1, 2];
  if (modelOrientation === 'LPI') return [0, 1, 2];
  throw new Error(`Unsupported modelOrientation "${modelOrientation}"`);
}



function shouldUseZYXModelAxisOrder(preprocessing, dims, patchSize) {
  const modelAxisOrder = preprocessing?.modelAxisOrder;
  if (modelAxisOrder === 'zyx') return true;
  if (modelAxisOrder !== 'zyx-if-x-short-z-long') return false;

  const [nx, , nz] = dims;
  const [px] = Array.isArray(patchSize) ? patchSize : [];
  return Number.isFinite(px) && nx < px && nz >= px;
}

// ==================== Model Loading ====================

async function fetchModel(url, modelName, progressBase, progressSpan) {
  const displayName = modelName || url.split("/").pop();
  const cacheKey = self._modelCacheKey || `${url}?v=${self._appVersion || ""}`;
  const bytes = await fetchModelAsset(
    { url, urls: [url, url], cacheKey, integrity: { minBytes: 100001 } },
    {
      cache: localForageCache(localforage),
      onInvalidCache: error => postLog(`Discarding cached model: ${error.message}`),
      onCacheError: () => postLog("Warning: Could not cache model (storage full?)"),
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
    postAnalysis(`Input volume: ${prepared.origDims.join('x')}, spacing: ${prepared.rasSpacing.map(value => value.toFixed(3)).join('x')}mm`);
    postLog(`RAS dims: ${prepared.rasDims.join('x')}`);
  }

  workerState.segLabelsRAS = null;
  workerState.lesionLabelsRAS = null;
  workerState.segMinComponentSize = 10;
  postVolumeInfo({ rasDims: [...prepared.rasDims], rasSpacing: [...prepared.rasSpacing], totalSlices: prepared.rasDims[2] });
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
    keepLargestComponent = false,
    taskId = 'spinalcord',
    modelAssetId = 'sct-spinalcord',
    modelName = 'sct-spinalcord.onnx',
    modelUrl,
    patchSize = [64, 64, 64],
    modelBaseUrl,
    supportStatus = 'unvalidated',
    testTimeAugmentation = false,
    cacheKey,
    provenance = {},
    preprocessing = {},
    output = {}
  } = params;

  if (supportStatus !== 'supported') {
    throw new Error(`SCT task "${taskId}" is ${supportStatus}. Convert and validate model asset "${modelAssetId}" before running inference.`);
  }
  self._currentTaskId = taskId;

  // Download + create ONNX session.
  self._modelCacheKey = cacheKey || `${taskId}:${modelAssetId}:${self._appVersion || ''}`;
  const resolvedModelUrl = modelUrl || `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(resolvedModelUrl, modelName, 0.05, 0.15);
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
    const spacingText = targetSpacing.map(v => v.toFixed(3)).join('x');
    const modelOrderSpacing = preprocessing.modelAxisOrder === 'zyx'
      ? [targetSpacing[2], targetSpacing[1], targetSpacing[0]]
      : targetSpacing;
    const modelOrderText = modelOrderSpacing.map(v => v.toFixed(3)).join('x');
    postLog(`Resampled for ${taskId}: ${modelInputDims.join('x')} -> ${resampled.dims.join('x')} at ${spacingText} mm RAS/XYZ (model order ${modelOrderText} mm)`);
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

  const modelOrientationFlipAxes = orientationFlipAxesFromRAS(preprocessing.modelOrientation);
  if (modelOrientationFlipAxes.length > 0) {
    const oriented = flipVolumeAxes(modelInputData, modelInputDims, modelOrientationFlipAxes, Float32Array);
    postLog(`Reoriented for ${taskId}: RAS -> ${preprocessing.modelOrientation}`);
    modelInputData = oriented.data;
    modelInputDims = oriented.dims;
    const previousOutputToRas = modelOutputToRas;
    modelOutputToRas = (labels, dims, OutputCtor) => {
      const restored = flipVolumeAxes(labels, dims, modelOrientationFlipAxes, OutputCtor || Uint8Array);
      return previousOutputToRas(restored.data, restored.dims, OutputCtor || Uint8Array);
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

  const runPatch = async (patch, patchDims) => {
    const [p0, p1, p2] = patchDims;
    const inputTensor = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
    const out = await session.run({ [inputName]: inputTensor });
    const logits = out[outputName].data;
    inputTensor.dispose();
    return logits;
  };

  const progressHandler = (stepsDone, totalSteps, label) => {
    const elapsed = (performance.now() - inferenceStartTime) / 1000;
    const eta = stepsDone > 0 ? (elapsed / stepsDone) * (totalSteps - stepsDone) : 0;
    const frac = totalSteps > 0 ? stepsDone / totalSteps : 0;
    postProgress(0.25 + 0.55 * frac, `${label} (ETA: ${eta.toFixed(0)}s)`);
  };

  if (output.activation === 'sigmoid-regions') {
    const regions = Array.isArray(output.regions) ? output.regions : [];
    const channelCount = output.channelCount || output.channelOrder?.length || regions.length || 1;
    const result = await SCTInferencePipeline.runRegionInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap,
        threshold,
        minComponentSize,
        testTimeAugmentation,
        channelCount,
        regions,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
        onPatchStats: (pi, s) => {
          const channelText = s.channels.map(channel => (
            `c${channel.channel}: logit=[${channel.oMin.toFixed(3)},${channel.oMax.toFixed(3)}], prob=[${channel.pMin.toFixed(4)},${channel.pMax.toFixed(4)}] mean=${channel.pMean.toFixed(4)}, n>thr=${channel.pAbove}`
          )).join('; ');
          postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${channelText}`);
        }
      }
    );
    await session.release();
    postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

    postProgress(0.86, 'Inverse transform...');
    let spinalCordRAS = null;
    let lesionRAS = null;
    for (const region of result.regions) {
      const stage = region.stage || region.name || `channel_${region.channel}`;
      const description = region.description || (stage === 'lesion' ? 'SCI lesion segmentation' : 'SCT segmentation');
      const preCleanupRAS = modelOutputToRas(region.preCleanupLabels, region.dims, Uint8Array);
      const outputRAS = modelOutputToRas(region.labels, region.dims, Uint8Array);
      if (stage === 'segmentation') {
        workerState.segLabelsRAS = new Uint8Array(preCleanupRAS.data);
        workerState.segMinComponentSize = minComponentSize;
        spinalCordRAS = new Uint8Array(outputRAS.data);
      }
      if (stage === 'lesion') {
        workerState.lesionLabelsRAS = new Uint8Array(outputRAS.data);
        lesionRAS = new Uint8Array(outputRAS.data);
      }

      let outputLabels = new Uint8Array(outputRAS.data);
      if (!workerState.isIdentity) {
        outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
      }
      const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
      postStageData(stage, outputNifti, description);

      const finalVoxels = postMaskSummary(stage, outputLabels);
      if (finalVoxels === 0) {
        const stats = region.probStats;
        postAnalysis(`WARNING: ${stage} mask is empty. Probability map max=${stats?.max?.toFixed?.(4) || 'n/a'} (threshold=${region.threshold}).`, 'warning');
      }
    }

    if (workerState.segLabelsRAS) emitSegmentationStateArtifact();

    if (spinalCordRAS && lesionRAS && self.SCTLesionAnalysis) {
      postProgress(0.94, 'Computing lesion metrics...');
      const metrics = self.SCTLesionAnalysis.analyzeLesions({
        lesion: lesionRAS,
        spinalCord: spinalCordRAS,
        dims: workerState.rasDims,
        spacing: workerState.rasSpacing
      });
      metrics.filename = `${taskId}_lesion_metrics.csv`;
      postMetricsData('lesion_metrics', metrics, 'SCI lesion metrics');
      postAnalysis(`Lesion metrics: ${metrics.summary.lesion_count} lesion(s), total volume=${metrics.summary.total_volume_mm3} mm^3`);
    }
  } else if (output.activation === 'sigmoid-labels') {
    const channelCount = output.channelCount || output.channelOrder?.length || output.classLabels?.length || 1;
    const result = await SCTInferencePipeline.runSigmoidLabelInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap,
        threshold,
        testTimeAugmentation,
        channelCount,
        classLabels: output.classLabels,
        labelPriority: output.labelPriority,
        paddingMode: output.paddingMode,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
        onPatchStats: (pi, s) => {
          const channelText = s.channels.map(channel => (
            `c${channel.channel}: logit=[${channel.oMin.toFixed(3)},${channel.oMax.toFixed(3)}], prob=[${channel.pMin.toFixed(4)},${channel.pMax.toFixed(4)}] mean=${channel.pMean.toFixed(4)}, n>thr=${channel.pAbove}`
          )).join('; ');
          postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${channelText}`);
        }
      }
    );
    await session.release();
    postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

    postProgress(0.86, 'Inverse transform...');
    const rawRAS = modelOutputToRas(result.labels, result.dims, Uint8Array);
    if (output.postprocess === 'totalspineseg-step1') {
      if (!self.TotalSpineSeg) throw new Error('TotalSpineSeg post-processing module is not available.');
      postProgress(0.90, 'Labeling TotalSpineSeg discs...');
      const processed = self.TotalSpineSeg.postprocessStep1(rawRAS.data, rawRAS.dims, {
        discPointRadius: output.discPointRadius
      });
      for (const warning of processed.warnings) postAnalysis(`TotalSpineSeg warning: ${warning}`, 'warning');

      const stages = [
        {
          stage: 'spine_step1',
          labels: processed.step1Labels,
          description: 'TotalSpineSeg step 1 labels'
        },
        {
          stage: 'spine_discs',
          labels: processed.discLabels,
          description: 'TotalSpineSeg disc labels'
        }
      ];

      for (const stageOutput of stages) {
        let outputLabels = stageOutput.labels;
        if (!workerState.isIdentity) {
          outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
        }
        const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
        postStageData(stageOutput.stage, outputNifti, stageOutput.description);
        postMaskSummary(stageOutput.stage, outputLabels);
      }
    } else {
      let outputLabels = rawRAS.data;
      if (!workerState.isIdentity) {
        outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
      }
      const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
      postStageData('segmentation', outputNifti, 'SCT sigmoid-label segmentation');
      postMaskSummary('segmentation', outputLabels);
    }
  } else if (output.activation === 'softmax') {
    const channelCount = output.channelCount || output.channelOrder?.length || output.classLabels?.length || 1;
    const result = await SCTInferencePipeline.runMulticlassInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap,
        testTimeAugmentation,
        channelCount,
        classLabels: output.classLabels,
        paddingMode: output.paddingMode,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
        onPatchStats: (pi, s) => {
          const channelText = s.channels.map(channel => (
            `c${channel.channel}: logit=[${channel.oMin.toFixed(3)},${channel.oMax.toFixed(3)}], prob=[${channel.pMin.toFixed(4)},${channel.pMax.toFixed(4)}] mean=${channel.pMean.toFixed(4)}`
          )).join('; ');
          postLog(`Patch ${pi} pos=[${s.pos}]: in=[${s.inMin.toFixed(3)},${s.inMax.toFixed(3)}] mean=${s.inMean.toFixed(3)}; ${channelText}`);
        }
      }
    );
    await session.release();
    postLog(`Inference complete in ${((performance.now() - inferenceStartTime) / 1000).toFixed(1)}s`);

    postProgress(0.86, 'Inverse transform...');
    const rawRAS = modelOutputToRas(result.labels, result.dims, Uint8Array);
    if (output.postprocess === 'totalspineseg-step1') {
      if (!self.TotalSpineSeg) throw new Error('TotalSpineSeg post-processing module is not available.');
      postProgress(0.90, 'Labeling TotalSpineSeg discs...');
      const processed = self.TotalSpineSeg.postprocessStep1(rawRAS.data, rawRAS.dims, {
        discPointRadius: output.discPointRadius
      });
      for (const warning of processed.warnings) postAnalysis(`TotalSpineSeg warning: ${warning}`, 'warning');

      const stages = [
        {
          stage: 'spine_step1',
          labels: processed.step1Labels,
          description: 'TotalSpineSeg step 1 labels'
        },
        {
          stage: 'spine_discs',
          labels: processed.discLabels,
          description: 'TotalSpineSeg disc labels'
        }
      ];

      for (const stageOutput of stages) {
        let outputLabels = stageOutput.labels;
        if (!workerState.isIdentity) {
          outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
        }
        const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
        postStageData(stageOutput.stage, outputNifti, stageOutput.description);
        postMaskSummary(stageOutput.stage, outputLabels);
      }
    } else {
      let outputLabels = rawRAS.data;
      if (!workerState.isIdentity) {
        outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
      }
      const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
      postStageData('segmentation', outputNifti, 'SCT multiclass segmentation');
      postMaskSummary('segmentation', outputLabels);
    }
  } else {
    // Delegate the per-patch inference + sliding-window orchestration to the
    // shared pipeline module, injecting an ORT-backed runPatch callback.
    const result = await SCTInferencePipeline.runInferencePipeline(
      {
        data: modelInputData,
        dims: modelInputDims,
        patchSize
      },
      runPatch,
      {
        overlap, threshold, minComponentSize, keepLargestComponent, testTimeAugmentation,
        onLog: (msg) => postLog(msg),
        onProgress: progressHandler,
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
    postStageData('segmentation', outputNifti, 'SCT segmentation');

    const finalVoxels = postMaskSummary('segmentation', outputLabels);
    if (finalVoxels === 0) {
      postAnalysis(`WARNING: Segmentation is empty. Probability map max=${result.probStats.max.toFixed(4)} (threshold=${threshold}). Try lowering the probability threshold or check input contrast/orientation.`, 'warning');
    }
  }

  postProgress(1.0, 'Complete');
  postStepComplete('inference');
  postComplete();
}

async function stepVertebralLabeling(params = {}) {
  if (!workerState.rasData) {
    throw new Error('No volume loaded. Run Load first.');
  }
  if (!workerState.segLabelsRAS) {
    throw new Error('No spinal cord segmentation is available. Run segmentation first.');
  }
  if (!self.SCTVertebrae) {
    throw new Error('Vertebral labeling module is not available.');
  }

  self._currentTaskId = 'vertebrae';
  postProgress(0.05, 'Loading vertebral labeling assets...');
  const modelBaseUrl = params.modelBaseUrl || '../models';
  const c2c3ModelUrl = params.c2c3ModelUrl || `${modelBaseUrl}/c2c3_disc_models/t2_model.yml`;
  const pam50LevelsUrl = params.pam50LevelsUrl || `${modelBaseUrl}/templates/PAM50/PAM50_levels.nii.gz`;
  const result = await self.SCTVertebrae.labelVertebrae({
    anatomy: workerState.rasData,
    segmentation: workerState.segLabelsRAS,
    dims: workerState.rasDims,
    spacing: workerState.rasSpacing,
    c2c3ModelUrl,
    pam50LevelsUrl,
    scaleDist: params.scaleDist ?? 0.55,
    detectorMinScore: params.detectorMinScore ?? 0.1
  });

  postProgress(0.85, 'Writing vertebral labels...');
  postLog(`C2-C3 detector: z=${result.detected.z}, score=${Number.isFinite(result.detected.score) ? result.detected.score.toFixed(4) : 'n/a'}, fallback=${!!result.detected.fallback}`);
  postLog(`Vertebral boundaries: ${result.boundaries.map(boundary => boundary.z).join(', ')}`);

  let outputLabels = result.labels;
  if (!workerState.isIdentity) {
    outputLabels = inverseOrient(outputLabels, workerState.rasDims, workerState.perm, workerState.flip, workerState.origDims);
  }

  const outputNifti = createOutputNifti(outputLabels, workerState.origHeaderBytes, workerState.origDims);
  postStageData('vertebrae', outputNifti, 'SCT vertebral labeling');

  postProgress(1.0, 'Vertebral labeling complete');
  postStepComplete('processing');
}

// ==================== Message Handler ====================

installWorkerRouter({
  scope: self,
  getServices: loadDependencies,
  handle: async ({ type, data, ...message }) => {

  switch (type) {
    case 'init':
      try {
        self._appVersion = message.version || '';
        ort.env.wasm.numThreads = getOptimalWasmThreads();
        ort.env.wasm.wasmPaths = '../wasm/';

        postLog(`Using WASM backend (${ort.env.wasm.numThreads} threads)`);

        localforage.config({
          name: 'SCTModelCache',
          storeName: 'models'
        });

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

    case 'run-vertebral-labeling':
      try {
        await stepVertebralLabeling(data || {});
      } catch (error) {
        console.error('Vertebral labeling error:', error);
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

    // Legacy support for old 'run' message
    case 'run':
      try {
        // Decompose the old single-run into steps for backwards compat
        const { inputData, settings } = data;
        stepLoad(inputData);
        await stepInference({
          overlap: settings.overlap,
          taskId: settings.taskId,
          modelAssetId: settings.modelAssetId,
          supportStatus: settings.supportStatus,
          cacheKey: settings.cacheKey,
          provenance: settings.provenance,
          threshold: settings.threshold ?? settings.probabilityThreshold,
          minComponentSize: settings.minComponentSize,
          keepLargestComponent: settings.keepLargestComponent,
          modelName: settings.modelName,
          modelUrl: settings.modelUrl,
          patchSize: settings.patchSize,
          preprocessing: settings.preprocessing,
          output: settings.output,
          testTimeAugmentation: settings.testTimeAugmentation,
          modelBaseUrl: settings.modelBaseUrl
        });
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;
  }
  }
});
