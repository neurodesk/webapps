// SPDX-License-Identifier: Apache-2.0
// NIfTI-1 plumbing of the SyN-SDC pipeline on the shared reader and writer: volumes in, typed
// arrays out, and the header edits nipype makes (copy_header and niworkflows' FixHeader copy a
// reference image's qform, sform and voxel sizes onto a tool's output).
import { createNiftiFromData, decodeNiftiBuffer, extractNiftiHeader, readNiftiFrames } from '@neurodesk/webapp-components/file-io/nifti';

/** Reads NIfTI bytes (gzipped or not): voxels x-fastest, frame after frame. */
export async function readImage(bytes, OutputCtor = Float32Array) {
  const buffer = await decodeNiftiBuffer(bytes);
  const { data, header, dims, frames } = readNiftiFrames(buffer, OutputCtor);
  return {
    data,
    dims,
    frames,
    affine: header.affine.map((row) => Array.from(row)),
    header: extractNiftiHeader(buffer),
    datatype: header.datatype,
    scaled: header.sclSlope !== 1 || header.sclInter !== 0,
    bytes: new Uint8Array(buffer),
  };
}

/** A 3D NIfTI of `data` (its typed array sets the datatype) with the header of `like`. */
export function writeLike(like, data, dims) {
  return new Uint8Array(createNiftiFromData(data, like.header ?? like, { dims: dims ?? like.dims }));
}

// pixdim[0..3], then qform_code to srow_z: the fields nibabel's set_qform and set_sform write.
const GEOMETRY = [
  [76, 92],
  [252, 328],
];

/** `bytes` with the qform, sform and voxel sizes of the header `from` (nipype's _copyxform). */
export function copyGeometry(bytes, from) {
  const out = new Uint8Array(bytes);
  const source = new Uint8Array(from.header ?? from);
  for (const [start, end] of GEOMETRY) out.set(source.subarray(start, end), start);
  return out;
}

/**
 * A header of `like` for a new grid: the sform is `affine` at `code`, as nibabel writes a new
 * image. A diagonal RAS affine also gets the same qform (identity quaternion); any other
 * affine gets none (qform_code 0), as sdcflows' fresh images have.
 */
export function gridHeader(like, dims, affine, code) {
  const bytes = new Uint8Array(like.header ?? like).slice();
  const view = new DataView(bytes.buffer);
  const little = view.getInt32(0, true) === 348;
  view.setInt16(40, 3, little);
  dims.forEach((n, i) => view.setInt16(42 + 2 * i, n, little));
  view.setInt16(48, 1, little);
  const zooms = [0, 1, 2].map((j) => Math.hypot(affine[0][j], affine[1][j], affine[2][j]));
  view.setFloat32(76, 1, little);
  for (let i = 0; i < 3; i++) view.setFloat32(80 + 4 * i, zooms[i], little);
  const rasDiagonal = [0, 1, 2].every((i) => affine[i][i] > 0 && [0, 1, 2].every((j) => i === j || affine[i][j] === 0));
  view.setInt16(252, rasDiagonal ? code : 0, little);
  view.setInt16(254, code, little);
  for (let i = 0; i < 3; i++) view.setFloat32(256 + 4 * i, 0, little);
  for (let i = 0; i < 3; i++) view.setFloat32(268 + 4 * i, rasDiagonal ? affine[i][3] : 0, little);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) view.setFloat32(280 + 16 * i + 4 * j, affine[i][j], little);
  }
  return bytes.buffer;
}

/**
 * The ITK displacement field of `field`: a 5D float32 NIfTI (x, y, z, 1, 3) with vector intent,
 * on the grid of `like`. `vectors` holds x-fastest interleaved LPS millimetres.
 */
export function displacementNifti(like, dims, vectors) {
  const voxels = dims[0] * dims[1] * dims[2];
  const planar = new Float32Array(voxels * 3);
  for (let i = 0; i < voxels; i++) {
    for (let c = 0; c < 3; c++) planar[c * voxels + i] = vectors[3 * i + c];
  }
  const bytes = writeLike(like, planar, [...dims, 3]);
  const view = new DataView(bytes.buffer);
  const little = view.getInt32(0, true) === 348;
  view.setInt16(40, 5, little);
  view.setInt16(48, 1, little);
  view.setInt16(50, 3, little);
  view.setFloat32(92, 1, little);
  view.setFloat32(96, 1, little);
  view.setInt16(68, 1007, little);
  view.setUint8(123, 2);
  return bytes;
}
