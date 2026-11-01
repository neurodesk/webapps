// BrainQCNet (Garcia, Dosenbach & Kelly, Imaging Neuroscience 2024) on one
// T1-weighted volume: every slice along x, y and z is classified as clean (0)
// or showing artifacts (1), then summarized as transform_log_to_csv.py does.
// The classifier is injected so the same code drives ONNX Runtime Web in the
// browser and any other runtime.
import manifest from '../model.manifest.json' with { type: 'json' };
import { IMG_SIZE, cropToForeground, modelSlice, readVolume, slicePlan, volumeFromNifti, writeInputTensor } from './slices.js';
import { summarize } from './summary.js';

export { manifest };
export const MODEL = Object.freeze({ ...manifest.assets[0], url: manifest.base_url + manifest.assets[0].filename });
export const INPUT_NAME = 'input';
export const OUTPUT_NAME = 'logits';
export const SLICE_FLOATS = 3 * IMG_SIZE * IMG_SIZE;

export { readVolume, volumeFromNifti };
export * from './summary.js';

/**
 * @typedef {(input: Float32Array, count: number) => Promise<Float32Array>} Classify
 * Runs `count` slices (count x 3 x 224 x 224) and returns count x 2 logits.
 *
 * @param {import('./slices.js').Volume} volume
 * @param {{ classify: Classify, batchSize?: number, method?: string, areas?: number,
 *   signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} options
 */
export async function runBrainQCNet(volume, { classify, batchSize = 4, method, areas, signal, onProgress }) {
  const cropped = cropToForeground(volume);
  const plan = [...slicePlan(cropped)];
  const predictions = [];
  const input = new Float32Array(batchSize * SLICE_FLOATS);
  for (let start = 0; start < plan.length; start += batchSize) {
    signal?.throwIfAborted();
    const batch = plan.slice(start, start + batchSize);
    batch.forEach(({ axis, slice }, b) => writeInputTensor(modelSlice(cropped, axis, slice), input, b * SLICE_FLOATS));
    const logits = await classify(input.subarray(0, batch.length * SLICE_FLOATS), batch.length);
    batch.forEach(({ axis, slice }, b) => {
      const clean = logits[b * 2];
      const artifact = logits[b * 2 + 1];
      // torch.argmax keeps the first index on a tie.
      predictions.push({ axis, slice, pred: artifact > clean ? 1 : 0, logits: [clean, artifact] });
    });
    onProgress?.(predictions.length, plan.length);
  }
  return { crop: { offset: cropped.offset, dims: cropped.dims }, predictions, summary: summarize(predictions, { method, areas }) };
}

/**
 * A voxel map on the input grid: how many of the three slices through each
 * voxel (x, y, z) were classified as showing artifacts, 0 to 3.
 */
export function flaggedSliceMap(dims, crop, predictions) {
  const [nx, ny, nz] = dims;
  const flagged = { x: new Uint8Array(crop.dims[0]), y: new Uint8Array(crop.dims[1]), z: new Uint8Array(crop.dims[2]) };
  for (const p of predictions) if (p.pred === 1) flagged[p.axis][p.slice] = 1;
  const map = new Uint8Array(nx * ny * nz);
  const [ox, oy, oz] = crop.offset;
  for (let k = 0; k < crop.dims[2]; k++) {
    for (let j = 0; j < crop.dims[1]; j++) {
      const base = ox + nx * (oy + j + ny * (oz + k));
      const yz = flagged.y[j] + flagged.z[k];
      for (let i = 0; i < crop.dims[0]; i++) map[base + i] = flagged.x[i] + yz;
    }
  }
  return map;
}
