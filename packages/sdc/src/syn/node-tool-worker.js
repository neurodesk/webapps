// SPDX-License-Identifier: Apache-2.0
// One DenoiseImage or N4 run of the Node runtime in its own worker thread, so that an abort can
// terminate it (both kernels run synchronously) and its heap is freed when it ends.
//   workerData: { tool: 'denoise' | 'n4', image: Uint8Array }  ->  message: Uint8Array (NIfTI)
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

const { tool, image } = workerData;
let output;
if (tool === 'denoise') {
  const { loadDenoise } = await import('@neurodesk/ants-denoise/node');
  const denoiser = await loadDenoise();
  // DenoiseImage -n Gaussian -s 1 with its default patch (1) and search (2) radii.
  output = await denoiser.denoise({ image, noiseModel: 'Gaussian', shrinkFactor: 1, patchRadius: 1, searchRadius: 2 });
} else if (tool === 'n4') {
  const { createN4, epiReferenceArguments } = await import('@neurodesk/n4');
  const { default: createModule } = await import('@neurodesk/n4/module');
  const wasmBinary = await readFile(new URL(import.meta.resolve('@neurodesk/n4/wasm')));
  const n4 = await createN4({ createModule, wasmBinary, buildArguments: epiReferenceArguments });
  output = (await n4.correct({ image })).corrected;
} else {
  throw new Error(`Unknown tool ${tool}.`);
}
const bytes = output.byteOffset === 0 && output.byteLength === output.buffer.byteLength ? output : output.slice();
parentPort.postMessage(bytes, [bytes.buffer]);
