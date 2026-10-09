// One registration worker at a time. A cancelled job closes itself and can
// never post into, terminate or hide the cancel control of the job after it.
export function createRegistrationRunner({ createWorker, onLog = () => {}, onActiveChange = () => {} }) {
  let activeWorker = null;
  let cancelActive = null;

  function run(fixed, moving, onProgress, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const worker = createWorker();
      activeWorker = worker;
      let closed = false;
      const close = () => {
        closed = true;
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        if (activeWorker === worker) {
          activeWorker = null;
          cancelActive = null;
          onActiveChange(false);
        }
      };
      worker.onmessage = ({ data }) => {
        if (closed) return;
        if (data.log) {
          onLog(data.log);
          return;
        }
        if (data.phase) {
          onProgress(data.phase);
          return;
        }
        close();
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      worker.onerror = (event) => {
        if (closed) return;
        close();
        reject(new Error(event.error instanceof Error ? event.error.message : event.message || "ANTs worker failed to start."));
      };
      worker.onmessageerror = () => {
        if (closed) return;
        close();
        reject(new Error("ANTs worker could not exchange registration data."));
      };
      const abort = () => {
        if (closed) return;
        close();
        reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      cancelActive = abort;
      signal?.addEventListener("abort", abort, { once: true });
      onActiveChange(true);
      Promise.all([fixed.arrayBuffer(), moving.arrayBuffer()]).then(([fixedBytes, movingBytes]) => {
        if (closed) return;
        worker.postMessage({ fixed: fixedBytes, moving: movingBytes }, [fixedBytes, movingBytes]);
      }).catch((error) => {
        if (closed) return;
        close();
        reject(error);
      });
    });
  }

  return {
    run,
    cancel: () => cancelActive?.(),
    terminate: () => activeWorker?.terminate(),
  };
}
