// Spreads the masked voxels over fitting workers, chunk by chunk, and collects the maps. The web
// app's Web Workers and the command line's worker threads run the same chunks through the same
// handler (fit-worker.js), so both fit every voxel with the same inputs.
import { CHUNK_VOXELS, chunks, emptyMaps, gatherChunk, isEveryVolume, maskIndices, scatterChunk } from "./pipeline.js";

/**
 * Fits the selected tensor backend and optional NODDI on the same input and mask in both hosts.
 * `dtifit(input, signal)` runs the shared dtifit preparation on the host's niimath runtime;
 * `spawn` and `workers` select the host's chunk workers. `onStage` reports dtifit or chunk fitting.
 */
export async function fitVolume({ input, mask, tensorFit = "wls", noddi, method = "amico", dtifit, signal, onStage, onProgress, spawn, workers }) {
  if (!["amico", "dmipy"].includes(method)) throw new Error("NODDI method is amico or dmipy.");
  signal?.throwIfAborted();
  const indices = maskIndices(mask);
  const niimath = tensorFit === "niimath-dtifit";
  let tensor = null;
  if (niimath) {
    onStage?.("dtifit");
    const volumes = input.table.dtiVolumes;
    tensor = await dtifit({
      buffer: input.buffer,
      data: isEveryVolume(volumes, input.bvals.length) ? null : input.data,
      dims: input.dims,
      bvals: input.bvals,
      bvecs: input.bvecs,
      volumes,
      mask,
    }, signal);
    signal?.throwIfAborted();
  }
  if (niimath && !noddi) return { tensor, noddi: null };
  onStage?.("chunks");
  const maps = await fitChunks({
    data: input.data,
    voxels: input.voxels,
    volumes: input.bvals.length,
    indices,
    bvals: input.bvals,
    bvecs: input.bvecs,
    weighted: tensorFit === "wls",
    tensor: !niimath,
    noddi,
    method,
    signal,
    onProgress,
    spawn,
    workers,
  });
  return { tensor: tensor ?? maps.tensor, noddi: maps.noddi, ...(maps.noddiDiagnostics ? { noddiDiagnostics: maps.noddiDiagnostics } : {}) };
}

/**
 * Fits the tensor (unless `tensor` is false) and optional NODDI to every voxel in `indices`.
 * @param spawn returns a new worker running fit-worker.js's handler: an object with
 *   `postMessage(message, transfer)`, `terminate()` and assignable `onmessage({ data })` and
 *   `onerror({ message })`, as a Web Worker has
 * @param workers how many workers to start at most
 * @returns {Promise<{ tensor: Record<string, Float32Array> | null, noddi: Record<string, Float32Array> | null }>}
 */
function fitChunks({ data, voxels, volumes, indices, bvals, bvecs, weighted, tensor = true, noddi, method, signal, onProgress, spawn, workers: count }) {
  const work = chunks(indices, CHUNK_VOXELS);
  const tensorMaps = tensor ? emptyMaps("tensor", voxels) : null;
  const noddiMaps = noddi ? emptyMaps("noddi", voxels) : null;
  const workers = [];
  const diagnostics = method === "dmipy" && noddi ? { fitted: 0, skipped: 0, nonconverged: 0, failed: 0 } : null;
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
      else resolve({ tensor: tensorMaps, noddi: noddiMaps, ...(diagnostics ? { noddiDiagnostics: diagnostics } : {}) });
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
        if (settled) return;
        if (message.type === "error") return finish(new Error(message.message));
        if (message.type === "ready") return send(worker);
        if (message.type !== "done") return;
        if (tensorMaps && message.tensor) scatterChunk(tensorMaps, message.tensor, work[message.id]);
        if (noddiMaps && message.noddi) scatterChunk(noddiMaps, message.noddi, work[message.id]);
        if (diagnostics && message.noddiDiagnostics) for (const key of Object.keys(diagnostics)) diagnostics[key] += message.noddiDiagnostics[key];
        done++;
        onProgress?.(done / work.length);
        if (done === work.length) finish();
        else send(worker);
      };
      worker.postMessage({ type: "init", bvals, bvecs, weighted, tensor, noddi, method });
    }
  });
}
