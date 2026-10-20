// Spreads the masked voxels over fitting workers, chunk by chunk, and collects the maps. The web
// app's Web Workers and the command line's worker threads run the same chunks through the same
// handler (fit-worker.js), so both fit every voxel with the same inputs.
import { CHUNK_VOXELS, chunks, emptyMaps, gatherChunk, scatterChunk } from "./pipeline.js";

/**
 * Fits the tensor (and NODDI when `noddi`) to every voxel in `indices`.
 * @param spawn returns a new worker running fit-worker.js's handler: an object with
 *   `postMessage(message, transfer)`, `terminate()` and assignable `onmessage({ data })` and
 *   `onerror({ message })`, as a Web Worker has
 * @param workers how many workers to start at most
 * @returns {Promise<{ tensor: Record<string, Float32Array>, noddi: Record<string, Float32Array> | null }>}
 */
export function fitVolume({ data, voxels, volumes, indices, bvals, bvecs, weighted, noddi, signal, onProgress, spawn, workers: count }) {
  const work = chunks(indices, CHUNK_VOXELS);
  const tensorMaps = emptyMaps("tensor", voxels);
  const noddiMaps = noddi ? emptyMaps("noddi", voxels) : null;
  const workers = [];
  return new Promise((resolve, reject) => {
    let next = 0;
    let done = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      for (const worker of workers) worker.terminate();
      if (error) reject(error);
      else resolve({ tensor: tensorMaps, noddi: noddiMaps });
    };
    const abort = () => finish(signal.reason ?? new DOMException("Fitting cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (!work.length) return finish();
    const send = (worker) => {
      if (next >= work.length) return;
      const id = next++;
      const chunk = gatherChunk(data, voxels, volumes, work[id]);
      worker.postMessage({ type: "fit", id, data: chunk, voxels: work[id].length }, [chunk.buffer]);
    };
    for (let w = 0; w < Math.max(1, Math.min(count, work.length)); w++) {
      const worker = spawn();
      workers.push(worker);
      worker.onerror = (event) => finish(new Error(event.message || "A fitting worker failed."));
      worker.onmessage = ({ data: message }) => {
        if (message.type === "error") return finish(new Error(message.message));
        if (message.type === "ready") return send(worker);
        if (message.type !== "done") return;
        scatterChunk(tensorMaps, message.tensor, work[message.id]);
        if (noddiMaps && message.noddi) scatterChunk(noddiMaps, message.noddi, work[message.id]);
        done++;
        onProgress?.(done / work.length);
        if (done === work.length) finish();
        else send(worker);
      };
      worker.postMessage({ type: "init", bvals, bvecs, weighted, noddi });
    }
  });
}
