// NiFreeze 3bcfb00's estimator: a model target per DWI volume, intensity clipping with its
// in-place semantics, and the shared registration/resampling/output path. The model split,
// median, GP and registration argv are the existing Rust ports, exposed by hmc.wasm.
import { correctHeadMotion } from "./pipeline.js";
import { sidecarText } from "./outputs.js";
import { nifreezeInputProblem } from "./limits.js";
import { sha256 } from "@neurodesk/webapp-components/file-io/hash";

/** A reproducible visit order. The sidecar records it; it is not NumPy's permutation. */
export function nifreezeOrder(length, seed) {
  const order = Array.from({ length }, (_, i) => i);
  let state = seed >>> 0;
  for (let i = length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Throws the message of `nifreezeInputProblem` when the estimator cannot hold this input.
 * Without `maskVoxels` only the series is checked, so a caller can refuse it before masking.
 */
export function assertNifreezeInput({ series, bvals, bvecs, hmc, model = "gp", maskVoxels = null }) {
  const problem = nifreezeInputProblem({
    voxels: series.dims.reduce((a, b) => a * b, 1), frames: series.frames, model, maskVoxels,
    dwiVolumes: hmc.b0Flags("nifreeze", bvals, bvecs).filter(b0 => !b0).length,
  });
  if (problem) throw new Error(problem);
}

/**
 * Runs NiFreeze's gp (default) or trivial estimator on an already-read series and mask.
 * `visitOrder`, when supplied, is a permutation of the DWI-only indices, as NiFreeze records.
 * `onPrediction` observes the prepared target synchronously before transfer to the kernel.
 * The registration pool limits live targets; none of the 90 GP targets is kept after use.
 */
export async function correctNiFreeze({ model = "gp", seed = 1234, visitOrder, onPrediction, maskProvenance = { Source: "unspecified" }, ...options }) {
  const { series, bvals, bvecs, mask, hmc, signal } = options;
  signal?.throwIfAborted();
  const maskVoxels = mask ? mask.reduce((sum, value) => sum + (value ? 1 : 0), 0) : series.dims.reduce((a, b) => a * b, 1);
  assertNifreezeInput({ series, bvals, bvecs, hmc, model, maskVoxels });
  const argv = hmc.nifreezeArguments(seed);
  const estimator = hmc.createNifreezeModel({ data: series.data, dims: series.dims, frames: series.frames, bvals, bvecs, mask, model });
  try {
    const effectiveMask = {
      ...maskProvenance,
      Bytes: estimator.mask.byteLength,
      Voxels: estimator.mask.reduce((sum, value) => sum + (value ? 1 : 0), 0),
      SHA256: await sha256(estimator.mask, signal),
    };
    const order = visitOrder ?? nifreezeOrder(estimator.dwiVolumes.length, seed);
    if (order.length !== estimator.dwiVolumes.length || new Set(order).size !== order.length
      || order.some(i => !Number.isInteger(i) || i < 0 || i >= order.length)) {
      throw new Error("The NiFreeze visit order must contain each DWI-only index once.");
    }
    const byFrame = new Map(estimator.dwiVolumes.map((frame, i) => [frame, i]));
    // Once a clip leaves the shared bzero unchanged it is an exact fixed point. Later
    // visits can reuse it, while other float inputs keep changing until they stabilize.
    let stableBzero = false;
    if (model === "trivial") estimator.release();
    const target = (frame, b0) => b0 ? null : () => {
      signal?.throwIfAborted();
      const index = byFrame.get(frame);
      let volume;
      let fit;
      if (model === "gp") ({ volume, fit } = estimator.predict(index));
      else {
        volume = estimator.bzero;
        if (!stableBzero) {
          const before = volume.slice();
          hmc.advancedClipInPlace(volume, series.dims);
          stableBzero = volume.every((value, i) => value === before[i]);
        }
      }
      onPrediction?.({ frame, index, volume, fit });
      return volume;
    };
    const result = await correctHeadMotion({
      ...options, method: "nifreeze", mask: estimator.mask,
      order: [...order.map(i => estimator.dwiVolumes[i]), ...estimator.b0Volumes],
      target, argv: () => [...argv],
      moving: (_frame, volume) => {
        if (series.floating !== false) hmc.advancedClipInPlace(volume, series.dims);
        return volume;
      },
    });
    const provenance = JSON.parse(new TextDecoder().decode(result.files[result.names.sidecar]));
    Object.assign(provenance.HeadMotionCorrection, { Model: model, Seed: seed, Mask: effectiveMask, VisitOrder: order, VisitOrderConvention: visitOrder ? "DWI-only indices; supplied order" : "DWI-only indices; seeded port permutation, not NumPy" });
    result.files[result.names.sidecar] = new TextEncoder().encode(sidecarText(provenance));
    return { ...result, model, seed, visitOrder: order };
  } finally {
    estimator.release();
  }
}
