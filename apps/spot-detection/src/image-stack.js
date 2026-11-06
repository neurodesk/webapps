// One-channel TIFF stack (one page per z plane) read through the shared TIFF module, plus the
// voxel size in nanometres when ImageJ or OME metadata records it.
import { inspectTiffStack, readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { checkSize } from "./config.js";

const DTYPES = new Set(["uint8", "uint16", "float32", "float64"]);

function nanometres(micrometres) {
  return micrometres === null ? null : micrometres * 1000;
}

export async function readImageStack(buffer, { signal } = {}) {
  const info = await inspectTiffStack(buffer);
  const { width, height, pages, dtype, metadata } = info;
  if (!DTYPES.has(dtype)) throw new Error(`TIFF sample type ${dtype} is not uint8, uint16, float32 or float64.`);
  if (metadata.kind !== "baseline" && (metadata.sizeC > 1 || metadata.sizeT > 1)) {
    const kind = metadata.kind === "ome" ? "OME-TIFF" : "TIFF";
    throw new Error(`This ${kind} holds several channels or time points; save one channel as its own stack.`);
  }
  const shape = pages > 1 ? [pages, height, width] : [height, width];
  checkSize(shape, dtype);
  // checkSize holds the run's whole working memory, far below the decoded stack's own limit.
  const { data } = await readTiffStack(buffer, { signal, maxBytes: Infinity });
  const { x, y, z } = metadata.pixelSize;
  const voxelSize = metadata.kind === "baseline" ? null : { z: nanometres(z), y: nanometres(y), x: nanometres(x) };
  return { data, shape, dtype, voxelSize };
}
