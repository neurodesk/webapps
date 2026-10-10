// Minimal NIfTI-1 single-file writer for Float32 / Uint8 volumes. Keeps
// just enough of the spec to round-trip back through nifti-reader-js or
// any standard reader (NiiVue, FSL, nibabel). Used by the Phase 4
// orchestrator to wrap the FC weighted-sum output as a downloadable NIfTI.
//
// Reference: NIfTI-1 spec, https://nifti.nimh.nih.gov/nifti-1
// Header is exactly 348 bytes; magic 'n+1' (single-file form) + 4 zero
// bytes immediately after. Data starts at byte offset 352.

const HEADER_SIZE = 348;
const VOX_OFFSET = 352;
const DT_UINT8 = 2;
const DT_FLOAT32 = 16;

function setStr(view, offset, str, maxLen) {
  for (let i = 0; i < maxLen; i++) {
    view.setUint8(offset + i, i < str.length ? str.charCodeAt(i) : 0);
  }
}

// Build a NIfTI-1 ArrayBuffer from a Float32 or Uint8 volume.
//   dims:    [X, Y, Z]
//   spacing: [sx, sy, sz] in mm (defaults [1, 1, 1])
//   affine:  optional 4x4 row-major Float64Array; if omitted, a sform
//            with origin -X/2*sx, -Y/2*sy, -Z/2*sz is written.
//   description: short header string (max 80 chars).
export function writeNifti1(data, { dims, spacing = [1, 1, 1], affine, description = '' } = {}) {
  if (!Array.isArray(dims) || dims.length !== 3) {
    throw new Error('writeNifti1: dims must be [X, Y, Z]');
  }
  const N = dims[0] * dims[1] * dims[2];
  if (data.length !== N) {
    throw new Error(`writeNifti1: data length ${data.length} != ${N}`);
  }
  let datatype, bitpix;
  if (data instanceof Float32Array) {
    datatype = DT_FLOAT32;
    bitpix = 32;
  } else if (data instanceof Uint8Array) {
    datatype = DT_UINT8;
    bitpix = 8;
  } else {
    throw new Error('writeNifti1: data must be Float32Array or Uint8Array');
  }

  const dataBytes = data.byteLength;
  const totalBytes = VOX_OFFSET + dataBytes;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);

  // -- Header --
  view.setInt32(0, HEADER_SIZE, true);              // sizeof_hdr
  // dim[8]: dim[0] = number of dimensions; dim[1..3] = dims; rest 1.
  view.setInt16(40, 3, true);
  view.setInt16(42, dims[0], true);
  view.setInt16(44, dims[1], true);
  view.setInt16(46, dims[2], true);
  view.setInt16(48, 1, true);
  view.setInt16(50, 1, true);
  view.setInt16(52, 1, true);
  view.setInt16(54, 1, true);

  view.setInt16(70, datatype, true);                // datatype
  view.setInt16(72, bitpix, true);                  // bitpix

  // pixdim[8]: pixdim[0] = qfac, [1..3] = voxel sizes mm.
  view.setFloat32(76, 1.0, true);
  view.setFloat32(80, spacing[0], true);
  view.setFloat32(84, spacing[1], true);
  view.setFloat32(88, spacing[2], true);

  view.setFloat32(108, VOX_OFFSET, true);           // vox_offset
  view.setFloat32(112, 1.0, true);                  // scl_slope
  view.setFloat32(116, 0.0, true);                  // scl_inter

  setStr(view, 148, description.slice(0, 80), 80);  // descrip

  // sform / qform: use sform with the supplied affine if available.
  view.setInt16(254, 1, true);                      // qform_code = 1 (scanner)
  view.setInt16(256, 1, true);                      // sform_code = 1
  if (affine && affine.length >= 12) {
    for (let i = 0; i < 4; i++) view.setFloat32(280 + i * 4, affine[0 * 4 + i], true);
    for (let i = 0; i < 4; i++) view.setFloat32(296 + i * 4, affine[1 * 4 + i], true);
    for (let i = 0; i < 4; i++) view.setFloat32(312 + i * 4, affine[2 * 4 + i], true);
  } else {
    // Default sform: spacing along diagonal, origin at the volume centre.
    view.setFloat32(280, spacing[0], true);
    view.setFloat32(284, 0, true);
    view.setFloat32(288, 0, true);
    view.setFloat32(292, -dims[0] * spacing[0] / 2, true);
    view.setFloat32(296, 0, true);
    view.setFloat32(300, spacing[1], true);
    view.setFloat32(304, 0, true);
    view.setFloat32(308, -dims[1] * spacing[1] / 2, true);
    view.setFloat32(312, 0, true);
    view.setFloat32(316, 0, true);
    view.setFloat32(320, spacing[2], true);
    view.setFloat32(324, -dims[2] * spacing[2] / 2, true);
  }

  setStr(view, 344, 'n+1', 4);                      // magic 'n+1\0'

  // -- Data starts at VOX_OFFSET --
  const dest = new Uint8Array(buf, VOX_OFFSET, dataBytes);
  dest.set(new Uint8Array(data.buffer, data.byteOffset, dataBytes));

  return buf;
}
