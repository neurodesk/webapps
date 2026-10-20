// Input size limits for apps that hold a whole image in memory, so a large input is
// refused with a message instead of crashing the tab.
import { readNiftiHeader } from './NiftiUtils.js';

/** The browser/WASM address-space ceiling: 2 GB across one input. */
export const MAX_INPUT_BYTES = 2_000_000_000;

export class InputTooLargeError extends Error {
  /**
   * @param {number} actualBytes
   * @param {number} [limitBytes]
   * @param {{ subject?: string }} [options] what is too large, at the start of the message
   */
  constructor(actualBytes, limitBytes = MAX_INPUT_BYTES, { subject = 'Input' } = {}) {
    super(`${subject} too large (${formatBytes(actualBytes)}; browser limit ${formatBytes(limitBytes)}).`);
    this.name = 'InputTooLargeError';
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

/** Decimal units, three significant digits: 2_000_000_000 is "2.00 GB". */
export function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Refuses files whose sizes add up to more than the limit. */
export function assertInputSize(files, limitBytes = MAX_INPUT_BYTES) {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > limitBytes) throw new InputTooLargeError(totalBytes, limitBytes);
}

/**
 * Bytes of the Float32 array `readNiftiFrames` allocates for this header:
 * nx × ny × nz × frames × 4, whatever the stored datatype.
 */
export function decodedFloat32Bytes(header) {
  const rank = Math.min(7, header.dims[0]);
  let frames = 1;
  for (let d = 4; d <= rank; d++) frames *= Math.max(1, header.dims[d]);
  return header.nx * header.ny * header.nz * frames * Float32Array.BYTES_PER_ELEMENT;
}

/**
 * Refuses a NIfTI file whose decoded Float32 image is above the limit, from its header
 * alone. Gzip streaming stops after the header when supported. Returns the decoded size.
 */
export async function assertNiftiDecodedSize(file, limitBytes = MAX_INPUT_BYTES) {
  const bytes = decodedFloat32Bytes(await readNiftiHeader(file));
  if (bytes > limitBytes) throw new InputTooLargeError(bytes, limitBytes, { subject: 'Decoded image' });
  return bytes;
}
