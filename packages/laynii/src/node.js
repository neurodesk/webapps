// Loads the LayNii WebAssembly module in Node after checking it matches the pinned build.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createLayniiRunner } from './index.js';
import { LAYNII_WASM_SHA256 } from './pin.js';

export { LAYNII_WASM_SHA256 };

export const LAYNII = Object.freeze({
  module: new URL('../wasm/laynii.mjs', import.meta.url),
  wasm: new URL('../wasm/laynii.wasm', import.meta.url),
});

export async function readLayniiWasm(wasm = LAYNII.wasm) {
  const bytes = await readFile(wasm);
  if (createHash('sha256').update(bytes).digest('hex') !== LAYNII_WASM_SHA256) {
    throw new Error('LayNii WebAssembly checksum mismatch.');
  }
  return bytes;
}

export async function loadLaynii({ module = LAYNII.module, wasm = LAYNII.wasm, onLog } = {}) {
  const wasmBinary = await readLayniiWasm(wasm);
  const { default: createModule } = await import(module);
  if (typeof createModule !== 'function') {
    throw new Error('LayNii module did not load.');
  }
  return createLayniiRunner({ createModule, wasmBinary, onLog });
}
