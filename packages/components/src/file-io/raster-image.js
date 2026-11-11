// PNG and JPEG images (histology sections, slide photographs): their size from the file header,
// so a caller can refuse an image before the browser decodes it, and the decoded RGBA pixels.
import { InputTooLargeError, MAX_INPUT_BYTES } from './input-limits.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// JPEG start-of-frame markers: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function pngSize(bytes) {
  if (bytes.length < 33) throw new Error('This PNG file is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) throw new Error('This PNG file does not start with its IHDR chunk.');
  return { format: 'png', width: view.getUint32(16), height: view.getUint32(20), bitDepth: bytes[24], colourType: bytes[25] };
}

function jpegSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('This JPEG file has a malformed segment.');
    const marker = bytes[at + 1];
    // Fill bytes, and markers without a length: TEM and RSTn.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = view.getUint16(at + 2);
    if (length < 2) throw new Error('This JPEG file has a malformed segment.');
    if (SOF_MARKERS.has(marker)) {
      if (at + 9 > bytes.length) break;
      return { format: 'jpeg', width: view.getUint16(at + 7), height: view.getUint16(at + 5), bitDepth: bytes[at + 4], components: bytes[at + 9] };
    }
    at += 2 + length;
  }
  throw new Error('This JPEG file has no frame header before its image data.');
}

/**
 * The format and pixel size of a PNG or JPEG from its header: the PNG IHDR chunk, or the JPEG
 * start-of-frame segment found by walking the segments (APPn metadata can be any length).
 * Returns null for any other format.
 * @param {Uint8Array} bytes the start of the file (a JPEG's frame header can follow large metadata)
 */
export function probeRasterImage(bytes) {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return pngSize(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return null;
}

/**
 * Decodes a PNG or JPEG to RGBA (row, column, channel), refusing it from its header when the
 * decoded pixels would exceed `maxBytes`. Pixels are taken as stored: no EXIF rotation, colour
 * space conversion or alpha premultiplication, and the decoded size must equal the header's.
 * Needs createImageBitmap and OffscreenCanvas (browsers and workers).
 * @param {Blob} file
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ width: number, height: number, format: 'png' | 'jpeg', data: Uint8ClampedArray }>}
 */
export async function decodeRasterImage(file, { maxBytes = MAX_INPUT_BYTES, signal } = {}) {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = probeRasterImage(bytes);
  if (!header) throw new Error(`${file.name ?? 'This file'} is not a PNG or JPEG image.`);
  if (!header.width || !header.height) throw new Error(`${file.name ?? 'This image'} has no pixels.`);
  const decodedBytes = header.width * header.height * 4;
  if (decodedBytes > maxBytes) throw new InputTooLargeError(decodedBytes, maxBytes, { subject: 'Decoded image' });
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width !== header.width || bitmap.height !== header.height) {
      throw new Error(`The decoded image is ${bitmap.width} × ${bitmap.height}, not ${header.width} × ${header.height} as its header says.`);
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, format: header.format, data };
  } finally {
    bitmap.close();
  }
}
