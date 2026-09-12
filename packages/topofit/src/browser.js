import * as ort from 'onnxruntime-web/wasm';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = 1;

export const Tensor = ort.Tensor;

export function createBrowserSession(bytes) {
  return ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

export function browserRuntime() {
  return {
    inference: 'ONNX Runtime Web WASM',
    onnxruntime: ort.env.versions?.web || '1.29.0',
    threads: ort.env.wasm.numThreads,
    graphOptimizationLevel: 'all',
  };
}
