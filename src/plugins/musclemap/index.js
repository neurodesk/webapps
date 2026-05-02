import { definePlugin } from '../plugin.js';

export const musclemapPlugin = definePlugin({
  id: 'musclemap',
  name: 'MuscleMap',
  description: 'MuscleMap model family metadata and metrics/legend UI hooks.',
  sourceRepos: ['neurodesk/musclemap-webapp'],
  capabilities: ['onnx-segmentation', 'multi-label-metrics', 'label-legend'],
  tasks: [
    { id: 'wholebody', label: 'Whole Body', modelAssets: [{ id: 'musclemap-wholebody', filename: 'musclemap-wholebody.onnx', numClasses: 100, roiSize: [256, 256] }] },
    { id: 'abdomen', label: 'Abdomen', modelAssets: [{ id: 'musclemap-abdomen', filename: 'musclemap-abdomen.onnx', numClasses: 9, roiSize: [128, 128] }] },
    { id: 'forearm', label: 'Forearm', modelAssets: [{ id: 'musclemap-forearm', filename: 'musclemap-forearm.onnx', numClasses: 6, roiSize: [256, 256] }] },
    { id: 'leg', label: 'Leg', modelAssets: [{ id: 'musclemap-leg', filename: 'musclemap-leg.onnx', numClasses: 15, roiSize: [128, 128] }] },
    { id: 'pelvis', label: 'Pelvis', modelAssets: [{ id: 'musclemap-pelvis', filename: 'musclemap-pelvis.onnx', numClasses: 14, roiSize: [128, 128] }] },
    { id: 'thigh', label: 'Thigh', modelAssets: [{ id: 'musclemap-thigh', filename: 'musclemap-thigh.onnx', numClasses: 29, roiSize: [128, 128] }] }
  ],
  workerSteps: {
    run: { requestType: 'run', outputStages: ['segmentation'], events: ['detectedLabels', 'metrics'] }
  }
});
