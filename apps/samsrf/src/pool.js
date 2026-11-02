// Runs one SamSrf analysis on a pool of module workers, one engine instance each.
// The first worker builds the job; every worker then fits shards of units taken
// from a shared queue; the first worker merges them. Cancelling terminates every
// worker, which is the only way to stop WebAssembly mid-fit.

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(8, hardware - 1));
}

/** Split [0, units) into contiguous shards, several per worker so fast workers take more. */
export function shardRanges(units, workers, perWorker = 4) {
  const count = Math.max(1, Math.min(units, workers * perWorker));
  const ranges = [];
  for (let index = 0; index < count; index++) {
    const start = Math.floor((index * units) / count);
    const end = Math.floor(((index + 1) * units) / count);
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
}

// Shares of the progress bar: reading the inputs, fitting, merging.
const PREPARE = 0.05;
const MERGE = 0.05;

/**
 * @param {import('./engine.js').JobInputs} inputs
 * @param {{ signal?: AbortSignal, onProgress?: (fraction: number, message: string) => void, onLog?: (line: string) => void,
 *   workers?: number, createWorker?: () => Worker }} [options]
 * @returns {Promise<import('./engine.js').Result>}
 */
export function runAnalysis(inputs, { signal, onProgress, onLog, workers = workerCount(), createWorker = defaultWorker } = {}) {
  const pool = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      for (const worker of pool) worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Analysis cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });

    const request = (worker, message) => new Promise((done, fail) => {
      worker.onmessage = ({ data }) => {
        if (data.type === "progress") return message.onProgress?.(data.done);
        if (data.type === "error") return fail(new Error(data.message));
        done(data.value);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(new Error(event.message || "A SamSrf worker failed."));
      };
      worker.postMessage(message.body);
    });

    const run = async () => {
      const first = createWorker();
      pool.push(first);
      onProgress?.(0, "Reading inputs…");
      const job = await request(first, { body: { type: "prepare", inputs } });
      for (const line of job.summary) onLog?.(line);
      const ranges = shardRanges(job.units, workers);
      while (pool.length < Math.min(workers, ranges.length)) pool.push(createWorker());
      const shards = new Array(ranges.length);
      const done = new Array(ranges.length).fill(0);
      const report = () => {
        const units = done.reduce((sum, value) => sum + value, 0);
        onProgress?.(PREPARE + (1 - PREPARE - MERGE) * (units / Math.max(1, job.units)), `Fitting ${units} of ${job.units} vertices…`);
      };
      let next = 0;
      const drain = async (worker) => {
        if (worker !== first) await request(worker, { body: { type: "job", job } });
        while (next < ranges.length) {
          const index = next++;
          const [start, end] = ranges[index];
          shards[index] = await request(worker, {
            body: { type: "run", start, end },
            onProgress: (units) => {
              done[index] = units;
              report();
            },
          });
          done[index] = end - start;
          report();
        }
      };
      await Promise.all(pool.map(drain));
      onProgress?.(1 - MERGE, "Writing maps…");
      const result = await request(first, { body: { type: "merge", shards } });
      onProgress?.(1, "Maps ready");
      return result;
    };
    run().then((result) => finish(null, result), (error) => finish(error));
  });
}

function defaultWorker() {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "samsrf" });
}
