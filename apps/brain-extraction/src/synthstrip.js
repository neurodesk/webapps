import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { createBrowserSession } from '@neurodesk/synthstrip/browser';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { SYNTHSTRIP_MODEL } from '@neurodesk/synthstrip/model';

export async function extractSynthstrip({ volume, onProgress }) {
  ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  return runSynthstrip({
    volume,
    async loadModel() {
      const { url, bytes, sha256 } = SYNTHSTRIP_MODEL;
      onProgress(0, 'Downloading SynthStrip model…');
      const model = await fetchModel({ url, integrity: { bytes, sha256 } }, {
        onProgress: ({ fraction }) => onProgress((fraction || 0) * 0.15, 'Downloading SynthStrip model…'),
      });
      return { bytes: model, hash: sha256 };
    },
    // Layer by layer in slabs: one whole-graph session outgrows the 4 GB WebAssembly heap at 256³.
    createSession: (bytes, dims) => createBrowserSession(bytes, dims, ort),
    Tensor: ort.Tensor,
    onProgress,
  });
}
