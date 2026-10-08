// The web app's MindGrab and niimath runtimes, shaped for pipeline.js. Each segmentation runs in
// its own module worker so cancelling terminates it and frees its memory.
import { version } from '@brainchop/mindgrab/package.json';
import { Niimath } from '@niivue/niimath';

const abortError = (signal) => signal.reason ?? new DOMException('Cancelled', 'AbortError');

function runInWorker(input, tissues, { signal, ...options }) {
  return new Promise((resolve, reject) => {
    const active = new Worker(new URL('./segmentation-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      active.terminate();
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => finish(abortError(signal));
    signal?.addEventListener('abort', cancel, { once: true });
    active.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, data.result);
    active.onerror = (event) => finish(new Error(event.message || 'Segmentation worker failed'));
    active.onmessageerror = () => finish(new Error('Segmentation worker returned an unreadable result'));
    if (signal?.aborted) cancel();
    else active.postMessage({ input, tissues, options });
  });
}

/** MindGrab through the published wrapper, with `assetPath` pointing at its staged dist files. */
export const mindgrab = Object.freeze({
  version,
  segment: (input, options) => runInWorker(input, false, options),
  segmentTissues: (input, options) => runInWorker(input, true, options),
});

/** niimath's mesh in its WebAssembly worker. `mesh(bytes, options, signal)` resolves to the mz3. */
export function createNiimathMesher() {
  const niimath = new Niimath();
  let ready = null;
  async function mesh(segmentation, options, signal) {
    const cancel = () => niimath.dispose('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      ready ??= niimath.init();
      await ready;
      signal?.throwIfAborted();
      const output = await niimath
        .image(new File([segmentation], 'segmentation.nii'))
        .mesh(options)
        .run('brain.mz3');
      signal?.throwIfAborted();
      return new Uint8Array(await output.arrayBuffer());
    } catch (error) {
      dispose('mesh failed');
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  // A disposed worker is started afresh by the next mesh.
  function dispose(reason) {
    niimath.dispose(reason);
    ready = null;
  }
  return { mesh, dispose };
}
