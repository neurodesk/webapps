export function createIoWorkerQueue(createWebWorker) {
  let worker = null;
  let queue = Promise.resolve();
  let generation = 0;

  function run(task, { signal } = {}) {
    signal?.throwIfAborted();
    const scheduled = generation;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (scheduled !== generation) throw new DOMException("Image IO cancelled", "AbortError");
    };
    const result = queue.then(async () => {
      assertCurrent();
      let active = worker;
      if (!active) {
        active = await createWebWorker();
        if (scheduled !== generation || signal?.aborted) active.terminate();
        assertCurrent();
        worker = active;
      }
      const output = await task(active);
      assertCurrent();
      if (output?.webWorker) worker = output.webWorker;
      return output;
    });
    queue = result.catch(() => {});
    return result;
  }

  function reset() {
    generation++;
    worker?.terminate();
    worker = null;
    queue = Promise.resolve();
  }

  return { run, reset };
}
