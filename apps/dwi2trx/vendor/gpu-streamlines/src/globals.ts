/**
 * Tracking constants used host-side, from GPUStreamlines
 * `cuslines/cuda_python/_globals.py`. These must match the values baked into
 * `wgsl/globals.wgsl` (the GPU kernels and host buffer sizing depend on both).
 * Only the constants the TS host actually uses live here; the rest are in the
 * WGSL.
 */

export const MAX_SLINE_LEN = 501
export const REAL_SIZE = 4 // bytes per f32 (WGSL has no f64)
export const BLOCK_Y = 1 // seeds per workgroup: one 32-lane subgroup each (upstream runs 2)

export const divUp = (a: number, b: number): number =>
  Math.floor((a + b - 1) / b)
