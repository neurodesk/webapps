export const VERSION = '1.2.37';

// Immutable model weights are published separately from the site artifact.
export const MODEL_BASE_URL = 'https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap';

export const MODELS = [
  { name: 'musclemap-wholebody.onnx', label: 'Whole Body', numClasses: 100, roiSize: [256, 256] },
  { name: 'musclemap-abdomen.onnx', label: 'Abdomen', numClasses: 9, roiSize: [128, 128] },
  { name: 'musclemap-forearm.onnx', label: 'Forearm', numClasses: 6, roiSize: [256, 256] },
  { name: 'musclemap-leg.onnx', label: 'Leg', numClasses: 15, roiSize: [128, 128] },
  { name: 'musclemap-pelvis.onnx', label: 'Pelvis', numClasses: 14, roiSize: [128, 128] },
  { name: 'musclemap-thigh.onnx', label: 'Thigh', numClasses: 29, roiSize: [128, 128] },
];

export const INFERENCE_DEFAULTS = {
  targetSpacing: [1.0, 1.0, -1], // -1 means keep original z spacing
  cropForegroundMargin: 20,
  overlap: 0.5, // 50% overlap for sliding window
  chunkSize: 'auto', // Number of tiles per inference call ('auto' or 1/2/4/8)
  sliceThickness: -1, // Z-axis spacing in mm; -1 means keep original
  lowRes: false, // When true, run faster lower-resolution postprocessing
  imfMetrics: {
    enabled: false,
    method: 'kmeans',
    components: 2
  }
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
  'segmentation': 'Segmentation'
};

export const ONNX_CONFIG = {
  executionProviders: ['webgpu', 'wasm'],
  graphOptimizationLevel: 'all'
};

export const CACHE_CONFIG = {
  name: 'MuscleMapModelCache',
  storeName: 'models',
  maxSizeMB: 500
};

if (typeof self !== 'undefined') self.MuscleMapConfig = { VERSION, MODEL_BASE_URL, MODELS, INFERENCE_DEFAULTS, VIEWER_CONFIG, PROGRESS_CONFIG, STAGE_NAMES, ONNX_CONFIG, CACHE_CONFIG };
