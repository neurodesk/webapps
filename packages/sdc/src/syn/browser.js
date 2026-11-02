// SPDX-License-Identifier: Apache-2.0
// The web app's runtimes for the SyN-SDC pipeline (pipeline.js): @neurodesk/hmc-registration's
// module worker for the ANTs programs, @neurodesk/ants-denoise's worker for DenoiseImage, this
// package's n4-worker.js for N4, the app's MindGrab, the field-fit module and CompressionStream.
// Every DenoiseImage and N4 run gets its own worker, terminated when it ends or the run is
// cancelled. The kernel is linked with -pthread, so the page must be cross-origin isolated.
import { loadFieldFit } from '../field-fit.js';

/** Posts one message to a new module worker and resolves with `pick(reply)`; an abort terminates it. */
function once(url, message, transfer, signal, pick) {
  signal?.throwIfAborted();
  const worker = new Worker(url, { type: 'module' });
  return new Promise((resolve, reject) => {
    const settle = (error, value) => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => settle(signal.reason ?? new DOMException('Cancelled.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => settle(new Error(event.message || 'A worker failed.'));
    worker.onmessage = ({ data }) => (data?.error !== undefined ? settle(new Error(data.error)) : settle(null, pick(data)));
    worker.postMessage(message, transfer);
  });
}

/** gzip through the browser's CompressionStream. */
export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The runtime correctSusceptibility takes, on Web Workers.
 * @param {object} options
 * @param {string | URL} options.registrationWorker the bundler's URL of @neurodesk/hmc-registration/worker
 * @param {string | URL} options.denoiseWorker the bundler's URL of @neurodesk/ants-denoise/worker
 * @param {string | URL} options.n4Worker the bundler's URL of this package's src/syn/n4-worker.js
 * @param {{ module: string, wasm?: string }} options.n4Kernel the URLs of @neurodesk/n4/module and /wasm;
 *   without `wasm` the module loads n4-bias.wasm from beside itself
 * @param {string | URL | Response | ArrayBuffer} options.fieldFit the field-fit module (@neurodesk/sdc/field-fit.wasm)
 * @param {(bytes: Uint8Array, options: { signal?: AbortSignal }) => Promise<Uint8Array>} [options.mindgrab]
 *   the app's MindGrab ('mindgrab' model) brain mask; not needed when the user gives both masks
 * @param {number} [options.workers] kernel workers at once (default 2)
 * @param {{ module: string, wasm: string }} [options.kernel] kernel URLs when a bundler moved them
 */
export async function browserRuntime({ registrationWorker, denoiseWorker, n4Worker, n4Kernel, fieldFit, mindgrab, workers = 2, kernel } = {}) {
  if (!registrationWorker || !denoiseWorker || !n4Worker || !n4Kernel) throw new Error('browserRuntime needs the registration, DenoiseImage and N4 worker URLs and the N4 kernel URLs.');
  return {
    spawn: () => new Worker(registrationWorker, { type: 'module' }),
    workers,
    kernel,
    fieldFit: await loadFieldFit(fieldFit),
    gzip,
    denoise: (image, { signal } = {}) =>
      once(denoiseWorker, { id: 1, image, noiseModel: 'Gaussian', shrinkFactor: 1, patchRadius: 1, searchRadius: 2 }, [], signal, (data) => data.output),
    n4: (image, { signal } = {}) => once(n4Worker, { image, kernel: n4Kernel }, [], signal, (data) => data.output),
    mindgrab: mindgrab ?? (() => Promise.reject(new Error('Give both brain masks, or a MindGrab runtime.'))),
  };
}
