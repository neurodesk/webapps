/**
 * What runs the model.
 *
 * `webgpu` is preferred wherever it exists: it is the fastest, and its module
 * yields to the event loop while the GPU works. `webgl2` is the fallback for
 * browsers WebGPU has not reached; it is universal but BLOCKS the calling
 * thread for the duration (use `worker: true`). `cpu` is the last resort, a
 * pthreads build of the same C the native executable runs -- bit-exact with
 * it, an order of magnitude slower than the GPU paths, and only on a
 * cross-origin isolated page.
 */
export type Backend = 'webgpu' | 'webgl2' | 'cpu';
export interface SegmentOptions {
    /**
     * Morphological opening radius, in voxels of the model's 0.1 mm grid, which
     * detaches skull or muscle joined to the brain by thin bridges. It only ever
     * removes voxels. 0 disables it. Default 4 (a 0.9 mm cube).
     */
    opening?: number;
    /**
     * Fill enclosed cavities in the mask (background with no path to the edge of
     * the volume) as brain, after the opening. It only ever adds voxels.
     * Default true.
     */
    fillHoles?: boolean;
    /**
     * Return both outputs on the model's 256^3 0.1 mm LPS grid instead of the
     * input's own grid. Off by default: outputs line up with the file you gave.
     * For an input already on that grid the two are the same.
     */
    saveConform?: boolean;
    /**
     * gzip the returned buffers. Defaults to whatever the input was, so a
     * `.nii.gz` in gives `.nii.gz` out.
     */
    gzipOutput?: boolean;
    /**
     * What to run on. Defaults to `auto`: WebGPU when this browser supports it,
     * otherwise WebGL2, otherwise the threaded CPU module. Naming one makes an
     * unsupported choice an error rather than a silent downgrade.
     */
    backend?: Backend | 'auto';
    /**
     * Run in a Web Worker instead of on the calling thread. STRONGLY RECOMMENDED
     * in a page that must stay responsive, and the only way to keep one during a
     * WebGL2 run. Incompatible with `device` and `glContext`, which cannot cross
     * a worker boundary.
     */
    worker?: boolean;
    /** Reuse a device you already own instead of requesting one. Implies webgpu. */
    device?: GPUDevice;
    /**
     * Reuse a WebGL2 context you already own. Implies webgl2. It must have
     * `EXT_color_buffer_float` available; `acquireGlContext()` does that for you.
     */
    glContext?: WebGL2RenderingContext;
    /**
     * Base URL the `.js`/`.wasm` modules (and `worker.js`) are served from.
     * Defaults to this package's own directory, which is right for an unbundled
     * ES module. Set it when a bundler has moved things: the files must stay
     * adjacent and unhashed, so copy them somewhere served and point here.
     * Must be same-origin.
     */
    assetPath?: string;
    /**
     * Abort if inference has not finished within this many ms. Default 120000,
     * or 900000 for the `cpu` backend. An in-thread `webgl2` call cannot be
     * interrupted (the module is synchronous); `worker: true` is the only real
     * cancellation.
     */
    timeoutMs?: number;
    /** Receives the module's stdout/stderr lines as they are produced. */
    onLog?: (line: string) => void;
}
export interface SegmentResult {
    /**
     * The skull-stripped image as a NIfTI file: the input's own voxels, datatype
     * and scaling, with non-brain voxels set to 0.
     */
    brain: ArrayBuffer;
    /** The binary brain mask as a NIfTI file (uint8, 0/1), on the same grid. */
    mask: ArrayBuffer;
    /** Milliseconds spent inside the wasm module, excluding device acquisition. */
    elapsedMs: number;
    /** Which backend actually ran, which matters when `backend` was `auto`. */
    backend: Backend;
    /** Whether it ran in a Web Worker. Follows `worker`; never silently different. */
    ranInWorker: boolean;
}
