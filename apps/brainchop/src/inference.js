import { brainChopOpts } from '../vendor/brainchop/brainchop-parameters.js';
import { MODEL_ROOT } from './models.js';

export function infer(volume, model, { signal, onProgress }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../vendor/brainchop/brainchop-webworker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      worker.terminate();
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => finish(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onerror = event => finish(new Error(event.message || 'Segmentation worker failed.'));
    worker.onmessageerror = () => finish(new Error('Unreadable segmentation result.'));
    worker.onmessage = ({ data }) => {
      if (data.cmd === 'img') finish(null, new Uint8Array(data.img));
      else if (data.modalMessage) finish(new Error(data.modalMessage));
      else onProgress(data.message, data.progressFrac);
    };
    worker.postMessage({
      opts: { ...brainChopOpts, rootURL: MODEL_ROOT, telemetryFlag: false },
      modelEntry: model.entry,
      niftiHeader: { datatypeCode: volume.hdr.datatypeCode, dims: volume.hdr.dims },
      niftiImage: volume.img,
    });
  });
}
