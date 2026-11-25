// Spec-compliant NIfTI-1 and NIfTI-2 3D scalar reader and uint8 mask writer.
// Follows NiBabel's affine selection precedence (sform > qform > pixdim) and
// preserves both qform and sform transforms verbatim in output masks.

const MAX_NIFTI1_DIM = 32767;

const DATATYPES = {
  2: { read: (v, o) => v.getUint8(o), bytes: 1 },
  4: { read: (v, o, le) => v.getInt16(o, le), bytes: 2 },
  8: { read: (v, o, le) => v.getInt32(o, le), bytes: 4 },
  16: { read: (v, o, le) => v.getFloat32(o, le), bytes: 4 },
  64: { read: (v, o, le) => v.getFloat64(o, le), bytes: 8 },
  256: { read: (v, o) => v.getInt8(o), bytes: 1 },
  512: { read: (v, o, le) => v.getUint16(o, le), bytes: 2 },
  768: { read: (v, o, le) => v.getUint32(o, le), bytes: 4 },
  1024: { read: (v, o, le) => Number(v.getBigInt64(o, le)), bytes: 8 },
  1280: { read: (v, o, le) => Number(v.getBigUint64(o, le)), bytes: 8 },
};

const NIFTI2_MAGIC = [0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a];

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('Expected binary NIfTI data.');
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function determinant3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function quaternionToAffine(quatern, qoffset, pixdim) {
  const [b, c, d] = quatern;
  const aSq = 1.0 - (b * b + c * c + d * d);
  if (!Number.isFinite(aSq) || aSq < -1e-5) {
    throw new Error('Invalid NIfTI quaternion in qform.');
  }
  const a = aSq > 0 ? Math.sqrt(aSq) : 0;
  const r00 = a * a + b * b - c * c - d * d;
  const r01 = 2 * (b * c - a * d);
  const r02 = 2 * (b * d + a * c);
  const r10 = 2 * (b * c + a * d);
  const r11 = a * a + c * c - b * b - d * d;
  const r12 = 2 * (c * d - a * b);
  const r20 = 2 * (b * d - a * c);
  const r21 = 2 * (c * d + a * b);
  const r22 = a * a + d * d - b * b - c * c;
  const qfac = pixdim[0] < 0 ? -1 : 1;
  const sx = pixdim[1];
  const sy = pixdim[2];
  const sz = pixdim[3] * qfac;
  return [
    [r00 * sx, r01 * sy, r02 * sz, qoffset[0]],
    [r10 * sx, r11 * sy, r12 * sz, qoffset[1]],
    [r20 * sx, r21 * sy, r22 * sz, qoffset[2]],
    [0, 0, 0, 1],
  ];
}

export function parseNiftiHeader(input) {
  const bytes = toBytes(input);
  if (bytes.byteLength < 348) throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    throw new Error('Decompress gzipped NIfTI input before parsing.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hdrLe = view.getInt32(0, true);
  const hdrBe = view.getInt32(0, false);

  let niftiVersion;
  let littleEndian;
  if (hdrLe === 348 || hdrBe === 348) {
    niftiVersion = 1;
    littleEndian = hdrLe === 348;
  } else if (hdrLe === 540 || hdrBe === 540) {
    if (bytes.byteLength < 540) throw new Error('The NIfTI-2 header is truncated.');
    niftiVersion = 2;
    littleEndian = hdrLe === 540;
  } else {
    throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
  }

  let dim;
  let pixdim;
  let datatype;
  let voxOffset;
  let sclSlope;
  let sclInter;
  let xyztUnits;
  let qformCode;
  let sformCode;
  let quatern;
  let qoffset;
  let srow;

  if (niftiVersion === 1) {
    const magic = ascii(bytes, 344, 4);
    if (magic === 'ni1\0') throw new Error('Two-file .hdr/.img pairs are not supported. Use a single-file .nii or .nii.gz image.');
    if (magic !== 'n+1\0') throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
    dim = Array.from({ length: 8 }, (_, i) => view.getInt16(40 + i * 2, littleEndian));
    datatype = view.getInt16(70, littleEndian);
    pixdim = Array.from({ length: 8 }, (_, i) => view.getFloat32(76 + i * 4, littleEndian));
    const rawOffset = view.getFloat32(108, littleEndian);
    voxOffset = rawOffset === 0 ? 352 : Math.trunc(rawOffset);
    sclSlope = view.getFloat32(112, littleEndian);
    sclInter = view.getFloat32(116, littleEndian);
    xyztUnits = view.getUint8(123);
    qformCode = view.getInt16(252, littleEndian);
    sformCode = view.getInt16(254, littleEndian);
    quatern = [
      view.getFloat32(256, littleEndian),
      view.getFloat32(260, littleEndian),
      view.getFloat32(264, littleEndian),
    ];
    qoffset = [
      view.getFloat32(268, littleEndian),
      view.getFloat32(272, littleEndian),
      view.getFloat32(276, littleEndian),
    ];
    srow = [0, 1, 2].map((r) =>
      [0, 1, 2, 3].map((c) => view.getFloat32(280 + (r * 4 + c) * 4, littleEndian)),
    );
  } else {
    const magic = ascii(bytes, 4, 4);
    if (magic === 'ni2\0') throw new Error('Two-file .hdr/.img pairs are not supported. Use a single-file .nii or .nii.gz image.');
    if (magic !== 'n+2\0') throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
    datatype = view.getInt16(12, littleEndian);
    dim = Array.from({ length: 8 }, (_, i) => {
      const value = Number(view.getBigInt64(16 + i * 8, littleEndian));
      if (!Number.isSafeInteger(value)) throw new Error('Unsupported image dimensions.');
      return value;
    });
    pixdim = Array.from({ length: 8 }, (_, i) => view.getFloat64(104 + i * 8, littleEndian));
    const rawOffset = Number(view.getBigInt64(168, littleEndian));
    if (!Number.isSafeInteger(rawOffset)) throw new Error('Invalid NIfTI-2 voxel offset.');
    voxOffset = rawOffset === 0 ? 544 : rawOffset;
    sclSlope = view.getFloat64(176, littleEndian);
    sclInter = view.getFloat64(184, littleEndian);
    qformCode = view.getInt32(344, littleEndian);
    sformCode = view.getInt32(348, littleEndian);
    quatern = [
      view.getFloat64(352, littleEndian),
      view.getFloat64(360, littleEndian),
      view.getFloat64(368, littleEndian),
    ];
    qoffset = [
      view.getFloat64(376, littleEndian),
      view.getFloat64(384, littleEndian),
      view.getFloat64(392, littleEndian),
    ];
    srow = [0, 1, 2].map((r) =>
      [0, 1, 2, 3].map((c) => view.getFloat64(400 + (r * 4 + c) * 8, littleEndian)),
    );
    xyztUnits = view.getInt32(500, littleEndian);
  }

  // Exact NiBabel affine precedence: sform_code > 0 wins over qform_code > 0, else pixdim fallback.
  let rawAffine;
  if (sformCode > 0) {
    rawAffine = [srow[0].slice(), srow[1].slice(), srow[2].slice(), [0, 0, 0, 1]];
  } else if (qformCode > 0) {
    rawAffine = quaternionToAffine(quatern, qoffset, pixdim);
  } else {
    rawAffine = [
      [pixdim[1], 0, 0, 0],
      [0, pixdim[2], 0, 0],
      [0, 0, pixdim[3], 0],
      [0, 0, 0, 1],
    ];
  }

  const spatialUnit = xyztUnits & 7;
  const scale = spatialUnit === 1 ? 1000 : spatialUnit === 3 ? 0.001 : 1;
  const affine = rawAffine.map((row, r) => row.map((v) => (r < 3 ? v * scale : v)));

  return {
    niftiVersion,
    littleEndian,
    dim,
    pixdim,
    datatype,
    voxOffset,
    sclSlope,
    sclInter,
    xyztUnits,
    qformCode,
    sformCode,
    quatern,
    qoffset,
    srow,
    affine,
  };
}

export function readNiftiVolume(input, { maxVoxels = 128 * 1024 * 1024 } = {}) {
  const bytes = toBytes(input);
  const header = parseNiftiHeader(bytes);
  const ndim = header.dim[0];
  if (!Number.isInteger(ndim) || ndim < 3 || ndim > 7) {
    throw new Error('Unsupported image dimensions.');
  }
  if (header.dim.slice(4, ndim + 1).some((d) => d > 1)) {
    throw new Error('This operation needs a single 3D image. Extract a volume from this 4D image first.');
  }
  const dims = header.dim.slice(1, 4);
  const totalVoxels = dims[0] * dims[1] * dims[2];
  if (dims.some((d) => !Number.isSafeInteger(d) || d < 2) || !Number.isSafeInteger(totalVoxels) || totalVoxels > maxVoxels) {
    throw new Error('Unsupported image dimensions.');
  }

  if (header.affine.flat().some((v) => !Number.isFinite(v))) {
    throw new Error('Invalid NIfTI affine.');
  }
  if (Math.abs(determinant3(header.affine)) < 1e-12) {
    throw new Error('The image affine is singular.');
  }

  const type = DATATYPES[header.datatype];
  if (!type) {
    throw new Error(`Unsupported NIfTI datatype ${header.datatype}. Use a scalar intensity image.`);
  }
  const minOffset = header.niftiVersion === 2 ? 540 : 348;
  if (!Number.isSafeInteger(header.voxOffset) || header.voxOffset < minOffset) {
    throw new Error('Invalid NIfTI voxel offset.');
  }
  const neededBytes = header.voxOffset + totalVoxels * type.bytes;
  if (neededBytes > bytes.byteLength) {
    throw new Error('The NIfTI voxel data is truncated.');
  }

  const data = new Float32Array(totalVoxels);
  const view = new DataView(bytes.buffer, bytes.byteOffset + header.voxOffset, totalVoxels * type.bytes);
  const hasSlope = Number.isFinite(header.sclSlope) && header.sclSlope !== 0;
  const slope = hasSlope ? header.sclSlope : 1;
  const intercept = hasSlope && Number.isFinite(header.sclInter) ? header.sclInter : 0;

  for (let i = 0; i < totalVoxels; i++) {
    const value = type.read(view, i * type.bytes, header.littleEndian) * slope + intercept;
    if (!Number.isFinite(value)) {
      throw new Error('The image contains non-finite intensities. Clean NaN/Infinity values before segmentation.');
    }
    data[i] = value;
  }

  return {
    data,
    dims,
    affine: header.affine,
    header: {
      niftiVersion: header.niftiVersion,
      xyztUnits: header.xyztUnits,
      pixdim: header.pixdim.slice(0, 8),
      qformCode: header.qformCode,
      sformCode: header.sformCode,
      quatern: header.quatern.slice(),
      qoffset: header.qoffset.slice(),
      srow: header.srow.map((row) => row.slice()),
    },
  };
}

export function writeNiftiUint8({ data, dims, affine, header = null }, description = 'TotalSegmentator multilabel mask') {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((d) => !Number.isSafeInteger(d) || d < 1)) {
    throw new Error('Invalid output volume dimensions.');
  }
  const count = dims[0] * dims[1] * dims[2];
  if (data.length !== count) {
    throw new Error(`Output label length (${data.length}) does not match dimensions (${dims.join('x')}).`);
  }

  const useNifti2 = header?.niftiVersion === 2 || dims.some((d) => d > MAX_NIFTI1_DIM);
  const fallbackPixdim = [
    1,
    Math.hypot(affine[0][0], affine[1][0], affine[2][0]),
    Math.hypot(affine[0][1], affine[1][1], affine[2][1]),
    Math.hypot(affine[0][2], affine[1][2], affine[2][2]),
    0,
    0,
    0,
    0,
  ];
  const pixdim = header?.pixdim ? header.pixdim : fallbackPixdim;
  const xyztUnits = header ? header.xyztUnits : 2;
  const qformCode = header ? header.qformCode : 0;
  const sformCode = header ? header.sformCode : 1;
  const quatern = header ? header.quatern : [0, 0, 0];
  const qoffset = header ? header.qoffset : [0, 0, 0];
  const srow = header ? header.srow : [affine[0], affine[1], affine[2]];
  const descBytes = new TextEncoder().encode(description).slice(0, 79);

  if (!useNifti2) {
    const buffer = new ArrayBuffer(352 + count);
    const v = new DataView(buffer);
    v.setInt32(0, 348, true);
    v.setInt16(40, 3, true);
    for (let a = 0; a < 7; a++) v.setInt16(42 + a * 2, dims[a] || 1, true);
    v.setInt16(70, 2, true);
    v.setInt16(72, 8, true);
    for (let a = 0; a < 8; a++) v.setFloat32(76 + a * 4, pixdim[a] ?? 0, true);
    v.setFloat32(108, 352, true);
    v.setFloat32(112, 1, true);
    v.setFloat32(116, 0, true);
    v.setUint8(123, xyztUnits & 0xff);
    new Uint8Array(buffer, 148, 80).set(descBytes);
    v.setInt16(252, qformCode, true);
    v.setInt16(254, sformCode, true);
    for (let i = 0; i < 3; i++) v.setFloat32(256 + i * 4, quatern[i], true);
    for (let i = 0; i < 3; i++) v.setFloat32(268 + i * 4, qoffset[i], true);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) v.setFloat32(280 + (r * 4 + c) * 4, srow[r][c], true);
    }
    new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0]);
    new Uint8Array(buffer, 352).set(data);
    return buffer;
  }

  const buffer = new ArrayBuffer(544 + count);
  const v = new DataView(buffer);
  v.setInt32(0, 540, true);
  new Uint8Array(buffer, 4, 8).set(NIFTI2_MAGIC);
  v.setInt16(12, 2, true);
  v.setInt16(14, 8, true);
  v.setBigInt64(16, 3n, true);
  for (let a = 0; a < 7; a++) v.setBigInt64(24 + a * 8, BigInt(dims[a] || 1), true);
  for (let a = 0; a < 8; a++) v.setFloat64(104 + a * 8, pixdim[a] ?? 0, true);
  v.setBigInt64(168, 544n, true);
  v.setFloat64(176, 1, true);
  v.setFloat64(184, 0, true);
  new Uint8Array(buffer, 240, 80).set(descBytes);
  v.setInt32(344, qformCode, true);
  v.setInt32(348, sformCode, true);
  for (let i = 0; i < 3; i++) v.setFloat64(352 + i * 8, quatern[i], true);
  for (let i = 0; i < 3; i++) v.setFloat64(376 + i * 8, qoffset[i], true);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) v.setFloat64(400 + (r * 4 + c) * 8, srow[r][c], true);
  }
  v.setInt32(500, xyztUnits, true);
  new Uint8Array(buffer, 544).set(data);
  return buffer;
}
