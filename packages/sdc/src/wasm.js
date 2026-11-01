// Glue for ./sdc.wasm (exes/sdc/wasm): a plain C ABI, no wasm-bindgen.
import { createGpuSolver, hasJspi, requestHardwareAdapter, requestSdcDevice } from "./webgpu.js";

// The CPU instance never calls the sdc_gpu imports; a WebGPU run gets its own instance.
const NO_GPU = Object.fromEntries(
  ["setup", "eval", "pcg", "corrected"].map((name) => [
    name,
    () => {
      throw new Error("The CPU instance has no WebGPU solver.");
    },
  ]),
);

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadSdc(source) {
  const module = await compile(await source);
  const wasm = (await WebAssembly.instantiate(module, { sdc_gpu: NO_GPU })).exports;

  /**
   * Estimates the susceptibility field from two b0 volumes with opposite phase-encoding
   * directions (PyHySCO 0.0.4 defaults).
   * @param image1 Float64Array of dims[0] × dims[1] × dims[2] values, first index fastest
   * @param image2 the same size, aligned to image1, with the opposite direction
   * @param voxel voxel sizes in mm (the affine's column lengths)
   * @param options.phaseEncodingDirection image 1's BIDS PhaseEncodingDirection: i, i-, j or j-
   * @param options.totalReadoutTime image 1's TotalReadoutTime in seconds
   * @returns {{ field: Float64Array, corrected1: Float64Array, corrected2: Float64Array, iterations: number }}
   *   the field in Hz (topup's sign) and the two corrected images (normalized), in the input order
   */
  function pyhysco(image1, image2, dims, voxel, options) {
    return call(wasm, wasm.pyhysco, image1, image2, dims, voxel, options);
  }

  // One solver per backend and device: `auto` and `webgpu` may pick different adapters.
  const solvers = new Map();

  /**
   * `pyhysco` on a chosen backend, as a promise. `options.backend`:
   * - "cpu": the WebAssembly path, the same numbers as `pyhysco`;
   * - "webgpu": the Gauss-Newton evaluations and the CG solves on WebGPU in float32
   *   (`options.device`, or a device of the browser's default adapter, also a software one);
   * - "auto" (default): WebGPU on a hardware adapter when the engine has JSPI, else the CPU.
   *   When the WebGPU run fails, `auto` runs the CPU path and reports the failure as `gpuError`.
   * @returns the result of `pyhysco` with `backend` ("cpu" or "webgpu") and, when given,
   *   `adapter` (the adapter's vendor and architecture) and `gpuError`
   */
  async function estimate(image1, image2, dims, voxel, options = {}) {
    const backend = options.backend ?? "auto";
    if (backend !== "auto" && backend !== "webgpu" && backend !== "cpu") throw new Error(`backend must be auto, webgpu or cpu, not "${backend}".`);
    const cpu = () => ({ ...pyhysco(image1, image2, dims, voxel, options), backend: "cpu" });
    if (backend === "cpu") return cpu();
    const key = options.device ?? backend;
    // A device that this module opened and the browser then lost is opened again.
    if ((await solvers.get(key)?.catch(() => null))?.lost()) solvers.delete(key);
    if (!solvers.has(key)) solvers.set(key, openGpu(backend, options.device));
    let solver;
    try {
      solver = await solvers.get(key);
    } catch (error) {
      solvers.delete(key);
      if (backend === "webgpu") throw error;
      return { ...cpu(), gpuError: error?.message ?? String(error) };
    }
    if (!solver) return cpu();
    try {
      return { ...(await runGpu(solver, image1, image2, dims, voxel, options)), backend: "webgpu", adapter: solver.adapter };
    } catch (error) {
      if (backend === "webgpu") throw error;
      // Invalid input fails on the CPU path with its own message; only a GPU failure remains.
      const out = cpu();
      // A lost device is opened again on the next run; any other failure keeps auto on the CPU.
      if (solver.lost()) solvers.delete(key);
      else solvers.set(key, Promise.resolve(null));
      return { ...out, gpuError: error?.message ?? String(error) };
    }
  }

  async function runGpu(solver, image1, image2, dims, voxel, options) {
    let instance = null;
    const run = solver.imports(() => instance.exports.memory);
    globalThis.sdcStage = "instantiate";
    instance = await WebAssembly.instantiate(module, { sdc_gpu: run.imports });
    const { device } = solver;
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    let out;
    let failure = null;
    try {
      out = await call(instance.exports, WebAssembly.promising(instance.exports.pyhysco_webgpu), image1, image2, dims, voxel, options);
    } catch (error) {
      failure = error;
    }
    run.dispose();
    globalThis.sdcStage = "popErrorScope";
    const memoryError = await device.popErrorScope();
    const validationError = await device.popErrorScope();
    globalThis.sdcStage = "popErrorScope done";
    // A WebGPU error explains a failure better than the error it caused in the WebAssembly.
    const error = memoryError ?? validationError;
    if (error) throw new Error(`WebGPU failed: ${error.message}`);
    if (failure) throw failure;
    return out;
  }

  return { pyhysco, estimate };
}

/** A WebGPU solver for `backend`, or null when `auto` finds no usable hardware path. */
async function openGpu(backend, device) {
  if (!hasJspi()) {
    if (backend === "webgpu") throw new Error("WebGPU PyHySCO needs WebAssembly JSPI (WebAssembly.Suspending), which this engine lacks.");
    return null;
  }
  let adapterInfo = null;
  let lost = false;
  if (!device) {
    const gpu = globalThis.navigator?.gpu;
    globalThis.sdcStage = `requestAdapter ${backend}`;
    const adapter = backend === "webgpu" ? await gpu?.requestAdapter() : await requestHardwareAdapter(gpu);
    globalThis.sdcStage = `requestAdapter ${backend} done`;
    if (!adapter) {
      if (backend === "webgpu") throw new Error("No WebGPU adapter is available.");
      return null;
    }
    adapterInfo = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(" ");
    globalThis.sdcStage = "requestDevice";
    device = await requestSdcDevice(adapter);
    globalThis.sdcStage = "requestDevice done";
    device.lost?.then((info) => {
      globalThis.sdcStage = `device lost: ${info?.reason} ${info?.message} (was ${globalThis.sdcStage})`;
      lost = true;
    });
  }
  const solver = await createGpuSolver(device);
  return { ...solver, device, adapter: adapterInfo, lost: () => lost };
}

/** Copies the inputs in, runs `entry` (sync or a promise) and copies the outputs out. */
function call(wasm, entry, image1, image2, dims, voxel, options) {
  const { axis, sign } = phaseEncoding(options.phaseEncodingDirection);
  const length = dims[0] * dims[1] * dims[2];
  for (const image of [image1, image2]) {
    if (image.length !== length) throw new Error(`Expected ${length} voxels, received ${image.length}.`);
  }
  const trt = Number(options.totalReadoutTime);
  if (!(trt > 0)) throw new Error("TotalReadoutTime must be a positive number of seconds.");
  const bytes = length * 8;
  const pointers = Array.from({ length: 5 }, () => wasm.alloc(bytes));
  const [in1, in2, field, out1, out2] = pointers;
  const free = () => {
    for (const pointer of pointers) wasm.dealloc(pointer, bytes);
  };
  const finish = (iterations) => {
    if (iterations === 0) throw new Error("PyHySCO refused the input: images need finite intensities, a nonzero common intensity range, positive voxel sizes and at least 3 voxels per axis.");
    const read = (pointer) => new Float64Array(wasm.memory.buffer, pointer, length).slice();
    return { field: read(field), corrected1: read(out1), corrected2: read(out2), iterations };
  };
  let result;
  try {
    new Float64Array(wasm.memory.buffer, in1, length).set(image1);
    new Float64Array(wasm.memory.buffer, in2, length).set(image2);
    result = entry(in1, in2, dims[0], dims[1], dims[2], voxel[0], voxel[1], voxel[2], axis, sign, trt, field, out1, out2);
  } catch (error) {
    free();
    throw error;
  }
  if (!(result instanceof Promise)) {
    try {
      return finish(result);
    } finally {
      free();
    }
  }
  return result.then(finish).finally(free);
}

/**
 * The axis (0 for i, 1 for j) and sign of a BIDS PhaseEncodingDirection. PyHySCO needs an
 * in-plane direction, so k is refused.
 */
export function phaseEncoding(code) {
  const text = String(code ?? "");
  const axis = { i: 0, j: 1 }[text.replace(/-$/, "")];
  if (axis === undefined) throw new Error(`PhaseEncodingDirection must be i, i-, j or j-, not "${text}".`);
  return { axis, sign: text.endsWith("-") ? -1 : 1 };
}

/** True when two BIDS PhaseEncodingDirection values are opposite directions on one axis. */
export function isReversePair(first, second) {
  const a = phaseEncoding(first);
  const b = phaseEncoding(second);
  return a.axis === b.axis && a.sign !== b.sign;
}

async function compile(source) {
  if (source instanceof WebAssembly.Module) return source;
  const bytes = typeof Response !== "undefined" && source instanceof Response ? await source.arrayBuffer() : source;
  return WebAssembly.compile(bytes);
}
