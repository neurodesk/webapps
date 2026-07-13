/**
 * InferenceExecutor
 *
 * Handles Web Worker lifecycle for ONNX model inference.
 */
import { downloadFile } from '@neurodesk/webapp-components/file-io';

import { VERSION } from '../app/config.js';

export class InferenceExecutor {
  constructor(options) {
    this.updateOutput = options.updateOutput || (() => {});
    this.setProgress = options.setProgress || (() => {});
    this.onStageData = options.onStageData || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onInitialized = options.onInitialized || (() => {});
    this.onDetectedLabels = options.onDetectedLabels || (() => {});
    this.onMetrics = options.onMetrics || (() => {});

    this.worker = null;
    this.workerReady = false;
    this.workerInitializing = false;
    this.running = false;
    this.webgpuAvailable = false;
    this.results = {};
    this.stageOrder = [];
    this.pendingTask = null;
    this.currentTaskType = null;
  }

  isReady() { return this.workerReady; }
  isRunning() { return this.running; }

  hasResult(stage) { return !!this.results[stage]?.file; }
  getResult(stage) { return this.results[stage] || null; }
  getResults() { return this.results; }
  getStageOrder() { return this.stageOrder; }

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
          this.updateOutput('ONNX Runtime ready');
          this.onInitialized();
          break;
        case 'complete':
          this._handleComplete();
          break;
        case 'stageData':
          this._handleStageData(data);
          break;
        case 'detectedLabels':
          this.onDetectedLabels(data.labels);
          break;
        case 'metrics':
          this.metrics = data.metrics;
          this.onMetrics(data.metrics);
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
    this.running = false;
    this.currentTaskType = null;
    this.onError(message);
    if (this.pendingTask) {
      this.pendingTask.reject(new Error(message));
      this.pendingTask = null;
    }
  }

  _handleComplete() {
    const completeMessage = this.currentTaskType === 'metricsOnly'
      ? 'Metrics completed successfully!'
      : this.currentTaskType === 'consolidateOnly'
        ? 'Consolidation completed successfully!'
        : 'Segmentation completed successfully!';
    this.updateOutput(completeMessage);
    this.running = false;
    this.currentTaskType = null;
    this.onComplete();
    if (this.pendingTask) {
      this.pendingTask.resolve(true);
      this.pendingTask = null;
    }
  }

  _handleStageData(data) {
    if (!this.running) return;

    if (!this.stageOrder.includes(data.stage)) {
      this.stageOrder.push(data.stage);
    }

    const blob = new Blob([data.niftiData], { type: 'application/octet-stream' });
    const file = new File([blob], `${data.stage}.nii`, { type: 'application/octet-stream' });
    this.results[data.stage] = {
      file: file,
      description: data.description
    };

    this.onStageData(data);
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

  _collectTransferables(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);

    if (value instanceof ArrayBuffer) return [value];
    if (ArrayBuffer.isView(value)) return [value.buffer];
    if (Array.isArray(value)) {
      return value.flatMap(item => this._collectTransferables(item, seen));
    }

    return Object.values(value).flatMap(item => this._collectTransferables(item, seen));
  }

  async _postTask(type, config) {
    try {
      await this.initialize();

      const startMessage = type === 'run'
        ? 'Starting segmentation...'
        : type === 'consolidateOnly'
          ? 'Consolidating segmentations...'
          : 'Calculating metrics...';
      this.updateOutput(startMessage);
      this.running = true;
      this.currentTaskType = type;
      this.results = {};
      this.stageOrder = [];

      const transferables = this._collectTransferables(config);
      this.worker.postMessage({
        type,
        data: config
      }, transferables);

      return new Promise((resolve, reject) => {
        this.pendingTask = { resolve, reject };
      });
    } catch (error) {
      this._handleError(error.message);
      return false;
    }
  }

  async run(config) {
    return this._postTask('run', config);
  }

  async calculateMetrics(config) {
    return this._postTask('metricsOnly', config);
  }

  async consolidateSegmentations(config) {
    return this._postTask('consolidateOnly', config);
  }

  cancel() {
    if (!this.running) return;

    const cancelMessage = this.currentTaskType === 'metricsOnly'
      ? 'Cancelling metrics...'
      : this.currentTaskType === 'consolidateOnly'
        ? 'Cancelling consolidation...'
        : 'Cancelling segmentation...';
    this.updateOutput(cancelMessage);

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
      this.workerInitializing = false;
    }

    this.running = false;
    this.currentTaskType = null;
    this.setProgress(0, 'Cancelled');
    this.updateOutput('Processing cancelled. Worker will be reinitialized on next run.');
  }

  clearResults() {
    this.results = {};
    this.stageOrder = [];
    this.metrics = null;
  }

  async downloadStage(stage) {
    if (!this.results[stage]?.file) {
      this.updateOutput(`${stage} not available`);
      return;
    }

    downloadFile(this.results[stage].file);
  }

  downloadAll() {
    for (const stage of this.stageOrder) {
      this.downloadStage(stage);
    }
  }
}
