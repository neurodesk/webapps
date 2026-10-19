// MindGrab for web apps, with the published wrapper's `segment` and `segmentTissues`. Each call
// runs in its own module worker (worker.js), which resolves `auto` to a hardware GPU or the
// threaded CPU module (backend.js), so cancelling terminates it and frees its memory.
// Pass `assetPath` pointing at the app's staged copies of the package's dist files.
import { version } from '@brainchop/mindgrab/package.json';

const abortError = (signal) => signal.reason ?? new DOMException('Cancelled', 'AbortError');

function runInWorker(input, tissues, { signal, onLog, ...options }) {
  return new Promise((resolve, reject) => {
    const active = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      active.terminate();
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => finish(abortError(signal));
    signal?.addEventListener('abort', cancel, { once: true });
    active.onmessage = ({ data }) => {
      if (data.log !== undefined) onLog?.(data.log);
      else if (data.error) finish(new Error(data.error));
      else finish(null, data.result);
    };
    active.onerror = (event) => finish(new Error(event.message || 'Segmentation worker failed'));
    active.onmessageerror = () => finish(new Error('Segmentation worker returned an unreadable result'));
    if (signal?.aborted) cancel();
    else active.postMessage({ input, tissues, options });
  });
}

/** MindGrab through the published wrapper; `options.signal` cancels a call. */
export const mindgrab = Object.freeze({
  version,
  segment: (input, options) => runInWorker(input, false, options),
  segmentTissues: (input, options) => runInWorker(input, true, options),
});

/**
 * A brain mask of one 3D NIfTI image (e.g. a mean b0) on the image's own grid, from MindGrab's
 * `mindgrab` model. Returns `{ mask, backend }` with `mask` as uncompressed NIfTI bytes.
 * `options` takes `assetPath` (required), `backend` (default `auto`) and `signal`.
 */
export async function brainMask(input, { assetPath, backend = 'auto', signal } = {}) {
  if (!assetPath) throw new Error('brainMask needs the assetPath of the staged MindGrab modules.');
  const result = await mindgrab.segment(input, { model: 'mindgrab', mask: true, gzipOutput: false, backend, assetPath, signal });
  if (!result?.mask) throw new Error('MindGrab did not return a brain mask.');
  return { mask: new Uint8Array(result.mask), backend: result.backend };
}
