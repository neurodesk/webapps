/**
 * QsmPipelineController
 *
 * Handles worker lifecycle, pipeline execution, and result caching.
 */

import { WorkerSession } from '@neurodesk/webapp-components/worker';

export class QsmPipelineController {
  constructor(options) {
    // Callbacks
    this.updateOutput = options.updateOutput || (() => {});
    this.setProgress = options.setProgress || (() => {});
    this.onStageData = options.onStageData || (() => {});
    this.onPipelineComplete = options.onPipelineComplete || (() => {});
    this.onPipelineError = options.onPipelineError || (() => {});
    this.onInitialized = options.onInitialized || (() => {});
    this.config = options.config;

    // Worker state
    this.workerSession = null;
    this.workerReady = false;
    this.workerInitializing = false;

    // Pipeline state
    this.pipelineRunning = false;
    // Callbacks to run when `cancel()` terminates the worker. Cancelling is a hard
    // `worker.terminate()` — nothing comes back from the worker afterwards — so any job waiting
    // on a worker message has to be settled from here or it hangs forever. See `onCancel`.
    this.cancelHandlers = new Set();
    this.results = {};
    this.stageOrder = [];
    this.pendingStageResolve = null;

    // Settings tracking for intelligent caching
    this.lastRunSettings = null;
    this.pipelineHasRun = false;
  }

  // ==================== State Accessors ====================

  isReady() {
    return this.workerReady;
  }

  isRunning() {
    return this.pipelineRunning;
  }

  /**
   * Register a callback to run if the worker is cancelled, for jobs that await a worker
   * message. `cancel()` terminates the worker, so the reply never arrives and the job's promise
   * would never settle — the callback is its chance to settle and clean up.
   *
   * @param {Function} fn
   * @returns {Function} unregister — call it when the job finishes normally
   */
  onCancel(fn) {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  hasResult(stage) {
    return !!this.results[stage]?.file;
  }

  getResult(stage) {
    return this.results[stage] || null;
  }

  getResults() {
    return this.results;
  }

  getStageOrder() {
    return this.stageOrder;
  }

  getLastRunSettings() {
    return this.lastRunSettings;
  }

  hasPipelineRun() {
    return this.pipelineHasRun;
  }

  // ==================== Worker Management ====================

  _setupWorker() {
    if (this.workerSession) return;
    this.workerSession = new WorkerSession({
      createWorker: () => new Worker('js/qsm-worker-pure.js', { type: 'module' }),
      onError: (message, event) => {
        this.updateOutput(`Worker error: ${message}`);
        console.error('Worker error:', event);
        this._handleError(message);
      },
    });
    this.workerSession.subscribe((message) => {
      const { type, ...data } = message;

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
          this.onInitialized();
          // Fetch default pipeline config from qsmxt-config WASM
          this.send('getDefaultConfig');
          break;

        case 'defaultConfig':
          try {
            this.defaultPipelineConfig = JSON.parse(data.result);
            import('../modules/ConfigBridge.js').then(m => m.setDefaultsFromConfig(this.defaultPipelineConfig));
            // Enable export buttons now that WASM config is available
            const cmdBtn = document.getElementById('exportCommand');
            const methodsBtn = document.getElementById('exportMethods');
            if (cmdBtn) cmdBtn.disabled = false;
            if (methodsBtn) methodsBtn.disabled = false;
          } catch (e) {
            console.warn('Failed to parse default config:', e);
          }
          break;

        case 'complete':
          this._handleComplete();
          break;

        case 'stageData':
          this._handleStageData(data);
          break;
      }
    });
    this.workerSession.start();
  }

  _handleError(message) {
    this.updateOutput(`Error: ${message}`);
    this.setProgress(0, 'Failed');
    this.pipelineRunning = false;
    this.onPipelineError(message);
  }

  _handleComplete() {
    this.updateOutput("Pipeline completed successfully!");
    this.pipelineHasRun = true;
    this.pipelineRunning = false;
    this.onPipelineComplete();
  }

  _handleStageData(data) {
    // Handle both live stage updates and explicit requests
    if (this.pendingStageResolve) {
      this.pendingStageResolve(data);
      this.pendingStageResolve = null;
    } else if (this.pipelineRunning) {
      // Track stage order
      if (!this.stageOrder.includes(data.stage)) {
        this.stageOrder.push(data.stage);
      }

      // Cache result
      const blob = new Blob([data.data], { type: 'application/octet-stream' });
      const file = new File([blob], `${data.stage}.nii`, { type: 'application/octet-stream' });
      this.results[data.stage] = {
        file: file,
        path: `${data.stage}.nii`,
        description: data.description
      };

      // Notify callback
      this.onStageData(data);
    }
  }

  async initialize() {
    this._setupWorker();

    // Already initialized
    if (this.workerReady) return;

    // Already initializing - just wait for it
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

    // Start initialization
    this.workerInitializing = true;
    this.updateOutput("Loading WASM module...");

    // Send init message to worker
    this.send('init');

    // Wait for initialization
    return new Promise((resolve) => {
      const checkReady = setInterval(() => {
        if (this.workerReady) {
          clearInterval(checkReady);
          this.workerInitializing = false;
          resolve();
        }
      }, 100);
    });
  }

  // ==================== Pipeline Execution ====================

  async run(pipelineConfig) {
    try {
      await this.initialize();

      const inputMode = pipelineConfig.inputMode || 'raw';
      const modeLabels = {
        raw: 'QSM Pipeline',
        totalField: 'Total Field Map Pipeline',
        localField: 'Local Field Map Pipeline'
      };
      this.updateOutput(`Starting ${modeLabels[inputMode] || 'Pipeline'}...`);
      this.pipelineRunning = true;

      // Save settings for intelligent caching
      this.lastRunSettings = JSON.parse(JSON.stringify(pipelineConfig.pipelineSettings));

      // Pass through all pipeline config to the worker
      this.send('run', pipelineConfig);

      return true;
    } catch (error) {
      this._handleError(error.message);
      console.error(error);
      return false;
    }
  }

  cancel() {
    if (!this.pipelineRunning) return;

    this.updateOutput("Cancelling pipeline...");

    // Settle anything awaiting a worker message first: after `terminate()` no reply can arrive,
    // so these promises would otherwise hang and leave the UI stuck mid-run.
    for (const fn of [...this.cancelHandlers]) {
      try { fn(); } catch (e) { console.warn('cancel handler failed:', e); }
    }
    this.cancelHandlers.clear();

    // Terminate the worker to stop all processing
    if (this.workerSession) {
      this.workerSession.terminate();
      this.workerSession = null;
      this.workerReady = false;
      this.workerInitializing = false;
    }

    // Reset state
    this.pipelineRunning = false;
    this.setProgress(0, 'Cancelled');

    this.updateOutput("Pipeline cancelled. Worker will be reinitialized on next run.");
  }

  // ==================== Result Management ====================

  clearResults() {
    this.results = {};
    this.stageOrder = [];
  }

  async downloadStage(stage) {
    if (!this.results[stage]?.file) {
      this.updateOutput(`${stage} not available - run the pipeline first`);
      return;
    }

    const file = this.results[stage].file;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ==================== Skip Stage Logic ====================

  determineSkipStages(currentSettings) {
    // First run - can't skip anything
    if (!this.pipelineHasRun || !this.lastRunSettings) {
      return { skipUnwrap: false, skipBgRemoval: false };
    }

    // If key results are missing, can't skip
    if (!this.results['unwrapped'] || !this.results['localField']) {
      return { skipUnwrap: false, skipBgRemoval: false };
    }

    const last = this.lastRunSettings;
    const current = currentSettings;

    // Check if unwrapping settings changed
    const unwrapChanged =
      current.phaseUnwrapping !== last.phaseUnwrapping ||
      (current.phaseUnwrapping === 'romeo' && current.romeo?.useQualityMap !== last.romeo?.useQualityMap);

    // Check if background removal settings changed
    const bgChanged =
      current.bf_algorithm !== last.bf_algorithm ||
      (current.bf_algorithm === 'vsharp' &&
        (current.vsharp?.minRadius !== last.vsharp?.minRadius ||
          current.vsharp?.maxRadius !== last.vsharp?.maxRadius)) ||
      (current.bf_algorithm === 'pdf' &&
        (current.pdf?.tolerance !== last.pdf?.tolerance ||
          current.pdf?.iterations !== last.pdf?.iterations)) ||
      (current.bf_algorithm === 'sharp' &&
        current.sharp?.radius !== last.sharp?.radius) ||
      (current.bf_algorithm === 'lbv' &&
        current.lbv?.tolerance !== last.lbv?.tolerance) ||
      (current.bf_algorithm === 'ismv' &&
        (current.ismv?.tolerance !== last.ismv?.tolerance ||
          current.ismv?.iterations !== last.ismv?.iterations));

    // If unwrap changed, can't skip anything
    if (unwrapChanged) {
      return { skipUnwrap: false, skipBgRemoval: false };
    }

    // If only dipole inversion changed, can skip both unwrap and bg removal
    if (!bgChanged) {
      return { skipUnwrap: true, skipBgRemoval: true };
    }

    // If bg removal changed but not unwrap, can skip unwrap only
    return { skipUnwrap: true, skipBgRemoval: false };
  }

  send(type, data = {}) {
    this.workerSession?.send({ type, data });
  }

  runSpecial(type, data) {
    this.pipelineRunning = true;
    this.send(type, data);
  }

  subscribe(listener) {
    return this.workerSession?.subscribe(listener) || (() => {});
  }

  getChannel() {
    return this.workerSession;
  }
}
