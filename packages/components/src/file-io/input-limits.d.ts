import type { NiftiHeader } from './NiftiUtils.js';

/** The browser/WASM address-space ceiling: 2 GB across one input. */
export const MAX_INPUT_BYTES: number;

export class InputTooLargeError extends Error {
  readonly actualBytes: number;
  readonly limitBytes: number;
  constructor(actualBytes: number, limitBytes?: number, options?: { subject?: string });
}

/** Decimal units, three significant digits: 2_000_000_000 is "2.00 GB". */
export function formatBytes(bytes: number): string;

/** Refuses files whose sizes add up to more than the limit. */
export function assertInputSize(files: ReadonlyArray<Pick<Blob, 'size'>>, limitBytes?: number): void;

/** Bytes of the Float32 array `readNiftiFrames` allocates for this header. */
export function decodedFloat32Bytes(header: Pick<NiftiHeader, 'dims' | 'nx' | 'ny' | 'nz'>): number;

/** Refuses a NIfTI file whose decoded Float32 image is above the limit, from its header alone. */
export function assertNiftiDecodedSize(file: Blob, limitBytes?: number): Promise<number>;
