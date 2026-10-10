/* tslint:disable */
/* eslint-disable */

/**
 * A derived DICOM series: all files concatenated, delimited by `offsets`.
 */
export class DicomOut {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly data: Uint8Array;
    readonly offsets: Uint32Array;
}

/**
 * A DICOM series parsed into a volume + geometry + detected role + params.
 */
export class DicomVolume {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly affine: Float32Array;
    readonly data: Float32Array;
    readonly dims: Uint32Array;
    /**
     * DICOM ImageType (0008,0008) tokens joined by '\' (e.g. "ORIGINAL\PRIMARY\M\ND").
     */
    readonly image_type: string;
    readonly params: Float64Array;
    readonly role: string;
    /**
     * SeriesDescription (for duplicate/similar-series detection).
     */
    readonly series_desc: string;
}

/**
 * Result of a correction: flat volumes (i fastest) in the MP2RAGE grid.
 */
export class T1Result {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Relative B1 map on the MP2RAGE grid.
     */
    readonly b1: Float32Array;
    /**
     * Output dims [nx, ny, nz].
     */
    readonly dims: Uint32Array;
    /**
     * B1-corrected T1 (ms).
     */
    readonly t1: Float32Array;
    /**
     * Uncorrected T1 (ms).
     */
    readonly t1_uncorr: Float32Array;
    /**
     * B1-corrected UNI (0..4095).
     */
    readonly uni_corr: Float32Array;
}

/**
 * Denoise a UNI (O'Brien robust combination) -> UNI-DEN. Flat i-fastest arrays;
 * `mf` is the noise regularization multiplier. Returns the denoised UNI (0..4095).
 */
export function denoise_uni(uni: Float32Array, inv1: Float32Array, inv2: Float32Array, dims: Uint32Array, mf: number): Float32Array;

/**
 * Parse one DICOM series given all its files concatenated, with `offsets`
 * delimiting each file (length = nfiles + 1, byte offsets into `concat`).
 */
export function parse_dicom_series(concat: Uint8Array, offsets: Uint32Array): DicomVolume;

/**
 * B1-corrected T1 from MP2RAGE UNI + INV2 + a generic B1 map.
 * Pass an empty `inv2` slice to derive a mask from |UNI - median(UNI)|.
 * `kind`: 0 = tfl (flip x10), 1 = percent, 2 = relative.
 * `extend_fov`: smoothly extrapolate a too-small B1 FOV to cover the brain.
 */
export function t1map_b1(uni: Float32Array, inv2: Float32Array, b1_map: Float32Array, dims: Uint32Array, uni_aff: Float32Array, b1_dims: Uint32Array, b1_aff: Float32Array, kind: number, ref_angle: number, mp: Float64Array, extend_fov: boolean, fallback_uncorrected: boolean): T1Result;

/**
 * B1-corrected T1 from MP2RAGE UNI + INV2 + SA2RAGE (2-volume) source.
 *
 * Pass an empty `inv2` slice to derive a mask from |UNI - median(UNI)|.
 * `dims`/`sa_dims` are `[nx,ny,nz]`; affines are row-major 4x4 (len 16);
 * `mp` = [TR,TI1,TI2,FA1,FA2,NZ1,NZ2,TRFLASH,invEff];
 * `sa` params = [TR,TI1,TI2,FA1,FA2,NZ1,NZ2,TRFLASH,avgT1].
 */
export function t1map_sa2rage(uni: Float32Array, inv2: Float32Array, sa: Float32Array, dims: Uint32Array, uni_aff: Float32Array, sa_dims: Uint32Array, sa_aff: Float32Array, mp: Float64Array, sa_p: Float64Array, fallback_uncorrected: boolean): T1Result;

/**
 * Library version string (for the UI footer / provenance).
 */
export function version(): string;

/**
 * Write a derived T1 (ms) DICOM series from the source DICOM bytes (`concat` +
 * `offsets`, as passed to `parse_dicom_series`) and the computed T1 volume
 * (i-fastest, on the source grid). `salt` makes the generated UIDs unique.
 * When `deidentify` is true, the derived output keeps only a whitelist of
 * technical/geometry/rendering/UID tags (everything else, including all source
 * PHI and private groups, is dropped by omission) and the study/frame-of-
 * reference UIDs are re-mapped to break linkage back to the source.
 */
export function write_dicom_t1(concat: Uint8Array, offsets: Uint32Array, t1: Float32Array, dims: Uint32Array, salt: string, deidentify: boolean): DicomOut;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_dicomout_free: (a: number, b: number) => void;
    readonly __wbg_dicomvolume_free: (a: number, b: number) => void;
    readonly __wbg_t1result_free: (a: number, b: number) => void;
    readonly denoise_uni: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly dicomout_data: (a: number) => [number, number];
    readonly dicomout_offsets: (a: number) => [number, number];
    readonly dicomvolume_affine: (a: number) => [number, number];
    readonly dicomvolume_data: (a: number) => [number, number];
    readonly dicomvolume_dims: (a: number) => [number, number];
    readonly dicomvolume_image_type: (a: number) => [number, number];
    readonly dicomvolume_params: (a: number) => [number, number];
    readonly dicomvolume_role: (a: number) => [number, number];
    readonly dicomvolume_series_desc: (a: number) => [number, number];
    readonly parse_dicom_series: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly t1map_b1: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number) => number;
    readonly t1map_sa2rage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number) => number;
    readonly t1result_b1: (a: number) => [number, number];
    readonly t1result_dims: (a: number) => [number, number];
    readonly t1result_t1: (a: number) => [number, number];
    readonly t1result_t1_uncorr: (a: number) => [number, number];
    readonly t1result_uni_corr: (a: number) => [number, number];
    readonly version: () => [number, number];
    readonly write_dicom_t1: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
