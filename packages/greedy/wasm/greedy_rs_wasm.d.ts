/* tslint:disable */
/* eslint-disable */

export function initThreadPool(num_threads: number): Promise<any>;

/**
 * Register moving to fixed using the light 3-D affine interface. `metric` is
 * `SSD` or `NMI`; `iterations` uses Greedy's `100x50x10` notation.
 */
export function register_affine_wasm(fixed: Uint8Array, moving: Uint8Array, metric: string, iterations: string): string;

/**
 * Register moving to fixed with NMI stationary velocity. `matrix` is the
 * optional affine initialization in RAS text form; pass an identity matrix
 * when the images are already aligned. Inputs and output are raw `.nii`
 * bytes; browser callers should use CompressionStream for `.nii.gz`. The
 * returned NIfTI is the residual physical-LPS displacement field used before
 * that affine.
 */
export function register_nmi_svf_wasm(fixed: Uint8Array, moving: Uint8Array, matrix: string, iterations: string): Uint8Array;

/**
 * Reslice a NIfTI moving image into the fixed image's grid through one RAS affine.
 */
export function reslice_affine(fixed: Uint8Array, moving: Uint8Array, matrix: string): Uint8Array;

/**
 * Matches the production `-r warp.nii.gz aff.mat` transform order.
 */
export function reslice_warp_affine(fixed: Uint8Array, moving: Uint8Array, warp: Uint8Array, matrix: string): Uint8Array;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    mainJS(): string;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly register_affine_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly register_nmi_svf_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly reslice_affine: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly reslice_warp_affine: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_mainJS: (a: number) => any;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
