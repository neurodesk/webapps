import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { createWorkerEmitter, fetchModel, getOptimalWasmThreads, installWorkerRouter } from '../vendor/webapp-components/src/worker/index.js';
import { runInference } from '../vendor/seedseg/src/pipeline.js';
import runtime from '../vendor/seedseg/browser-runtime.manifest.json' with { type: 'json' };
import { runWithFallback } from '../vendor/seedseg/src/session.js';

const messages = createWorkerEmitter(self);
const observedGpuDevices = new WeakSet();
let niftiReady;
let qsm;
const loadDependencies = () => niftiReady ||= import('../nifti-js/index.js');

function observeGpuDevice() {
  Promise.resolve().then(() => ort.env.webgpu.device).then(device => {
    if (observedGpuDevices.has(device)) return;
    observedGpuDevices.add(device);
    messages.log(`WebGPU device: ${JSON.stringify({
      vendor: device.adapterInfo?.vendor,
      architecture: device.adapterInfo?.architecture,
      shaderF16: device.features.has('shader-f16'),
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
    })}`);
    device.addEventListener('uncapturederror', event => {
      messages.log(`WebGPU ${event.error.constructor.name}: ${event.error.message}`);
    });
    device.lost.then(info => {
      if (info.reason !== 'destroyed') messages.log(`WebGPU device lost (${info.reason}): ${info.message}`);
    });
  }).catch(error => messages.log(`WebGPU diagnostics unavailable: ${error.message}`));
}

installWorkerRouter({
  scope: self,
  getServices: loadDependencies,
  handle: async ({ type, data }) => {
    if (type === 'init') {
      ort.env.wasm.numThreads = Math.min(4, getOptimalWasmThreads());
      ort.env.wasm.wasmPaths = new URL('../wasm/', self.location.href).href;
      qsm = await import(new URL('../wasm/qsm_wasm.js', import.meta.url).href);
      await qsm.default({ module_or_path: new URL('../wasm/qsm_wasm_bg.wasm', import.meta.url) });
      messages.initialized();
    } else if (type === 'run') {
      const settings = data.settings;
      if (!ort.env.wasm.wasmBinary) {
        messages.progress(0.01, 'Loading inference runtime...');
        const bytes = await fetchModel({ url: runtime.url, cacheKey: runtime.url,
          integrity: { bytes: runtime.bytes, sha256: runtime.sha256 } }, {
          onInvalidCache: error => messages.log(`Discarding cached runtime: ${error.message}`),
          onCacheError: error => messages.log(`Runtime cache unavailable: ${error.message}`),
        });
        ort.env.wasm.wasmBinary = new Uint8Array(bytes);
      }
      if (!['auto', 'wasm'].includes(settings.backend ?? 'auto')) throw new Error('Backend must be auto or wasm.');
      let backend = settings.backend !== 'wasm' && await navigator.gpu?.requestAdapter().catch(() => null) ? 'webgpu' : 'wasm';
      const result = await runInference(data.inputData, {
        ...settings,
        Tensor: ort.Tensor,
        qsm,
        decompress: bytes => globalThis.nifti.decompress(bytes),
        createSession: bytes => ort.InferenceSession.create(bytes, {
          executionProviders: ['wasm'], graphOptimizationLevel: 'all',
        }),
        runSession: (bytes, execute) => runWithFallback({
          backend, execute,
          createSession: async provider => {
            const session = await ort.InferenceSession.create(bytes, {
              executionProviders: [provider], graphOptimizationLevel: 'all',
            });
            if (provider === 'webgpu') observeGpuDevice();
            return session;
          },
          onFallback: error => {
            backend = 'wasm';
            messages.log(`WebGPU failed (${error.message}); retrying this network with WebAssembly`);
          },
        }),
        loadModel: async (asset, name, base, span) => {
          const bytes = await fetchModel({ url: asset.url, cacheKey: asset.url,
            integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
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
      const { stages, ...report } = result;
      messages.complete({ report: { ...report, executionProvider: result.detections?.backend ?? 'wasm', onnxRuntime: ort.env.versions.web } });
    }
  },
});
