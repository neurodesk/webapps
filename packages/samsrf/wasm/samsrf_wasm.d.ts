/* tslint:disable */
/* eslint-disable */

/**
 * Stimulus apertures in wasm memory, sparse per frame.
 */
export class Apertures {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(bytes: Uint8Array | number[]): Apertures;
    scaledXy(scaling_factor: number): Float64Array;
    serialize(): Uint8Array;
    toDense(): Float64Array;
    readonly height: number;
    readonly volumes: number;
    readonly width: number;
}

/**
 * A functional run in wasm memory: float32, vertex-major.
 */
export class Run {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    course(vertex: number): Float32Array;
    readonly vertices: number;
    readonly volumes: number;
}

/**
 * Streams runs into the combined, normalised time courses of the kept vertices.
 */
export class RunAccumulator {
    free(): void;
    [Symbol.dispose](): void;
    finish(): any;
    constructor(total_vertices: number, keep: Uint32Array | number[] | null | undefined, normalise: string, combine: string, noise_ceiling: boolean, global_signal: boolean);
    pushRun(run: Run): void;
}

export function detrend(x: Float64Array | number[]): Float64Array;

/**
 * `kernel` is the HRF; without one, `fit_tr` is the TR of the fitted HRF.
 */
export function errfun(source: string, apertures: Apertures, xy: Float64Array | number[], kernel: Float64Array | number[] | null | undefined, fit_tr: number | null | undefined, params: Float64Array | number[], observed: Float64Array | number[], downsampling: number, css_nonlinearity: boolean): number;

/**
 * `args` arrive flattened: the shape of argument `i` is `rows[i] x cols[i]` and its
 * column-major values follow the previous argument's in `data`.
 */
export function evaluateExpression(source: string, rows: Uint32Array | number[], cols: Uint32Array | number[], data: Float64Array | number[]): any;

export function exportGiis(values: string[], vertices: number, data: Float64Array | number[], prefix: string, selection?: string[] | null): Array<any>;

export function hrfConvolve(y: Float64Array | number[], kernel: Float64Array | number[], downsampling: number): Float64Array;

export function hrfDeHaas(tr: number): Float64Array;

export function hrfDoublegamma(tr: number, p: Float64Array | number[]): Float64Array;

export function hrfOldSchool(tr: number, fp: Float64Array | number[]): Float64Array;

/**
 * Resolves a parsed model's `hrf` object (`type` plus `values` or `file`).
 */
export function hrfResolve(kind: string, values: Float64Array | number[] | null | undefined, file: string | null | undefined, tr: number): any;

export function hrfSpmCanonical(tr: number): Float64Array;

export function noiseCeiling(odd: Float64Array | number[], even: Float64Array | number[]): number;

/**
 * The model as JSON. Serde's default form of `HrfSpec` is rewritten to
 * `{ type, values }` / `{ type, file }` here because an internally tagged enum
 * cannot carry the core's tuple variants.
 */
export function parseModel(kind: string, json: string): string;

export function pearson(x: Float64Array | number[], y: Float64Array | number[]): number;

export function polarAndEccentricity(values: string[], vertices: number, data: Float64Array | number[]): any;

export function predictTimecourse(rfp: Float64Array | number[], apertures: Apertures): Float64Array;

export function prfProfileGrid(source: string, params: Float64Array | number[], screen_width: number): Float64Array;

export function prfProfileXy(source: string, params: Float64Array | number[], xy: Float64Array | number[]): Float64Array;

export function readAnatomy(white: Uint8Array | number[], pial: Uint8Array | number[], inflated: Uint8Array | number[], sphere: Uint8Array | number[], curv: Uint8Array | number[], area: Uint8Array | number[], thickness?: Uint8Array | number[] | null): any;

export function readApertures(bytes: Uint8Array | number[], format: string): Apertures;

export function readFreeSurferCurv(bytes: Uint8Array | number[]): Float64Array;

export function readFreeSurferLabel(bytes: Uint8Array | number[]): any;

export function readFreeSurferSurface(bytes: Uint8Array | number[]): any;

export function readGifti(bytes: Uint8Array | number[]): any;

export function readGiftiRun(bytes: Uint8Array | number[]): Run;

export function readGiftiSurface(bytes: Uint8Array | number[]): any;

export function readMat(bytes: Uint8Array | number[]): any;

export function readOldSchoolHrf(bytes: Uint8Array | number[]): Float64Array;

export function removeNoise(volumes: number, vertices: number, data: Float64Array | number[], covariates: Float64Array | number[], n_covariates: number): Float64Array;

export function version(): string;

export function writeGiftiMap(values: Float64Array | number[]): Uint8Array;

export function zscore(x: Float64Array | number[]): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_apertures_free: (a: number, b: number) => void;
    readonly __wbg_run_free: (a: number, b: number) => void;
    readonly __wbg_runaccumulator_free: (a: number, b: number) => void;
    readonly apertures_deserialize: (a: number, b: number) => [number, number, number];
    readonly apertures_height: (a: number) => number;
    readonly apertures_scaledXy: (a: number, b: number) => [number, number];
    readonly apertures_serialize: (a: number) => [number, number];
    readonly apertures_toDense: (a: number) => [number, number];
    readonly apertures_volumes: (a: number) => number;
    readonly apertures_width: (a: number) => number;
    readonly detrend: (a: number, b: number) => [number, number];
    readonly errfun: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number];
    readonly evaluateExpression: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly exportGiis: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly hrfConvolve: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly hrfDeHaas: (a: number) => [number, number];
    readonly hrfDoublegamma: (a: number, b: number, c: number) => [number, number];
    readonly hrfOldSchool: (a: number, b: number, c: number) => [number, number, number, number];
    readonly hrfResolve: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly hrfSpmCanonical: (a: number) => [number, number];
    readonly noiseCeiling: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly parseModel: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly pearson: (a: number, b: number, c: number, d: number) => number;
    readonly polarAndEccentricity: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly predictTimecourse: (a: number, b: number, c: number) => [number, number];
    readonly prfProfileGrid: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prfProfileXy: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly readAnatomy: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number];
    readonly readApertures: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly readFreeSurferCurv: (a: number, b: number) => [number, number, number, number];
    readonly readFreeSurferLabel: (a: number, b: number) => [number, number, number];
    readonly readFreeSurferSurface: (a: number, b: number) => [number, number, number];
    readonly readGifti: (a: number, b: number) => [number, number, number];
    readonly readGiftiRun: (a: number, b: number) => [number, number, number];
    readonly readGiftiSurface: (a: number, b: number) => [number, number, number];
    readonly readMat: (a: number, b: number) => [number, number, number];
    readonly readOldSchoolHrf: (a: number, b: number) => [number, number, number, number];
    readonly removeNoise: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly run_course: (a: number, b: number) => [number, number, number];
    readonly run_vertices: (a: number) => number;
    readonly run_volumes: (a: number) => number;
    readonly runaccumulator_finish: (a: number) => [number, number, number];
    readonly runaccumulator_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly runaccumulator_pushRun: (a: number, b: number) => [number, number];
    readonly version: () => [number, number];
    readonly writeGiftiMap: (a: number, b: number) => [number, number];
    readonly zscore: (a: number, b: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
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
