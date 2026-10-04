import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';

// Stop after the header, including for highly compressible voxel payloads. A gzip
// filename/comment may precede it, so compressed input has a separate 1 MiB cap.
export async function readNiftiHeader(path, length = 352) {
  const file = await open(path, 'r');
  const first = Buffer.alloc(length);
  let bytesRead;
  try { ({ bytesRead } = await file.read(first, 0, first.length, 0)); }
  finally { await file.close(); }
  if (first[0] !== 0x1f || first[1] !== 0x8b) return first.subarray(0, bytesRead);
  const input = createReadStream(path, { highWaterMark: 4096, end: 1024 * 1024 - 1 });
  const decoder = createGunzip({ chunkSize: 1024 });
  input.on('error', error => decoder.destroy(error));
  input.pipe(decoder);
  const header = Buffer.alloc(length);
  let received = 0;
  try {
    for await (const chunk of decoder) {
      received += chunk.copy(header, received, 0, Math.min(chunk.length, header.length - received));
      if (received === header.length) return header;
    }
    return header.subarray(0, received);
  } catch (error) {
    throw new Error(`Cannot read NIfTI header within 1 MiB of compressed input: ${error.message}`);
  } finally {
    input.destroy();
    decoder.destroy();
  }
}


// Encoding checks precede scientific execution. Geometry and spatial identity
// have separate validation rules; a filename or NIfTI magic cannot prove them.
export async function validateNiftiEncoding(path) {
  const bytes = await readNiftiHeader(path, 548);
  if (bytes.length >= 352 && (bytes.readInt32LE(0) === 348 || bytes.readInt32BE(0) === 348)
    && bytes.subarray(344, 348).equals(Buffer.from('n+1\0'))) return;
  if (bytes.length >= 544 && (bytes.readInt32LE(0) === 540 || bytes.readInt32BE(0) === 540)
    && bytes.subarray(4, 12).equals(Buffer.from([110, 43, 50, 0, 13, 10, 26, 10]))) return;
  throw new Error(`Input encoding is not a single-file NIfTI image: ${path}`);
}
