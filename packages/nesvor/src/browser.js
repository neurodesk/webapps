import { browserConfig } from './config.js';
import { validateBrowserReference } from './reference-config.js';
export { REFERENCE_PRESET, validateBrowserReference } from './reference-config.js';

export function runBrowserReference(request, { signal, onProgress = () => {} } = {}) {
  validateBrowserReference(request);
  return runWorker(() => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), request, { signal, onProgress });
}

export function runBrowserReconstruction(request, options = {}) {
  browserConfig(request);
  return runWorker(() => new Worker(new URL('./gpu-worker.js', import.meta.url), { type: 'module' }), request, options);
}

function runWorker(createWorker, request, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const dispose = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      dispose();
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = (event) => {
      dispose();
      reject(new Error(event.message || 'Browser reconstruction worker failed.'));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.progress);
      else {
        dispose();
        if (data.type === 'complete') resolve(data.result);
        else reject(new Error(data.message));
      }
    };
    worker.postMessage(request);
  });
}
