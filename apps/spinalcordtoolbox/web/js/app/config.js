export const VERSION = '7.1.17';

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

export const VIEWER_CONFIG = {
  loadingText: "",
  dragToMeasure: false,
  isColorbar: false,
  textHeight: 0.03,
  show3Dcrosshair: false,
  crosshairColor: [0.23, 0.51, 0.96, 1.0],
  crosshairWidth: 0.75
};

export const PROGRESS_CONFIG = {
  animationSpeed: 0.5
};

export const STAGE_NAMES = {
  'input': 'Input',
  'segmentation': 'SCT Segmentation',
  'lesion': 'SCI Lesion',
  'vertebrae': 'Vertebral Labels',
  'spine_step1': 'TotalSpineSeg Labels',
  'spine_discs': 'Spine Disc Labels',
  'lesion_metrics': 'Lesion Metrics'
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
