// Runs one job in a fresh module worker, so that cancelling terminates the computation and
// frees its memory.

function runWorker(worker, message, transfer, { signal, onMessage = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.ok === undefined) return onMessage(data);
      finish();
      if (data.ok) resolve(data);
      else reject(new Error(data.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The worker failed."));
    };
    worker.postMessage(message, transfer);
  });
}

/** Runs shoreline on `files` ({ name: ArrayBuffer }, transferred) with `args`. */
export function correctSeries({ files, args, signal, onLog, onThreads }) {
  const worker = new Worker(new URL("./correct-worker.js", import.meta.url), { type: "module" });
  return runWorker(worker, { files, args }, Object.values(files), {
    signal,
    onMessage: (data) => {
      if (data.log !== undefined) onLog?.(data.log);
      if (data.threads !== undefined) onThreads?.(data.threads);
    },
  });
}

/** The susceptibility field (Hz, topup's sign) from two b = 0 means with opposite directions. */
export function estimateField({ image1, image2, dims, voxel, options, signal }) {
  const worker = new Worker(new URL("./field-worker.js", import.meta.url), { type: "module" });
  return runWorker(worker, { image1, image2, dims, voxel, options }, [], { signal });
}
