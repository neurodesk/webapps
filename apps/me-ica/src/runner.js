// One worker job at a time. Cancelling terminates that job's worker, so a cancelled run can
// never post into the next one. (Greedy's registration runner, for a generic payload.)
export function createRunner({ createWorker, onActiveChange = () => {} }) {
  let cancelActive = null;

  function run(payload, transfer, onProgress, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const worker = createWorker();
      let closed = false;
      const close = () => {
        closed = true;
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        cancelActive = null;
        onActiveChange(false);
      };
      const fail = (error) => {
        if (closed) return;
        close();
        reject(error);
      };
      worker.onmessage = ({ data }) => {
        if (closed) return;
        if (data.phase) return onProgress(data.phase);
        close();
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = (event) => fail(new Error(event.message || "The me-ica worker failed to start."));
      worker.onmessageerror = () => fail(new Error("The me-ica worker could not exchange data."));
      const abort = () => fail(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      cancelActive = abort;
      signal?.addEventListener("abort", abort, { once: true });
      onActiveChange(true);
      worker.postMessage(payload, transfer);
    });
  }

  return { run, cancel: () => cancelActive?.() };
}
