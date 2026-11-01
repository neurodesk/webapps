// SPDX-License-Identifier: Apache-2.0
// Module worker for one N4 run with the EPI-reference settings (browser runtime of the SyN-SDC
// pipeline). N4 is synchronous, so it runs here; the page terminates the worker to cancel.
//   in:  { image: Uint8Array, kernel: { module, wasm } }   the @neurodesk/n4 module and wasm URLs
//   out: { output: Uint8Array } or { error }
import { createN4, epiReferenceArguments } from '@neurodesk/n4';

self.onmessage = async ({ data }) => {
  try {
    const { default: createModule } = await import(/* @vite-ignore */ data.kernel.module);
    const response = await fetch(data.kernel.wasm);
    if (!response.ok) throw new Error(`The N4 WebAssembly did not load (HTTP ${response.status}).`);
    const n4 = await createN4({ createModule, wasmBinary: new Uint8Array(await response.arrayBuffer()), buildArguments: epiReferenceArguments });
    const { corrected } = await n4.correct({ image: data.image });
    const output = corrected.slice();
    self.postMessage({ output }, [output.buffer]);
  } catch (error) {
    self.postMessage({ error: error?.message ?? String(error) });
  }
};
