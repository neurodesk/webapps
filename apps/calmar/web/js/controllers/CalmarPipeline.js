import { PipelineExecutor } from '@neurodesk/webapp-components';
import { VERSION } from '../app/config.js';

export class CalmarPipeline extends PipelineExecutor {
  constructor(options = {}) {
    super({
      ...options,
      workerUrl: `js/inference-worker.js?v=${VERSION}`,
      workerType: 'module',
      version: VERSION,
      steps: ['load', 'brainmask', 'inference', 'processing', 'register', 'warp-mask', 'inverse-warp-mask'],
      hiddenArtifacts: { segmentationState: { segLabelsRAS: null, segMinComponentSize: 10 } },
      resultFileName: (stage, data) => `${data.taskId || 'lnm'}_${stage}.nii`,
      initializingMessage: null,
      readyMessage: null,
      workerLog: message => this.updateOutput(message, { source: 'worker' }),
    });
  }

  handleMessage(message) {
    super.handleMessage(message);
    if (message.type === 'initialized') {
      this.updateOutput('ONNX Runtime ready', { source: 'worker' });
    }
  }

  runInference(settings) {
    return this.executeCommand('run-inference', settings, { step: 'inference', taskId: settings?.taskId || null });
  }

  runDeepIslesInference(settings) {
    return this.executeCommand('run-deepisles-inference', settings, { step: 'inference', taskId: settings?.taskId || null });
  }

  runSynthStrip(settings = {}) {
    return this.executeCommand('run-synthstrip', settings, { step: 'brainmask', taskId: settings.modelAssetId || null });
  }

  runRegistration(settings = {}) {
    return this.executeCommand('run-register', settings, { step: 'register', taskId: settings.modelAssetId || null });
  }

  runWarpMask(settings = {}) {
    return this.executeCommand('warp-mask', settings, { step: 'warp-mask', checkpoint: false });
  }

  runInverseWarpMask(settings = {}) {
    return this.executeCommand('inverse-warp-mask', settings, { step: 'inverse-warp-mask', checkpoint: false });
  }
}
