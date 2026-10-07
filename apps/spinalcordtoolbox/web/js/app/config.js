export const VERSION = '0.6.20261004';

// Model - relative path (served from same origin)
export const MODEL_BASE_URL = './models';

export const MODEL = {
  name: 'sct-spinalcord.onnx',
  label: 'SCT spinalcord',
  numClasses: 1,
  patchSize: [160, 224, 64]
};

// Available SCT task entries. Runtime details are defined in sct-tasks.js.
export const MODELS = [
  {
    id: 'spinalcord',
    name: 'sct-spinalcord.onnx',
    label: 'Spinal cord',
    description: 'SCT stable contrast-agnostic spinal cord segmentation.',
    numClasses: 1,
    patchSize: [160, 224, 64],
    supportStatus: 'supported'
  }
];

export const INFERENCE_DEFAULTS = {
  cropForegroundMargin: 20,
  overlap: 0,
  probabilityThreshold: 0.5,
  minComponentSize: 10,
  keepLargestComponent: false,
  testTimeAugmentation: false
};

// NiiVue 1.0 constructor options for the embedded FreeBrowse viewer and the
// comparison canvases. SCT's own input flow loads files, so canvas drops stay
// off; WebGL2 is the renderer the app is tested on.
export const VIEWER_CONFIG = {
  backend: 'webgl2',
  isDragDropEnabled: false
};

export const PROGRESS_CONFIG = {
  animationSpeed: 0.5
};

export const STAGE_NAMES = {
  'input': 'Input',
  'segmentation': 'SCT Segmentation',
  'lesion': 'Lesion',
  'spine_step1': 'TotalSpineSeg Labels',
  'spine_discs': 'Spine Disc Labels',
  'lesion_metrics': 'Browser lesion metrics (approximate)'
};

export const ONNX_CONFIG = {
  executionProviders: ['webgpu', 'wasm'],
  graphOptimizationLevel: 'all'
};

export const CACHE_CONFIG = {
  name: 'SCTModelCache',
  storeName: 'models',
  maxSizeMB: 1024
};

export const PIPELINE_STEPS = ['load', 'inference', 'processing'];

if (typeof self !== 'undefined') self.SpinalCordToolboxConfig = { VERSION, MODEL_BASE_URL, MODEL, MODELS, INFERENCE_DEFAULTS, VIEWER_CONFIG, PROGRESS_CONFIG, STAGE_NAMES, ONNX_CONFIG, CACHE_CONFIG, PIPELINE_STEPS };
