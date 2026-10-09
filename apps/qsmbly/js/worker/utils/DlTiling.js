/**
 * Deep-learning tile size limits
 *
 * A tiled DL inversion holds one patch's activations per tile in flight, all in the 32-bit wasm
 * heap. qsm-core caps how many tiles run at once, but one patch still has to fit on its own:
 * near the 4 GB ceiling a run stalls without an error (astewartau/QSM.rs#89). qsm-core refuses a
 * patch over 131³ (`max_wasm_patch_edge`, from a 2.5 GB single-patch limit at xQSM's
 * 1100 B/voxel); rounded down to the nets' size divisor of 8 that is 128³.
 */

/** Largest tile patch edge (core + 2·halo) a browser can run. Mirrors qsm-core's limit. */
export const MAX_WASM_PATCH_EDGE = 128;

/** Smallest tile core the settings modal offers. */
const MIN_CORE = 16;

/**
 * Shrink a tile config until its patch fits {@link MAX_WASM_PATCH_EDGE}.
 *
 * The core gives way first, since the halo is what limits tile-boundary error. The halo is
 * reduced only if it alone leaves less than {@link MIN_CORE} voxels of core.
 *
 * @param {number} core - tile core size in voxels
 * @param {number} halo - tile halo in voxels
 * @returns {{ core: number, halo: number, clamped: boolean }}
 */
export function clampTileConfig(core, halo) {
  if (core + 2 * halo <= MAX_WASM_PATCH_EDGE) return { core, halo, clamped: false };
  const h = Math.min(halo, Math.floor((MAX_WASM_PATCH_EDGE - MIN_CORE) / 2));
  return { core: MAX_WASM_PATCH_EDGE - 2 * h, halo: h, clamped: true };
}
