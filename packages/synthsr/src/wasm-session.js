import model from './gpu-model.json' with { type: 'json' };
import { planGpuGraph } from './gpu-session.js';
import { createStreamedSession } from '@neurodesk/runtime-support/streamed-onnx';

export const WASM_IMPLEMENTATION = 'synthsr-streamed-fp32-v1';
export const needsStreamedWasm = dims => dims.reduce((a, b) => a * b, 1) > 8 * 1024 * 1024;

export function createStreamedWasmSession(raw, dims, ort, options = {}) {
  return createStreamedSession(raw, dims, ort, {
    ...options,
    model,
    nodes: planGpuGraph(dims).nodes,
    implementation: WASM_IMPLEMENTATION,
  });
}
