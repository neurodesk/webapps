// The web app's fitting pool: @neurodesk/noddi's chunked fit on a few Web Workers.
import { fitVolume as fitChunks } from "@neurodesk/noddi/fit-pool";

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(4, hardware - 1));
}

const spawn = () => new Worker(new URL("./fit-worker.js", import.meta.url), { type: "module" });

/**
 * Fits the tensor (and NODDI when `noddi`) to every voxel in `indices`.
 * @returns {Promise<{ tensor: Record<string, Float32Array>, noddi: Record<string, Float32Array> | null }>}
 */
export function fitVolume(options) {
  return fitChunks({ ...options, spawn, workers: workerCount() });
}
