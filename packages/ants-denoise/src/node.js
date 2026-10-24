// Loads the DenoiseImage WebAssembly module in Node after checking it is the pinned build.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDenoiser } from './index.js';
import { DENOISE_WASM_SHA256 } from './pin.js';

export { DENOISE_WASM_SHA256 };

export const DENOISE = Object.freeze({
  module: new URL('../wasm/ants-denoise.mjs', import.meta.url),
  wasm: new URL('../wasm/ants-denoise.wasm', import.meta.url),
});

export async function readDenoiseWasm(wasm = DENOISE.wasm) {
  const bytes = await readFile(wasm);
  if (createHash('sha256').update(bytes).digest('hex') !== DENOISE_WASM_SHA256) {
    throw new Error('Denoise WebAssembly checksum mismatch.');
  }
  return bytes;
}

export async function loadDenoise({ module = DENOISE.module, wasm = DENOISE.wasm, onLog } = {}) {
  const wasmBinary = await readDenoiseWasm(wasm);
  const { default: createModule } = await import(module);
  if (typeof createModule !== 'function') {
    throw new Error('Denoise module did not load.');
  }
  return createDenoiser({ createModule, wasmBinary, onLog });
}
