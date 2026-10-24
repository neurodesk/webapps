// Module worker entry: runs ANTs DenoiseImage off the main thread.
//
//   const worker = new Worker(denoiseWorkerUrl, { type: 'module' });
//   worker.postMessage({ id, image, mask });   // NIfTI bytes, gzipped or not; mask is optional
//   worker.onmessage = ({ data }) => ...;      // { id, output, log, heapBytes } or { id, error, log, heapBytes }
//
// The message may also carry the denoise settings of createDenoiser().denoise() (noiseModel,
// shrinkFactor, patchRadius, searchRadius) and `kernel: { module, wasm }` URLs when a bundler or
// the app moved the module files. The module is loaded once, after the SHA-256 of its WebAssembly
// matches the pinned build, and serves every later message. After a run aborts the module, the
// next message loads a new one. heapBytes is the module's heap after the message, which never
// shrinks, so it is the peak of this worker. Messages run one at a time, in the order they come.
import { createDenoiser } from './index.js';
import { DENOISE_WASM_SHA256 } from './pin.js';

const DEFAULT_KERNEL = {
  module: new URL('../wasm/ants-denoise.mjs', import.meta.url).href,
  wasm: new URL('../wasm/ants-denoise.wasm', import.meta.url).href,
};

const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

// The log of the message that runs now; the module writes to it while it loads and runs.
let lines = [];

async function loadKernel({ module, wasm }) {
  const response = await fetch(wasm);
  if (!response.ok) {
    throw new Error(`Denoise WebAssembly did not load (HTTP ${response.status}).`);
  }
  const wasmBinary = new Uint8Array(await response.arrayBuffer());
  if (hex(await crypto.subtle.digest('SHA-256', wasmBinary)) !== DENOISE_WASM_SHA256) {
    throw new Error('Denoise WebAssembly checksum mismatch.');
  }
  const { default: createModule } = await import(/* @vite-ignore */ module);
  if (typeof createModule !== 'function') {
    throw new Error('Denoise module did not load.');
  }
  return createDenoiser({ createModule, wasmBinary, onLog: (line) => lines.push(String(line)) });
}

// ants-denoise index.js words an abort this way, with the module's error as the cause.
const isAbort = (error) => error?.cause !== undefined && /DenoiseImage aborted/.test(error?.message ?? '');

let kernel = null;
let queue = Promise.resolve();

async function handle(data) {
  const { id, image, mask = null, kernel: urls, ...settings } = data ?? {};
  lines = [];
  const log = lines;
  let denoiser = null;
  try {
    kernel ??= loadKernel({ ...DEFAULT_KERNEL, ...urls }).catch((error) => {
      kernel = null;
      throw error;
    });
    denoiser = await kernel;
    const bytes = await denoiser.denoise({ ...settings, image, mask });
    // FS.readFile copies, so the output normally owns its buffer; a view is copied before the transfer.
    const output = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    self.postMessage({ id, output, log, heapBytes: denoiser.memoryBytes() }, [output.buffer]);
  } catch (error) {
    const heapBytes = denoiser?.memoryBytes() ?? null;
    if (isAbort(error)) {
      kernel = null;
    }
    self.postMessage({ id, error: error?.message ?? String(error), log, heapBytes });
  }
}

self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
  return queue;
};
