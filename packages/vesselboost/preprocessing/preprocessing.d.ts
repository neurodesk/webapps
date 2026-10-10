/* tslint:disable */
/* eslint-disable */

/**
 * BET brain extraction (FSL-BET2 algorithm via qsm-core).
 *
 * Accepts Float32 input and converts to Float64 internally to avoid
 * doubling memory usage on the JS side.
 *
 * # Arguments
 * * `data` - Flattened Float32 magnitude volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `vsx`, `vsy`, `vsz` - Voxel sizes in mm
 * * `fractional_intensity` - Intensity threshold (0.0-1.0, smaller = larger brain, default: 0.5)
 * * `progress_callback` - JS function(current, total) for progress updates
 *
 * # Returns
 * Binary mask as Uint8Array (1 = brain, 0 = background)
 */
export function bet_brain_extract(data: Float32Array, nx: number, ny: number, nz: number, vsx: number, vsy: number, vsz: number, fractional_intensity: number, progress_callback: Function): Uint8Array;

/**
 * 3D bilateral filter denoising for MRI volumes.
 *
 * # Arguments
 * * `data` - Flattened Float32 volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `spatial_radius` - Spatial kernel half-size (default: 2, gives 5x5x5 kernel)
 * * `sigma_spatial` - Spatial Gaussian sigma (default: 1.5)
 * * `sigma_intensity` - Intensity Gaussian sigma (0.0 = auto-estimate from noise)
 */
export function bilateral_denoise(data: Float32Array, nx: number, ny: number, nz: number, spatial_radius: number, sigma_spatial: number, sigma_intensity: number): Float32Array;

/**
 * N4ITK bias field correction for 3D MRI volumes.
 *
 * # Arguments
 * * `data` - Flattened Float32 volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `vox_x`, `vox_y`, `vox_z` - Voxel sizes in mm
 * * `shrink_factor` - Downsampling factor for speed (default: 4)
 * * `max_iterations` - Maximum iterations per level (default: 50)
 * * `convergence_threshold` - Convergence threshold (default: 0.001)
 */
export function n4_bias_correct(data: Float32Array, nx: number, ny: number, nz: number, vox_x: number, vox_y: number, vox_z: number, shrink_factor: number, max_iterations: number, convergence_threshold: number): Float32Array;

/**
 * Non-local means denoising for 3D MRI volumes.
 *
 * # Arguments
 * * `data` - Flattened Float32 volume data
 * * `nx`, `ny`, `nz` - Volume dimensions
 * * `search_radius` - Search window half-size (default: 5)
 * * `patch_radius` - Patch half-size (default: 1, gives 3x3x3 patches)
 * * `h` - Smoothing parameter (0.0 = auto-estimate from noise)
 */
export function nlm_denoise(data: Float32Array, nx: number, ny: number, nz: number, search_radius: number, patch_radius: number, h: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly bet_brain_extract: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: any) => [number, number];
    readonly bilateral_denoise: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly n4_bias_correct: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
    readonly nlm_denoise: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
