// Spreads the voxels of a series over a few workers in two passes: the Gram sums of each
// chunk, then, after one solve per group, the predictions of each chunk.
import { gatherChunk, scatterChunk, voxelRanges } from "./pipeline.js";

export const CHUNK_VOXELS = 16384;

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(4, hardware - 1));
}

/**
 * Denoises `data` (nvox voxels × frames volumes, volume-major) and returns a new array.
 * @param groups the fitted volume groups, from fittedGroups(bvals)
 * @param solve (gram, group) => coefficients, run once per group on the summed Gram matrix
 */
export async function denoiseSeries({ data, nvox, frames, groups, solve, signal, onProgress }) {
  const ranges = voxelRanges(nvox, CHUNK_VOXELS);
  const workers = Array.from({ length: Math.min(workerCount(), ranges.length) }, () =>
    new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
  );
  const total = 2 * ranges.length;
  let done = 0;
  const chunk = (first, count) => gatherChunk(data, nvox, frames, first, count);
  try {
    // Partial sums are kept per chunk and added in chunk order, so a run does not depend on
    // which worker answers first.
    const parts = [];
    const gramRequest = (first, count) => ({ type: "gram", data: chunk(first, count), count, groups });
    const keepGrams = (message) => {
      parts[message.id] = message.grams;
      onProgress?.(++done / total);
    };
    await runPass(workers, ranges, signal, gramRequest, keepGrams);
    const grams = groups.map((_group, g) => {
      const sum = parts[0][g].slice();
      for (const part of parts.slice(1)) {
        for (let i = 0; i < sum.length; i++) sum[i] += part[g][i];
      }
      return sum;
    });

    const coefficients = groups.map((group, g) => solve(grams[g], group));
    const out = new Float32Array(data.length);
    const applyRequest = (first, count) => ({ type: "apply", data: chunk(first, count), count, groups, coefficients });
    const storeChunk = (message, [first, count]) => {
      scatterChunk(out, message.data, nvox, frames, first, count);
      onProgress?.(++done / total);
    };
    await runPass(workers, ranges, signal, applyRequest, storeChunk);
    return out;
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

/** Sends one message per range, one range at a time per worker, until every range has a reply. */
function runPass(workers, ranges, signal, request, receive) {
  return new Promise((resolve, reject) => {
    let next = 0;
    let replies = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      for (const worker of workers) worker.onmessage = worker.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException("Denoising cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    const send = (worker) => {
      if (next >= ranges.length) return;
      const id = next++;
      const message = { id, ...request(...ranges[id]) };
      worker.postMessage(message, [message.data.buffer]);
    };
    for (const worker of workers) {
      worker.onerror = (event) => finish(new Error(event.message || "A denoising worker failed."));
      worker.onmessage = ({ data: message }) => {
        if (message.error) return finish(new Error(message.error));
        receive(message, ranges[message.id]);
        if (++replies === ranges.length) finish();
        else send(worker);
      };
      send(worker);
    }
  });
}
