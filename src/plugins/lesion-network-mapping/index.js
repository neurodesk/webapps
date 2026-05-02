import { definePlugin } from '../plugin.js';

export const lesionNetworkMappingPlugin = definePlugin({
  id: 'lesion-network-mapping',
  name: 'Lesion Network Mapping',
  description: 'LNM lesion segmentation, atlas overlap, and export metadata.',
  sourceRepos: ['neurodesk/lesion-network-mapping-webapp'],
  capabilities: ['atlas-overlap', 'csv-export', 'brain-extraction', 'onnx-segmentation'],
  pipelines: [
    {
      id: 'lnm-yeo-only',
      label: 'Yeo 7-network overlap',
      requiredInputs: ['lesion-mask'],
      stages: [
        { id: 'overlap', label: 'Atlas overlap', workerCommand: 'parcel-overlap', assets: ['yeo7-2mm'], outputStages: ['overlap'] }
      ]
    },
    {
      id: 'lnm-segment-only',
      label: 'Auto-segment lesion',
      requiredInputs: ['structural-image'],
      stages: [
        { id: 'brainmask', label: 'Brain extraction', workerCommand: 'run-synthstrip', assets: ['lnm-synthstrip'], outputStages: ['brainmask'] },
        { id: 'segment', label: 'Lesion segmentation', workerCommand: 'run-inference', assets: ['lnm-stroke-lesion'], outputStages: ['segmentation'] }
      ]
    }
  ]
});
