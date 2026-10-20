/** Each export has its own worker; settlement and cancellation release its heap. */
export function exportBids(series, options, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('BIDS export timed out. Try a smaller examination.')), 10 * 60 * 1000);
    worker.onmessage = ({ data }) => {
      if (data.error) finish(new Error(data.error));
      else if (data.bytes) finish(null, data);
      else if (data.progress !== undefined) onProgress(data.progress);
    };
    worker.onerror = () => finish(new Error('BIDS export worker failed. Retry or use a smaller examination.'));
    worker.onmessageerror = () => finish(new Error('BIDS export worker could not read the examination.'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker.postMessage({ series, options });
    } catch (error) {
      finish(error);
    }
  });
}
