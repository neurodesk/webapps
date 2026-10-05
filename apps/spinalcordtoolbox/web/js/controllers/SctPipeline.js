import { PipelineExecutor, StepPipelineState } from '@neurodesk/webapp-components';
import { VERSION } from '../app/config.js';

export class SctPipeline extends PipelineExecutor {
  constructor(options = {}) {
    super({
      ...options,
      workerUrl: `js/inference-worker.js?v=${VERSION}`,
      workerType: 'module',
      version: VERSION,
      steps: ['load', 'inference', 'morphometry', 'lesion_metrics'],
      currentTaskId: 'spinalcord',
      readyMessage: 'ONNX Runtime ready',
      hiddenArtifacts: { segmentationState: { segLabelsRAS: null, segMinComponentSize: 10 } },
      resultFileName: (stage, data) => `${data.taskId || 'spinalcord'}_${stage}.nii`,
    });
    this.graph = new StepPipelineState({
      nodeOrder: ['load', 'inference', 'morphometry', 'lesion_metrics'],
      stageToNode: { input: 'load', segmentation: 'inference', morphometry: 'morphometry', lesion_metrics: 'lesion_metrics' },
      nodeToStages: { load: ['input'], inference: ['segmentation'], morphometry: ['morphometry'], lesion_metrics: ['lesion_metrics'] },
      // The metric steps measure mask files, so they depend on no other node.
      dependencies: { load: [], inference: ['load'], morphometry: [], lesion_metrics: [] },
    });
  }

  getPipelineGraph() { return this.graph; }

  handleStepComplete(step) {
    if (this.graph.nodes.has(step)) this.graph.markNodeComplete(step);
    super.handleStepComplete(step);
  }

  /**
   * `sct_process_segmentation` on a mask NIfTI (and optional disc labels).
   * `request`: { maskData, maskName, maskLabel, filename, discData, discName,
   * discFilename, options: { aggregate, slices, levels, angleCorrection } }.
   */
  runMorphometry(request) {
    this.lastMorphometrySettings = structuredClone({
      mask: request.maskName || request.filename || null,
      maskLabel: request.maskLabel ?? null,
      discs: request.discData ? (request.discName || request.discFilename || null) : null,
      options: request.options || {},
    });
    this.removeResult('morphometry');
    return this.executeCommand('run-morphometry', request, { step: 'morphometry' });
  }

  /**
   * `sct_analyze_lesion` on mask NIfTI files of one grid.
   * `request`: { lesionData, cordData, imageData?, imageName?, taskId? }.
   */
  runLesionMetrics(request) {
    this.removeResult('lesion_metrics');
    return this.executeCommand('run-lesion-metrics', request, { step: 'lesion_metrics' });
  }

  runInference(settings) {
    this.lastRunSettings = structuredClone(settings);
    return this.executeCommand('run-inference', settings, {
      step: 'inference',
      taskId: settings?.taskId || 'spinalcord',
    });
  }
}
