/**
 * Every refusal this package makes carries a machine-readable `code` alongside
 * the prose, because the interesting failures are ones a caller may want to act
 * on rather than merely display -- "this GPU is too small" is a different
 * situation from "the page is not cross-origin isolated".
 *
 * There is no silent fallback behind any of these. `backend: 'auto'` choosing
 * webgpu -> webgl2 -> cpu happens BEFORE anything is fetched and only when the
 * caller expressed no preference; a NAMED backend that cannot run throws.
 */
export type BrainchompErrorCode = 'no-webgpu' | 'no-adapter' | 'device-too-small' | 'no-f16' | 'unsupported-option' | 'bad-input' | 'initialization-failed' | 'inference-failed';
export declare class BrainchompError extends Error {
    readonly code: BrainchompErrorCode;
    /** The module's own output, when the failure came from inside it. */
    readonly log?: string[];
    constructor(code: BrainchompErrorCode, message: string, log?: string[]);
}
