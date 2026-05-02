import { definePlugin } from '../plugin.js';

export const synthstripPlugin = definePlugin({
  id: 'synthstrip',
  name: 'SynthStrip',
  description: 'Brain extraction worker step and model metadata for browser pipelines.',
  sourceRepos: [
    'neurodesk/lesion-network-mapping-webapp',
    'neurodesk/vesselboost-webapp'
  ],
  capabilities: ['brain-extraction', 'onnx', 'worker-step'],
  tasks: [
    {
      id: 'synthstrip-brainmask',
      label: 'SynthStrip brain mask',
      outputType: 'binary-mask',
      modelAssets: [{ id: 'synthstrip', filename: 'synthstrip.onnx' }]
    }
  ],
  workerSteps: {
    synthstrip: { requestType: 'run-synthstrip', outputStages: ['brainmask'] }
  }
});
