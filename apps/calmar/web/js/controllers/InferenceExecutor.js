import { downloadFile } from '@neurodesk/webapp-components/file-io';
/**
 * InferenceExecutor
 *
 * Handles Web Worker lifecycle for ONNX model inference.
 * Supports both step-by-step interactive pipeline and legacy single-run mode.
 */

import { VERSION } from '../app/config.js';

export class InferenceExecutor {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.updateDebugOutput = options.updateDebugOutput || this.updateOutput;
    this.setProgress = options.setProgress || (() => {});
    this.onStageData = options.onStageData || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onInitialized = options.onInitialized || (() => {});
    this.onStepComplete = options.onStepComplete || (() => {});
    this.onVolumeInfo = options.onVolumeInfo || (() => {});

    this.worker = null;
    this.workerReady = false;
    this.workerInitializing = false;
    this.running = false;
    this.webgpuAvailable = false;
    this.results = {};
    this.stageOrder = [];
    this.inputVolumeBuffer = null;
    this.currentRunningStep = null;
    this.pendingAbortCheckpoint = null;
    this.currentTaskId = null;
    this.hiddenArtifacts = this._createEmptyHiddenArtifacts();
    this.restoreStateResolve = null;
    this.restoreStateReject = null;

    // Step status tracking
    this.stepStatus = {
      load: 'pending',
      brainmask: 'pending',
      inference: 'pending',
      processing: 'pending',
      register: 'pending',
      'warp-mask': 'pending',
      'inverse-warp-mask': 'pending'
    };
    this.volumeInfo = null;
  }

  isReady() { return this.workerReady; }
  isRunning() { return this.running; }

  hasResult(stage) { return !!this.results[stage]?.file; }
  getResult(stage) { return this.results[stage] || null; }
  getResults() { return this.results; }
  getStageOrder() { return this.stageOrder; }

  getStepStatus(step) { return this.stepStatus[step]; }
  getVolumeInfo() { return this.volumeInfo; }

  _createEmptyHiddenArtifacts() {
    return {
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

    this.worker = new Worker(`js/inference-worker.js?v=${VERSION}`, { type: 'module' });

    // Surface module-worker boot failures (top-level imports, top-level
    // await throws, etc.). Without this the orchestrator would sit forever
    // waiting for 'initialized'.
    this.worker.onerror = (event) => {
      const detail = [event.message, event.filename, event.lineno && `line ${event.lineno}`]
        .filter(Boolean).join(' ');
      const message = `Worker error: ${detail || '(no detail)'}`;
      this.updateOutput(message);
      this.onError(message);
    };
    this.worker.onmessageerror = (event) => {
      const message = `Worker messageerror: ${event?.data || '(no detail)'}`;
      this.updateOutput(message);
      this.onError(message);
    };

    this.worker.onmessage = (e) => {
      const { type, ...data } = e.data;

      switch (type) {
        case 'progress':
          this.setProgress(data.value, data.text);
          break;
        case 'log':
          this.updateDebugOutput(data.message, { source: 'worker', audience: 'technical' });
          break;
        case 'error':
          this._handleError(data.message);
          break;
        case 'initialized':
          this.workerReady = true;
          this.workerInitializing = false;
          this.webgpuAvailable = !!data.webgpuAvailable;
          this.updateDebugOutput('ONNX Runtime ready', { source: 'worker', audience: 'technical' });
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
    const taskId = data.taskId || this.currentTaskId || 'sct';
    const file = new File([blob], `${taskId}_${data.stage}.nii`, { type: 'application/octet-stream' });
    this.results[data.stage] = {
      file: file,
      description: data.description
    };

    Promise.resolve(this.onStageData(data)).catch(err => {
      console.error('Error handling stage data:', err);
      this.updateOutput(`Error displaying ${data.stage}: ${err.message}`);
    });
  }

  _handleStepComplete(step) {
    // Preserve 'skipped' status if already set by skip method
    if (this.stepStatus[step] !== 'skipped') {
      this.stepStatus[step] = 'complete';
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
    this.updateDebugOutput('Initializing ONNX Runtime...', { source: 'worker', audience: 'technical' });

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
    this.worker.postMessage(
      { type: 'load', data: { inputData } },
      [inputData]
    );
  }

  async runInference(settings) {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'inference') {
      this.captureCheckpoint('inference');
    }
    this.running = true;
    this.currentRunningStep = 'inference';
    this.currentTaskId = settings?.taskId || null;
    this.stepStatus.inference = 'running';
    this.worker.postMessage({ type: 'run-inference', data: settings });
  }

  async runDeepIslesInference(settings) {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'inference') {
      this.captureCheckpoint('inference');
    }
    this.running = true;
    this.currentRunningStep = 'inference';
    this.currentTaskId = settings?.taskId || null;
    this.stepStatus.inference = 'running';
    const transferables = [];
    if (settings?.dwiBuffer instanceof ArrayBuffer) transferables.push(settings.dwiBuffer);
    if (settings?.adcBuffer instanceof ArrayBuffer) transferables.push(settings.adcBuffer);
    this.worker.postMessage({ type: 'run-deepisles-inference', data: settings }, transferables);
  }

  // Phase 2a.1.4b: SynthStrip brain-extraction stage. Posts to the worker's
  // 'run-synthstrip' op (see web/js/inference-worker.js stepSynthStrip).
  // Settings shape:
  //   { modelAssetId, modelName, modelBaseUrl, cacheKey, fast?, dilate? }
  async runSynthStrip(settings = {}) {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'brainmask') {
      this.captureCheckpoint('brainmask');
    }
    this.running = true;
    this.currentRunningStep = 'brainmask';
    this.currentTaskId = settings?.modelAssetId || null;
    this.stepStatus.brainmask = 'running';
    this.worker.postMessage({ type: 'run-synthstrip', data: settings });
  }

  // Phase 3.4: SynthMorph MNI registration stage. Posts to the worker's
  // 'run-register' op. Settings shape:
  //   { modelAssetId, modelName, modelBaseUrl, modelCacheKey,
  //     referenceAssetId, referenceUrl, referenceCacheKey,
  //     brainMaskBuffer?, brainMaskDims?, nbSteps? }
  async runRegistration(settings = {}) {
    await this.initialize();
    if (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== 'register') {
      this.captureCheckpoint('register');
    }
    this.running = true;
    this.currentRunningStep = 'register';
    this.currentTaskId = settings?.modelAssetId || null;
    this.stepStatus.register = 'running';
    const transferList = [];
    if (settings?.brainMaskBuffer instanceof ArrayBuffer) {
      transferList.push(settings.brainMaskBuffer);
    }
    this.worker.postMessage({ type: 'run-register', data: settings }, transferList);
  }

  // Phase 3.5: warp a mask in F-order Uint8 voxel-bytes through the
  // displacement left on workerState by runRegistration.
  async runWarpMask(settings = {}) {
    await this.initialize();
    this.running = true;
    this.currentRunningStep = 'warp-mask';
    this.stepStatus['warp-mask'] = 'running';
    const transferList = [];
    if (settings.maskBuffer instanceof ArrayBuffer) transferList.push(settings.maskBuffer);
    this.worker.postMessage({ type: 'warp-mask', data: settings }, transferList);
  }

  async runInverseWarpMask(settings = {}) {
    await this.initialize();
    this.running = true;
    this.currentRunningStep = 'inverse-warp-mask';
    this.stepStatus['inverse-warp-mask'] = 'running';
    const transferList = [];
    if (settings.maskBuffer instanceof ArrayBuffer) transferList.push(settings.maskBuffer);
    this.worker.postMessage({ type: 'inverse-warp-mask', data: settings }, transferList);
  }

  async resetWorkerState() {
    await this.initialize();
    this.worker.postMessage({ type: 'reset-state' });
    this.stepStatus = {
      load: 'pending',
      brainmask: 'pending',
      inference: 'pending',
      processing: 'pending',
      register: 'pending',
      'warp-mask': 'pending',
      'inverse-warp-mask': 'pending'
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
  }

  captureCheckpoint(step) {
    this.pendingAbortCheckpoint = {
      step,
      inputBuffer: this.inputVolumeBuffer,
      stepStatus: { ...this.stepStatus },
      results: this._cloneResults(this.results),
      stageOrder: [...this.stageOrder],
      volumeInfo: this.volumeInfo ? { ...this.volumeInfo } : null,
      hiddenArtifacts: this._cloneHiddenArtifacts(this.hiddenArtifacts)
    };
    return this.pendingAbortCheckpoint;
  }

  async _createRestorePayload(checkpoint) {
    if (!checkpoint?.inputBuffer) {
      throw new Error('No input volume is available for restore');
    }

    return {
      inputData: checkpoint.inputBuffer.slice(0),
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
    const steps = ['load', 'inference', 'processing'];
    const idx = steps.indexOf(fromStep);
    if (idx < 0) return;
    for (let i = idx + 1; i < steps.length; i++) {
      this.stepStatus[steps[i]] = 'pending';
    }
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
