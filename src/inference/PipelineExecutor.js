import { downloadFile } from '../file-io/download.js';
import { collectTransferables, WorkerEventType, WorkerRequestType } from './workerProtocol.js';

export class PipelineExecutor {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl;
    this.workerType = options.workerType || 'module';
    this.version = options.version || '';
    this.initPayload = options.initPayload || {};
    this.updateOutput = options.updateOutput || (() => {});
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
    this.resultFileName = options.resultFileName || ((stage, _data, context) => `${context?.taskId ? `${context.taskId}_` : ''}${stage}.nii`);
    this.stageDataKey = options.stageDataKey || null;

    this.worker = null;
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
    this.updateOutput('Initializing worker...');
    this.post(WorkerRequestType.INIT, { ...this.initPayload, version: this.version }, { transfer: false });
    return this.waitUntilReady();
  }

  setupWorker() {
    if (this.worker) return;
    if (!this.workerUrl) throw new Error('PipelineExecutor requires workerUrl');
    this.worker = new Worker(this.workerUrl, this.workerType ? { type: this.workerType } : undefined);
    this.worker.onmessage = event => this.handleMessage(event.data || {});
    this.worker.onerror = event => {
      const message = event.message || 'Worker error';
      this.updateOutput(`Worker error: ${message}`);
      this.handleError(message);
    };
    this.worker.onmessageerror = () => this.handleError('Worker message could not be deserialized');
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
        this.updateOutput(data.message);
        break;
      case WorkerEventType.ERROR:
        this.handleError(data.message || data.error || 'Worker failed');
        break;
      case WorkerEventType.INITIALIZED:
        this.workerReady = true;
        this.workerInitializing = false;
        this.updateOutput(data.message || 'Worker ready');
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
      case WorkerEventType.COMPLETE:
        this.running = false;
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
    this.onError(message);
  }

  handleStageData(data) {
    const stage = data.stage || 'output';
    if (!this.stageOrder.includes(stage)) this.stageOrder.push(stage);
    const payload = this.extractStagePayload(data);
    const blob = new Blob([payload], { type: 'application/octet-stream' });
    const file = new File([blob], this.resultFileName(stage, data, data.context || data), { type: 'application/octet-stream' });
    this.results[stage] = { file, description: data.description, raw: data };
    Promise.resolve(this.onStageData(data, this.results[stage])).catch(error => {
      this.updateOutput(`Error handling ${stage}: ${error.message}`);
    });
  }

  handleStepComplete(step) {
    if (step) this.stepStatus[step] = 'complete';
    this.running = false;
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

  cancel() {
    if (!this.running && !this.worker) return;
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
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.workerInitializing = false;
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
    this.worker.postMessage(payload, transferables);
  }
}

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
}
