import { fetchModel } from '@neurodesk/webapp-components/worker';
import { runSynthsr } from '@neurodesk/synthsr';
import { createBrowserSession, browserRuntime } from '@neurodesk/synthsr/browser';
import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');

async function modelBytes(model) {
  if (model.file) {
    if (model.file.size !== model.bytes) {
      throw new Error('Choose the validated synthsr-v2.onnx file. This file has a different size.');
    }
    const bytes = await model.file.arrayBuffer();
    const hash = await sha256(bytes);
    if (model.sha256 && hash !== model.sha256.toLowerCase()) {
      throw new Error('These weights do not match SynthSR v2. Choose the exported synthsr-v2.onnx file.');
    }
    return { bytes, hash };
  }
  const bytes = await fetchModel({
    url: model.url,
    integrity: { bytes: model.bytes, sha256: model.sha256 },
  }, {
    cache: 'neurodesk-synthsr-v1',
    requestFailureMessage: 'Could not download SynthSR weights. Check the connection or choose a local model file.',
    onProgress: ({ received, fraction }) => progress(
      0.12 + 0.13 * Math.min(1, fraction ?? 1),
      `Loading model · ${(received / 1048576).toFixed(1)} MB`,
    ),
  });
  const hash = model.sha256 ? model.sha256.toLowerCase() : await sha256(bytes);
  return { bytes, hash };
}

self.onmessage = async ({ data: job }) => {
  try {
    const runtime = { app: 'SynthSR web 0.1.2', ...browserRuntime(job.options.backend) };
    const { buffer, provenance } = await runSynthsr({
      buffer: await job.file.arrayBuffer(),
      options: job.options,
      Tensor: ort.Tensor,
      loadModel: () => modelBytes(job.model),
      createSession: (bytes, backend, shape) => {
        Object.assign(runtime, browserRuntime(backend, shape));
        return createBrowserSession(ort, bytes, backend, shape);
      },
      onProgress: progress,
      runtime,
    });
    self.postMessage({ type: 'result', buffer, provenance }, [buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
