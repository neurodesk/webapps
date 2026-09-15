import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { browserSynthstrip } from '../../../packages/syncro/src/assets.js';

export async function extractSynthstrip({ volume, onProgress }) {
  ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  let storage;
  try { storage = await caches.open('neurodesk-models-v1'); } catch {}
  const cache = storage && {
    async get(key) { return (await storage.match(key))?.arrayBuffer(); },
    async set(key, bytes) { await storage.put(key, new Response(bytes)); },
    async delete(key) { await storage.delete(key); },
  };
  return runSynthstrip({
    volume,
    async loadModel() {
      const { url, bytes, sha256 } = browserSynthstrip;
      onProgress(0, 'Downloading SynthStrip model…');
      const model = await fetchModel({ url, integrity: { bytes, sha256 } }, {
        cache,
        onProgress: ({ fraction }) => onProgress((fraction || 0) * 0.15, 'Downloading SynthStrip model…'),
      });
      return { bytes: model, hash: sha256 };
    },
    createSession: bytes => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
    Tensor: ort.Tensor,
    onProgress,
  });
}
