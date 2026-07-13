import { downloadFile } from '@neurodesk/webapp-components/file-io';
/**
 * InferenceExecutor
 *
 * Handles Web Worker lifecycle for ONNX model inference.
 * Supports both step-by-step interactive pipeline and legacy single-run mode.
 */

import { VERSION } from '../app/config.js';
import { PipelineGraph } from '../modules/pipeline/PipelineGraph.js';
import {
  analysisVolumeSpace,
  readNiftiSpatialMetadata,
  spatialGridId,
  tagSpatialFile,
  VOLUME_SPACES
} from '../modules/spatial-file.js';

export class InferenceExecutor {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.setProgress = options.setProgress || (() => {});
    this.onStageData = options.onStageData || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onInitialized = options.onInitialized || (() => {});
    this.onStepComplete = options.onStepComplete || (() => {});
    this.onVolumeInfo = options.onVolumeInfo || (() => {});
    this.onBrainMaskOverlay = options.onBrainMaskOverlay || null;

    this.worker = null;
    this.brainMaskOverlayFile = null;
    this.workerReady = false;
    this.workerInitializing = false;
    this.running = false;
    this.webgpuAvailable = false;
    this.wasmAvailable = false;
    this.results = {};
    this.stageOrder = [];
    this.inputVolumeBuffer = null;
    this.currentRunningStep = null;
    this.pendingAbortCheckpoint = null;
    this.hiddenArtifacts = this._createEmptyHiddenArtifacts();
    this.restoreStateResolve = null;
    this.restoreStateReject = null;
    this.graph = new PipelineGraph();
    this.currentStepParams = {};
    this.sourceSpatial = null;

    // Step status tracking
    this.stepStatus = {
      load: 'pending',
      downsample: 'pending',
      n4: 'pending',
      bet: 'pending',
      denoise: 'pending',
      inference: 'pending'
    };
    this.volumeInfo = null;
  }

  isReady() { return this.workerReady; }
  isRunning() { return this.running; }

  hasResult(stage) { return !!this.results[stage]?.file; }
  getResult(stage) { return this.results[stage] || null; }
  getResults() { return this.results; }
  getStageOrder() { return this.stageOrder; }
  getPipelineGraph() { return this.graph; }

  getStepStatus(step) { return this.stepStatus[step]; }
  getVolumeInfo() { return this.volumeInfo; }

  _createEmptyHiddenArtifacts() {
    return {
      n4State: { preN4Data: null },
      betState: { brainMask: null, preBETMask: null },
      denoiseState: { preDenoiseData: null },
      segmentationState: { segLabelsRAS: null, segMinComponentSize: 10 }
    };
  }

  _cloneValue(value) {
    if (value == null || typeof value !== 'object') return value;
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) return new value.constructor(value);
    if (Array.isArray(value)) return value.map(item => this._cloneValue(item));

    const cloned = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      cloned[key] = this._cloneValue(nestedValue);
    }
    return cloned;
  }

  _cloneResults(results) {
    const cloned = {};
    for (const [stage, result] of Object.entries(results || {})) {
      cloned[stage] = result ? { ...result } : result;
    }
    return cloned;
  }

  _cloneHiddenArtifacts(artifacts) {
    return this._cloneValue(artifacts || this._createEmptyHiddenArtifacts());
  }

  _collectTransferables(value, transferables, seen = new Set()) {
    if (!value || typeof value !== 'object') return;

    if (value instanceof ArrayBuffer) {
      if (!seen.has(value)) {
        seen.add(value);
        transferables.push(value);
      }
      return;
    }

    if (ArrayBuffer.isView(value)) {
      this._collectTransferables(value.buffer, transferables, seen);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) this._collectTransferables(item, transferables, seen);
      return;
    }

    for (const nestedValue of Object.values(value)) {
      this._collectTransferables(nestedValue, transferables, seen);
    }
  }

  _clearRunningStepState() {
    this.running = false;
    this.currentRunningStep = null;
    this.pendingAbortCheckpoint = null;
  }

  _terminateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.workerReady = false;
    this.workerInitializing = false;
  }

  _rejectPendingRestore(message) {
    if (!this.restoreStateReject) return;
    const reject = this.restoreStateReject;
    this.restoreStateResolve = null;
    this.restoreStateReject = null;
    reject(new Error(message));
  }

  _setupWorker() {
    if (this.worker) return;

    this.worker = new Worker(`js/inference-worker.js?v=${VERSION}`);

    this.worker.onmessage = (e) => {
      const { type, ...data } = e.data;

      switch (type) {
        case 'progress':
          this.setProgress(data.value, data.text);
          break;
        case 'log':
          this.updateOutput(data.message);
          break;
        case 'error':
          this._handleError(data.message);
          break;
        case 'initialized':
          this.workerReady = true;
          this.workerInitializing = false;
          this.webgpuAvailable = !!data.webgpuAvailable;
          this.wasmAvailable = !!data.wasmPreprocessingAvailable;
          this.updateOutput('ONNX Runtime ready');
          this.onInitialized();
          break;
        case 'complete':
          this._handleComplete();
          break;
        case 'stageData':
          this._handleStageData(data);
          break;
        case 'step-complete':
          this._handleStepComplete(data.step);
          break;
        case 'volume-info':
          this._handleVolumeInfo(data);
          break;
        case 'state-artifact':
          this._handleStateArtifact(data);
          break;
        case 'brain-mask-overlay':
          this._handleBrainMaskOverlay(data);
          break;
        case 'state-restored':
          this._handleStateRestored();
          break;
      }
    };

    this.worker.onerror = (e) => {
      this.updateOutput(`Worker error: ${e.message}`);
      console.error('Worker error:', e);
      this._handleError(e.message);
    };
  }

  _handleError(message) {
    this.updateOutput(`Error: ${message}`);
    this.setProgress(0, 'Failed');
    this._rejectPendingRestore(message);
    this._clearRunningStepState();
    this.onError(message);
  }

  _handleComplete() {
    this.updateOutput('Segmentation completed successfully!');
    this.running = false;
    this.currentRunningStep = null;
    this.pendingAbortCheckpoint = null;
    this.onComplete();
  }

  _handleStageData(data) {
    if (!this.stageOrder.includes(data.stage)) {
      this.stageOrder.push(data.stage);
    }

    const blob = new Blob([data.niftiData], { type: 'application/octet-stream' });
    const file = new File([blob], `${data.stage}.nii`, { type: 'application/octet-stream' });
    const spatial = this._tagStageFile(file, data.stage, data.niftiData);
    this.results[data.stage] = {
      file: file,
      description: data.description,
      spatial
    };

    const nodeId = this.graph.getNodeForStage(data.stage);
    this.graph.recordArtifact(nodeId, {
      stage: data.stage,
      role: data.stage,
      file,
      description: data.description,
      spatial
    });
    if (data.stage === 'segmentation') {
      this.stepStatus.inference = 'complete';
      this.graph.markNodeComplete('inference', {
        mode: 'run',
        params: this.currentStepParams.inference || {}
      });
    }

    Promise.resolve(this.onStageData(data)).catch(err => {
      console.error('Error handling stage data:', err);
      this.updateOutput(`Error displaying ${data.stage}: ${err.message}`);
    });
  }

  _handleBrainMaskOverlay(data) {
    const blob = new Blob([data.niftiData], { type: 'application/octet-stream' });
    this.brainMaskOverlayFile = new File([blob], 'brain-mask.nii', { type: 'application/octet-stream' });
    const spatial = this._tagStageFile(this.brainMaskOverlayFile, 'brainmask', data.niftiData);
    if (!this.stageOrder.includes('brainmask')) {
      this.stageOrder.push('brainmask');
    }
    this.results.brainmask = {
      file: this.brainMaskOverlayFile,
      description: 'Brain mask',
      spatial
    };
    this.graph.recordArtifact('bet', {
      stage: 'brainmask',
      role: 'brainmask',
      file: this.brainMaskOverlayFile,
      description: 'Brain mask overlay',
      spatial
    });
    if (this.onBrainMaskOverlay) {
      this.onBrainMaskOverlay(this.brainMaskOverlayFile);
    }
  }

  _handleStepComplete(step) {
    // Preserve 'skipped' status if already set by skip method
    if (this.stepStatus[step] !== 'skipped') {
      this.stepStatus[step] = 'complete';
    }
    if (this.graph.nodes?.has(step)) {
      this.graph.markNodeComplete(step, {
        mode: this.stepStatus[step] === 'skipped' ? 'skip' : 'run',
        params: this.currentStepParams[step] || {}
      });
    }
    this.running = false;
    if (this.currentRunningStep === step) {
      this.currentRunningStep = null;
      this.pendingAbortCheckpoint = null;
    }
    this.onStepComplete(step);
  }

  _handleVolumeInfo(data) {
    this.volumeInfo = {
      rasDims: data.rasDims,
      rasSpacing: data.rasSpacing,
      totalSlices: data.totalSlices
    };
    this.onVolumeInfo(this.volumeInfo);
  }

  _handleStateArtifact(data) {
    if (!data.artifact) return;
    this.hiddenArtifacts[data.artifact] = this._cloneValue(data.payload);
  }

  _handleStateRestored() {
    if (!this.restoreStateResolve) return;
    const resolve = this.restoreStateResolve;
    this.restoreStateResolve = null;
    this.restoreStateReject = null;
    resolve();
  }

  async initialize() {
    this._setupWorker();

    if (this.workerReady) return;

    if (this.workerInitializing) {
      return new Promise((resolve) => {
        const checkReady = setInterval(() => {
          if (this.workerReady) {
            clearInterval(checkReady);
            resolve();
          }
        }, 100);
      });
    }

    this.workerInitializing = true;
    this.updateOutput('Initializing ONNX Runtime...');

    this.worker.postMessage({ type: 'init', version: VERSION });

    return new Promise((resolve) => {
      const checkReady = setInterval(() => {
        if (this.workerReady) {
          clearInterval(checkReady);
          resolve();
        }
      }, 100);
    });
  }

  // ==================== Step Methods ====================

  async loadVolume(inputData) {
    await this.initialize();
    this.inputVolumeBuffer = inputData.slice(0);
    this.running = true;
    this.stepStatus.load = 'running';
    this.graph.setNodeRunning('load', { params: {} });
    this.worker.postMessage(
      { type: 'load', data: { inputData } },
      [inputData]
    );
  }

  async downsample(factor) {
    await this.initialize();
    this.invalidateFromStep('downsample', { includeSelf: true });
    this.running = true;
    this.stepStatus.downsample = 'running';
    this.currentStepParams.downsample = { factor };
    this.graph.setNodeRunning('downsample', { params: this.currentStepParams.downsample });
    const inputData = this.inputVolumeBuffer?.slice(0);
    if (inputData) {
      this.worker.postMessage({ type: 'downsample-from-input', data: { inputData, factor } }, [inputData]);
    } else {
      this.worker.postMessage({ type: 'downsample', data: { factor } });
    }
  }

  skipDownsample() {
    this.invalidateFromStep('downsample', { includeSelf: true });
    this.stepStatus.downsample = 'skipped';
    this.currentStepParams.downsample = { skipped: true };
    this.graph.markNodeSkipped('downsample', this.currentStepParams.downsample);
    this.running = true;
    const inputData = this.inputVolumeBuffer?.slice(0);
    if (inputData) {
      this.worker.postMessage({ type: 'skip-downsample', data: { inputData } }, [inputData]);
    } else {
      this.worker.postMessage({ type: 'skip-downsample' });
    }
  }

  async runN4() {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'n4') {
      this.captureCheckpoint('n4');
    }
    this.invalidateFromStep('n4', { includeSelf: true });
    this.running = true;
    this.currentRunningStep = 'n4';
    this.stepStatus.n4 = 'running';
    this.currentStepParams.n4 = { skipped: false };
    this.graph.setNodeRunning('n4', { params: this.currentStepParams.n4 });
    this.worker.postMessage({ type: 'run-n4' });
  }

  skipN4() {
    this.invalidateFromStep('n4', { includeSelf: true });
    this.stepStatus.n4 = 'skipped';
    this.currentStepParams.n4 = { skipped: true };
    this.graph.markNodeSkipped('n4', this.currentStepParams.n4);
    this.running = true;
    this.worker.postMessage({ type: 'skip-n4' });
  }

  async runBET(fractionalIntensity, method = 'bet', modelBaseUrl) {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'bet') {
      this.captureCheckpoint('bet');
    }
    this.invalidateFromStep('bet', { includeSelf: true });
    this.running = true;
    this.currentRunningStep = 'bet';
    this.stepStatus.bet = 'running';
    this.currentStepParams.bet = { fractionalIntensity, method, modelBaseUrl };
    this.graph.setNodeRunning('bet', { params: this.currentStepParams.bet });
    this.worker.postMessage({ type: 'run-bet', data: { fractionalIntensity, method, modelBaseUrl } });
  }

  skipBET() {
    this.invalidateFromStep('bet', { includeSelf: true });
    this.stepStatus.bet = 'skipped';
    this.currentStepParams.bet = { skipped: true };
    this.graph.markNodeSkipped('bet', this.currentStepParams.bet);
    this.running = true;
    this.worker.postMessage({ type: 'skip-bet' });
  }

  async applyBrainMask() {
    await this.initialize();
    this.running = true;
    this.worker.postMessage({ type: 'apply-brain-mask' });
  }

  async dilateBrainMask(iterations = 1) {
    await this.initialize();
    this.running = true;
    this.worker.postMessage({ type: 'dilate-brain-mask', data: { iterations } });
  }

  async erodeBrainMask(iterations = 1) {
    await this.initialize();
    this.running = true;
    this.worker.postMessage({ type: 'erode-brain-mask', data: { iterations } });
  }

  async runDenoise(method) {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'denoise') {
      this.captureCheckpoint('denoise');
    }
    this.invalidateFromStep('denoise', { includeSelf: true });
    this.running = true;
    this.currentRunningStep = 'denoise';
    this.stepStatus.denoise = 'running';
    this.currentStepParams.denoise = { method };
    this.graph.setNodeRunning('denoise', { params: this.currentStepParams.denoise });
    this.worker.postMessage({ type: 'run-denoise', data: { method } });
  }

  skipDenoise() {
    this.invalidateFromStep('denoise', { includeSelf: true });
    this.stepStatus.denoise = 'skipped';
    this.currentStepParams.denoise = { skipped: true };
    this.graph.markNodeSkipped('denoise', this.currentStepParams.denoise);
    this.running = true;
    this.worker.postMessage({ type: 'skip-denoise' });
  }

  async runInference(settings) {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'inference') {
      this.captureCheckpoint('inference');
    }
    this.invalidateFromStep('inference', { includeSelf: true });
    this.running = true;
    this.currentRunningStep = 'inference';
    this.stepStatus.inference = 'running';
    this.currentStepParams.inference = { ...settings };
    this.graph.setNodeRunning('inference', { params: this.currentStepParams.inference });
    this.worker.postMessage({ type: 'run-inference', data: settings });
  }

  async resetWorkerState() {
    await this.initialize();
    this.worker.postMessage({ type: 'reset-state' });
    this.stepStatus = {
      load: 'pending',
      downsample: 'pending',
      n4: 'pending',
      bet: 'pending',
      denoise: 'pending',
      inference: 'pending'
    };
    this.volumeInfo = null;
    this.results = {};
    this.stageOrder = [];
    this.hiddenArtifacts = this._createEmptyHiddenArtifacts();
    this.inputVolumeBuffer = null;
    this.currentRunningStep = null;
    this.pendingAbortCheckpoint = null;
    this.restoreStateResolve = null;
    this.restoreStateReject = null;
    this.graph.reset();
    this.currentStepParams = {};
    this.sourceSpatial = null;
  }

  captureCheckpoint(step) {
    this.pendingAbortCheckpoint = {
      step,
      inputBuffer: this.inputVolumeBuffer,
      stepStatus: { ...this.stepStatus },
      results: this._cloneResults(this.results),
      stageOrder: [...this.stageOrder],
      volumeInfo: this.volumeInfo ? { ...this.volumeInfo } : null,
      hiddenArtifacts: this._cloneHiddenArtifacts(this.hiddenArtifacts),
      graph: this.graph.snapshot(),
      currentStepParams: this._cloneValue(this.currentStepParams),
      sourceSpatial: this._cloneValue(this.sourceSpatial)
    };
    return this.pendingAbortCheckpoint;
  }

  async _createRestorePayload(checkpoint) {
    if (!checkpoint?.inputBuffer) {
      throw new Error('No input volume is available for restore');
    }

    const n4ResultData = checkpoint.results.n4?.file
      ? await checkpoint.results.n4.file.arrayBuffer()
      : null;
    const downsampleResultData = checkpoint.results.downsample?.file
      ? await checkpoint.results.downsample.file.arrayBuffer()
      : null;
    const denoiseResultData = checkpoint.results.nlm?.file
      ? await checkpoint.results.nlm.file.arrayBuffer()
      : null;

    return {
      inputData: checkpoint.inputBuffer.slice(0),
      downsampleResultData,
      n4ResultData,
      denoiseResultData,
      hiddenArtifacts: this._cloneHiddenArtifacts(checkpoint.hiddenArtifacts)
    };
  }

  async restoreCheckpoint(checkpoint) {
    await this.initialize();

    const payload = await this._createRestorePayload(checkpoint);
    const transferables = [];
    this._collectTransferables(payload, transferables);

    return new Promise((resolve, reject) => {
      this.restoreStateResolve = resolve;
      this.restoreStateReject = reject;
      this.worker.postMessage({ type: 'restore-state', data: payload }, transferables);
    });
  }

  async abortCurrentStep() {
    if (!this.running || !this.currentRunningStep || !this.pendingAbortCheckpoint) {
      return null;
    }

    const abortedStep = this.currentRunningStep;
    const checkpoint = this.pendingAbortCheckpoint;
    this.updateOutput(`Aborting ${abortedStep}...`);

    this._terminateWorker();
    this.running = false;
    this.currentRunningStep = null;

    try {
      await this.initialize();
      await this.restoreCheckpoint(checkpoint);

      this.results = this._cloneResults(checkpoint.results);
      this.stageOrder = [...checkpoint.stageOrder];
      this.volumeInfo = checkpoint.volumeInfo ? { ...checkpoint.volumeInfo } : null;
      this.hiddenArtifacts = this._cloneHiddenArtifacts(checkpoint.hiddenArtifacts);
      this.graph.restore(checkpoint.graph);
      this.currentStepParams = this._cloneValue(checkpoint.currentStepParams || {});
      this.sourceSpatial = this._cloneValue(checkpoint.sourceSpatial || null);
      this.stepStatus = {
        ...checkpoint.stepStatus,
        [abortedStep]: 'pending'
      };

      this.running = false;
      this.currentRunningStep = null;
      this.pendingAbortCheckpoint = null;

      this.setProgress(0, 'Ready');
      this.updateOutput(`Aborted ${abortedStep}. Restored previous state.`);

      return { abortedStep, checkpoint };
    } catch (error) {
      this.running = false;
      this.currentRunningStep = null;
      this.pendingAbortCheckpoint = null;
      throw error;
    }
  }

  // Reset downstream steps when a step is re-run
  resetDownstream(fromStep) {
    const steps = ['load', 'downsample', 'n4', 'denoise', 'inference', 'bet'];
    const idx = steps.indexOf(fromStep);
    if (idx < 0) return;
    for (let i = idx + 1; i < steps.length; i++) {
      // BET re-run does NOT invalidate downstream (mask is independent)
      if (fromStep === 'bet') break;
      this.stepStatus[steps[i]] = 'pending';
    }
  }

  setSourceFile(file, inputData) {
    const spatial = readNiftiSpatialMetadata(inputData);
    this.sourceSpatial = spatial;
    tagSpatialFile(file, {
      space: spatial ? VOLUME_SPACES.SOURCE_NATIVE : undefined,
      role: 'source',
      sourceStage: 'input',
      dims: spatial?.dims,
      affine: spatial?.affine
    });
    this.graph.loadSource({
      file,
      digest: this._bufferDigest(inputData),
      spatial: {
        space: spatial ? VOLUME_SPACES.SOURCE_NATIVE : undefined,
        dims: spatial?.dims,
        affine: spatial?.affine
      }
    });
  }

  invalidateFromStep(step, { includeSelf = false } = {}) {
    const invalidated = this.graph.invalidateFrom(step, { includeSelf });
    for (const stage of invalidated.stages) {
      delete this.results[stage];
    }
    this.stageOrder = this.stageOrder.filter(stage => !invalidated.stages.includes(stage));
    for (const node of invalidated.nodes) {
      if (this.stepStatus[node] !== undefined && node !== 'load') this.stepStatus[node] = 'pending';
    }
    return invalidated;
  }

  _tagStageFile(file, stage, niftiData) {
    const spatial = readNiftiSpatialMetadata(niftiData);
    const gridId = spatialGridId(spatial || {});
    const sameAsSource = this._sameSpatial(spatial, this.sourceSpatial);
    const metadata = {
      space: stage === 'input' || sameAsSource ? VOLUME_SPACES.SOURCE_NATIVE : analysisVolumeSpace(gridId),
      role: stage,
      sourceStage: stage,
      dims: spatial?.dims,
      affine: spatial?.affine
    };
    tagSpatialFile(file, metadata);
    return metadata;
  }

  _bufferDigest(buffer) {
    if (!(buffer instanceof ArrayBuffer)) return `source:${Date.now()}`;
    const bytes = new Uint8Array(buffer);
    let hash = 0;
    const stride = Math.max(1, Math.floor(bytes.length / 4096));
    for (let i = 0; i < bytes.length; i += stride) {
      hash = ((hash << 5) - hash + bytes[i]) | 0;
    }
    hash = ((hash << 5) - hash + bytes.length) | 0;
    return Math.abs(hash).toString(36);
  }

  _sameSpatial(a, b) {
    if (!a?.dims || !b?.dims) return false;
    if (a.dims.length !== b.dims.length || a.dims.some((value, index) => Number(value) !== Number(b.dims[index]))) {
      return false;
    }
    if (!a.affine || !b.affine) return true;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (Math.abs(Number(a.affine[r]?.[c]) - Number(b.affine[r]?.[c])) > 1e-3) return false;
      }
    }
    return true;
  }

  // ==================== Legacy Methods ====================

  async run(config) {
    try {
      await this.initialize();

      this.updateOutput('Starting segmentation...');
      this.running = true;
      this.results = {};
      this.stageOrder = [];

      this.worker.postMessage({
        type: 'run',
        data: config
      }, config.inputData ? [config.inputData] : []);

      return true;
    } catch (error) {
      this._handleError(error.message);
      return false;
    }
  }

  cancel() {
    if (!this.running) return;

    this.updateOutput('Cancelling...');
    this._rejectPendingRestore('Worker terminated');
    this._terminateWorker();
    this._clearRunningStepState();
    this.setProgress(0, 'Cancelled');
    this.updateOutput('Cancelled. Worker will be reinitialized on next action.');
  }

  removeResult(stage) {
    delete this.results[stage];
    this.stageOrder = this.stageOrder.filter(s => s !== stage);
  }

  clearResults() {
    this.invalidateFromStep('downsample', { includeSelf: true });
    this.results = {};
    this.stageOrder = [];
  }

  async downloadStage(stage) {
    if (!this.results[stage]?.file) {
      this.updateOutput(`${stage} not available`);
      return;
    }

    const file = this.results[stage].file;
    downloadFile(file);
  }

  downloadAll() {
    for (const stage of this.stageOrder) {
      this.downloadStage(stage);
    }
  }
}
