import {
  APP_VERSION,
  LABEL_SPACES,
  MODEL_BASE_URL as GENERATED_MODEL_BASE_URL,
  MODEL_RELEASES,
  MODELS
} from './model-catalog.generated.js';

export const VERSION = APP_VERSION;
export const MODEL_BASE_URL = GENERATED_MODEL_BASE_URL;
export { LABEL_SPACES, MODEL_RELEASES, MODELS };

export const INFERENCE_DEFAULTS = {
  targetSpacing: [1.0, 1.0, -1],
  cropForegroundMargin: 20,
  overlap: MODELS[0].preprocessing.overlapDefault,
  chunkSize: 'auto',
  sourceChunkSize: 17,
  imfMetrics: {
    enabled: false,
    method: 'kmeans',
    components: 2
  }
};

export const VIEWER_CONFIG = {
  loadingText: '',
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
  input: 'Input',
  segmentation: 'Segmentation'
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

if (typeof self !== 'undefined') {
  self.MuscleMapConfig = {
    VERSION,
    MODEL_BASE_URL,
    MODELS,
    MODEL_RELEASES,
    LABEL_SPACES,
    INFERENCE_DEFAULTS,
    VIEWER_CONFIG,
    PROGRESS_CONFIG,
    STAGE_NAMES,
    ONNX_CONFIG,
    CACHE_CONFIG
  };
}
