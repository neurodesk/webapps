import { PipelineExecutor, StepPipelineState } from '@neurodesk/webapp-components';
import { VERSION } from '../app/config.js';

export class SctPipeline extends PipelineExecutor {
  constructor(options = {}) {
    super({
      ...options,
      workerUrl: `js/inference-worker.js?v=${VERSION}`,
      workerType: 'module',
      version: VERSION,
      steps: ['load', 'inference'],
      currentTaskId: 'spinalcord',
      readyMessage: 'ONNX Runtime ready',
      hiddenArtifacts: { segmentationState: { segLabelsRAS: null, segMinComponentSize: 10 } },
      resultFileName: (stage, data) => `${data.taskId || 'spinalcord'}_${stage}.nii`,
    });
    this.graph = new StepPipelineState({
      nodeOrder: ['load', 'inference'],
      stageToNode: { input: 'load', segmentation: 'inference' },
      nodeToStages: { load: ['input'], inference: ['segmentation'] },
      dependencies: { load: [], inference: ['load'] },
    });
  }

  getPipelineGraph() { return this.graph; }

  handleStepComplete(step) {
    if (this.graph.nodes.has(step)) this.graph.markNodeComplete(step);
    super.handleStepComplete(step);
  }

  runInference(settings) {
    this.lastRunSettings = structuredClone(settings);
    return this.executeCommand('run-inference', settings, {
      step: 'inference',
      taskId: settings?.taskId || 'spinalcord',
    });
  }
}
