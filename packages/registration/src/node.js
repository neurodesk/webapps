// Loads the ANTs WebAssembly kernel in Node after checking it is the pinned build.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRegistration } from './index.js';

export const REGISTRATION_WASM_SHA256 = '23cb91e0a9363cce16581d459ee52dabbf35538a2ad4ed565d2d83cd4a116348';

// Bundlers that copy the kernel elsewhere (SYNcro's dist/) pass their own locations.
export const KERNEL = Object.freeze({
  module: new URL('../wasm/syncro-registration.mjs', import.meta.url),
  wasm: new URL('../wasm/syncro-registration.wasm', import.meta.url),
});

export async function readRegistrationWasm(wasm = KERNEL.wasm) {
  const bytes = await readFile(wasm);
  if (createHash('sha256').update(bytes).digest('hex') !== REGISTRATION_WASM_SHA256) throw new Error('Registration WebAssembly checksum mismatch.');
  return bytes;
}

export async function loadRegistration({ module = KERNEL.module, wasm = KERNEL.wasm } = {}) {
  const wasmBinary = await readRegistrationWasm(wasm);
  const { default: createModule } = await import(module);
  if (typeof createModule !== 'function') throw new Error('Registration module did not load.');
  return createRegistration({ createModule, wasmBinary });
}
