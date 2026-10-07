import { downloadFile } from '../file-io/download.js';
import { collectTransferables, WorkerEventType, WorkerRequestType } from './workerProtocol.js';
import { WorkerSession } from '../worker/WorkerSession.js';

export class PipelineExecutor {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl;
    this.workerType = options.workerType || 'module';
    this.createWorker = options.createWorker || null;
    this.version = options.version || '';
    this.initPayload = options.initPayload || {};
    this.updateOutput = options.updateOutput || (() => {});
    this.workerLog = options.workerLog || this.updateOutput;
    this.initializingMessage = options.initializingMessage === undefined ? 'Initializing worker...' : options.initializingMessage;
    this.readyMessage = options.readyMessage === undefined ? 'Worker ready' : options.readyMessage;
    this.setProgress = options.setProgress || (() => {});
    this.onStageData = options.onStageData || (() => {});
    this.onComplete = options.onComplete || options.onPipelineComplete || (() => {});
    this.onError = options.onError || options.onPipelineError || (() => {});
    this.onInitialized = options.onInitialized || (() => {});
    this.onStepComplete = options.onStepComplete || (() => {});
    this.onVolumeInfo = options.onVolumeInfo || (() => {});
    this.onMetrics = options.onMetrics || (() => {});
    this.onDetectedLabels = options.onDetectedLabels || (() => {});
    this.onStateArtifact = options.onStateArtifact || (() => {});
    this.onBrainMaskOverlay = options.onBrainMaskOverlay || null;
    this.resultFileName = options.resultFileName || ((stage, _data, context) => `${context?.taskId ? `${context.taskId}_` : ''}${stage}.nii`);
    this.stageDataKey = options.stageDataKey || null;

    this.workerSession = null;
    this.workerReady = false;
    this.workerInitializing = false;
    this.running = false;
    this.results = {};
    this.stageOrder = [];
    this.stepStatus = {};
    this.hiddenArtifacts = {};
    this.volumeInfo = null;
    this.metrics = null;
    this.lastRunSettings = null;
    this.pendingRestore = null;
    this.webgpuAvailable = false;
    this.wasmAvailable = false;
    this.steps = options.steps || ['load', 'inference', 'processing'];
    this.stepStatus = Object.fromEntries(this.steps.map(step => [step, 'pending']));
    this.hiddenArtifactDefaults = cloneValue(options.hiddenArtifacts || {});
    this.hiddenArtifacts = cloneValue(this.hiddenArtifactDefaults);
    this.inputVolumeBuffer = null;
    this.currentRunningStep = null;
    this.pendingAbortCheckpoint = null;
    this.currentTaskId = options.currentTaskId || null;
    this.checkpointExtension = options.checkpointExtension || null;
  }

  isReady() { return this.workerReady; }
  isRunning() { return this.running; }
  hasResult(stage) { return Boolean(this.results[stage]?.file); }
  getResult(stage) { return this.results[stage] || null; }
  getResults() { return this.results; }
  getStageOrder() { return this.stageOrder; }
  getStepStatus(step) { return this.stepStatus[step] || 'pending'; }
  getVolumeInfo() { return this.volumeInfo; }

  async initialize() {
    this.setupWorker();
    if (this.workerReady) return;
    if (this.workerInitializing) return this.waitUntilReady();
    this.workerInitializing = true;
    if (this.initializingMessage) this.updateOutput(this.initializingMessage);
    this.postRaw({ type: WorkerRequestType.INIT, ...this.initPayload, version: this.version }, { transfer: false });
    return this.waitUntilReady();
  }

  setupWorker() {
    if (this.workerSession) return;
    if (!this.createWorker && !this.workerUrl) throw new Error('PipelineExecutor requires createWorker or workerUrl');
    this.workerSession = new WorkerSession({
      createWorker: this.createWorker || (() => new Worker(this.workerUrl, this.workerType ? { type: this.workerType } : undefined)),
      onError: (message) => {
        this.updateOutput(`Worker error: ${message}`);
        this.handleError(message);
      },
    });
    this.workerSession.subscribe((message) => this.handleMessage(message));
    this.workerSession.start();
  }

  waitUntilReady() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timeoutMs = 120000;
      const interval = setInterval(() => {
        if (this.workerReady) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(interval);
          reject(new Error('Worker initialization timed out'));
        }
      }, 50);
    });
  }

  handleMessage(message) {
    const { type, ...data } = message;
    switch (type) {
      case WorkerEventType.PROGRESS:
        this.setProgress(data.value ?? data.percentage ?? 0, data.text || data.currentOperation || null);
        break;
      case WorkerEventType.LOG:
        this.workerLog(data.message, data);
        break;
      case WorkerEventType.ERROR:
        this.handleError(data.message || data.error || 'Worker failed');
        break;
      case WorkerEventType.INITIALIZED:
        this.workerReady = true;
        this.workerInitializing = false;
        this.webgpuAvailable = Boolean(data.webgpuAvailable);
        this.wasmAvailable = Boolean(data.wasmPreprocessingAvailable);
        if (data.message || this.readyMessage) this.updateOutput(data.message || this.readyMessage);
        this.onInitialized(data);
        break;
      case WorkerEventType.STAGE_DATA:
        this.handleStageData(data);
        break;
      case WorkerEventType.STEP_COMPLETE:
        this.handleStepComplete(data.step);
        break;
      case WorkerEventType.VOLUME_INFO:
        this.volumeInfo = data;
        this.onVolumeInfo(data);
        break;
      case WorkerEventType.STATE_ARTIFACT:
        if (data.artifact) this.hiddenArtifacts[data.artifact] = cloneValue(data.payload);
        this.onStateArtifact(data);
        break;
      case WorkerEventType.STATE_RESTORED:
        this.pendingRestore?.resolve(data);
        this.pendingRestore = null;
        break;
      case WorkerEventType.METRICS:
        this.metrics = data.metrics || data;
        this.onMetrics(this.metrics);
        break;
      case WorkerEventType.DETECTED_LABELS:
        this.onDetectedLabels(data.labels || []);
        break;
      case 'brain-mask-overlay':
        this.onBrainMaskOverlay?.(data);
        break;
      case WorkerEventType.COMPLETE:
        this.running = false;
        this.currentRunningStep = null;
        this.pendingAbortCheckpoint = null;
        this.updateOutput(data.message || 'Pipeline completed successfully');
        this.onComplete(data);
        break;
    }
  }

  handleError(message) {
    this.updateOutput(`Error: ${message}`);
    this.setProgress(0, 'Failed');
    this.running = false;
    this.workerInitializing = false;
    this.pendingRestore?.reject(new Error(message));
    this.pendingRestore = null;
    this.currentRunningStep = null;
    this.onError(message);
  }

  handleStageData(data) {
    const stage = data.stage || 'output';
    if (!this.stageOrder.includes(stage)) this.stageOrder.push(stage);
    if (data.kind === 'metrics') {
      const csv = data.csv || '';
      const file = new File([csv], data.filename || `${data.taskId || this.currentTaskId || 'pipeline'}_${stage}.csv`, { type: 'text/csv' });
      this.results[stage] = {
        file,
        description: data.description,
        kind: 'metrics',
        rows: data.rows || [],
        summary: data.summary || null,
        csv,
        raw: data,
      };
      Promise.resolve(this.onStageData(data, this.results[stage])).catch(error => {
        this.updateOutput(`Error handling ${stage}: ${error.message}`);
      });
      return;
    }
    const payload = this.extractStagePayload(data);
    const blob = new Blob([payload], { type: 'application/octet-stream' });
    const file = new File([blob], this.resultFileName(stage, data, data.context || data), { type: 'application/octet-stream' });
    this.results[stage] = {
      file,
      description: data.description,
      kind: data.kind || 'nifti',
      provenance: data.provenance || null,
      raw: data,
    };
    Promise.resolve(this.onStageData(data, this.results[stage])).catch(error => {
      this.updateOutput(`Error handling ${stage}: ${error.message}`);
    });
  }

  handleStepComplete(step) {
    if (step && this.stepStatus[step] !== 'skipped') this.stepStatus[step] = 'complete';
    this.running = false;
    if (this.currentRunningStep === step) {
      this.currentRunningStep = null;
      this.pendingAbortCheckpoint = null;
    }
    this.onStepComplete(step);
  }

  extractStagePayload(data) {
    if (this.stageDataKey && data[this.stageDataKey]) return data[this.stageDataKey];
    if (data.niftiData) return data.niftiData;
    if (data.data) return data.data;
    if (data.buffer) return data.buffer;
    throw new Error(`stageData event for ${data.stage || 'output'} did not include data`);
  }

  async load(inputData, payload = {}) {
    await this.initialize();
    this.running = true;
    this.stepStatus.load = 'running';
    this.post(WorkerRequestType.LOAD, { ...payload, inputData });
  }

  async loadVolume(inputData, payload = {}) {
    await this.initialize();
    this.inputVolumeBuffer = inputData.slice(0);
    this.running = true;
    this.currentRunningStep = 'load';
    this.stepStatus.load = 'running';
    this.postRaw({ type: WorkerRequestType.LOAD, data: { ...payload, inputData } });
  }

  async run(config = {}) {
    await this.initialize();
    this.running = true;
    this.results = {};
    this.stageOrder = [];
    this.lastRunSettings = cloneValue(config);
    this.updateOutput(config.label ? `Starting ${config.label}...` : 'Starting pipeline...');
    this.post(config.type || WorkerRequestType.RUN, config);
    return true;
  }

  async runStep(step, data = {}) {
    await this.initialize();
    this.running = true;
    this.stepStatus[step] = 'running';
    this.post(WorkerRequestType.RUN_STEP, { step, ...data });
    return true;
  }

  async executeCommand(type, data = {}, options = {}) {
    await this.initialize();
    const step = options.step || null;
    if (step) {
      if (options.checkpoint !== false && (!this.pendingAbortCheckpoint || this.pendingAbortCheckpoint.step !== step)) {
        this.captureCheckpoint(step);
      }
      this.stepStatus[step] = options.skipped ? 'skipped' : 'running';
    }
    if (options.clearResults) this.clearResults();
    this.running = options.running !== false;
    this.currentRunningStep = this.running ? step : null;
    if (options.taskId !== undefined) this.currentTaskId = options.taskId;
    this.postRaw({ type, data }, { transfer: options.transfer !== false });
    return true;
  }

  async restoreState(data = {}) {
    await this.initialize();
    return new Promise((resolve, reject) => {
      this.pendingRestore = { resolve, reject };
      this.post(WorkerRequestType.RESTORE_STATE, data);
    });
  }

  async resetState(data = {}) {
    await this.initialize();
    this.results = {};
    this.stageOrder = [];
    this.stepStatus = {};
    this.hiddenArtifacts = {};
    this.volumeInfo = null;
    this.post(WorkerRequestType.RESET_STATE, data, { transfer: false });
  }

  async resetWorkerState(data = {}) {
    await this.initialize();
    this.postRaw({ type: WorkerRequestType.RESET_STATE, data }, { transfer: false });
    this.stepStatus = Object.fromEntries(this.steps.map(step => [step, 'pending']));
    this.volumeInfo = null;
    this.results = {};
    this.stageOrder = [];
    this.hiddenArtifacts = cloneValue(this.hiddenArtifactDefaults);
    this.inputVolumeBuffer = null;
    this.currentRunningStep = null;
    this.pendingAbortCheckpoint = null;
    this.pendingRestore = null;
  }

  captureCheckpoint(step) {
    const view = {
      input: this.inputVolumeBuffer,
      results: this.results,
      artifacts: this.hiddenArtifacts,
      state: this.snapshot(),
    };
    this.pendingAbortCheckpoint = {
      step,
      inputBuffer: this.inputVolumeBuffer,
      stepStatus: { ...this.stepStatus },
      results: cloneResults(this.results),
      stageOrder: [...this.stageOrder],
      volumeInfo: this.volumeInfo ? cloneValue(this.volumeInfo) : null,
      hiddenArtifacts: cloneValue(this.hiddenArtifacts),
      hostState: this.checkpointExtension?.captureHost?.(view),
    };
    return this.pendingAbortCheckpoint;
  }

  async createRestorePayload(checkpoint) {
    if (!checkpoint?.inputBuffer) throw new Error('No input volume is available for restore');
    const payload = {
      inputData: checkpoint.inputBuffer.slice(0),
      hiddenArtifacts: cloneValue(checkpoint.hiddenArtifacts),
    };
    const extension = await this.checkpointExtension?.extendRestoreRequest?.({
      input: checkpoint.inputBuffer,
      results: checkpoint.results,
      artifacts: checkpoint.hiddenArtifacts,
      state: this.snapshot(),
    });
    return { ...payload, ...(extension || {}) };
  }

  async restoreCheckpoint(checkpoint) {
    await this.initialize();
    const payload = await this.createRestorePayload(checkpoint);
    return new Promise((resolve, reject) => {
      this.pendingRestore = { resolve, reject };
      this.postRaw({ type: WorkerRequestType.RESTORE_STATE, data: payload });
    });
  }

  async abortCurrentStep() {
    if (!this.running || !this.currentRunningStep || !this.pendingAbortCheckpoint) return null;
    const abortedStep = this.currentRunningStep;
    const checkpoint = this.pendingAbortCheckpoint;
    this.updateOutput(`Aborting ${abortedStep}...`);
    this.terminateWorker();
    this.running = false;
    this.currentRunningStep = null;
    try {
      await this.initialize();
      await this.restoreCheckpoint(checkpoint);
      this.results = cloneResults(checkpoint.results);
      this.stageOrder = [...checkpoint.stageOrder];
      this.volumeInfo = checkpoint.volumeInfo ? cloneValue(checkpoint.volumeInfo) : null;
      this.hiddenArtifacts = cloneValue(checkpoint.hiddenArtifacts);
      this.stepStatus = { ...checkpoint.stepStatus, [abortedStep]: 'pending' };
      this.checkpointExtension?.restoreHost?.(cloneValue(checkpoint.hostState), this.snapshot());
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

  resetDownstream(fromStep) {
    const index = this.steps.indexOf(fromStep);
    if (index < 0) return;
    for (const step of this.steps.slice(index + 1)) this.stepStatus[step] = 'pending';
  }

  invalidateFromStep(step, { includeSelf = false } = {}) {
    const index = this.steps.indexOf(step);
    if (index < 0) return [];
    const invalidated = this.steps.slice(includeSelf ? index : index + 1);
    for (const item of invalidated) this.stepStatus[item] = 'pending';
    return invalidated;
  }

  removeResult(stage) {
    delete this.results[stage];
    this.stageOrder = this.stageOrder.filter(item => item !== stage);
  }

  snapshot() {
    return Object.freeze({
      running: this.running,
      currentStep: this.currentRunningStep,
      stepStatus: Object.freeze({ ...this.stepStatus }),
      stageOrder: Object.freeze([...this.stageOrder]),
      volumeInfo: this.volumeInfo ? Object.freeze(cloneValue(this.volumeInfo)) : null,
    });
  }

  cancel() {
    if (!this.running) return;
    this.updateOutput('Cancelling...');
    try {
      this.post(WorkerRequestType.CANCEL, {}, { transfer: false });
    } catch {
      // Termination below is the hard cancellation path.
    }
    this.terminateWorker();
    this.running = false;
    this.setProgress(0, 'Cancelled');
  }

  terminateWorker() {
    this.workerSession?.terminate();
    this.workerSession = null;
    this.workerReady = false;
    this.workerInitializing = false;
    this.pendingRestore = null;
  }

  clearResults() {
    this.results = {};
    this.stageOrder = [];
    this.metrics = null;
  }

  downloadStage(stage) {
    if (!this.results[stage]?.file) {
      this.updateOutput(`${stage} not available`);
      return false;
    }
    downloadFile(this.results[stage].file);
    return true;
  }

  downloadAll() {
    for (const stage of this.stageOrder) this.downloadStage(stage);
  }

  post(type, data = {}, options = {}) {
    const payload = { type, data };
    const transferables = options.transfer === false ? [] : collectTransferables(data);
    this.workerSession.send(payload, transferables);
  }

  postRaw(message, options = {}) {
    const transferables = options.transfer === false ? [] : collectTransferables(message.data || {});
    this.workerSession.send(message, transferables);
  }
}

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
}

function cloneResults(results) {
  return Object.fromEntries(Object.entries(results).map(([stage, result]) => [stage, {
    ...result,
    raw: cloneValue(result.raw),
    rows: cloneValue(result.rows),
    summary: cloneValue(result.summary),
  }]));
}
