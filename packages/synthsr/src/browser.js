import { createStreamedWasmSession, needsStreamedWasm, WASM_IMPLEMENTATION } from './wasm-session.js';
import { createGpuSession, gpuBufferLimit, planGpuGraph, GPU_IMPLEMENTATION } from './gpu-session.js';

export { createGpuSession, planGpuGraph, GPU_IMPLEMENTATION } from './gpu-session.js';

// The backend to run when the app has not been told one. A software adapter (SwiftShader on a
// VM or a hosted runner) computes on the CPU and stops at 1 GiB buffers, so WASM is the faster
// and the only working choice there. With the prepared `shape`, WebGPU is chosen only when the
// adapter can bind the plan's largest buffer; without it, any hardware adapter qualifies.
export function chooseBrowserBackend(adapter, shape) {
  if (!adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) return 'wasm';
  if (!shape) return 'webgpu';
  const largest = Math.max(...planGpuGraph(shape).slots.map((slot) => slot.bytes));
  return largest <= gpuBufferLimit(adapter.limits) ? 'webgpu' : 'wasm';
}

// Apps supply their bundled ORT instance (and its WASM asset URLs). The shared
// pipeline supplies the prepared, padded shape, including its tiling policy.
export function createBrowserSession(ort, bytes, backend = 'wasm', shape, gpuOptions) {
  if (backend === 'webgpu') return createGpuSession(bytes, shape, gpuOptions);
  if (backend !== 'wasm') throw new Error('SynthSR browser backend must be wasm or webgpu.');
  if (shape && needsStreamedWasm(shape)) return createStreamedWasmSession(bytes, shape, ort);
  return ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
}

export function browserRuntime(backend = 'wasm', shape) {
  return backend === 'webgpu'
    ? { gpuImplementation: GPU_IMPLEMENTATION }
    : { onnxRuntime: '1.29.0', ...(shape ? {wasmImplementation:needsStreamedWasm(shape)?WASM_IMPLEMENTATION:'onnxruntime-full-volume'} : {}) };
}
