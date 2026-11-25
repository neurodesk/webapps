// Strict NIfTI-1 / NIfTI-2 reader for Node with bounded native gunzipSync (CRC32 + maxOutputLength),
// exact NiBabel affine precedence (sform > qform > LAS-centered fallback), preservation of both
// qform & sform metadata, and finiteness validation AFTER Float32Array narrowing.
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
});

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("Expected Uint8Array or ArrayBuffer for NIfTI input.");
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

function detectHeaderFormat(view) {
  if (view.byteLength < 348) throw new Error("NIfTI file is too small to contain a valid header.");
  const le = view.getInt32(0, true);
  if (le === 348) return { version: 1, littleEndian: true };
  if (le === 540) return { version: 2, littleEndian: true };
  const be = view.getInt32(0, false);
  if (be === 348) return { version: 1, littleEndian: false };
  if (be === 540) return { version: 2, littleEndian: false };
  throw new Error("Input is not a valid NIfTI-1 or NIfTI-2 file.");
}

/**
 * Parses a raw (uncompressed) NIfTI-1 or NIfTI-2 header, preserving both qform and sform
 * metadata and computing the affine with exact NiBabel precedence:
 *   sform_code > 0  >  qform_code > 0  >  LAS-centered fallback.
 */
export function parseStrictNiftiHeader(input) {
  const bytes = toUint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { version, littleEndian } = detectHeaderFormat(view);

  let dim;
  let pixdim;
  let datatype;
  let bitpix;
  let voxOffset;
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
    voxOffset = view.getFloat32(108, littleEndian);
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
    if (bytes.byteLength < 540) throw new Error("NIfTI-2 file is too small to contain a valid header.");
    datatype = view.getInt16(12, littleEndian);
    bitpix = view.getInt16(14, littleEndian);
    dim = Array.from({ length: 8 }, (_, i) => Number(view.getBigInt64(16 + i * 8, littleEndian)));
    pixdim = Array.from({ length: 8 }, (_, i) => view.getFloat64(104 + i * 8, littleEndian));
    voxOffset = Number(view.getBigInt64(168, littleEndian));
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

  const qformAffine = quaternionToAffine(quatern, qoffset, pixdim);
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
    littleEndian,
    dims: dim,
    pixDims: pixdim,
    datatype,
    bitpix,
    voxOffset: Math.max(version === 2 ? 540 : 348, Math.trunc(voxOffset)),
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
 * exact NiBabel affine precedence, preserved qform & sform, and finiteness validation
 * performed AFTER Float32Array narrowing.
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
  const type = DATATYPES[header.datatype];
  if (!type) {
    throw new Error(`Unsupported NIfTI datatype code ${header.datatype}.`);
  }
  const [nx, ny, nz] = [header.dims[1], header.dims[2], header.dims[3]];
  if (!(nx > 0 && ny > 0 && nz > 0)) {
    throw new Error(`Invalid NIfTI dimensions: ${nx} × ${ny} × ${nz}.`);
  }
  const extraDims = header.dims.slice(4, Math.min(8, header.dims[0] + 1));
  if (extraDims.some((size) => size > 1)) {
    throw new Error(`Expected a 3D MRI volume, but found higher dimensions (${header.dims.slice(1, header.dims[0] + 1).join(" × ")}).`);
  }
  const totalVoxels = nx * ny * nz;
  if (totalVoxels > maxVoxels) {
    throw new Error(`NIfTI volume has ${totalVoxels} voxels, exceeding the ${maxVoxels} voxel limit.`);
  }
  const requiredBytes = header.voxOffset + totalVoxels * type.bytes;
  if (bytes.byteLength < requiredBytes) {
    throw new Error(`NIfTI file is truncated: expected at least ${requiredBytes} bytes, got ${bytes.byteLength}.`);
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
