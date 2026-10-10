import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import {
  createWorkerEmitter,
  getOptimalWasmThreads,
  installWorkerRouter,
  localForageCache,
} from '../vendor/webapp-components/src/worker/index.js';
import { parseNiftiVolume } from '../vendor/webapp-components/src/file-io/NiftiUtils.js';
import { createVesselBoostPipeline } from '../vendor/vesselboost/src/pipeline.js';
import { fetchVerifiedModel } from '../vendor/vesselboost/src/browser-loader.js';
import { modelAsset } from '../vendor/vesselboost/src/assets.js';
import { MODEL_BASE_URL } from './app/config.js';
import * as preprocessing from '../preprocessing-wasm/preprocessing.js';

const events = createWorkerEmitter(self);
let pipeline;
let dependencies;
function loadDependencies() {
  dependencies ||= Promise.all([
    import('https://cdn.jsdelivr.net/npm/localforage@1.10.0/+esm'),
    import('../nifti-js/index.js'),
    preprocessing.default(),
  ]).then(([{ default: cache }]) => {
    cache.config({ name: 'VesselBoostModelCache', storeName: 'models' });
    ort.env.wasm.numThreads = getOptimalWasmThreads();
    ort.env.wasm.wasmPaths = '../wasm/';
    pipeline = createVesselBoostPipeline({
      ort,
      preprocessingWasm: preprocessing,
      parseVolume: (bytes) => parseNiftiVolume(bytes, { decompress: globalThis.nifti.decompress }),
      events,
      modelBaseUrl: MODEL_BASE_URL,
      sessionOptions: { executionProviders: ['wasm'] },
      fetchModel: async (url, name, base, span) => {
        const asset = modelAsset(name);
        return fetchVerifiedModel(asset, {
          url,
          cache: localForageCache(cache),
          onInvalidCache: (error) => events.log(`Discarding cached model: ${error.message}`),
          onProgress: ({ fraction }) => {
            if (fraction !== null) events.progress(base + fraction * span, `Downloading ${name}`);
          },
        });
      },
    });
  });
  return dependencies;
}
installWorkerRouter({
  scope: self,
  getServices: loadDependencies,
  handle: async ({ type, data }) => {
    if (type === 'init') {
      events.log(`Using WASM backend (${ort.env.wasm.numThreads} threads)`);
      events.log('Required preprocessing WASM ready (N4ITK + NLM + BET)');
      events.initialized({ wasmPreprocessingAvailable: true });
      return;
    }
    await pipeline.dispatch(type, data);
  },
});
