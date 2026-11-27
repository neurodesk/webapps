// Pure-JS NIfTI-1 encoder matching nibabel Nifti1Image + BrkRaw v0.5.7 nifti resolver
// (src/brkraw/resolver/nifti.py, GPL-3.0-only).

const KIND_TO_NIFTI = Object.freeze({
  uint8: Object.freeze({ code: 2, bitpix: 8, bytes: 1 }),
  int16: Object.freeze({ code: 4, bitpix: 16, bytes: 2 }),
  int32: Object.freeze({ code: 8, bitpix: 32, bytes: 4 }),
  float32: Object.freeze({ code: 16, bitpix: 32, bytes: 4 }),
});

const SLICE_CODES = Object.freeze({
  Sequential: 1,
  Reverse_sequential: 2,
  Interlaced: 3,
  Reverse_interlacesd: 4,
  Angiopraphy: 5,
});

const XYZ_UNIT_CODES = Object.freeze({
  unknown: 0,
  meter: 1,
  mm: 2,
  micron: 3,
});

const T_UNIT_CODES = Object.freeze({
  sec: 8,
  msec: 16,
  usec: 24,
  hz: 32,
  ppm: 40,
  rads: 48,
});

export function sliceCodeFromScheme(scheme) {
  if (!scheme || scheme === 'User_defined_slice_scheme') return 0;
  return SLICE_CODES[scheme] ?? 0;
}

/** Decompose a 4x4 affine into NIfTI-1 qform parameters (pixdim, qfac, quaternion, qoffset). */
export function affineToQform(affine) {
  const m = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]],
  ];
  const sx = Math.hypot(m[0][0], m[1][0], m[2][0]) || 1;
  const sy = Math.hypot(m[0][1], m[1][1], m[2][1]) || 1;
  const sz = Math.hypot(m[0][2], m[1][2], m[2][2]) || 1;

  const r = [
    [m[0][0] / sx, m[0][1] / sy, m[0][2] / sz],
    [m[1][0] / sx, m[1][1] / sy, m[1][2] / sz],
    [m[2][0] / sx, m[2][1] / sy, m[2][2] / sz],
  ];
  const det =
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
    - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
    + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  const qfac = det < 0 ? -1 : 1;
  if (qfac < 0) {
    r[0][2] = -r[0][2];
    r[1][2] = -r[1][2];
    r[2][2] = -r[2][2];
  }

  let a;
  let b;
  let c;
  let d;
  const trace = r[0][0] + r[1][1] + r[2][2] + 1;
  if (trace > 0.5) {
    a = 0.5 * Math.sqrt(trace);
    const s = 0.25 / a;
    b = (r[2][1] - r[1][2]) * s;
    c = (r[0][2] - r[2][0]) * s;
    d = (r[1][0] - r[0][1]) * s;
  } else {
    const xd = 1 + r[0][0] - (r[1][1] + r[2][2]);
    const yd = 1 + r[1][1] - (r[0][0] + r[2][2]);
    const zd = 1 + r[2][2] - (r[0][0] + r[1][1]);
    if (xd > 1) {
      b = 0.5 * Math.sqrt(xd);
      c = (r[0][1] + r[1][0]) / (4 * b);
      d = (r[0][2] + r[2][0]) / (4 * b);
      a = (r[2][1] - r[1][2]) / (4 * b);
    } else if (yd > 1) {
      c = 0.5 * Math.sqrt(yd);
      b = (r[0][1] + r[1][0]) / (4 * c);
      d = (r[1][2] + r[2][1]) / (4 * c);
      a = (r[0][2] - r[2][0]) / (4 * c);
    } else {
      d = 0.5 * Math.sqrt(Math.max(0, zd));
      b = (r[0][2] + r[2][0]) / (4 * d);
      c = (r[1][2] + r[2][1]) / (4 * d);
      a = (r[1][0] - r[0][1]) / (4 * d);
    }
    if (a < 0) {
      b = -b;
      c = -c;
      d = -d;
    }
  }

  return {
    qfac,
    zooms: [sx, sy, sz],
    quatern: [b, c, d],
    qoffset: [affine[0][3], affine[1][3], affine[2][3]],
  };
}

/**
 * Encode a Fortran-ordered typed array + 4x4 affine into an uncompressed little-endian
 * NIfTI-1 (`.nii`) Uint8Array matching nibabel `Nifti1Image` + `brkraw.resolver.nifti`.
 */
export function encodeNifti1({
  data,
  shape,
  kind,
  affine,
  sclSlope = 1.0,
  sclInter = 0.0,
  sliceCode = 0,
  timeStep = null,
  xyzUnits = 'mm',
  tUnits = 'sec',
  descrip = 'Converted with Neurodesk BrkRaw',
}) {
  const typeInfo = KIND_TO_NIFTI[kind];
  if (!typeInfo) throw new Error(`Unsupported NIfTI output kind: ${kind}`);
  if (shape.length < 1 || shape.length > 7) {
    throw new Error(`Unsupported NIfTI dimensionality: ${shape.length}`);
  }

  const headerSize = 352;
  const dataBytes = data.length * typeInfo.bytes;
  const out = new Uint8Array(headerSize + dataBytes);
  const dv = new DataView(out.buffer);

  dv.setInt32(0, 348, true); // sizeof_hdr
  dv.setInt16(40, shape.length, true); // dim[0]
  for (let i = 0; i < 7; i++) {
    dv.setInt16(42 + i * 2, i < shape.length ? shape[i] : 1, true);
  }
  dv.setInt16(70, typeInfo.code, true); // datatype
  dv.setInt16(72, typeInfo.bitpix, true); // bitpix

  const qf = affineToQform(affine);
  dv.setFloat32(76, qf.qfac, true); // pixdim[0]
  dv.setFloat32(80, qf.zooms[0], true); // pixdim[1]
  dv.setFloat32(84, qf.zooms[1], true); // pixdim[2]
  dv.setFloat32(88, qf.zooms[2], true); // pixdim[3]
  dv.setFloat32(92, timeStep !== null && timeStep !== undefined ? timeStep : 1.0, true); // pixdim[4]
  for (let i = 5; i < 8; i++) dv.setFloat32(76 + i * 4, 1.0, true);

  dv.setFloat32(108, headerSize, true); // vox_offset
  dv.setFloat32(112, sclSlope, true); // scl_slope
  dv.setFloat32(116, sclInter, true); // scl_inter
  dv.setUint8(122, sliceCode & 0xff); // slice_code
  dv.setUint8(123, (XYZ_UNIT_CODES[xyzUnits] ?? 2) | (T_UNIT_CODES[tUnits] ?? 8)); // xyzt_units

  for (let i = 0; i < descrip.length && i < 79; i++) {
    out[148 + i] = descrip.charCodeAt(i);
  }

  // Matches nibabel Nifti1Image(dataobj, affine): qform quaternion populated, qform_code=0, sform_code=2.
  dv.setInt16(252, 0, true); // qform_code
  dv.setInt16(254, 2, true); // sform_code
  dv.setFloat32(256, qf.quatern[0], true);
  dv.setFloat32(260, qf.quatern[1], true);
  dv.setFloat32(264, qf.quatern[2], true);
  dv.setFloat32(268, qf.qoffset[0], true);
  dv.setFloat32(272, qf.qoffset[1], true);
  dv.setFloat32(276, qf.qoffset[2], true);

  for (let col = 0; col < 4; col++) {
    dv.setFloat32(280 + col * 4, affine[0][col], true);
    dv.setFloat32(296 + col * 4, affine[1][col], true);
    dv.setFloat32(312 + col * 4, affine[2][col], true);
  }

  // Magic "n+1\0"
  out.set([0x6e, 0x2b, 0x31, 0x00], 344);

  // Write little-endian voxel payload
  if (kind === 'uint8') {
    out.set(data, headerSize);
  } else if (kind === 'int16') {
    for (let i = 0; i < data.length; i++) dv.setInt16(headerSize + i * 2, data[i], true);
  } else if (kind === 'int32') {
    for (let i = 0; i < data.length; i++) dv.setInt32(headerSize + i * 4, data[i], true);
  } else if (kind === 'float32') {
    for (let i = 0; i < data.length; i++) dv.setFloat32(headerSize + i * 4, data[i], true);
  }
  return out;
}
