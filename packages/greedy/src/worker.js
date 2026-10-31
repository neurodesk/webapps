// A module worker that runs the single-threaded Greedy build (wasm-single/), the bytes the Node
// command lines run, so a browser and Node give the same matrix. Serve src/ beside wasm-single/.
//   in:  { id, method: 'affine' | 'rigid', fixed, moving, wasm? }   raw .nii bytes; wasm: moved .wasm URL
//        { id, method: 'svf', fixed, moving, matrix, mask, wasm? }   registerSvfGreedy's arguments
//   out: { id, result, heapBytes } | { id, error, heapBytes }   result: the matrix text, or the warp
import init, * as api from "../wasm-single/greedy_rs_wasm.js";
import { registerAffineGreedy, registerRigidGreedy, registerSvfGreedy } from "./index.js";

const METHODS = { affine: registerAffineGreedy, rigid: registerRigidGreedy, svf: registerSvfGreedy };
let ready = null;

self.onmessage = async ({ data: { id, method, wasm, ...args } }) => {
  let exports = null;
  try {
    ready ??= init(wasm ? { module_or_path: wasm } : undefined);
    exports = await ready;
    const register = METHODS[method];
    if (!register) throw new Error(`Unknown Greedy method ${method}.`);
    const result = register({ api, ...args });
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id, result, heapBytes: exports.memory.buffer.byteLength }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error), heapBytes: exports?.memory.buffer.byteLength ?? null });
  }
};
