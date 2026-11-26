/// <reference types="@webgpu/types" />
import type { SegmentOptions, SegmentResult } from './types.js';
export { BrainchompError } from './error.js';
export type { BrainchompErrorCode } from './error.js';
export { checkSupport, acquireDevice, ACTIVATION_BYTES } from './device.js';
export type { DeviceReport } from './device.js';
export { checkWebgl2Support, acquireGlContext, releaseGlContext, GL_ACTIVATION_BYTES, } from './webgl2.js';
export type { Webgl2Report } from './webgl2.js';
export type { Backend, SegmentOptions, SegmentResult } from './types.js';
/**
 * Whether the threaded CPU module can be instantiated at all.
 *
 * The module is pthreads, so it imports SHARED memory, and a page that is not
 * cross-origin isolated cannot instantiate that. Worse, the failure is not an
 * exception -- emscripten's pool spawn rejects a promise nobody holds and
 * initialisation never completes -- so this is checked BEFORE the module is
 * fetched. `!== true` rather than `=== false`: node has SharedArrayBuffer and
 * no `crossOriginIsolated` at all, and must be refused, not admitted to a hang.
 */
export declare function checkCpuSupport(): {
    supported: boolean;
    reasons: string[];
};
/**
 * Extract the brain from one rodent MRI volume.
 *
 * Takes a NIfTI file image (gzipped or not) and returns two: the skull-stripped
 * image and the binary brain mask. The whole chain -- conform to the model's
 * 256^3 0.1 mm grid, normalise, the MeshNet, largest component, mask opening, hole filling,
 * and reslicing back onto the input's grid -- runs inside the wasm module; this
 * function owns only what the module does not: gzip, device and context
 * acquisition, the cross-origin-isolation probe, and deciding to refuse.
 *
 * The input must carry its real voxel size: rodent scans whose headers were
 * scaled x10 for human tools have to be fixed first.
 *
 * Pass `worker: true` from a UI. The WebGL2 module is synchronous and holds
 * the calling thread for the whole run; in a worker the page stays responsive
 * on every backend.
 *
 * @example
 * const { brain, mask, backend } = await segment(await file.arrayBuffer(), { worker: true })
 */
export declare function segment(input: ArrayBuffer | ArrayBufferView, options?: SegmentOptions): Promise<SegmentResult>;
