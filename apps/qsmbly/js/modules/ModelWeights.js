import { fetchModel } from '../../vendor/webapp-components/src/worker/fetchModel.js';
/**
 * Deep-learning model weight manager (browser side).
 *
 * The WASM build can't download its own weights (qsm-core's `download` feature is native-
 * only), so the model registry — exposed by `get_model_registry_wasm()` in the base wasm —
 * tells us each model's weight file URLs / sizes / hashes, and this module fetches them,
 * caches verified bytes by SHA-256 in shared Cache Storage, and hands the raw bytes to the
 * DL wasm functions. It also lazy-loads the larger `onnx` wasm bundle on first DL use.
 *
 * Runs in the Web Worker.
 */

/** Parse the JSON from `get_model_registry_wasm()` into `{ id: modelSpec }`. */
export function parseRegistry(json) {
  const byId = {};
  try {
    for (const m of JSON.parse(json)) byId[m.id] = m;
  } catch (e) {
    console.error('parseRegistry failed:', e);
  }
  return byId;
}

/** Fetch and validate model weights through the shared worker downloader. */
export async function fetchModelWeights(model, onProgress, weightBaseUrl = '') {
  const out = [];
  for (const [index, file] of model.files.entries()) {
    const url = weightBaseUrl ? `${weightBaseUrl.replace(/\/$/, '')}/${file.name}` : file.url;
    let downloaded = false;
    const bytes = await fetchModel({
      url,
      integrity: { bytes: Number(file.bytes), sha256: file.sha256 },
    }, {
      onProgress: ({ received, total }) => onProgress?.(index, file.name, received, total, false),
      onDownloaded: () => { downloaded = true; },
      onCacheError: error => console.warn(`Could not cache ${file.name}: ${error.message}`),
    });
    onProgress?.(index, file.name, bytes.byteLength, bytes.byteLength, !downloaded);
    out.push(new Uint8Array(bytes));
  }
  return out;
}

// Lazy-load the onnx wasm bundle (bigger; only needed for deep-learning inference).
let _dlModulePromise = null;

/** Load + init the DL wasm bundle once; resolves to its module namespace. */
export function loadDlWasm(baseUrl, version) {
  if (!_dlModulePromise) {
    _dlModulePromise = (async () => {
      const jsUrl = `${baseUrl}/wasm/qsm_wasm_dl.js?v=${version}`;
      const wasmUrl = `${baseUrl}/wasm/qsm_wasm_dl_bg.wasm`;
      const mod = await import(jsUrl);
      await mod.default(wasmUrl);
      return mod;
    })().catch((e) => { _dlModulePromise = null; throw e; });
  }
  return _dlModulePromise;
}
