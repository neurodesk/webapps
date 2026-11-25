// NIfTI-1 and NIfTI-2 images for Greedy and for download.
// Preserves source MRI NIfTI version, qform, sform, pixdim and xyzt_units verbatim when supplied,
// and automatically emits NIfTI-2 whenever a dimension exceeds 32767, the source header is NIfTI-2,
// or any pixdim/norm/transform entry overflows IEEE-754 float32.
import { createNiftiFromData, createNiftiHeaderFromVolume, parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';

// NIfTI xyzt_units spatial codes in millimetres; 0 (unknown) is read as millimetres.
const SPATIAL_UNIT_MM = { 0: 1, 1: 1000, 2: 1, 3: 0.001 };
const MAX_NIFTI1_DIM = 32767;
const NIFTI1_MAGIC = [0x6e, 0x2b, 0x31, 0x00];
const NIFTI2_MAGIC = [0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a];

function fitsFloat32(value) {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function extractSourceHeader(hdr) {
  if (!hdr || typeof hdr !== 'object') return null;
  const hasExplicitTransforms =
    Number.isInteger(hdr.qformCode)
    && Number.isInteger(hdr.sformCode)
    && Array.isArray(hdr.quatern)
    && Array.isArray(hdr.qoffset)
    && Array.isArray(hdr.srow);
  if (!hasExplicitTransforms) return null;
  const pixdimSource = hdr.pixdim ?? hdr.pixDims;
  return {
    niftiVersion: hdr.niftiVersion ?? hdr.version ?? 1,
    xyztUnits: Number.isInteger(hdr.xyztUnits) ? hdr.xyztUnits : 2,
    pixdim: Array.isArray(pixdimSource) ? Array.from({ length: 8 }, (_, i) => Number(pixdimSource[i] ?? 0)) : null,
    qformCode: hdr.qformCode,
    sformCode: hdr.sformCode,
    quatern: hdr.quatern.slice(0, 3).map(Number),
    qoffset: hdr.qoffset.slice(0, 3).map(Number),
    srow: hdr.srow.slice(0, 3).map((row) => row.slice(0, 4).map(Number)),
  };
}

/**
 * The MRI from a parsed NIfTI (`parseNiftiVolume` or `readStrictNiftiVolume`) as
 * `{ dims, affine, data, unitScale, header }`, with the affine (translations included) in
 * millimetres whatever unit the header gives (`unitScale` millimetres per header unit).
 * Preserves verbatim NIfTI-1/2 header geometry when present on `parsed.header`.
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
  const preservedHeader = extractSourceHeader(parsed.header);
  return {
    dims: parsed.dims,
    affine,
    data,
    unitScale: scale,
    ...(preservedHeader ? { header: preservedHeader } : {}),
  };
}

/**
 * The MRI file the viewer shows: `file` when its header is in millimetres, else a float32 copy
 * with the millimetre affine. NiiVue ignores xyzt_units, so a metre or micrometre header would
 * put the outputs, all in millimetres, 1000 times off it.
 */
export function mriViewerFile(file, volume) {
  if (volume.unitScale === 1) return file;
  const stem = file.name.replace(/\.nii(\.gz)?$/i, '');
  return new File([scalarNifti(volume.data, volume.dims, volume.affine)], `${stem}_mm.nii`);
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

/**
 * An RGBA32 image (NIfTI datatype 2304): four bytes per voxel, alpha 0 where nothing is drawn.
 * When `header` (source MRI geometry) is supplied, preserves its NIfTI version, xyzt_units,
 * pixdim, qform and sform verbatim. Automatically writes NIfTI-2 if `header.niftiVersion === 2`,
 * any dimension exceeds 32767, or any pixdim/norm/transform entry overflows float32.
 */
export function rgbaNifti(rgba, dims, sform, { header: sourceHeader = null } = {}) {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((d) => !Number.isSafeInteger(d) || d < 1)) {
    throw new Error('Invalid RGBA NIfTI dimensions.');
  }
  const voxels = dims[0] * dims[1] * dims[2];
  if (rgba.length !== voxels * 4) throw new Error('RGBA data do not match the image size.');

  const spacing = spacingOf(sform);
  const fallbackPixdim = [1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1];
  const pixdim = sourceHeader?.pixdim ? sourceHeader.pixdim.slice(0, 8) : fallbackPixdim;
  const xyztUnits = sourceHeader ? sourceHeader.xyztUnits : 2;
  const qformCode = sourceHeader ? sourceHeader.qformCode : 0;
  const sformCode = sourceHeader ? sourceHeader.sformCode : 2;
  const quatern = sourceHeader ? sourceHeader.quatern.slice(0, 3) : [0, 0, 0];
  const qoffset = sourceHeader ? sourceHeader.qoffset.slice(0, 3) : [0, 0, 0];
  const srow = sourceHeader
    ? sourceHeader.srow.slice(0, 3).map((row) => row.slice(0, 4))
    : [sform[0].slice(0, 4), sform[1].slice(0, 4), sform[2].slice(0, 4)];

  const numericFields = [...pixdim, ...spacing, ...quatern, ...qoffset, ...srow.flat()];
  if (numericFields.some((v) => !Number.isFinite(v))) {
    throw new Error('RGBA NIfTI transform or pixdim contains non-finite values.');
  }
  const overflowsFloat32 = numericFields.some((v) => !fitsFloat32(v));
  const useNifti2 =
    sourceHeader?.niftiVersion === 2
    || dims.some((d) => d > MAX_NIFTI1_DIM)
    || overflowsFloat32;

  if (!useNifti2) {
    const out = new Uint8Array(352 + rgba.length);
    const view = new DataView(out.buffer);
    view.setInt32(0, 348, true);
    view.setInt16(40, 3, true);
    view.setInt16(42, dims[0], true);
    view.setInt16(44, dims[1], true);
    view.setInt16(46, dims[2], true);
    view.setInt16(48, 1, true);
    view.setInt16(50, 1, true);
    view.setInt16(52, 1, true);
    view.setInt16(54, 1, true);
    view.setInt16(70, 2304, true);
    view.setInt16(72, 32, true);
    for (let i = 0; i < 8; i++) view.setFloat32(76 + i * 4, pixdim[i] ?? 0, true);
    view.setFloat32(108, 352, true);
    view.setFloat32(112, 1, true);
    view.setFloat32(116, 0, true);
    view.setUint8(123, xyztUnits & 0xff);
    view.setFloat32(124, 0, true);
    view.setFloat32(128, 0, true);
    view.setInt16(252, qformCode, true);
    view.setInt16(254, sformCode, true);
    for (let i = 0; i < 3; i++) view.setFloat32(256 + i * 4, quatern[i], true);
    for (let i = 0; i < 3; i++) view.setFloat32(268 + i * 4, qoffset[i], true);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) view.setFloat32(280 + (r * 4 + c) * 4, srow[r][c], true);
    }
    out.set(NIFTI1_MAGIC, 344);
    out.set(rgba, 352);
    return out;
  }

  const out = new Uint8Array(544 + rgba.length);
  const view = new DataView(out.buffer);
  view.setInt32(0, 540, true);
  out.set(NIFTI2_MAGIC, 4);
  view.setInt16(12, 2304, true);
  view.setInt16(14, 32, true);
  view.setBigInt64(16, 3n, true);
  view.setBigInt64(24, BigInt(dims[0]), true);
  view.setBigInt64(32, BigInt(dims[1]), true);
  view.setBigInt64(40, BigInt(dims[2]), true);
  for (let i = 4; i < 8; i++) view.setBigInt64(16 + i * 8, 1n, true);
  for (let i = 0; i < 8; i++) view.setFloat64(104 + i * 8, pixdim[i] ?? 0, true);
  view.setBigInt64(168, 544n, true);
  view.setFloat64(176, 1, true);
  view.setFloat64(184, 0, true);
  view.setFloat64(192, 0, true);
  view.setFloat64(200, 0, true);
  view.setInt32(344, qformCode, true);
  view.setInt32(348, sformCode, true);
  for (let i = 0; i < 3; i++) view.setFloat64(352 + i * 8, quatern[i], true);
  for (let i = 0; i < 3; i++) view.setFloat64(376 + i * 8, qoffset[i], true);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) view.setFloat64(400 + (r * 4 + c) * 8, srow[r][c], true);
  }
  view.setInt32(500, xyztUnits, true);
  out.set(rgba, 544);
  return out;
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
