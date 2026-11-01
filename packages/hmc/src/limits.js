// What hmc.wasm's estimator can hold. Its linear memory stops at 1 GiB (scripts/build-wasm.sh),
// whatever the machine has, so an input over the limit fails with a bare "unreachable".
// The terms count the large allocations of createNifreezeModel (src/wasm.js), nifreeze_init and
// nifreeze_predict (exes/dwi/hmc-wasm/src/lib.rs, exes/dwi/hmc, exes/dwi/gp), for V grid voxels,
// F frames, D DWI volumes, M mask voxels and n = D − 1. Measured in docs/architecture/dwi-hmc-plan.md,
// section 6, with validation/estimator-limits.mjs, init-limits.mjs and gp-quadratic.mjs.

const GB = 1e9;
/** The largest estimate accepted. 1 GiB is 1.074 GB; measured heaps reached 1.0734 GB and passed. */
export const ESTIMATOR_LIMIT = 1.06 * GB;

/**
 * Estimated heap bytes at the end of initialisation and of the first GP prediction. `maskVoxels` is
 * null until the mask is known: init then counts no mask voxels, a lower bound, and the fit is not
 * estimated. Upper bounds for the mask voxels are safe.
 */
export function estimatorBytes({ voxels: V, frames: F, dwiVolumes: D, maskVoxels = null, model = "gp" }) {
  const gp = model === "gp", M = maskVoxels ?? 0, n = D - 1;
  // nifreeze_init with the series copied in: the Float32 series and its DWI volumes, the float64
  // median bzero and four byte masks (the brain mask copied in, its bools, the GP data mask and the
  // copy kept), and for GP the voxel indices, a Vec<u32> grown by doubling, old and new at once.
  const init = 4 * V * (F + D) + 12 * V + (gp ? 12 * M : 0);
  if (!gp || maskVoxels === null) return { init, fit: 0 };
  // A prediction reuses the freed input copy and copied-in mask; what it holds beyond that goes on
  // top of the heap, with up to one more block lost to placement. It holds the float64 output, a
  // new data mask and voxel indices, then, at its largest:
  //   fitting:    float32 targets, their float64 copy, mean and std, the log-likelihood's eleven
  //               float64 n × n matrices (exes/dwi/gp/src/likelihood.rs);
  //   predicting: the float64 copy, mean and std, the posterior mean and the float64 volume;
  //   clipping:   the volume, its median filter and the stable sort's scratch, len − len/2 values
  //               or the whole length up to 8 MB (core::slice::sort::stable::driftsort_main).
  const kept = 9 * V + 8 * M;
  const scratch = 8 * Math.max(V - Math.floor(V / 2), Math.min(V, 1e6));
  const stages = [
    { live: kept + 12 * M * n + 16 * M + 88 * n ** 2, block: Math.max(8 * V, 8 * M * n, 8 * n ** 2) },
    { live: kept + 8 * M * n + 24 * M + 8 * V, block: Math.max(8 * V, 8 * M * n) },
    { live: kept + 16 * V + scratch, block: 8 * V },
  ];
  const freed = 4 * V * F + V;
  const overflow = Math.max(0, ...stages.map(({ live, block }) => live > freed ? live - freed + block : 0));
  return { init, fit: init + overflow };
}

const gb = bytes => (bytes / GB).toFixed(2);

/** Why NiFreeze cannot run on this input, or null. Upper bounds for the mask voxels are safe. */
export function nifreezeInputProblem(input) {
  const bytes = estimatorBytes(input);
  if (bytes.init > ESTIMATOR_LIMIT) {
    return `Series too large for motion correction (${gb(bytes.init)} of ${gb(ESTIMATOR_LIMIT)} GB): crop it or use fewer volumes.`;
  }
  if (bytes.fit > ESTIMATOR_LIMIT) {
    return `GP model too large (${gb(bytes.fit)} of ${gb(ESTIMATOR_LIMIT)} GB): use a tighter mask, fewer volumes or mean b0.`;
  }
  return null;
}
