import { definePlugin, generateDiscreteColormap } from '../plugin.js';

export const SCT_LABELS = {
  spinalcord: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0] },
    { index: 1, name: 'Spinal cord', color: [68, 128, 255, 255] }
  ],
  graymatter: [
    { index: 0, name: 'Background', color: [0, 0, 0, 0] },
    { index: 1, name: 'Gray matter', color: [255, 184, 76, 255] }
  ],
  vertebrae: Array.from({ length: 12 }, (_, index) => ({
    index,
    name: index === 0 ? 'Background' : `Vertebral level ${index}`,
    color: index === 0 ? [0, 0, 0, 0] : vertebraColor(index)
  }))
};

export const sctPlugin = definePlugin({
  id: 'sct',
  name: 'Spinal Cord Toolbox',
  description: 'SCT segmentation and vertebral labeling task metadata.',
  sourceRepos: ['neurodesk/spinalcordtoolbox-webapp'],
  capabilities: ['onnx-segmentation', 'vertebral-labeling', 'task-manifest'],
  labels: SCT_LABELS,
  colormaps: {
    spinalcord: generateDiscreteColormap(SCT_LABELS.spinalcord),
    graymatter: generateDiscreteColormap(SCT_LABELS.graymatter),
    vertebrae: generateDiscreteColormap(SCT_LABELS.vertebrae)
  },
  tasks: [
    {
      id: 'spinalcord',
      label: 'Spinal cord',
      outputType: 'binary-mask',
      labelSet: 'spinalcord',
      modelAssets: [{ id: 'sct-spinalcord', filename: 'sct-spinalcord.onnx', patchSize: [160, 224, 64] }]
    },
    {
      id: 'graymatter',
      label: 'Gray matter',
      outputType: 'binary-mask',
      labelSet: 'graymatter',
      modelAssets: [{ id: 'sct-graymatter', filename: 'sct-graymatter.onnx', patchSize: [64, 64, 64] }]
    },
    {
      id: 'vertebrae',
      label: 'Vertebral labeling',
      outputType: 'multi-label-mask',
      labelSet: 'vertebrae',
      processingOnly: true
    }
  ],
  workerSteps: {
    inference: { requestType: 'run-inference', outputStages: ['segmentation'] },
    vertebrae: { requestType: 'run-vertebral-labeling', outputStages: ['vertebrae'] }
  }
});

function vertebraColor(index) {
  const colors = [
    [48, 18, 59, 255], [70, 75, 174, 255], [60, 138, 222, 255],
    [40, 191, 215, 255], [60, 230, 160, 255], [144, 248, 91, 255],
    [216, 234, 53, 255], [254, 187, 43, 255], [251, 130, 38, 255],
    [220, 65, 22, 255], [165, 22, 11, 255]
  ];
  return colors[(index - 1) % colors.length];
}
