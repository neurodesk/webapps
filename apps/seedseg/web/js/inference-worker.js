import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { createWorkerEmitter, fetchModel, getOptimalWasmThreads, installWorkerRouter } from '../vendor/webapp-components/src/worker/index.js';
import { runInference } from '../vendor/seedseg/src/pipeline.js';

const messages = createWorkerEmitter(self);
let niftiReady;
let qsm;
const loadDependencies = () => niftiReady ||= import('../nifti-js/index.js');

installWorkerRouter({
  scope: self,
  getServices: loadDependencies,
  handle: async ({ type, data }) => {
    if (type === 'init') {
      ort.env.wasm.numThreads = Math.min(4, getOptimalWasmThreads());
      ort.env.wasm.wasmPaths = '../wasm/';
      qsm = await import(new URL('../wasm/qsm_wasm.js', import.meta.url).href);
      await qsm.default({ module_or_path: new URL('../wasm/qsm_wasm_bg.wasm', import.meta.url) });
      messages.initialized();
    } else if (type === 'run') {
      const settings = data.settings;
      await runInference(data.inputData, {
        ...settings,
        Tensor: ort.Tensor,
        qsm,
        decompress: bytes => globalThis.nifti.decompress(bytes),
        createSession: bytes => ort.InferenceSession.create(bytes, {
          executionProviders: ['wasm'], graphOptimizationLevel: 'all',
        }),
        loadModel: async (asset, name, base, span) => {
          const url = `${settings.modelBaseUrl}/${asset.filename}`;
          const bytes = await fetchModel({ url, urls: [url, url], cacheKey: asset.url,
            integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
            cache: 'SeedSegVerifiedModels',
            onInvalidCache: error => messages.log(`Discarding cached model: ${error.message}`),
            onCacheError: error => messages.log(`Model cache unavailable: ${error.message}`),
            onProgress: ({ fraction }) => {
              if (fraction !== null) messages.progress(base + fraction * span, `Downloading ${name}...`);
            },
          });
          messages.log(`Verified ${name} (${(bytes.byteLength / 1048576).toFixed(1)} MB)`);
          return bytes;
        },
        events: {
          log: message => messages.log(message),
          progress: (fraction, message) => messages.progress(fraction, message),
          stageData: (stage, bytes, description) => messages.stageData(stage, bytes, description),
        },
      });
      messages.complete();
    }
  },
});
