// NIfTI-1 images for Greedy and for download, built on the shared NIfTI writer. Every header
// carries the transform as an sform (qform_code 0), so Greedy and NiiVue read the same frame.
import { createNiftiFromData, createNiftiHeaderFromVolume, parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';

// NIfTI xyzt_units spatial codes in millimetres; 0 (unknown) is read as millimetres.
const SPATIAL_UNIT_MM = { 0: 1, 1: 1000, 2: 1, 3: 0.001 };

/**
 * The MRI from a parsed NIfTI (`parseNiftiVolume`) as { dims, affine, data }, with the affine,
 * translations included, in millimetres whatever unit the header gives. Refuses images that are
 * not 3-D, an unknown spatial unit, and NaN or infinite voxels.
 */
export function mriVolume(parsed, name = 'The MRI') {
  if (parsed.dims.filter((size) => size > 1).length < 3) throw new Error(`${name} is not a 3D volume.`);
  const unit = parsed.header.xyztUnits & 7;
  const scale = SPATIAL_UNIT_MM[unit];
  if (!scale) throw new Error(`${name} gives its spatial unit as code ${unit}, not metres, millimetres or micrometres.`);
  const data = parsed.imageData;
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) throw new Error(`${name} has NaN or infinite voxels; replace them (for example with 0) and load it again.`);
  }
  const affine = Array.from(parsed.affine, (row, r) => Array.from(row, (value) => (r < 3 ? value * scale : value)));
  return { dims: parsed.dims, affine, data };
}

function spacingOf(sform) {
  return [0, 1, 2].map((c) => Math.hypot(sform[0][c], sform[1][c], sform[2][c]));
}

function header(dims, sform) {
  const spacing = spacingOf(sform);
  return createNiftiHeaderFromVolume({
    hdr: {
      dims: [dims.length > 3 ? dims.length : 3, ...dims, ...Array(7 - dims.length).fill(1)],
      pixDims: [1, ...spacing, 1, 1, 1, 1],
      affine: sform,
    },
  });
}

function sformOnly(buffer) {
  const view = new DataView(buffer);
  view.setInt16(252, 0, true);
  view.setInt16(254, 2, true);
  return new Uint8Array(buffer);
}

/** A scalar 3-D image (`dims` [nx, ny, nz]) with voxel-to-RAS `sform`. */
export function scalarNifti(data, dims, sform) {
  return sformOnly(createNiftiFromData(data, header(dims, sform), { range: 'auto', clampCalMax: false }));
}

/** An RGBA32 image (NIfTI datatype 2304): four bytes per voxel, alpha 0 where nothing is drawn. */
export function rgbaNifti(rgba, dims, sform) {
  const voxels = dims[0] * dims[1] * dims[2];
  if (rgba.length !== voxels * 4) throw new Error('RGBA data do not match the image size.');
  const head = new Uint8Array(header(dims, sform));
  const out = new Uint8Array(352 + rgba.length);
  out.set(head.subarray(0, 352));
  const view = new DataView(out.buffer);
  view.setInt16(70, 2304, true);
  view.setInt16(72, 32, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setFloat32(116, 0, true);
  view.setFloat32(124, 0, true);
  view.setFloat32(128, 0, true);
  out.set(rgba, 352);
  return sformOnly(out.buffer);
}

/** Greedy's displacement field: its header and float32 components (x, y, z planes, LPS mm). */
export function readWarp(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const head = parseNiftiHeader(buffer);
  if (head.dims[5] !== 3 || head.datatype !== 16) throw new Error('Expected a float32 Greedy displacement field.');
  const voxels = head.dims[1] * head.dims[2] * head.dims[3];
  const data = new Float32Array(buffer, Math.ceil(head.voxOffset), voxels * 3);
  return { dims: [head.dims[1], head.dims[2], head.dims[3]], voxels, data: Float32Array.from(data), header: head };
}

/** A displacement field in Greedy's layout (5-D, vector intent, LPS components) on `sform`'s grid. */
export function warpNifti(components, dims, sform) {
  const voxels = dims[0] * dims[1] * dims[2];
  const head = new Uint8Array(header([...dims, 1, 3], sform));
  const out = new Uint8Array(352 + voxels * 12);
  out.set(head.subarray(0, 352));
  const view = new DataView(out.buffer);
  view.setInt16(40, 5, true);
  view.setInt16(48, 1, true);
  view.setInt16(50, 3, true);
  view.setInt16(68, 1007, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  view.setFloat32(108, 352, true);
  new Float32Array(out.buffer, 352, voxels * 3).set(components);
  return sformOnly(out.buffer);
}
