/** Two activation sets ping-pong, so the device needs twice one activation: 1 GiB. */
export declare const GL_ACTIVATION_BYTES: number;
export interface Webgl2Report {
    supported: boolean;
    /** Why not, in the caller's terms. Empty when supported. */
    reasons: string[];
    renderer?: string;
    max3dTextureSize?: number;
    maxDrawBuffers?: number;
    maxColorAttachments?: number;
    maxTextureSize?: number;
    /** True when a single 128 MiB activation plane actually allocated. */
    allocates?: boolean;
}
/**
 * Ask whether this browser can run the model on WebGL2, without running it.
 *
 * Cheap and side-effect free apart from one texture allocation, which is the
 * only honest way to answer the question that matters: WebGL2 has no memory
 * query at all, so "will 1 GiB of activations fit" cannot be asked, only tried.
 * This tries a single 128 MiB plane -- an eighth of the real requirement --
 * which catches a device that is nowhere near without reserving what a real run
 * would need.
 */
export declare function checkWebgl2Support(): Webgl2Report;
/**
 * Release a context this package created.
 *
 * Not called for a caller-supplied `glContext`: that one is theirs.
 */
export declare function releaseGlContext(gl: WebGL2RenderingContext): void;
/**
 * Acquire a context sized for the model, or refuse and say what was short.
 *
 * The returned context has EXT_color_buffer_float already enabled. That matters:
 * a WebGL extension is per-context state, and the module asks for it too, but
 * enabling it here means a device that cannot provide it is refused with a
 * sentence rather than a GL error 200 lines into C.
 */
export declare function acquireGlContext(): WebGL2RenderingContext;
