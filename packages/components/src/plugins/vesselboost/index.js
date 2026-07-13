import { definePlugin, generateDiscreteColormap } from '../plugin.js';

export const VESSELBOOST_LABELS = [
  { index: 0, name: 'Background', color: [0, 0, 0, 0] },
  { index: 1, name: 'Vessel', color: [255, 50, 50, 255] }
];

export const vesselboostPlugin = definePlugin({
  id: 'vesselboost',
  name: 'VesselBoost',
  description: 'VesselBoost model variants and step-pipeline metadata.',
  sourceRepos: ['neurodesk/vesselboost-webapp'],
  capabilities: ['onnx-segmentation', 'preprocessing-pipeline', 'brain-mask-editing'],
  labels: { vessel: VESSELBOOST_LABELS },
  colormaps: { vessel: generateDiscreteColormap(VESSELBOOST_LABELS) },
  tasks: [
    { id: 'manual', label: 'Default TOF MRA', modelAssets: [{ id: 'vesselboost', filename: 'vesselboost.onnx', patchSize: [64, 64, 64] }] },
    { id: 'omelette1', label: 'Boosted Sensitive', modelAssets: [{ id: 'vesselboost-omelette1', filename: 'vesselboost-omelette1.onnx', patchSize: [64, 64, 64] }] },
    { id: 'omelette2', label: 'Boosted Moderate', modelAssets: [{ id: 'vesselboost-omelette2', filename: 'vesselboost-omelette2.onnx', patchSize: [64, 64, 64] }] },
    { id: 't2s', label: 'T2star or SWI', modelAssets: [{ id: 'vesselboost-t2s', filename: 'vesselboost-t2s.onnx', patchSize: [64, 64, 64] }] }
  ],
  pipelines: [
    {
      id: 'vesselboost-step-pipeline',
      label: 'VesselBoost step pipeline',
      stages: [
        { id: 'load', label: 'Load volume', workerCommand: 'load' },
        { id: 'n4', label: 'Bias correction', workerCommand: 'run-n4', required: false },
        { id: 'bet', label: 'Brain extraction', workerCommand: 'run-bet', required: false },
        { id: 'denoise', label: 'Denoise', workerCommand: 'run-denoise', required: false },
        { id: 'inference', label: 'Segmentation', workerCommand: 'run-inference', outputStages: ['segmentation'] }
      ]
    }
  ]
});

export const vesselBoostPlugin = vesselboostPlugin;
