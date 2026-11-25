// NIfTI-1 and NIfTI-2 sources. Without intensity scaling the stored samples are written unchanged.
// With scl_slope (not 0 or 1) or scl_inter (not 0), the values are scaled as NIfTI defines them
// (stored × scl_slope + scl_inter) into float32, or float64 for 32-bit integers and float64,
// whose range float32 cannot hold exactly. NIfTI's i, j, k run along x, y, z, x fastest,
// which is the row-major (z, y, x) order of an OME-Zarr plane stack, so no voxel moves.
import { decodeNiftiBuffer } from "@neurodesk/webapp-components/file-io/nifti";
import { assertInputSize, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { ARRAY_TYPES } from "../pyramid.js";
import { niftiUnits } from "../units.js";
import { imageStem, note } from "./source.js";

const TYPES = { 2: "uint8", 4: "int16", 8: "int32", 16: "float32", 64: "float64", 256: "int8", 512: "uint16", 768: "uint32" };

function ascii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function quaternionToAffine(quatern, qoffset, pixDims) {
  const [b, c, d] = quatern;
  const aSq = 1.0 - (b * b + c * c + d * d);
  if (!Number.isFinite(aSq) || aSq < -1e-5) throw new Error("Invalid NIfTI quaternion in qform.");
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
 * its affine following NiBabel's precedence: sform > qform > LAS-centered fallback.
 */
export function parseNiftiAnyHeader(bufferLike) {
  const bytes = bufferLike instanceof Uint8Array
    ? bufferLike
    : ArrayBuffer.isView(bufferLike)
      ? new Uint8Array(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength)
      : new Uint8Array(bufferLike);
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
    voxOffset = rawOffset === 0 ? 352 : Math.ceil(rawOffset);
    rawSlope = view.getFloat32(112, littleEndian);
    rawInter = view.getFloat32(116, littleEndian);
    xyztUnits = view.getUint8(123);
    qformCode = view.getInt16(252, littleEndian);
    sformCode = view.getInt16(254, littleEndian);
    quatern = [view.getFloat32(256, littleEndian), view.getFloat32(260, littleEndian), view.getFloat32(264, littleEndian)];
    qoffset = [view.getFloat32(268, littleEndian), view.getFloat32(272, littleEndian), view.getFloat32(276, littleEndian)];
    srow = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => view.getFloat32(280 + (r * 4 + c) * 4, littleEndian)));
  } else {
    const magic = ascii(bytes, 4, 4);
    if (magic === "ni2\0") throw new Error("Two-file .hdr/.img pairs are not supported. Use a single-file .nii or .nii.gz image.");
    if (magic !== "n+2\0") throw new Error("Input must be a NIfTI-1 or NIfTI-2 image.");
    datatype = view.getInt16(12, littleEndian);
    dims = Array.from({ length: 8 }, (_, i) => {
      const value = Number(view.getBigInt64(16 + i * 8, littleEndian));
      if (!Number.isSafeInteger(value)) throw new Error("Unsupported NIfTI-2 image dimensions.");
      return value;
    });
    pixDims = Array.from({ length: 8 }, (_, i) => view.getFloat64(104 + i * 8, littleEndian));
    const rawOffset = Number(view.getBigInt64(168, littleEndian));
    if (!Number.isSafeInteger(rawOffset)) throw new Error("Invalid NIfTI-2 voxel offset.");
    voxOffset = rawOffset === 0 ? 544 : rawOffset;
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
    affine = quaternionToAffine(quatern, qoffset, pixDims);
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
    datatype,
    voxOffset,
    sclSlope: activeSlope ? rawSlope : 1,
    sclInter: activeSlope && Number.isFinite(rawInter) ? rawInter : 0,
    xyztUnits,
    qformCode,
    sformCode,
    affine,
  };
}

/** The shortest decimal that is the same float32 (0.4, not 0.4000000059604645). */
export function float32Decimal(value) {
  for (let digits = 1; digits <= 9; digits += 1) {
    const decimal = Number(value.toPrecision(digits));
    if (Math.fround(decimal) === value) return decimal;
  }
  return value;
}

/** A .nii or .nii.gz file (Blob or ArrayBuffer with a `name`) as a source. Supports NIfTI-1 and NIfTI-2. */
export async function openNiftiSource(file, { signal } = {}) {
  // NIfTI is read whole, so its size is checked before it is read and while it is inflated.
  if (file instanceof Blob) assertInputSize([file]);
  const bytes = file instanceof Blob ? await file.arrayBuffer() : file;
  signal?.throwIfAborted();
  const buffer = await decodeNiftiBuffer(bytes, { maxBytes: MAX_INPUT_BYTES });
  signal?.throwIfAborted();
  const header = parseNiftiAnyHeader(buffer);
  const dtype = TYPES[header.datatype];
  if (!dtype) throw new Error(`NIfTI datatype ${header.datatype} is not supported; use an integer or float image with one value per voxel.`);
  const rank = header.dims[0];
  if (rank > 4 && header.dims.slice(5, rank + 1).some((size) => size > 1)) throw new Error("NIfTI images with more than four dimensions are not supported.");
  const shape = { t: rank >= 4 ? Math.max(1, header.dims[4]) : 1, c: 1, z: Math.max(1, header.nz), y: Math.max(1, header.ny), x: Math.max(1, header.nx) };
  const ArrayType = ARRAY_TYPES[dtype];
  const bytesPer = ArrayType.BYTES_PER_ELEMENT;
  const planeVoxels = shape.y * shape.x;
  const minOffset = header.niftiVersion === 2 ? 540 : 348;
  const start = Math.ceil(header.voxOffset);
  if (start < minOffset || start + shape.t * shape.z * planeVoxels * bytesPer > buffer.byteLength) {
    throw new Error("The NIfTI file is shorter than its header says.");
  }
  const units = niftiUnits(header.xyztUnits);
  const spacing = (value) => {
    if (!Number.isFinite(value) || value === 0) return null;
    return header.niftiVersion === 2 ? Math.abs(value) : float32Decimal(Math.abs(value));
  };
  const notes = [note("NIfTI orientation dropped", "OME-NGFF 0.4 and 0.5 have no orientation: the NIfTI affine is not carried over; voxels keep their stored order.")];
  const slope = header.sclSlope;
  const intercept = header.sclInter;
  const scaled = slope !== 1 || intercept !== 0;
  const outputType = scaled ? (["int32", "uint32", "float64"].includes(dtype) ? "float64" : "float32") : dtype;
  if (scaled) {
    notes.push(note(`Scaled to ${outputType} (scl_slope)`, `Values are stored × scl_slope ${slope} + scl_inter ${intercept}, written as ${outputType}; the stored ${dtype} samples are not kept.`));
  }
  const scale = { t: shape.t > 1 ? spacing(header.pixDims[4]) : null, z: spacing(header.pixDims[3]), y: spacing(header.pixDims[2]), x: spacing(header.pixDims[1]) };
  const view = new DataView(buffer);
  const storedPlane = (t, z) => {
    const offset = start + (t * shape.z + z) * planeVoxels * bytesPer;
    const plane = new ArrayType(planeVoxels);
    if (header.littleEndian || bytesPer === 1) {
      new Uint8Array(plane.buffer).set(new Uint8Array(buffer, offset, planeVoxels * bytesPer));
      return plane;
    }
    const getter = `get${{ int16: "Int16", uint16: "Uint16", int32: "Int32", uint32: "Uint32", float32: "Float32", float64: "Float64" }[dtype]}`;
    for (let i = 0; i < planeVoxels; i += 1) plane[i] = view[getter](offset + i * bytesPer, false);
    return plane;
  };
  return {
    name: imageStem(file.name ?? "image"),
    stem: imageStem(file.name ?? "image") || "image",
    format: header.niftiVersion === 2 ? "NIfTI-2" : "NIfTI",
    dtype: outputType,
    shape,
    scale,
    units: {
      t: scale.t ? units.time : null,
      z: scale.z ? units.space : null,
      y: scale.y ? units.space : null,
      x: scale.x ? units.space : null,
    },
    channels: [{ label: null, color: null }],
    notes,
    async readPlane(t, _c, z) {
      const stored = storedPlane(t, z);
      if (!scaled) return stored;
      const plane = new ARRAY_TYPES[outputType](planeVoxels);
      for (let i = 0; i < planeVoxels; i += 1) {
        const value = stored[i] * slope + intercept;
        plane[i] = value;
        if (outputType === "float32" && !Number.isFinite(plane[i]) && Number.isFinite(stored[i])) {
          throw new Error(`Scaled NIfTI voxel at index ${i} overflows float32.`);
        }
      }
      return plane;
    },
  };
}
