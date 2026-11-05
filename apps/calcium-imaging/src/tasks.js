// DOM-free helpers for running worker tasks together, unit-tested under Node.

/**
 * Starts every task with one shared signal and resolves with all their results. When one task
 * fails, or `signal` aborts, the shared signal aborts so the other tasks stop too (callWorker
 * terminates its worker on abort), and the first failure is thrown.
 * @template T
 * @param {AbortSignal | undefined} signal
 * @param {Array<(signal: AbortSignal) => Promise<T>>} tasks
 * @returns {Promise<T[]>}
 */
export async function allOrAbort(signal, tasks) {
  signal?.throwIfAborted();
  const group = new AbortController();
  const forward = () => group.abort(signal.reason);
  signal?.addEventListener("abort", forward, { once: true });
  try {
    return await Promise.all(tasks.map((task) => task(group.signal).catch((error) => {
      group.abort(error);
      throw error;
    })));
  } finally {
    signal?.removeEventListener("abort", forward);
  }
}
