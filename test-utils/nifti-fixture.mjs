// Minimal NIfTI-1 helpers for tests and the reference compute server.
import { gunzipSync, gzipSync } from 'node:zlib';

export const NIFTI_HEADER_BYTES = 352;

export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function decompressIfNeeded(bytes) {
  return isGzip(bytes) ? gunzipSync(bytes) : Buffer.from(bytes);
}

/** True when the (possibly gzipped) bytes carry a NIfTI-1 magic string. */
export function isNifti1(bytes) {
  let header;
  try {
    header = decompressIfNeeded(bytes).subarray(0, NIFTI_HEADER_BYTES);
  } catch {
    return false;
  }
  if (header.length < NIFTI_HEADER_BYTES) return false;
  const magic = header.toString('latin1', 344, 347);
  return magic === 'n+1' || magic === 'ni1';
}

/** Parse the few header fields the reference server needs. */
export function parseHeader(buffer) {
  const header = buffer.subarray(0, NIFTI_HEADER_BYTES);
  const dims = [];
  for (let index = 0; index < 8; index += 1) dims.push(header.readInt16LE(40 + index * 2));
  const datatype = header.readInt16LE(70);
  const voxOffset = header.readFloatLE(108);
  const sclSlope = header.readFloatLE(112);
  const sclInter = header.readFloatLE(116);
  return { dims, datatype, voxOffset: voxOffset || NIFTI_HEADER_BYTES, sclSlope, sclInter };
}

const READERS = {
  2: (view, offset) => view.getUint8(offset),
  4: (view, offset) => view.getInt16(offset, true),
  8: (view, offset) => view.getInt32(offset, true),
  16: (view, offset) => view.getFloat32(offset, true),
  64: (view, offset) => view.getFloat64(offset, true),
  256: (view, offset) => view.getInt8(offset),
  512: (view, offset) => view.getUint16(offset, true),
  768: (view, offset) => view.getUint32(offset, true),
};
const SIZES = { 2: 1, 4: 2, 8: 4, 16: 4, 64: 8, 256: 1, 512: 2, 768: 4 };

/** Read a volume into a Float64Array (scaled) with its dims and raw header. */
export function readVolume(bytes) {
  const buffer = decompressIfNeeded(bytes);
  const header = parseHeader(buffer);
  const reader = READERS[header.datatype];
  const size = SIZES[header.datatype];
  if (!reader) throw new Error(`Unsupported NIfTI datatype ${header.datatype}`);
  const [, nx, ny, nz] = header.dims;
  const count = Math.max(1, nx) * Math.max(1, ny) * Math.max(1, nz);
  const view = new DataView(buffer.buffer, buffer.byteOffset + Math.round(header.voxOffset), count * size);
  const data = new Float64Array(count);
  const slope = header.sclSlope || 1;
  for (let index = 0; index < count; index += 1) {
    data[index] = reader(view, index * size) * slope + header.sclInter;
  }
  return { header: buffer.subarray(0, NIFTI_HEADER_BYTES), dims: [nx, ny, nz], data };
}

/** Write a float32 gzipped NIfTI-1 using another volume's header. */
export function writeFloat32Volume(headerBytes, data) {
  const header = Buffer.from(headerBytes.subarray(0, NIFTI_HEADER_BYTES));
  header.writeInt16LE(16, 70);
  header.writeInt16LE(32, 72);
  header.writeFloatLE(NIFTI_HEADER_BYTES, 108);
  header.writeFloatLE(1, 112);
  header.writeFloatLE(0, 116);
  const body = Buffer.alloc(data.length * 4);
  for (let index = 0; index < data.length; index += 1) body.writeFloatLE(data[index], index * 4);
  return gzipSync(Buffer.concat([header, body]));
}

/** Build a small synthetic float32 NIfTI-1 (gzipped unless `gzip: false`). */
export function syntheticNifti({ dims = [4, 4, 4], spacing = [1, 1, 3], value = index => index, gzip = true } = {}) {
  const header = Buffer.alloc(NIFTI_HEADER_BYTES);
  header.writeInt32LE(348, 0);
  header.writeInt16LE(3, 40);
  header.writeInt16LE(dims[0], 42);
  header.writeInt16LE(dims[1], 44);
  header.writeInt16LE(dims[2], 46);
  header.writeInt16LE(1, 48);
  header.writeInt16LE(16, 70);
  header.writeInt16LE(32, 72);
  header.writeFloatLE(1, 76);
  header.writeFloatLE(spacing[0], 80);
  header.writeFloatLE(spacing[1], 84);
  header.writeFloatLE(spacing[2], 88);
  header.writeFloatLE(NIFTI_HEADER_BYTES, 108);
  header.writeFloatLE(1, 112);
  header.writeInt16LE(1, 252);
  header.writeInt16LE(1, 254);
  header.writeFloatLE(spacing[0], 280);
  header.writeFloatLE(spacing[1], 296);
  header.writeFloatLE(spacing[2], 312);
  header.write('n+1\0', 344, 'latin1');
  const count = dims[0] * dims[1] * dims[2];
  const body = Buffer.alloc(count * 4);
  for (let index = 0; index < count; index += 1) body.writeFloatLE(value(index), index * 4);
  const bytes = Buffer.concat([header, body]);
  return gzip ? gzipSync(bytes) : bytes;
}
