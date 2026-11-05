// One stitching task per module worker: decode the tiles, register a share of the pairs, or
// fuse. The main thread terminates the worker to cancel.
import { inspectTiffStack, readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import { registerPairs } from "./core/pipeline.js";
import { fuseTiles, toSampleType } from "./core/fusion.js";
import { fusedTiff } from "./outputs.js";

function checkMetadata(name, info) {
  const { metadata } = info;
  if (metadata.images > 1) throw new Error(`${name} holds ${metadata.images} OME images; save each tile as its own file.`);
  if (metadata.sizeC > 1) throw new Error(`${name} has ${metadata.sizeC} channels; stitch one channel at a time.`);
  // A baseline TIFF records no axes; its pages are taken as the planes of a z stack.
  if (metadata.kind !== "baseline" && metadata.sizeT > 1) throw new Error(`${name} is a time series (${metadata.sizeT} time points); save one time point per tile.`);
}

function checkFinite(name, data) {
  if (!(data instanceof Float32Array || data instanceof Float64Array)) return;
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) throw new Error(`${name} contains NaN or infinite values; replace them (for example with 0) before stitching.`);
  }
}

async function decode({ files, maxBytes }) {
  const infos = [];
  let total = 0;
  for (const { name, buffer } of files) {
    const info = await inspectTiffStack(buffer).catch((error) => {
      throw new Error(`${name}: ${error.message}`);
    });
    checkMetadata(name, info);
    total += info.pages * info.width * info.height * info.bytesPerSample;
    infos.push(info);
  }
  if (total > maxBytes) throw new InputTooLargeError(total, maxBytes, { subject: "The decoded tiles" });
  const tiles = [];
  for (const [k, { name, buffer }] of files.entries()) {
    const stack = await readTiffStack(buffer, { maxBytes });
    checkFinite(name, stack.data);
    const shape = stack.pages > 1 ? [stack.width, stack.height, stack.pages] : [stack.width, stack.height];
    tiles.push({
      name,
      shape,
      dtype: stack.dtype,
      data: stack.data,
      pixelSize: stack.metadata.pixelSize,
      stagePosition: stack.metadata.stagePosition ?? null,
      kind: stack.metadata.kind,
    });
    self.postMessage({ progress: (k + 1) / files.length });
  }
  return tiles;
}

function register({ tiles, pairs, options }) {
  return registerPairs(tiles, pairs, options, { onProgress: (done) => self.postMessage({ progress: done }) });
}

function fuse({ tiles, positions, dtype, pixelSize, tiff }) {
  const fused = fuseTiles(tiles, positions, { onProgress: (done, total) => self.postMessage({ progress: done / total }) });
  const data = toSampleType(fused.data, dtype);
  const result = { data, shape: fused.shape, origin: fused.origin };
  if (tiff) result.tiff = fusedTiff({ data, shape: fused.shape, pixelSize });
  return result;
}

const TASKS = { decode, register, fuse };

self.onmessage = async ({ data: message }) => {
  try {
    const result = await TASKS[message.type](message);
    const transfer = [];
    if (message.type === "decode") for (const tile of result) transfer.push(tile.data.buffer);
    if (message.type === "fuse") {
      transfer.push(result.data.buffer);
      if (result.tiff) transfer.push(result.tiff.buffer);
    }
    self.postMessage({ result }, transfer.filter((buffer) => !(buffer instanceof SharedArrayBuffer)));
  } catch (error) {
    self.postMessage({ error: error?.message ?? String(error) });
  }
};
