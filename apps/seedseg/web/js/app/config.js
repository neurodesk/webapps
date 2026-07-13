export const VERSION = '0.2.6';

// Immutable model weights are published separately from the site artifact.
export const MODEL_BASE_URL = 'https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/seedseg';

export const MODELS = [
  { name: 'seedseg-model-seed42.onnx', label: 'Model 1 (seed 42)', seed: 42 },
  { name: 'seedseg-model-seed123.onnx', label: 'Model 2 (seed 123)', seed: 123 },
  { name: 'seedseg-model-seed456.onnx', label: 'Model 3 (seed 456)', seed: 456 },
  { name: 'seedseg-model-seed789.onnx', label: 'Model 4 (seed 789)', seed: 789 }
];

export const INFERENCE_DEFAULTS = {
  threshold: 0.1,
  nMarkers: 3,
  padFactor: 32
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
  'input': 'Input T1w',
  'model1': 'Model 1',
  'model2': 'Model 2',
  'model3': 'Model 3',
  'model4': 'Model 4',
  'avgProb': 'Avg Prob',
  'consensus': 'Consensus'
};

export const ONNX_CONFIG = {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all'
};

export const CACHE_CONFIG = {
  name: 'SeedSegModelCache',
  storeName: 'models',
  maxSizeMB: 500
};

if (typeof self !== 'undefined') self.SeedSegConfig = { VERSION, MODEL_BASE_URL, MODELS, INFERENCE_DEFAULTS, VIEWER_CONFIG, PROGRESS_CONFIG, STAGE_NAMES, ONNX_CONFIG, CACHE_CONFIG };
