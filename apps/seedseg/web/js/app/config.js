export const VERSION = '0.7.20261031';
<<<<<<< monorepo
export { FOLDS, INFERENCE_DEFAULTS } from '../../vendor/seedseg/src/assets.js';
=======

// Models: nnU-Net v2 ResEnc folds exported to ONNX (scripts/deploy/export_onnx.py), hosted in the
// Hugging Face model repo ash347/seedseg and pinned to one commit, so the files cannot change
// under the app. v2/seedseg-v2.json holds the patch size, spacing, file names, sizes and SHA-256
// digests; each network is downloaded when first used, checked and cached in IndexedDB.
export const MODEL_HOST = 'https://huggingface.co/ash347/seedseg/resolve/ef4fb8f11a126425cde4b87e5fdca924032626b2';
export const MODEL_BASE_URL = `${MODEL_HOST}/v2`;
// Folder of each seedseg-v2.json variant under MODEL_BASE_URL
export const MODEL_DIRS = { web: 'browser', fp32: 'fp32' };

export const FOLDS = ['0', '1', '2', '3', '4'];

// Legacy v1 model (the previously released 4-network 3D U-Net consensus), Advanced settings only.
export const LEGACY_MODEL_BASE_URL = `${MODEL_HOST}/v1`;
export const LEGACY_MODELS = ['seedseg-model-seed42.onnx', 'seedseg-model-seed123.onnx',
  'seedseg-model-seed456.onnx', 'seedseg-model-seed789.onnx'];
export const LEGACY_SHA256 = {
  'seedseg-model-seed42.onnx': '7dc1ef1875b7027c56950cc3c35f1ffa8d67f7190a49df49811105cd639b784d',
  'seedseg-model-seed123.onnx': 'bfe4fe9140383e87a6c0c4cb2a6e9a84c3435f1413fd3644273bd9f1a0c3bdee',
  'seedseg-model-seed456.onnx': '2aa00094e01e978f3d85a882a97f9a1ef59da32341db4aaaf46c0c5388424ae7',
  'seedseg-model-seed789.onnx': 'e0cf5de01f36b1507e99910a92071bb888166aff4c5c90b902f04105ad8956c5'
};

// Example data: synthetic demo cases (no patient data) in the Hugging Face dataset
// ash347/seedseg-demo, pinned to one commit like the models. Hugging Face resolve URLs are
// public and CORS-enabled and return Content-Length, which drives the download progress bar.
export const EXAMPLE_DATA = {
  baseUrl: 'https://huggingface.co/datasets/ash347/seedseg-demo/resolve/d48dd5d3f005feb3f43b4b666332eede9e2837f0',
  files: ['demo-001_T1w.nii.gz']
};

export const INFERENCE_DEFAULTS = {
  threshold: 0.1,
  nMarkers: 3,
  folds: ['0'],
  mirror: false,
  model: 'web',      // seedseg-v2.json entry: *.wg16.onnx, fp16-stored weights, fp32 compute (WebGPU and WebAssembly)
  backend: 'auto'    // WebGPU when available, else WebAssembly
};
>>>>>>> upstream

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
  animationSpeed: 0.5,
  progressBarId: 'progress',
  statusTextId: 'statusText',
  elapsedId: 'elapsed',
  cancelId: 'cancelButton'
};
<<<<<<< monorepo
=======

export const STAGE_NAMES = {
  'input': 'Input T1w',
  'probability': 'Probability',
  'markers': 'Markers'
};

export const CACHE_CONFIG = {
  name: 'SeedSegModelCache',
  storeName: 'models',
  maxSizeMB: 1100
};

if (typeof self !== 'undefined') self.SeedSegConfig = { VERSION, EXAMPLE_DATA, MODEL_BASE_URL, MODEL_DIRS, FOLDS, INFERENCE_DEFAULTS, VIEWER_CONFIG, PROGRESS_CONFIG, STAGE_NAMES, CACHE_CONFIG };
>>>>>>> upstream
