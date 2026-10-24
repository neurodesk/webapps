// A pool of @neurodesk/hmc-registration kernels, each in its own worker. The workers speak the
// kernel worker's protocol (@neurodesk/hmc-registration/worker):
//
//   in:  { id, argv, inputs, kernel? }        inputs: { "name.nii": Uint8Array, ... }
//   out: { id, outputs, log } or { id, error, log }
//
// The web app spawns that module worker; the command line spawns a worker thread
// (node-worker.js) that answers in the same way. Each kernel holds one registration at a time
// and starts at the INITIAL_MEMORY of its build (256 MiB), so `workers` sets the memory too.
//
// Cancellation: the pool checks the AbortSignal before it sends each task, and an abort
// terminates every worker at once, the running tasks included, which frees their memory.

/** The error a cancelled run rejects with when the signal gives no reason. */
export function cancelled() {
  return new DOMException("Head-motion correction cancelled.", "AbortError");
}

/**
 * @param {object} options
 * @param {() => object} options.spawn returns a new worker: `postMessage(message, transfer)`,
 *   `terminate()` (a Promise or nothing) and assignable `onmessage({ data })` and
 *   `onerror({ message })`, as a Web Worker has
 * @param {number} options.workers how many workers to start at most
 * @param {AbortSignal} [options.signal] cancels every task and terminates the workers
 * @param {{ module: string, wasm: string }} [options.kernel] kernel file URLs for the browser worker
 */
export function createRegistrationPool({ spawn, workers, signal, kernel }) {
  if (!Number.isInteger(workers) || workers < 1) throw new Error("workers must be a positive whole number.");
  const live = [];
  const idle = [];
  const waiting = [];
  const busy = new Map();
  const exits = [];
  let stopped = null;
  let ids = 0;

  function stop(reason) {
    if (stopped) return;
    stopped = reason;
    signal?.removeEventListener("abort", onAbort);
    for (const worker of live) exits.push(Promise.resolve(worker.terminate()).catch(() => {}));
    for (const job of busy.values()) job.reject(reason);
    for (const job of waiting) job.reject(reason);
    busy.clear();
    waiting.length = 0;
    idle.length = 0;
  }

  function onAbort() {
    stop(signal.reason ?? cancelled());
  }

  function start() {
    const worker = spawn();
    live.push(worker);
    worker.onmessage = ({ data }) => {
      const job = busy.get(worker);
      if (!job || data?.id !== job.id) return;
      busy.delete(worker);
      if (data.error !== undefined) {
        const error = new Error(data.error);
        error.log = data.log ?? [];
        job.reject(error);
      } else {
        job.resolve({ outputs: data.outputs, log: data.log ?? [] });
      }
      idle.push(worker);
      pump();
    };
    worker.onerror = (event) => stop(new Error(event?.message || "A registration worker failed."));
    return worker;
  }

  function pump() {
    while (!stopped && waiting.length) {
      if (signal?.aborted) return onAbort();
      const worker = idle.pop() ?? (live.length < workers ? start() : null);
      if (!worker) return;
      const job = waiting.shift();
      let inputs;
      try {
        inputs = typeof job.task.inputs === "function" ? job.task.inputs() : job.task.inputs;
      } catch (error) {
        if (!stopped) idle.push(worker);
        job.reject(stopped ?? error);
        continue;
      }
      // Input factories may cancel through an observer such as onPrediction.
      // This job is between queues, so stop() could not reject it itself.
      if (signal?.aborted && !stopped) onAbort();
      if (stopped) {
        job.reject(stopped);
        return;
      }
      job.id = ++ids;
      busy.set(worker, job);
      const transfer = job.task.transfer ? [...new Set(Object.values(inputs).map((bytes) => bytes.buffer))] : [];
      const message = { id: job.id, argv: job.task.argv, inputs };
      if (kernel) message.kernel = kernel;
      worker.postMessage(message, transfer);
    }
  }

  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return {
    /**
     * Queues one kernel run. `task.inputs` may be a function, called when a worker is free, so
     * that a long series does not hold every volume's NIfTI at once; `task.transfer` moves the
     * input buffers to the worker instead of copying them.
     * @param {{ argv: string[], inputs: Record<string, Uint8Array> | (() => Record<string, Uint8Array>), transfer?: boolean }} task
     * @returns {Promise<{ outputs: Record<string, Uint8Array>, log: string[] }>}
     */
    run(task) {
      if (stopped) return Promise.reject(stopped);
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        pump();
      });
    },
    /** Terminates every worker. Resolves when they have all ended. */
    close() {
      stop(new Error("The registration pool is closed."));
      return Promise.all(exits).then(() => undefined);
    },
    /** How many workers were started. */
    get started() {
      return live.length;
    },
  };
}
