// Strict NIfTI-1 / NIfTI-2 reader for Node with bounded native gunzipSync (CRC32 + maxOutputLength),
// exact magic/datatype/bitpix/dimension/vox_offset validation, exact NiBabel affine precedence
// (sform > qform > LAS-centered fallback), preservation of both qform & sform metadata, and
// finiteness validation AFTER Float32Array narrowing.
import { gunzipSync } from "node:zlib";

export const DEFAULT_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_VOXELS = 128 * 1024 * 1024;

const DATATYPES = Object.freeze({
  2: { bytes: 1, read: (v, o) => v.getUint8(o) },
  4: { bytes: 2, read: (v, o, le) => v.getInt16(o, le) },
  8: { bytes: 4, read: (v, o, le) => v.getInt32(o, le) },
  16: { bytes: 4, read: (v, o, le) => v.getFloat32(o, le) },
  64: { bytes: 8, read: (v, o, le) => v.getFloat64(o, le) },
  256: { bytes: 1, read: (v, o) => v.getInt8(o) },
  512: { bytes: 2, read: (v, o, le) => v.getUint16(o, le) },
  768: { bytes: 4, read: (v, o, le) => v.getUint32(o, le) },
  1024: { bytes: 8, read: (v, o, le) => Number(v.getBigInt64(o, le)) },
  1280: { bytes: 8, read: (v, o, le) => Number(v.getBigUint64(o, le)) },
});

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("Expected Uint8Array or ArrayBuffer for NIfTI input.");
}

function readAscii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

export function isGzipped(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function decompressIfGzipped(input, { maxOutputLength = DEFAULT_MAX_DECOMPRESSED_BYTES } = {}) {
  const bytes = toUint8Array(input);
  if (!isGzipped(bytes)) return bytes;
  try {
    const out = gunzipSync(bytes, { maxOutputLength });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (error) {
    throw new Error(`Failed to decompress gzipped NIfTI: ${error.message}`, { cause: error });
  }
}

function quaternionToAffine([b, c, d], [qx, qy, qz], pixdim) {
  const aSq = 1 - (b * b + c * c + d * d);
  if (!Number.isFinite(aSq) || aSq < -1e-5) {
    throw new Error("Invalid NIfTI quaternion in qform.");
  }
  const a = aSq > 0 ? Math.sqrt(aSq) : 0;
  const qfac = pixdim[0] < 0 ? -1 : 1;
  const sx = Math.abs(pixdim[1]) || 1;
  const sy = Math.abs(pixdim[2]) || 1;
  const sz = (Math.abs(pixdim[3]) || 1) * qfac;
  const r00 = a * a + b * b - c * c - d * d;
  const r01 = 2 * (b * c - a * d);
  const r02 = 2 * (b * d + a * c);
  const r10 = 2 * (b * c + a * d);
  const r11 = a * a + c * c - b * b - d * d;
  const r12 = 2 * (c * d - a * b);
  const r20 = 2 * (b * d - a * c);
  const r21 = 2 * (c * d + a * b);
  const r22 = a * a + d * d - b * b - c * c;
  return [
    [r00 * sx, r01 * sy, r02 * sz, qx],
    [r10 * sx, r11 * sy, r12 * sz, qy],
    [r20 * sx, r21 * sy, r22 * sz, qz],
    [0, 0, 0, 1],
  ];
}

function detectHeaderFormat(bytes, view) {
  if (bytes.byteLength < 348) throw new Error("NIfTI file is too small to contain a valid header.");
  const le = view.getInt32(0, true);
  const be = view.getInt32(0, false);
  if (le === 348 || be === 348) {
    const magic = readAscii(bytes, 344, 4);
    if (magic === "ni1\0") {
      throw new Error("Two-file NIfTI-1 (.hdr/.img) pairs with magic 'ni1' are not supported; provide a single-file .nii or .nii.gz.");
    }
    if (magic !== "n+1\0") {
      throw new Error("Invalid NIfTI-1 magic bytes: expected single-file 'n+1\\0'.");
    }
    return { version: 1, littleEndian: le === 348, minHeaderSize: 348 };
  }
  if (le === 540 || be === 540) {
    if (bytes.byteLength < 540) throw new Error("NIfTI-2 file is too small to contain a valid header.");
    const magic = readAscii(bytes, 4, 4);
    if (magic === "ni2\0") {
      throw new Error("Two-file NIfTI-2 (.hdr/.img) pairs with magic 'ni2' are not supported; provide a single-file .nii or .nii.gz.");
    }
    if (magic !== "n+2\0") {
      throw new Error("Invalid NIfTI-2 magic bytes: expected single-file 'n+2\\0'.");
    }
    return { version: 2, littleEndian: le === 540, minHeaderSize: 540 };
  }
  throw new Error("Input is not a valid NIfTI-1 or NIfTI-2 file.");
}

/**
 * Parses a raw (uncompressed) NIfTI-1 or NIfTI-2 header with strict magic, datatype, bitpix,
 * dimension, and vox_offset validation. Preserves both qform and sform metadata and computes
 * the affine with exact NiBabel precedence:
 *   sform_code > 0  >  qform_code > 0  >  LAS-centered fallback.
 */
export function parseStrictNiftiHeader(input) {
  const bytes = toUint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { version, littleEndian, minHeaderSize } = detectHeaderFormat(bytes, view);

  let dim;
  let pixdim;
  let datatype;
  let bitpix;
  let rawVoxOffset;
  let sclSlope;
  let sclInter;
  let qformCode;
  let sformCode;
  let quatern;
  let qoffset;
  let srow;
  let xyztUnits;

  if (version === 1) {
    dim = Array.from({ length: 8 }, (_, i) => view.getInt16(40 + i * 2, littleEndian));
    datatype = view.getInt16(70, littleEndian);
    bitpix = view.getInt16(72, littleEndian);
    pixdim = Array.from({ length: 8 }, (_, i) => view.getFloat32(76 + i * 4, littleEndian));
    rawVoxOffset = view.getFloat32(108, littleEndian);
    sclSlope = view.getFloat32(112, littleEndian);
    sclInter = view.getFloat32(116, littleEndian);
    xyztUnits = view.getUint8(123);
    qformCode = view.getInt16(252, littleEndian);
    sformCode = view.getInt16(254, littleEndian);
    quatern = [view.getFloat32(256, littleEndian), view.getFloat32(260, littleEndian), view.getFloat32(264, littleEndian)];
    qoffset = [view.getFloat32(268, littleEndian), view.getFloat32(272, littleEndian), view.getFloat32(276, littleEndian)];
    srow = [
      Array.from({ length: 4 }, (_, i) => view.getFloat32(280 + i * 4, littleEndian)),
      Array.from({ length: 4 }, (_, i) => view.getFloat32(296 + i * 4, littleEndian)),
      Array.from({ length: 4 }, (_, i) => view.getFloat32(312 + i * 4, littleEndian)),
    ];
  } else {
    datatype = view.getInt16(12, littleEndian);
    bitpix = view.getInt16(14, littleEndian);
    dim = Array.from({ length: 8 }, (_, i) => {
      const value = Number(view.getBigInt64(16 + i * 8, littleEndian));
      if (!Number.isSafeInteger(value)) throw new Error("NIfTI-2 dimension exceeds safe integer range.");
      return value;
    });
    pixdim = Array.from({ length: 8 }, (_, i) => view.getFloat64(104 + i * 8, littleEndian));
    rawVoxOffset = Number(view.getBigInt64(168, littleEndian));
    if (!Number.isSafeInteger(rawVoxOffset)) throw new Error("NIfTI-2 vox_offset exceeds safe integer range.");
    sclSlope = view.getFloat64(176, littleEndian);
    sclInter = view.getFloat64(184, littleEndian);
    qformCode = view.getInt32(344, littleEndian);
    sformCode = view.getInt32(348, littleEndian);
    quatern = [view.getFloat64(352, littleEndian), view.getFloat64(360, littleEndian), view.getFloat64(368, littleEndian)];
    qoffset = [view.getFloat64(376, littleEndian), view.getFloat64(384, littleEndian), view.getFloat64(392, littleEndian)];
    srow = [
      Array.from({ length: 4 }, (_, i) => view.getFloat64(400 + i * 8, littleEndian)),
      Array.from({ length: 4 }, (_, i) => view.getFloat64(432 + i * 8, littleEndian)),
      Array.from({ length: 4 }, (_, i) => view.getFloat64(464 + i * 8, littleEndian)),
    ];
    xyztUnits = view.getInt32(500, littleEndian);
  }

  // Strict vox_offset check: finite integer >= minHeaderSize (rejects NaN, negative, fractional, or < header size)
  if (!Number.isFinite(rawVoxOffset) || !Number.isInteger(rawVoxOffset) || rawVoxOffset < minHeaderSize) {
    throw new Error(`Invalid NIfTI vox_offset (${rawVoxOffset}): must be a finite integer >= ${minHeaderSize}.`);
  }

  // Validate ndim and active dimensions
  const ndim = dim[0];
  if (!Number.isInteger(ndim) || ndim < 1 || ndim > 7) {
    throw new Error(`Invalid NIfTI dimensionality dim[0] = ${ndim}.`);
  }
  for (let axis = 1; axis <= ndim; axis++) {
    if (!Number.isSafeInteger(dim[axis]) || dim[axis] < 1) {
      throw new Error(`Invalid NIfTI dimension dim[${axis}] = ${dim[axis]}.`);
    }
  }

  // Strict datatype + bitpix agreement check
  if (Object.hasOwn(DATATYPES, datatype)) {
    const expectedBitpix = DATATYPES[datatype].bytes * 8;
    if (bitpix !== expectedBitpix) {
      throw new Error(`NIfTI header bitpix (${bitpix}) does not match datatype ${datatype} (expected ${expectedBitpix}).`);
    }
  } else if (datatype === 2304) {
    if (bitpix !== 32) {
      throw new Error(`NIfTI header bitpix (${bitpix}) does not match RGBA32 datatype 2304 (expected 32).`);
    }
  }

  const qformAffine = qformCode > 0 ? quaternionToAffine(quatern, qoffset, pixdim) : null;
  const sformAffine = [srow[0].slice(), srow[1].slice(), srow[2].slice(), [0, 0, 0, 1]];

  // Exact NiBabel affine precedence: sform_code > 0 wins over qform_code > 0, else LAS-centered fallback.
  let affine;
  if (sformCode > 0) {
    affine = sformAffine;
  } else if (qformCode > 0) {
    affine = qformAffine;
  } else {
    const sx = Math.abs(pixdim[1]) || 1;
    const sy = Math.abs(pixdim[2]) || 1;
    const sz = Math.abs(pixdim[3]) || 1;
    const cx = (dim[1] - 1) / 2;
    const cy = (dim[2] - 1) / 2;
    const cz = (dim[3] - 1) / 2;
    affine = [
      [-sx, 0, 0, sx * cx],
      [0, sy, 0, -sy * cy],
      [0, 0, sz, -sz * cz],
      [0, 0, 0, 1],
    ];
  }

  return {
    version,
    niftiVersion: version,
    littleEndian,
    dims: dim,
    pixDims: pixdim,
    pixdim: pixdim.slice(0, 8),
    datatype,
    bitpix,
    voxOffset: rawVoxOffset,
    sclSlope: Number.isFinite(sclSlope) && sclSlope !== 0 ? sclSlope : 1,
    sclInter: Number.isFinite(sclSlope) && sclSlope !== 0 && Number.isFinite(sclInter) ? sclInter : 0,
    qformCode,
    sformCode,
    quatern,
    qoffset,
    srow,
    qformAffine,
    sformAffine,
    xyztUnits,
    affine,
  };
}

/**
 * Reads a NIfTI (.nii or .nii.gz) volume into Float32Array with bounded decompression,
 * strict header validation, exact NiBabel affine precedence, preserved qform & sform,
 * and finiteness validation performed AFTER Float32Array narrowing.
 */
export function readStrictNiftiVolume(
  input,
  {
    maxDecompressedBytes = DEFAULT_MAX_DECOMPRESSED_BYTES,
    maxVoxels = DEFAULT_MAX_VOXELS,
  } = {},
) {
  const bytes = decompressIfGzipped(input, { maxOutputLength: maxDecompressedBytes });
  const header = parseStrictNiftiHeader(bytes);
  if (!Object.hasOwn(DATATYPES, header.datatype)) {
    throw new Error(`Unsupported NIfTI datatype code ${header.datatype}.`);
  }
  const type = DATATYPES[header.datatype];
  if (header.bitpix !== type.bytes * 8) {
    throw new Error(`NIfTI header bitpix (${header.bitpix}) does not match datatype ${header.datatype} (expected ${type.bytes * 8}).`);
  }
  const ndim = header.dims[0];
  if (ndim < 3) {
    throw new Error(`Expected a 3D MRI volume, but found ${ndim}D NIfTI header.`);
  }
  const [nx, ny, nz] = [header.dims[1], header.dims[2], header.dims[3]];
  if (!(nx > 0 && ny > 0 && nz > 0)) {
    throw new Error(`Invalid NIfTI dimensions: ${nx} × ${ny} × ${nz}.`);
  }
  const extraDims = header.dims.slice(4, Math.min(8, ndim + 1));
  if (extraDims.some((size) => size > 1)) {
    throw new Error(`Expected a 3D MRI volume, but found higher dimensions (${header.dims.slice(1, ndim + 1).join(" × ")}).`);
  }
  const totalVoxels = nx * ny * nz;
  if (!Number.isSafeInteger(totalVoxels) || totalVoxels > maxVoxels) {
    throw new Error(`NIfTI volume has ${totalVoxels} voxels, exceeding the ${maxVoxels} voxel limit.`);
  }
  const requiredBytes = header.voxOffset + totalVoxels * type.bytes;
  if (bytes.byteLength < requiredBytes) {
    throw new Error(`NIfTI file is truncated: expected at least ${requiredBytes} bytes, got ${bytes.byteLength}.`);
  }
  if (header.affine.flat().some((value) => !Number.isFinite(value))) {
    throw new Error("The MRI volume affine contains non-finite values.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + header.voxOffset, totalVoxels * type.bytes);
  const imageData = new Float32Array(totalVoxels);
  const slope = header.sclSlope;
  const inter = header.sclInter;
  for (let i = 0; i < totalVoxels; i++) {
    const value = type.read(view, i * type.bytes, header.littleEndian) * slope + inter;
    imageData[i] = value;
    if (!Number.isFinite(imageData[i])) {
      throw new Error("The MRI volume contains non-finite intensities after Float32 conversion. Replace NaN/Infinity/overflowing voxels first.");
    }
  }

  return {
    header,
    dims: [nx, ny, nz],
    affine: header.affine,
    imageData,
  };
}
