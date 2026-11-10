import { MAX_TILE_BYTES } from "./config.js";

/** Bound source allocations before reading; decoded sizes are checked separately by the worker. */
export async function readTileFiles(files, signal, maxBytes = MAX_TILE_BYTES) {
  signal?.throwIfAborted();
  if (files.reduce((total, file) => total + file.size, 0) > maxBytes) {
    throw new Error(`The source tiles exceed the ${(maxBytes / 1e9).toFixed(1)} GB input limit. Choose a smaller mosaic.`);
  }
  const buffers = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const buffer = await file.arrayBuffer();
    signal?.throwIfAborted();
    buffers.push({ name: file.name, buffer });
  }
  return buffers;
}
