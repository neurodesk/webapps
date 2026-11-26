// Read one microscopy volume, TIFF or NIfTI (NIfTI-1 or NIfTI-2), into
// `{ name, format, dims: [nz, ny, nx], data, spacingUm, spacingSource, niftiHeader, niftiVersion, niftiMeta }`
// with data `[z][y][x]` (x fastest), as the module takes it. DOM-free, so both the web app and
// the portable CLI read the exact same files.
import { readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { decodeNiftiBuffer, isGzipped } from "@neurodesk/webapp-components/file-io";
import { InputTooLargeError, assertInputSize, assertNiftiDecodedSize } from "@neurodesk/webapp-components/file-io/input-limits";
import { checkSquarePixels, createFloat32Nifti2, niftiSpacingUm } from "./format.js";

export { createFloat32Nifti2 };

/** Decoded voxel bytes accepted before refusing a file (512 MiB). */
export const MAX_INPUT_BYTES = 2 ** 29;

/**
 * File bytes allowed beyond the voxels, for page directories, OME-XML and NIfTI headers, so a
 * stack exactly at the voxel limit is not refused for its metadata (64 MiB).
 */
const METADATA_BYTES = 2 ** 26;

const NIFTI_DATATYPES = {
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
const NIFTI2_PAIR_MAGIC = [0x6e, 0x69, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a];
const VELTKAMP_SPLIT = 134217729; // 2^27 + 1

function ascii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function bytesEqualAt(bytes, offset, expected) {
  if (offset + expected.length > bytes.byteLength) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function twoSum(a, b) {
  const s = a + b;
  const v = s - a;
  const e = (a - (s - v)) + (b - v);
  return [s, e];
}

function twoProd(a, b) {
  const p = a * b;
  const ca = VELTKAMP_SPLIT * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = VELTKAMP_SPLIT * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  return [p, e];
}

function growExpansion(expansion, b) {
  const out = [];
  let q = b;
  for (let i = 0; i < expansion.length; i += 1) {
    const [sum, err] = twoSum(q, expansion[i]);
    q = sum;
    if (err !== 0) out.push(err);
  }
  if (q !== 0 || out.length === 0) out.push(q);
  return out;
}

function exactQuaternionW2(b, c, d) {
  const [b2h, b2l] = twoProd(b, b);
  const [c2h, c2l] = twoProd(c, c);
  const [d2h, d2l] = twoProd(d, d);
  let exp = [1];
  for (const term of [-b2h, -b2l, -c2h, -c2l, -d2h, -d2l]) {
    exp = growExpansion(exp, term);
  }
  let sum = 0;
  for (let i = 0; i < exp.length; i += 1) sum += exp[i];
  return sum;
}

function quaternionToAffine(quatern, qoffset, pixDims, isNifti2) {
  const [b, c, d] = quatern;
  if (!Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d) || Math.abs(b) > 2 || Math.abs(c) > 2 || Math.abs(d) > 2) {
    throw new Error("Invalid NIfTI quaternion in qform.");
  }
  // NiBabel 5.3.3 fillpositive two-sided threshold: 3 * eps (float32 for NIfTI-1, float64 for NIfTI-2).
  const absThresh = isNifti2 ? 3 * Number.EPSILON : 3 * (2 ** -23);
  const w2 = exactQuaternionW2(b, c, d);
  let a;
  if (Math.abs(w2) < absThresh) {
    a = 0;
  } else if (w2 < 0) {
    throw new Error("Invalid NIfTI quaternion in qform.");
  } else {
    a = Math.sqrt(w2);
  }
  // NiBabel 5.3.3 quat2mat([a, b, c, d]) normalization by nq = a^2 + b^2 + c^2 + d^2.
  const nq = a * a + b * b + c * c + d * d;
  let r00;
  let r01;
  let r02;
  let r10;
  let r11;
  let r12;
  let r20;
  let r21;
  let r22;
  if (nq < Number.EPSILON) {
    r00 = 1;
    r01 = 0;
    r02 = 0;
    r10 = 0;
    r11 = 1;
    r12 = 0;
    r20 = 0;
    r21 = 0;
    r22 = 1;
  } else {
    const s = 2.0 / nq;
    const x = b * s;
    const y = c * s;
    const z = d * s;
    const wx = a * x;
    const wy = a * y;
    const wz = a * z;
    const xx = b * x;
    const xy = b * y;
    const xz = b * z;
    const yy = c * y;
    const yz = c * z;
    const zz = d * z;
    r00 = 1.0 - (yy + zz);
    r01 = xy - wz;
    r02 = xz + wy;
    r10 = xy + wz;
    r11 = 1.0 - (xx + zz);
    r12 = yz - wx;
    r20 = xz - wy;
    r21 = yz + wx;
    r22 = 1.0 - (xx + yy);
  }
  const qfac = pixDims[0] < 0 ? -1 : 1;
  const sx = Math.abs(pixDims[1]) || 1;
  const sy = Math.abs(pixDims[2]) || 1;
  const sz = (Math.abs(pixDims[3]) || 1) * qfac;
  return [
    new Float64Array([r00 * sx, r01 * sy, r02 * sz, qoffset[0]]),
    new Float64Array([r10 * sx, r11 * sy, r12 * sz, qoffset[1]]),
    new Float64Array([r20 * sx, r21 * sy, r22 * sz, qoffset[2]]),
    new Float64Array([0, 0, 0, 1]),
  ];
}

/**
 * Parses a NIfTI-1 (sizeof_hdr === 348) or NIfTI-2 (sizeof_hdr === 540) header and computes
 * the affine following NiBabel's precedence (`sform > qform > LAS-centered fallback`).
 */
export function parseNiftiAnyHeader(headerBuffer) {
  const bytes = headerBuffer instanceof Uint8Array
    ? headerBuffer
    : ArrayBuffer.isView(headerBuffer)
      ? new Uint8Array(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength)
      : new Uint8Array(headerBuffer);
  if (bytes.byteLength < 348) throw new Error("Input must be a NIfTI-1 or NIfTI-2 image.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hdrLe = view.getInt32(0, true);
  const hdrBe = view.getInt32(0, false);

  let niftiVersion;
  let littleEndian;
  if (hdrLe === 348 || hdrBe === 348) {
    niftiVersion = 1;
    littleEndian = hdrLe === 348;
  } else if (hdrLe === 540 || hdrBe === 540) {
    if (bytes.byteLength < 540) throw new Error("The NIfTI-2 header is truncated.");
    niftiVersion = 2;
    littleEndian = hdrLe === 540;
  } else {
    throw new Error("Input must be a NIfTI-1 or NIfTI-2 image.");
  }

  let dims;
  let pixDims;
  let datatype;
  let voxOffset;
  let rawSlope;
  let rawInter;
  let xyztUnits;
  let qformCode;
  let sformCode;
  let quatern;
  let qoffset;
  let srow;

  if (niftiVersion === 1) {
    const magic = ascii(bytes, 344, 4);
    if (magic === "ni1\0") throw new Error("Two-file .hdr/.img pairs are not supported. Use a single-file .nii or .nii.gz image.");
    if (magic !== "n+1\0") throw new Error("Input must be a NIfTI-1 or NIfTI-2 image.");
    dims = Array.from({ length: 8 }, (_, i) => view.getInt16(40 + i * 2, littleEndian));
    datatype = view.getInt16(70, littleEndian);
    pixDims = Array.from({ length: 8 }, (_, i) => view.getFloat32(76 + i * 4, littleEndian));
    const rawOffset = view.getFloat32(108, littleEndian);
    if (!Number.isFinite(rawOffset) || rawOffset < 352) {
      throw new Error(`Invalid NIfTI-1 vox_offset (${rawOffset}): single-file NIfTI-1 requires vox_offset >= 352.`);
    }
    voxOffset = Math.ceil(rawOffset);
    rawSlope = view.getFloat32(112, littleEndian);
    rawInter = view.getFloat32(116, littleEndian);
    xyztUnits = view.getUint8(123);
    qformCode = view.getInt16(252, littleEndian);
    sformCode = view.getInt16(254, littleEndian);
    quatern = [view.getFloat32(256, littleEndian), view.getFloat32(260, littleEndian), view.getFloat32(264, littleEndian)];
    qoffset = [view.getFloat32(268, littleEndian), view.getFloat32(272, littleEndian), view.getFloat32(276, littleEndian)];
    srow = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => view.getFloat32(280 + (r * 4 + c) * 4, littleEndian)));
  } else {
    if (bytesEqualAt(bytes, 4, NIFTI2_PAIR_MAGIC)) {
      throw new Error("Two-file .hdr/.img pairs are not supported. Use a single-file .nii or .nii.gz image.");
    }
    if (!bytesEqualAt(bytes, 4, NIFTI2_MAGIC)) {
      throw new Error("Input must be a NIfTI-1 or NIfTI-2 image.");
    }
    datatype = view.getInt16(12, littleEndian);
    dims = Array.from({ length: 8 }, (_, i) => {
      const value = Number(view.getBigInt64(16 + i * 8, littleEndian));
      if (!Number.isSafeInteger(value)) throw new Error("Unsupported NIfTI-2 image dimensions.");
      return value;
    });
    pixDims = Array.from({ length: 8 }, (_, i) => view.getFloat64(104 + i * 8, littleEndian));
    const rawOffset = Number(view.getBigInt64(168, littleEndian));
    if (!Number.isSafeInteger(rawOffset) || rawOffset < 544) {
      throw new Error(`Invalid NIfTI-2 vox_offset (${rawOffset}): single-file NIfTI-2 requires vox_offset >= 544.`);
    }
    voxOffset = rawOffset;
    rawSlope = view.getFloat64(176, littleEndian);
    rawInter = view.getFloat64(184, littleEndian);
    qformCode = view.getInt32(344, littleEndian);
    sformCode = view.getInt32(348, littleEndian);
    quatern = [view.getFloat64(352, littleEndian), view.getFloat64(360, littleEndian), view.getFloat64(368, littleEndian)];
    qoffset = [view.getFloat64(376, littleEndian), view.getFloat64(384, littleEndian), view.getFloat64(392, littleEndian)];
    srow = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => view.getFloat64(400 + (r * 4 + c) * 8, littleEndian)));
    xyztUnits = view.getInt32(500, littleEndian);
  }

  let affine;
  if (sformCode > 0) {
    affine = [
      new Float64Array(srow[0]),
      new Float64Array(srow[1]),
      new Float64Array(srow[2]),
      new Float64Array([0, 0, 0, 1]),
    ];
  } else if (qformCode > 0) {
    affine = quaternionToAffine(quatern, qoffset, pixDims, niftiVersion === 2);
  } else {
    const dx = Math.abs(pixDims[1]) || 1;
    const dy = Math.abs(pixDims[2]) || 1;
    const dz = Math.abs(pixDims[3]) || 1;
    const nx = Math.max(1, dims[1]);
    const ny = Math.max(1, dims[2]);
    const nz = Math.max(1, dims[3]);
    affine = [
      new Float64Array([-dx, 0, 0, ((nx - 1) / 2) * dx]),
      new Float64Array([0, dy, 0, -((ny - 1) / 2) * dy]),
      new Float64Array([0, 0, dz, -((nz - 1) / 2) * dz]),
      new Float64Array([0, 0, 0, 1]),
    ];
  }

  const activeSlope = Number.isFinite(rawSlope) && rawSlope !== 0;
  return {
    niftiVersion,
    littleEndian,
    dims,
    nx: dims[1],
    ny: dims[2],
    nz: dims[3],
    pixDims,
    voxelSize: [Math.abs(pixDims[1]) || 1, Math.abs(pixDims[2]) || 1, Math.abs(pixDims[3]) || 1],
    datatype,
    voxOffset,
    sclSlope: activeSlope ? rawSlope : 1,
    sclInter: activeSlope && Number.isFinite(rawInter) ? rawInter : 0,
    xyztUnits,
    qformCode,
    sformCode,
    quatern,
    qoffset,
    srow,
    affine,
  };
}

export function formatOf(name) {
  if (/\.(ome\.)?tiff?$/i.test(name)) return "tiff";
  if (/\.nii(\.gz)?$/i.test(name)) return "nifti";
  return null;
}

export function checkZStack({ pages, metadata }, name) {
  if (metadata.sizeC > 1) throw new Error(`${name} has ${metadata.sizeC} channels; save the channel to deconvolve as its own stack.`);
  if (metadata.unlabelledStack) return;
  if (metadata.sizeT > 1) throw new Error(`${name} has ${metadata.sizeT} time points; save one time point as its own stack.`);
  if (metadata.sizeZ !== pages) throw new Error(`${name} declares ${metadata.sizeZ} z planes but holds ${pages} pages; save the stack again.`);
}

/** NiBabel affine precedence (`sform > qform > LAS-centered fallback`) for NIfTI-1 and NIfTI-2. */
export function niftiAffine(headerBuffer) {
  return parseNiftiAnyHeader(headerBuffer).affine;
}

function assertFiniteFloat32(data, name) {
  for (let i = 0; i < data.length; i += 1) {
    if (!Number.isFinite(data[i])) {
      throw new Error(`${name} has non-finite values (NaN or infinity) in float32.`);
    }
  }
}

const SPACING_SOURCE = { ome: "OME-XML", imagej: "ImageJ" };

/**
 * `maxBytes` limits the decoded voxels (the Float32 array for NIfTI, checked from the header
 * before inflating), `maxFileBytes` the file and a NIfTI's inflated bytes.
 * Callers in Node may pass `gunzip` (e.g. bounded native `gunzipSync` with CRC32 validation).
 */
export async function readVolume(file, { signal, maxBytes = MAX_INPUT_BYTES, maxFileBytes = maxBytes + METADATA_BYTES, gunzip } = {}) {
  const format = formatOf(file.name);
  if (!format) throw new Error(`${file.name} is not a TIFF or NIfTI file.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  signal?.throwIfAborted();
  assertInputSize([file], maxFileBytes);
  if (format === "nifti" && !gunzip) {
    // Only use NIfTI-1 browser preflight if header is NIfTI-1; NIfTI-2 falls through to decode.
    try {
      await assertNiftiDecodedSize(file, maxBytes);
    } catch (error) {
      if (error instanceof InputTooLargeError) throw error;
    }
    signal?.throwIfAborted();
  }
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (format === "tiff") {
    const stack = await readTiffStack(bytes, { maxBytes, signal, Type: Float32Array });
    checkZStack(stack, file.name);
    const spacingUm = stack.metadata.pixelSize;
    checkSquarePixels(spacingUm, file.name);
    return {
      name: file.name,
      format,
      dims: [stack.pages, stack.height, stack.width],
      data: stack.data,
      spacingUm,
      spacingSource: Object.values(spacingUm).some(Boolean) ? SPACING_SOURCE[stack.metadata.kind] : null,
      niftiHeader: null,
    };
  }
  let buffer;
  if (gunzip && isGzipped(bytes)) {
    buffer = gunzip(new Uint8Array(bytes), maxFileBytes, file.name);
  } else {
    buffer = await decodeNiftiBuffer(bytes, { maxBytes: maxFileBytes + 1 });
  }
  signal?.throwIfAborted();
  if (buffer.byteLength > maxFileBytes) throw new InputTooLargeError(buffer.byteLength, maxFileBytes, { subject: "Decompressed NIfTI" });

  const header = parseNiftiAnyHeader(buffer);
  const rank = header.dims[0];
  if (rank < 2 || rank > 7) throw new Error(`${file.name}: unsupported NIfTI dimensionality (${rank}).`);
  let frames = 1;
  for (let d = 4; d <= rank; d += 1) frames *= Math.max(1, header.dims[d]);
  if (frames !== 1) throw new Error(`${file.name} has ${frames} volumes; choose a single 3D stack.`);
  const nx = Math.max(1, header.nx);
  const ny = Math.max(1, header.ny);
  const nz = Math.max(1, header.nz);
  const totalVoxels = nx * ny * nz;
  if (!Number.isSafeInteger(totalVoxels) || totalVoxels < 1) throw new Error(`${file.name}: invalid NIfTI dimensions.`);
  const decodedBytes = totalVoxels * Float32Array.BYTES_PER_ELEMENT;
  if (decodedBytes > maxBytes) throw new InputTooLargeError(decodedBytes, maxBytes, { subject: file.name });

  const type = NIFTI_DATATYPES[header.datatype];
  if (!type) throw new Error(`${file.name}: unsupported NIfTI datatype ${header.datatype}.`);
  const minOffset = header.niftiVersion === 2 ? 544 : 352;
  const start = Math.ceil(header.voxOffset);
  if (!Number.isSafeInteger(start) || start < minOffset || start + totalVoxels * type.bytes > buffer.byteLength) {
    throw new Error(`${file.name}: NIfTI voxel data is truncated.`);
  }

  const data = new Float32Array(totalVoxels);
  const view = new DataView(buffer, start, totalVoxels * type.bytes);
  for (let i = 0; i < totalVoxels; i += 1) {
    data[i] = type.read(view, i * type.bytes, header.littleEndian) * header.sclSlope + header.sclInter;
  }
  // Check finiteness after Float32Array narrowing (catches float64 values that overflow float32).
  assertFiniteFloat32(data, file.name);

  const spacingUm = niftiSpacingUm(header);
  checkSquarePixels(spacingUm, file.name);
  return {
    name: file.name,
    format,
    dims: [nz, ny, nx],
    data,
    spacingUm,
    spacingSource: "NIfTI header",
    niftiVersion: header.niftiVersion,
    niftiHeader: header.niftiVersion === 1 ? buffer.slice(0, start) : null,
    niftiMeta: header,
    affine: header.affine,
  };
}
