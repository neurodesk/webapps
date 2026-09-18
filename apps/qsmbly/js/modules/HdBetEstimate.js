/**
 * How much work an HD-BET run will be, without running it.
 *
 * Mirrors what `qsm_core::bet::hd_bet` does before inference: resample to 1 mm, centre-pad up to
 * at least one patch, then slide the window by `tileStep * patch`. Kept in its own module so the
 * arithmetic can be tested against a real run rather than living inside the app class.
 */

/** nnU-Net's `compute_new_shape` target spacing (mm). */
const TARGET_SPACING = 1.0;

/**
 * Window positions along one axis — `window_steps` in `src/bet/hdbet.rs`.
 *
 * @param {number} size - axis length after resampling and padding
 * @param {number} tile - patch extent on this axis
 * @param {number} step - stride as a fraction of the patch, in (0, 1]
 * @returns {number} number of window positions
 */
export function windowSteps(size, tile, step) {
  if (size <= tile) return 1;
  return Math.ceil((size - tile) / (tile * step)) + 1;
}

/**
 * Estimate the sliding-window patch count for a volume.
 *
 * This is an **upper bound**: nnU-Net crops to the non-zero region before resampling, which this
 * cannot know without reading the voxels, and which only ever removes patches. The exact total
 * arrives with the first progress callback once the run starts.
 *
 * @param {number[]} dims - `[nx, ny, nz]`
 * @param {number[]} voxelSize - `[vx, vy, vz]` in mm
 * @param {number[]} patch - `[px, py, pz]`
 * @param {number} tileStep - stride as a fraction of the patch, in (0, 1]
 * @returns {number} patches
 */
export function estimateHdBetPatches(dims, voxelSize, patch, tileStep) {
  const [nx, ny, nz] = dims;
  const [vx, vy, vz] = voxelSize;
  const [px, py, pz] = patch;

  // The crate works in nnU-Net's (z, y, x) order; pair each axis with its own extent + spacing.
  const axes = [[nz, pz, vz], [ny, py, vy], [nx, px, vx]];
  return axes.reduce((total, [dim, tile, spacing]) => {
    const resampled = Math.round((spacing / TARGET_SPACING) * dim);
    const padded = Math.max(resampled, tile);   // centred pad to at least one patch
    return total * windowSteps(padded, tile, tileStep);
  }, 1);
}
