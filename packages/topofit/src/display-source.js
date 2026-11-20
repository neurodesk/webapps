// The input scan as the viewer should load it. NiiVue takes a NIfTI-2 affine from the
// srows whatever the codes say, as nifti-reader-js does, while TopoFit picks it by the
// NIfTI-1 rule (headerAffine). A NIfTI-2 scan whose srows do not already hold TopoFit's
// affine is returned as an uncompressed copy with that affine as its sform, in millimetres;
// its voxel data is untouched. Any other scan is returned as the same File.
import * as nifti from 'nifti-reader-js';
import { headerAffine } from './volume.js';

const NIFTI2_HEADER = 540;

async function leadingBytes(file, count) {
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return new Uint8Array(await file.slice(0, count).arrayBuffer());
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const output = new Uint8Array(count);
  let length = 0;
  while (length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    output.set(value.subarray(0, count - length), length);
    length += Math.min(value.length, count - length);
  }
  await reader.cancel();
  return output.subarray(0, length);
}

async function contents(file) {
  const bytes = await file.arrayBuffer();
  return nifti.isCompressed(bytes) ? nifti.decompress(bytes) : bytes;
}

export async function displaySource(file) {
  const head = await leadingBytes(file, NIFTI2_HEADER + 4);
  if (head.length < NIFTI2_HEADER + 4) return file;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const little = view.getInt32(0, true) === NIFTI2_HEADER;
  if (!little && view.getInt32(0, false) !== NIFTI2_HEADER) return file;
  // Geometry does not depend on extensions, which may lie beyond the bytes read.
  const header = nifti.readHeader(Uint8Array.from(head).fill(0, NIFTI2_HEADER).buffer);
  const affine = headerAffine(header);
  const agrees = header.affine.slice(0, 3).every((row, axis) => row.every((value, column) => Math.abs(value - affine[axis][column]) <= 1e-6 * Math.max(1, Math.abs(affine[axis][column]))));
  if (agrees) return file;
  const bytes = await contents(file);
  const output = new DataView(bytes);
  output.setInt32(348, Math.max(header.sform_code, header.qform_code, 1), little);
  affine.slice(0, 3).forEach((row, axis) => row.forEach((value, column) => output.setFloat64(400 + (axis * 4 + column) * 8, value, little)));
  output.setInt32(500, 2 | (header.xyzt_units & 56), little);
  return new File([bytes], file.name.replace(/\.gz$/i, ''), { type: file.type });
}
