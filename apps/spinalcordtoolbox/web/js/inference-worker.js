/**
 * SpinalCordToolbox Inference Worker
 *
 * Adapts the shared SCT segmentation (packages/spinalcordtoolbox, staged into
 * web/vendor/spinalcordtoolbox) to the browser: ONNX Runtime Web, verified model
 * downloads cached in Cache Storage, and the worker message protocol.
 *   1. Load (NIfTI parse + orient to RAS)
 *   2. Inference (resample → normalize → crop → sliding window → threshold → CC → inverse)
 */

import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { createWorkerEmitter, fetchModel as fetchModelAsset, getOptimalWasmThreads, installWorkerRouter } from '../vendor/webapp-components/src/worker/index.js';
import { prepareInput, segmentPrepared } from '../vendor/spinalcordtoolbox/src/segment.js';

let nifti;
let dependenciesReady;

function loadDependencies() {
  dependenciesReady ||= import('../nifti-js/index.js').then(() => {
    nifti = globalThis.nifti;
    if (!nifti) throw new Error('SCT worker dependencies failed to initialize');
    return { nifti };
  });
  return dependenciesReady;
}

// ==================== Shared Worker State ====================

let prepared = null;
let segmentationState = null;

function resetState() {
  prepared = null;
  segmentationState = null;
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

const pipelineEvents = {
  log: (message) => postLog(message),
  analysis: postAnalysis,
  progress: postProgress,
};

function postStageResult(result) {
  if (result.kind === 'metrics') {
    workerMessages.emit('stageData', {
      kind: 'metrics',
      stage: result.stage,
      rows: result.rows,
      summary: result.summary,
      csv: result.csv,
      filename: result.filename,
      description: result.description,
      taskId: result.taskId
    }, { transfer: false });
    return;
  }
  workerMessages.stageData(result.stage, result.niftiData, result.description, {
    kind: 'nifti',
    taskId: result.taskId,
  });
}

function emitSegmentationStateArtifact() {
  const segLabelsRAS = segmentationState?.segLabelsRAS ? new Uint8Array(segmentationState.segLabelsRAS).buffer : null;
  workerMessages.emit('state-artifact', {
    artifact: 'segmentationState',
    payload: {
      segLabelsRAS,
      segMinComponentSize: segmentationState?.segMinComponentSize ?? 10
    }
  });
}

// ==================== Model Loading ====================

async function fetchModel({ url, modelName, sha256, bytes }, progressBase, progressSpan) {
  const displayName = modelName || url.split('/').pop();
  if (!/^[0-9a-f]{64}$/.test(sha256 || '') || !Number.isSafeInteger(bytes)) {
    throw new Error(`Model ${displayName} has no pinned SHA-256 and size.`);
  }
  const modelBytes = await fetchModelAsset(
    { url, urls: [url, url], cacheKey: url, integrity: { bytes, sha256 } },
    {
      onInvalidCache: error => postLog(`Discarding cached model: ${error.message}`),
      onCacheError: () => postLog('Warning: Could not cache model (storage full?)'),
      onProgress: ({ received, total, fraction }) => {
        if (fraction === null) return;
        const mb = (received / 1048576).toFixed(1);
        const totalMb = (total / 1048576).toFixed(0);
        postProgress(progressBase + fraction * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
      }
    }
  );
  postLog(`Loaded: ${displayName} (${(modelBytes.byteLength / 1048576).toFixed(1)} MB, SHA-256 verified)`);
  return modelBytes;
}

// ==================== Step Functions ====================

function prepareInputState(inputData, { emitUpdates = false } = {}) {
  const events = emitUpdates ? pipelineEvents : {};
  prepared = prepareInput(inputData, { decompress: buffer => nifti.decompress(buffer), events });
  segmentationState = null;
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

  const restored = data.hiddenArtifacts?.segmentationState;
  segmentationState = restored?.segLabelsRAS
    ? { segLabelsRAS: new Uint8Array(restored.segLabelsRAS), segMinComponentSize: restored.segMinComponentSize ?? 10 }
    : null;

  postLog('Worker state restored');
  workerMessages.emit('state-restored', {}, { transfer: false });
}

async function stepInference(params) {
  if (!prepared) {
    throw new Error('No volume loaded. Run Load first.');
  }

  const {
    taskId = 'spinalcord',
    modelAssetId = 'sct-spinalcord',
    modelName = 'sct-spinalcord.onnx',
    modelUrl,
    modelSha256,
    modelBytes,
    modelBaseUrl,
    supportStatus = 'unvalidated'
  } = params;

  if (supportStatus !== 'supported') {
    throw new Error(`SCT task "${taskId}" is ${supportStatus}. Convert and validate model asset "${modelAssetId}" before running inference.`);
  }

  // Download (or read from cache) and verify, then create the ONNX session.
  const resolvedModelUrl = modelUrl || `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel({ url: resolvedModelUrl, modelName, sha256: modelSha256, bytes: modelBytes }, 0.05, 0.15);

  postProgress(0.22, 'Loading ONNX model...');
  postLog('Creating ONNX InferenceSession (wasm - 3D ops require WASM backend)...');
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

  await segmentPrepared(prepared, params, {
    ort,
    session,
    events: {
      ...pipelineEvents,
      stage: postStageResult,
      segmentationState: (state) => {
        segmentationState = state;
        emitSegmentationStateArtifact();
      },
    },
  });

  postStepComplete('inference');
  postComplete();
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
          modelSha256: settings.modelSha256,
          modelBytes: settings.modelBytes,
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
