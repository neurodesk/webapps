/* tslint:disable */
/* eslint-disable */

/**
 * Richardson-Lucy (RL-TV when `tv_weight` > 0), one iteration per `iterate` call so the
 * caller can report progress and stop between iterations.
 */
export class Deconvolver {
    free(): void;
    [Symbol.dispose](): void;
    estimate(): Float64Array;
    iterate(count: number): void;
    iterations(): number;
    constructor(image: Float64Array | number[], dims: Uint32Array | number[], psf: Float64Array | number[], psf_dims: Uint32Array | number[], tv_weight: number);
}

/**
 * The scalar Gibson-Lanni PSF on a centred `nz x xy_size x xy_size` grid, peak 1.
 * `excitation_um` > 0 gives the confocal product of excitation and emission PSFs; 0 gives
 * the widefield emission PSF. The coverslip and working distance keep psfmodels' defaults
 * (170 um of index 1.515, 150 um); the immersion design and experimental indices are both `ni`.
 */
export function gibsonLanniPsf(na: number, ni: number, ns: number, emission_um: number, excitation_um: number, dxy: number, dz: number, xy_size: number, nz: number, pz: number): Float64Array;

/**
 * The padded FFT grid `[nz, ny, nx]` a deconvolution of these sizes uses.
 */
export function paddedDims(image_dims: Uint32Array | number[], psf_dims: Uint32Array | number[]): Uint32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_deconvolver_free: (a: number, b: number) => void;
    readonly deconvolver_estimate: (a: number) => [number, number];
    readonly deconvolver_iterate: (a: number, b: number) => void;
    readonly deconvolver_iterations: (a: number) => number;
    readonly deconvolver_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly gibsonLanniPsf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly paddedDims: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
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
