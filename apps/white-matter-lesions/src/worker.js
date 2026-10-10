import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { readVolume } from '@neurodesk/synthsr';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { nonzeroMask, runFolds } from '@neurodesk/white-matter-lesions';
import { FLAMES_FOLDS, SYNTHSTRIP } from '@neurodesk/white-matter-lesions/assets';
import { lesionResults } from '@neurodesk/white-matter-lesions/results';

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
const log = (message) => self.postMessage({ type: 'log', message });

async function modelCache() {
  try {
    const storage = await caches.open('neurodesk-models-v1');
    return {
      async get(key) { return (await storage.match(key))?.arrayBuffer(); },
      async set(key, bytes) { await storage.put(key, new Response(bytes)); },
      async delete(key) { await storage.delete(key); },
    };
  } catch {
    return null;
  }
}

async function download(asset, label, from, to, cache) {
  progress(from, `Downloading ${label}…`);
  return fetchModel({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
    cache,
    onProgress: ({ fraction }) => progress(from + (to - from) * (fraction || 0), `Downloading ${label}…`),
  });
}

async function brainMask(volume, cache) {
  const result = await runSynthstrip({
    volume,
    loadModel: async () => ({ bytes: await download(SYNTHSTRIP, 'brain extraction model', 0.02, 0.08, cache), hash: SYNTHSTRIP.sha256 }),
    createSession: (bytes) => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
    Tensor: ort.Tensor,
    onProgress: (value, message) => progress(0.08 + 0.12 * value, message),
  });
  return result.mask.data;
}

async function segment(folds, cache, backend, volume, brainMask) {
  progress(0.3, 'Preparing FLAMeS…');
  log(`FLAMeS, ${folds.length === 1 ? 'fold 0' : `${folds.length} folds`}, on ${backend === 'webgpu' ? 'WebGPU' : `WebAssembly, ${ort.env.wasm.numThreads} threads`}`);
  return runFolds({
    volume,
    brainMask,
    folds: folds.length,
    loadModel: (n) => {
      const label = folds.length === 1 ? 'FLAMeS model' : `FLAMeS model ${n + 1} of ${folds.length}`;
      const from = 0.3 + 0.65 * n / folds.length;
      return download(folds[n], label, from, from, cache);
    },
    createSession: (bytes) => ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: 'all' }),
    Tensor: ort.Tensor,
    onPatch: (n, total) => progress(0.3 + 0.65 * n / total, `Segmenting lesions · patch ${n} of ${total}`),
  });
}

self.onmessage = async ({ data: job }) => {
  try {
    const volume = readVolume(await job.file.arrayBuffer());
    const cache = await modelCache();
    let mask;
    if (job.skullStripped) {
      mask = nonzeroMask(volume);
      progress(0.2, 'Using nonzero voxels as the brain');
    } else {
      mask = await brainMask(volume, cache);
    }
    const folds = FLAMES_FOLDS.slice(0, job.folds);
    const started = performance.now();
    let backend = job.backend;
    let result;
    try {
      result = await segment(folds, cache, backend, volume, mask);
    } catch (error) {
      if (backend !== 'webgpu') throw error;
      log(`WebGPU failed (${error.message}); continuing on the CPU`);
      backend = 'wasm';
      result = await segment(folds, cache, backend, volume, mask);
    }
    const { probability, windows, resampledShape } = result;
    const outputs = lesionResults(volume, probability);
    self.postMessage({
      type: 'result',
      ...outputs,
      provenance: {
        models: folds.map((fold) => ({ file: fold.filename, sha256: fold.sha256 })),
        backend,
        brainMask: job.skullStripped ? 'nonzero voxels' : 'SynthStrip',
        resampledShape,
        windows,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      },
    }, [outputs.mask, outputs.probability]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
