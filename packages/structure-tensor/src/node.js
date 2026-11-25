// Node command-line interface for @neurodesk/structure-tensor.
// Runs the exact same 2D/3D Gaussian structure-tensor analysis as the Structure Tensor web application,
// using pure-Node TIFF/NIfTI-1/NIfTI-2/PNG/JPEG I/O with atomic output staging and exclusive directory locking.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { crc32, gunzipSync, gzipSync, inflateSync } from "node:zlib";
import {
  createNiftiFromData,
  createRgb24Nifti,
  isGzipped,
} from "@neurodesk/webapp-components/file-io";
import { InputTooLargeError, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import packageJson from "../package.json" with { type: "json" };
import {
  analysisSettings,
  DEFAULT_SETTINGS,
  imageRefusal,
  inputKind,
  outputPlan,
  summary,
  voxelRefusal,
} from "./settings.js";
import { analyse, distributionCsv, nonFiniteRefusal } from "./tensor.js";
import { frameMajor, rasterHeader, readTiff, tiffLayout, writeTiff } from "./tiff.js";

export const MAX_CLI_FILE_BYTES = MAX_INPUT_BYTES;
export const LOCK_NAME = ".neurodesk-cli.lock";

const NIFTI2_MAGIC = [0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a];
const NIFTI2_PAIR_MAGIC = [0x6e, 0x69, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a];
const VELTKAMP_SPLIT = 134217729; // 2^27 + 1
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

export const OPTIONS = Object.freeze({
  sigma: {
    type: "number",
    minimum: 0.5,
    maximum: 20,
    default: DEFAULT_SETTINGS.sigma,
    description: "Gradient scale σ in pixels (Gaussian derivative standard deviation).",
  },
  rho: {
    type: "number",
    minimum: 0.5,
    maximum: 50,
    default: DEFAULT_SETTINGS.rho,
    description: "Window scale ρ in pixels (tensor smoothing Gaussian standard deviation).",
  },
  minCoherency: {
    type: "number",
    flag: "min-coherency",
    minimum: 0,
    maximum: 1,
    default: DEFAULT_SETTINGS.minCoherency,
    description: "Minimum coherency included in the orientation distribution.",
  },
  minEnergy: {
    type: "number",
    flag: "min-energy",
    minimum: 0,
    maximum: 1,
    default: DEFAULT_SETTINGS.minEnergy,
    description: "Minimum fraction of peak energy included in the orientation distribution.",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Offline mode (structure-tensor never uses the network).",
  },
});

const ALLOWED_OPTION_KEYS = new Set([
  "sigma",
  "rho",
  "min-coherency",
  "minCoherency",
  "min-energy",
  "minEnergy",
  "overwrite",
  "offline",
]);

export function optionName(key) {
  return OPTIONS[key]?.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function assertNonEmptyString(raw, flag) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(`--${flag} must be a non-empty string.`);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`--${flag} requires a non-empty value.`);
  return trimmed;
}

export function rejectDisallowedFlags(values, allowed, command) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(key)) {
      throw new Error(`--${key} is not allowed with ${command}.`);
    }
  }
}

function parseBooleanOption(raw, flag) {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new Error(`--${flag} must be a boolean, got ${typeof raw} (${JSON.stringify(raw)}).`);
  }
  return raw;
}

function parseNumeric(raw, flag) {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean" || raw === null) {
    throw new Error(`--${flag} must be a finite number, got ${JSON.stringify(raw)}.`);
  }
  const trimmed = assertNonEmptyString(raw, flag);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`--${flag} must be a finite number, got '${raw}'.`);
  return value;
}

function assertPlainOptions(options, allowedKeys, context = "Options") {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${context} must be a plain object.`);
  }
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${context} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(options)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option '${String(key)}'.`);
    }
  }
  return options;
}

function readAliasedOption(options, primary, alias) {
  const hasPrimary = Object.hasOwn(options, primary) && options[primary] !== undefined;
  const hasAlias = alias && Object.hasOwn(options, alias) && options[alias] !== undefined;
  if (hasPrimary && hasAlias) {
    throw new Error(`Specify either '${primary}' or '${alias}', not both.`);
  }
  if (hasPrimary) return options[primary];
  if (hasAlias) return options[alias];
  return undefined;
}

export function parseCliOptions(values) {
  const opts = assertPlainOptions(values, ALLOWED_OPTION_KEYS, "Options");
  const sigma = parseNumeric(opts.sigma, "sigma");
  const rho = parseNumeric(opts.rho, "rho");
  const minCoherency = parseNumeric(readAliasedOption(opts, "min-coherency", "minCoherency"), "min-coherency");
  const minEnergy = parseNumeric(readAliasedOption(opts, "min-energy", "minEnergy"), "min-energy");
  const settings = analysisSettings({
    ...(sigma !== undefined ? { sigma } : {}),
    ...(rho !== undefined ? { rho } : {}),
    ...(minCoherency !== undefined ? { minCoherency } : {}),
    ...(minEnergy !== undefined ? { minEnergy } : {}),
  });
  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const envOffline = process.env.NEURODESK_OFFLINE === "1";
  if (Object.hasOwn(opts, "offline") && opts.offline !== undefined) {
    const explicit = parseBooleanOption(opts.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
  }
  const offline = envOffline || Boolean(opts.offline);
  return { settings, overwrite, offline };
}

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
  const dx = Math.abs(pixDims[1]) || 1;
  const dy = Math.abs(pixDims[2]) || 1;
  const dz = (Math.abs(pixDims[3]) || 1) * qfac;
  return [
    [r00 * dx, r01 * dy, r02 * dz, qoffset[0]],
    [r10 * dx, r11 * dy, r12 * dz, qoffset[1]],
    [r20 * dx, r21 * dy, r22 * dz, qoffset[2]],
    [0, 0, 0, 1],
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
  if (bytes.byteLength < 348) throw new Error("Invalid NIfTI header (truncated).");
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
    throw new Error("Invalid NIfTI header (sizeof_hdr must be 348 or 540).");
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
    if (magic === "ni1\0") throw new Error("Two-file .hdr/.img pairs are not supported.");
    if (magic !== "n+1\0" && magic !== "\0\0\0\0") throw new Error("Invalid NIfTI-1 magic.");
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
      throw new Error("Two-file .hdr/.img pairs are not supported.");
    }
    if (!bytesEqualAt(bytes, 4, NIFTI2_MAGIC)) {
      throw new Error("Invalid NIfTI-2 magic.");
    }
    datatype = view.getInt16(12, littleEndian);
    dims = Array.from({ length: 8 }, (_, i) => {
      const val = Number(view.getBigInt64(16 + i * 8, littleEndian));
      if (!Number.isSafeInteger(val)) throw new Error("Unsupported NIfTI-2 image dimensions.");
      return val;
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
    affine = [srow[0].slice(), srow[1].slice(), srow[2].slice(), [0, 0, 0, 1]];
  } else if (qformCode > 0) {
    affine = quaternionToAffine(quatern, qoffset, pixDims, niftiVersion === 2);
  } else {
    const nx = Math.max(1, dims[1]);
    const ny = Math.max(1, dims[2]);
    const nz = Math.max(1, dims[3]);
    const dx = Math.abs(pixDims[1]) || 1;
    const dy = Math.abs(pixDims[2]) || 1;
    const dz = Math.abs(pixDims[3]) || 1;
    affine = [
      [-dx, 0, 0, ((nx - 1) / 2) * dx],
      [0, dy, 0, -((ny - 1) / 2) * dy],
      [0, 0, dz, -((nz - 1) / 2) * dz],
      [0, 0, 0, 1],
    ];
  }

  const activeSlope = Number.isFinite(rawSlope) && rawSlope !== 0;
  return {
    niftiVersion,
    littleEndian,
    dims,
    nx: Math.max(1, dims[1]),
    ny: Math.max(1, dims[2]),
    nz: Math.max(1, dims[3]),
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

/**
 * Computes a NIfTI-1 or NIfTI-2 4x4 affine following NiBabel's precedence:
 *   1. sform (when sform_code > 0)
 *   2. qform (when qform_code > 0)
 *   3. LAS-centered fallback
 */
export function extractNibabelAffine(bufferLike) {
  return parseNiftiAnyHeader(bufferLike).affine;
}

function writeNifti2Payload(payloadBytes, meta, { dims, datatype, bitpix }) {
  const buf = new ArrayBuffer(544 + payloadBytes.byteLength);
  const v = new DataView(buf);
  v.setInt32(0, 540, true);
  new Uint8Array(buf, 4, 8).set(NIFTI2_MAGIC);
  v.setInt16(12, datatype, true);
  v.setInt16(14, bitpix, true);
  v.setBigInt64(16, BigInt(dims.length), true);
  for (let i = 0; i < 7; i += 1) v.setBigInt64(24 + i * 8, BigInt(dims[i] ?? 1), true);
  for (let i = 0; i < 8; i += 1) v.setFloat64(104 + i * 8, meta.pixDims[i] ?? 0, true);
  v.setBigInt64(168, 544n, true);
  v.setFloat64(176, 1, true);
  v.setFloat64(184, 0, true);
  v.setInt32(344, meta.qformCode, true);
  v.setInt32(348, meta.sformCode, true);
  for (let i = 0; i < 3; i += 1) v.setFloat64(352 + i * 8, meta.quatern[i], true);
  for (let i = 0; i < 3; i += 1) v.setFloat64(376 + i * 8, meta.qoffset[i], true);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) v.setFloat64(400 + (r * 4 + c) * 8, meta.srow[r][c], true);
  }
  v.setInt32(500, meta.xyztUnits, true);
  new Uint8Array(buf, 544).set(payloadBytes);
  return buf;
}

/** Bounded gzip decompression with CRC32 verification (via native zlib). */
export function boundedGunzip(bytes, maxOutputBytes = MAX_CLI_FILE_BYTES) {
  try {
    return gunzipSync(bytes, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength/i.test(error?.message ?? "")) {
      throw new InputTooLargeError(maxOutputBytes + 1, maxOutputBytes, { subject: "Decompressed input" });
    }
    throw new Error(`Invalid gzip stream: ${error.message}`);
  }
}

/** Converts Float64/Float32 values to Float32Array and rejects any non-finite value AFTER narrowing. */
export function toCheckedFloat32(values, label = "output") {
  const out = values instanceof Float32Array ? values : Float32Array.from(values);
  for (let i = 0; i < out.length; i += 1) {
    if (!Number.isFinite(out[i])) {
      throw new Error(`${label} contains a non-finite float32 value at index ${i}.`);
    }
  }
  return out;
}

async function readBoundedFile(filePath, maxBytes = MAX_CLI_FILE_BYTES) {
  const abs = resolve(filePath);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error(`Input '${filePath}' is not a regular file.`);
  if (info.size === 0) throw new Error(`${basename(abs)} is empty.`);
  if (info.size > maxBytes) {
    throw new InputTooLargeError(info.size, maxBytes, { subject: basename(abs) });
  }
  const handle = await open(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buf, offset, info.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const slice = offset === info.size ? buf : buf.subarray(0, offset);
    return {
      name: basename(abs),
      bytes: slice,
      arrayBuffer: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    };
  } finally {
    await handle.close();
  }
}

function isPngBytes(bytes) {
  return bytes.byteLength >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

const NON_SRGB_PROFILE_RE =
  /\b(p3|display\s*p3|dci[- ]?p3|adobe\s*rgb|adobe\s*1998|prophoto|romm|rec\.?\s*2020|bt\.?\s*2020|wide\s*gamut|cmyk|linear|scrgb|aces|apple\s*rgb|colormatch|eci\s*rgb|smpte)\b/i;
const SRGB_NAME_RE = /\bsrgb\b|srgb2014|iec\s*61966[- ]2[.-]1|srgb\s*iec61966/i;
const MAX_ICC_BYTES = 4 * 1024 * 1024;
const SRGB_CHRM = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
const SRGB_ICC_PRIMARIES = Object.freeze({
  rXYZ: Object.freeze([0.4361, 0.2225, 0.0139]),
  gXYZ: Object.freeze([0.3851, 0.7169, 0.0971]),
  bXYZ: Object.freeze([0.1431, 0.0606, 0.7141]),
});
const ICC_PRIMARY_TOLERANCE = 0.015;
const ICC_TRC_LINEAR_TOLERANCE = 0.003;
const ICC_TRC_SRGB_TOLERANCE = 0.008;

function linearToSrgb(linear) {
  if (linear <= 0) return 0;
  if (linear >= 1) return 1;
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * (linear ** (1 / 2.4)) - 0.055;
}

function srgbToLinear(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

function readUint16BE(view, offset) {
  return (view[offset] << 8) | view[offset + 1];
}

function readUint32BE(view, offset) {
  return (
    ((view[offset] << 24) >>> 0) +
    (view[offset + 1] << 16) +
    (view[offset + 2] << 8) +
    view[offset + 3]
  );
}

function readInt32BE(view, offset) {
  return (
    (view[offset] << 24) |
    (view[offset + 1] << 16) |
    (view[offset + 2] << 8) |
    view[offset + 3]
  );
}

function isValidSrgbTrc(profile, tagOffset, tagSize) {
  if (tagOffset + 12 > profile.length || tagSize < 12) return false;
  const type = ascii(profile, tagOffset, 4);

  if (type === "curv") {
    const count = readUint32BE(profile, tagOffset + 8);
    // Reject identity/linear (count=0) and single pure power-law gamma (count=1, e.g. 2.2).
    if (count < 2) return false;
    const needed = 12 + count * 2;
    if (needed > tagSize || tagOffset + needed > profile.length) return false;
    const denom = count - 1;
    // Validate both stored entries and the linearly interpolated curve (ICC.1:2022 §10.6).
    for (let i = 0; i < count; i += 1) {
      const u = i / denom;
      const val = readUint16BE(profile, tagOffset + 12 + i * 2) / 65535;
      if (Math.abs(val - srgbToLinear(u)) > ICC_TRC_LINEAR_TOLERANCE) return false;
      if (Math.abs(linearToSrgb(val) - u) > ICC_TRC_SRGB_TOLERANCE) return false;
    }
    for (let k = 0; k <= 255; k += 1) {
      const u = k / 255;
      const pos = u * denom;
      const lo = Math.floor(pos);
      const hi = Math.min(denom, lo + 1);
      const frac = pos - lo;
      const v0 = readUint16BE(profile, tagOffset + 12 + lo * 2) / 65535;
      const v1 = readUint16BE(profile, tagOffset + 12 + hi * 2) / 65535;
      const val = v0 + (v1 - v0) * frac;
      if (Math.abs(val - srgbToLinear(u)) > ICC_TRC_LINEAR_TOLERANCE) return false;
      if (Math.abs(linearToSrgb(val) - u) > ICC_TRC_SRGB_TOLERANCE) return false;
    }
    return true;
  }

  if (type === "para") {
    const funcType = readUint16BE(profile, tagOffset + 8);
    if (funcType !== 3 && funcType !== 4) return false;
    const needed = funcType === 3 ? 32 : 40;
    if (needed > tagSize || tagOffset + needed > profile.length) return false;
    const g = readInt32BE(profile, tagOffset + 12) / 65536;
    const a = readInt32BE(profile, tagOffset + 16) / 65536;
    const b = readInt32BE(profile, tagOffset + 20) / 65536;
    const c = readInt32BE(profile, tagOffset + 24) / 65536;
    const d = readInt32BE(profile, tagOffset + 28) / 65536;
    const e = funcType === 4 ? readInt32BE(profile, tagOffset + 32) / 65536 : 0;
    const f = funcType === 4 ? readInt32BE(profile, tagOffset + 36) / 65536 : 0;
    if (
      Math.abs(g - 2.4) > 0.05 ||
      Math.abs(a - 1 / 1.055) > 0.01 ||
      Math.abs(b - 0.055 / 1.055) > 0.01 ||
      Math.abs(c - 1 / 12.92) > 0.01 ||
      Math.abs(d - 0.04045) > 0.01 ||
      Math.abs(e) > 0.002 ||
      Math.abs(f) > 0.002
    ) {
      return false;
    }
    for (let k = 0; k <= 255; k += 1) {
      const u = k / 255;
      const val = u >= d ? ((a * u + b) ** g) + e : c * u + f;
      if (!Number.isFinite(val)) return false;
      if (Math.abs(val - srgbToLinear(u)) > ICC_TRC_LINEAR_TOLERANCE) return false;
      if (Math.abs(linearToSrgb(val) - u) > ICC_TRC_SRGB_TOLERANCE) return false;
    }
    return true;
  }

  return false;
}

function parseIccTags(profile, kind) {
  const tags = {
    description: "",
    rXYZ: null,
    gXYZ: null,
    bXYZ: null,
    rTRC: null,
    gTRC: null,
    bTRC: null,
    kTRC: null,
  };
  if (profile.length < 132) {
    throw new Error(`Embedded ICC profile in ${kind} is truncated or invalid.`);
  }
  const tagCount = readUint32BE(profile, 128);
  if (tagCount > 1024 || 132 + tagCount * 12 > profile.length) {
    throw new Error(`Embedded ICC profile in ${kind} has a truncated or invalid tag table.`);
  }
  for (let i = 0; i < tagCount; i += 1) {
    const entryOffset = 132 + i * 12;
    const sig = ascii(profile, entryOffset, 4);
    const tagOffset = readUint32BE(profile, entryOffset + 4);
    const tagSize = readUint32BE(profile, entryOffset + 8);
    if (tagOffset < 128 || tagSize < 4 || tagOffset + tagSize > profile.length) {
      throw new Error(`Embedded ICC profile in ${kind} has a truncated or out-of-bounds tag '${sig}'.`);
    }
    if (tagSize < 12) continue;

    if (sig === "desc") {
      const type = ascii(profile, tagOffset, 4);
      if (type === "desc") {
        const len = readUint32BE(profile, tagOffset + 8);
        const start = tagOffset + 12;
        const stop = Math.min(profile.length, start + Math.min(len, tagSize - 12));
        tags.description = ascii(profile, start, Math.max(0, stop - start)).replace(/\0+$/, "").trim();
      } else if (type === "mluc" && tagOffset + 28 <= profile.length) {
        const recordCount = readUint32BE(profile, tagOffset + 8);
        if (recordCount >= 1) {
          const strLen = readUint32BE(profile, tagOffset + 20);
          const strOff = readUint32BE(profile, tagOffset + 24);
          const start = tagOffset + strOff;
          const stop = Math.min(profile.length, start + strLen);
          let text = "";
          for (let p = start; p + 1 < stop; p += 2) {
            const code = (profile[p] << 8) | profile[p + 1];
            if (code === 0) break;
            text += String.fromCharCode(code);
          }
          tags.description = text.trim();
        }
      }
    } else if (sig === "rXYZ" || sig === "gXYZ" || sig === "bXYZ") {
      if (tagOffset + 20 <= profile.length && ascii(profile, tagOffset, 4) === "XYZ ") {
        tags[sig] = [
          readInt32BE(profile, tagOffset + 8) / 65536,
          readInt32BE(profile, tagOffset + 12) / 65536,
          readInt32BE(profile, tagOffset + 16) / 65536,
        ];
      }
    } else if (sig === "rTRC" || sig === "gTRC" || sig === "bTRC" || sig === "kTRC") {
      tags[sig] = isValidSrgbTrc(profile, tagOffset, tagSize);
    }
  }
  return tags;
}

function matchesPrimary(actual, expected) {
  if (!actual) return false;
  return (
    Math.abs(actual[0] - expected[0]) <= ICC_PRIMARY_TOLERANCE &&
    Math.abs(actual[1] - expected[1]) <= ICC_PRIMARY_TOLERANCE &&
    Math.abs(actual[2] - expected[2]) <= ICC_PRIMARY_TOLERANCE
  );
}

function validateIccProfile(iccBytes, profileName, kind) {
  const profile = iccBytes instanceof Uint8Array ? iccBytes : new Uint8Array(iccBytes);
  if (profile.length < 132 || ascii(profile, 36, 4) !== "acsp") {
    throw new Error(`Embedded ICC profile in ${kind} is truncated or invalid.`);
  }
  const declaredSize = readUint32BE(profile, 0);
  if (declaredSize < 132 || declaredSize > profile.length) {
    throw new Error(
      `Embedded ICC profile in ${kind} is truncated (header declares ${declaredSize} bytes, got ${profile.length}).`,
    );
  }
  const colorSpace = ascii(profile, 16, 4).trim();
  const tags = parseIccTags(profile, kind);
  const label = tags.description || profileName || colorSpace || "unnamed";

  if (colorSpace !== "RGB" && colorSpace !== "GRAY") {
    throw new Error(`Unsupported non-sRGB ICC color space '${colorSpace}' ('${label}') in ${kind}. Convert to sRGB first.`);
  }
  if (tags.description && NON_SRGB_PROFILE_RE.test(tags.description)) {
    throw new Error(`Unsupported non-sRGB ICC profile '${label}' in ${kind}. Convert to sRGB first.`);
  }

  if (colorSpace === "RGB") {
    const primariesMatch =
      matchesPrimary(tags.rXYZ, SRGB_ICC_PRIMARIES.rXYZ) &&
      matchesPrimary(tags.gXYZ, SRGB_ICC_PRIMARIES.gXYZ) &&
      matchesPrimary(tags.bXYZ, SRGB_ICC_PRIMARIES.bXYZ);
    if (!primariesMatch) {
      throw new Error(`Unsupported non-sRGB ICC profile '${label}' (primaries do not match sRGB) in ${kind}. Convert to sRGB first.`);
    }
    if (tags.rTRC !== true || tags.gTRC !== true || tags.bTRC !== true) {
      throw new Error(`Unsupported non-sRGB ICC profile '${label}' (missing or non-sRGB transfer curve rTRC/gTRC/bTRC) in ${kind}. Convert to sRGB first.`);
    }
    return label;
  }

  if (!tags.description || !SRGB_NAME_RE.test(tags.description) || tags.kTRC !== true) {
    throw new Error(`Unsupported non-sRGB ICC profile '${label}' in ${kind}. Convert to sRGB first.`);
  }
  return label;
}

function linearToSrgbByte(linear) {
  return Math.max(0, Math.min(255, Math.round(linearToSrgb(linear) * 255)));
}

function buildGamaToSrgbLut(gamma) {
  const inv = 1 / gamma;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    lut[i] = linearToSrgbByte((i / 255) ** inv);
  }
  return lut;
}

function roundHalfToEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f & 1) === 0 ? f : f + 1;
}

const INV_255_F32 = Math.fround(1 / 255);

/**
 * Matches Chromium/Skia Canvas2D 8-bit premultiply + float32 unpremultiply round-half-to-even
 * (0/65536 mismatches across all (v, a) pairs against Chromium OffscreenCanvas).
 */
function premulUnpremulChannel(v, a, invAf) {
  const p = ((v * a + 128) + ((v * a + 128) >> 8)) >> 8;
  const u = Math.min(1, Math.fround(Math.fround(p * INV_255_F32) * invAf));
  return Math.min(255, roundHalfToEven(Math.fround(u * 255)));
}

/**
 * Validates every PNG chunk's IEEE CRC32, checks IHDR dimensions against the voxel budget,
 * validates color profile chunks (cICP, iCCP, cHRM), and returns bitDepth + gAMA metadata for sRGB parity.
 */
function inspectPngChunks(bytes) {
  if (!isPngBytes(bytes)) throw new Error("Invalid PNG signature.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let hasIhdr = false;
  let hasIend = false;
  let hasSrgb = false;
  let hasCicpSrgb = false;
  let rawGama = null;
  let gama = null;
  let chrm = null;
  let iccp = null;

  while (pos + 12 <= bytes.byteLength) {
    const length = view.getUint32(pos, false);
    const chunkEnd = pos + 8 + length;
    if (chunkEnd + 4 > bytes.byteLength) throw new Error("Truncated PNG chunk.");
    const type = ascii(bytes, pos + 4, 4);
    const storedCrc = view.getUint32(chunkEnd, false);
    const computedCrc = crc32(bytes.subarray(pos + 4, chunkEnd)) >>> 0;
    if (computedCrc !== storedCrc) {
      throw new Error(`Invalid PNG chunk CRC32 in ${type}.`);
    }
    const dataStart = pos + 8;
    if (type === "IHDR") {
      if (length < 13) throw new Error("Truncated PNG IHDR chunk.");
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = bytes[dataStart + 8];
      hasIhdr = true;
      const tooLarge = voxelRefusal([width, height, 1]);
      if (tooLarge) throw new Error(tooLarge);
    } else if (type === "sRGB") {
      hasSrgb = true;
    } else if (type === "gAMA") {
      if (length !== 4) throw new Error(`Invalid PNG gAMA chunk length (${length}; expected 4).`);
      const raw = view.getUint32(dataStart, false);
      if (raw === 0) throw new Error("Invalid PNG gAMA value 0.");
      rawGama = raw;
      gama = raw / 100000;
    } else if (type === "cHRM") {
      if (length !== 32) throw new Error(`Invalid PNG cHRM chunk length (${length}; expected 32).`);
      chrm = Array.from({ length: 8 }, (_, k) => view.getUint32(dataStart + k * 4, false));
    } else if (type === "cICP") {
      if (length !== 4) {
        throw new Error(`Invalid PNG cICP chunk length (${length}; expected 4).`);
      }
      const primaries = bytes[dataStart];
      const transfer = bytes[dataStart + 1];
      const matrix = bytes[dataStart + 2];
      const fullRange = bytes[dataStart + 3];
      // PNG-3 §11.3.3.5: sRGB full range requires [1, 13, 0, 1]; narrow range (0) is rejected.
      if (primaries !== 1 || transfer !== 13 || matrix !== 0 || fullRange !== 1) {
        throw new Error(
          `Unsupported non-sRGB PNG color profile (cICP ${primaries}/${transfer}/${matrix}/range=${fullRange}). Convert to full-range sRGB first.`,
        );
      }
      hasCicpSrgb = true;
    } else if (type === "iCCP") {
      if (length < 3) throw new Error("Invalid PNG iCCP chunk (truncated).");
      let nul = dataStart;
      while (nul < chunkEnd && bytes[nul] !== 0) nul += 1;
      if (nul === dataStart || nul - dataStart > 79 || nul + 2 >= chunkEnd) {
        throw new Error("Invalid PNG iCCP chunk.");
      }
      const profileName = ascii(bytes, dataStart, nul - dataStart);
      const method = bytes[nul + 1];
      if (method !== 0) throw new Error(`Unsupported PNG iCCP compression method ${method}.`);
      const compressed = bytes.subarray(nul + 2, chunkEnd);
      let inflated;
      try {
        inflated = inflateSync(compressed, { maxOutputLength: MAX_ICC_BYTES });
      } catch (error) {
        throw new Error(`Invalid PNG iCCP compressed profile: ${error.message}`, { cause: error });
      }
      iccp = { profileName, bytes: inflated };
    } else if (type === "IEND") {
      hasIend = true;
      break;
    }
    pos = chunkEnd + 4;
  }

  if (!hasIhdr || !hasIend) throw new Error("Incomplete PNG file (missing IHDR or IEND).");
  if (iccp) {
    validateIccProfile(iccp.bytes, iccp.profileName, "PNG");
  }
  if (!hasCicpSrgb && !iccp && !hasSrgb && chrm) {
    const nonSrgb = chrm.some((val, idx) => Math.abs(val - SRGB_CHRM[idx]) > 500);
    if (nonSrgb) {
      throw new Error("Unsupported non-sRGB PNG chromaticity (cHRM). Convert to sRGB first.");
    }
  }
  const hasExplicitSrgb = hasCicpSrgb || hasSrgb || Boolean(iccp);
  // Chromium/Blink PNGImageDecoder treats standalone gAMA within ±5% of 1/2.2 (43182..47727)
  // without cHRM as standard sRGB identity (0/256 diffs across all 8-bit levels).
  const isChromiumSrgbGama = !chrm && rawGama !== null && rawGama >= 43182 && rawGama <= 47727;
  const effectiveGama = hasExplicitSrgb || isChromiumSrgbGama ? null : gama;
  return { width, height, bitDepth, hasSrgb: hasExplicitSrgb || isChromiumSrgbGama, gama: effectiveGama };
}

/**
 * Decodes a PNG in pure Node via pngjs@7.0.0 with full per-chunk CRC32 checks,
 * strict color-profile validation, 16-bit strip-high-byte parity (matching Chromium's libpng),
 * gAMA->sRGB transfer, and exact Chromium/Skia Canvas2D alpha premul/unpremul parity.
 */
export function decodePngGreyscale(bytes) {
  const meta = inspectPngChunks(bytes);
  const is16Bit = meta.bitDepth === 16;
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    checkCRC: true,
    skipRescale: is16Bit,
  });
  const { width, height, data: rawRgba } = png;
  const tooLarge = voxelRefusal([width, height, 1]);
  if (tooLarge) throw new Error(tooLarge);

  const gamaLut = meta.gama !== null ? buildGamaToSrgbLut(meta.gama) : null;
  const n = width * height;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = is16Bit ? (rawRgba[4 * i + 3] >> 8) : rawRgba[4 * i + 3];
    if (a === 0) {
      out[i] = 0;
      continue;
    }
    let r = is16Bit ? (rawRgba[4 * i] >> 8) : rawRgba[4 * i];
    let g = is16Bit ? (rawRgba[4 * i + 1] >> 8) : rawRgba[4 * i + 1];
    let b = is16Bit ? (rawRgba[4 * i + 2] >> 8) : rawRgba[4 * i + 2];
    if (gamaLut) {
      r = gamaLut[r];
      g = gamaLut[g];
      b = gamaLut[b];
    }
    if (a < 255) {
      const invAf = Math.fround(1 / Math.fround(a * INV_255_F32));
      r = premulUnpremulChannel(r, a, invAf);
      g = premulUnpremulChannel(g, a, invAf);
      b = premulUnpremulChannel(b, a, invAf);
    }
    out[i] = (r + g + b) / 3;
  }
  return { data: out, dims: [width, height, 1], spacing: [1, 1, 1], unit: "pixel" };
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function inspectJpegIcc(bytes) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid JPEG signature.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iccChunks = new Map();
  let totalIccChunks = 0;
  let components = [];
  let adobeTransform = null;
  let pos = 2;
  while (pos + 4 <= bytes.byteLength) {
    if (bytes[pos] !== 0xff) break;
    let markerPos = pos + 1;
    while (markerPos < bytes.byteLength && bytes[markerPos] === 0xff) markerPos += 1;
    if (markerPos >= bytes.byteLength) break;
    const marker = bytes[markerPos];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos = markerPos + 1;
      continue;
    }
    if (markerPos + 2 >= bytes.byteLength) break;
    const segLen = view.getUint16(markerPos + 1, false);
    const segDataStart = markerPos + 3;
    const segEnd = markerPos + 1 + segLen;
    if (segLen < 2 || segEnd > bytes.byteLength) break;
    if (marker === 0xe2 && segLen >= 14 && ascii(bytes, segDataStart, 12) === "ICC_PROFILE\0") {
      if (segLen < 16) {
        throw new Error("Invalid JPEG APP2 ICC_PROFILE segment (truncated header).");
      }
      const seqNo = bytes[segDataStart + 12];
      const count = bytes[segDataStart + 13];
      if (seqNo < 1 || count < 1 || seqNo > count) {
        throw new Error(`Invalid JPEG APP2 ICC_PROFILE segment sequence (${seqNo}/${count}).`);
      }
      if (totalIccChunks !== 0 && count !== totalIccChunks) {
        throw new Error(`Inconsistent JPEG APP2 ICC_PROFILE segment count (${count} vs ${totalIccChunks}).`);
      }
      if (iccChunks.has(seqNo)) {
        throw new Error(`Duplicate JPEG APP2 ICC_PROFILE segment ${seqNo}/${count}.`);
      }
      totalIccChunks = count;
      iccChunks.set(seqNo, bytes.subarray(segDataStart + 14, segEnd));
    } else if (marker === 0xee && segLen >= 14 && ascii(bytes, segDataStart, 5) === "Adobe") {
      adobeTransform = bytes[segDataStart + 11];
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && components.length === 0) {
      if (segLen >= 8) {
        const nComp = bytes[segDataStart + 5];
        if (segDataStart + 6 + nComp * 3 <= segEnd) {
          components = [];
          for (let c = 0; c < nComp; c += 1) {
            const id = bytes[segDataStart + 6 + c * 3];
            const hv = bytes[segDataStart + 7 + c * 3];
            components.push({ id, h: hv >> 4, v: hv & 0x0f });
          }
        }
      }
    }
    pos = segEnd;
  }
  if (totalIccChunks > 0) {
    if (iccChunks.size !== totalIccChunks) {
      throw new Error(`Incomplete JPEG APP2 ICC_PROFILE segments (${iccChunks.size}/${totalIccChunks}).`);
    }
    const parts = [];
    let totalBytes = 0;
    for (let i = 1; i <= totalIccChunks; i += 1) {
      const part = iccChunks.get(i);
      if (!part) {
        throw new Error(`Incomplete JPEG APP2 ICC_PROFILE segments (${iccChunks.size}/${totalIccChunks}).`);
      }
      totalBytes += part.length;
      if (totalBytes > MAX_ICC_BYTES) {
        throw new Error("Embedded JPEG ICC profile exceeds size limit.");
      }
      parts.push(part);
    }
    const assembled = Buffer.concat(parts);
    validateIccProfile(assembled, null, "JPEG");
  }
  return { components, adobeTransform };
}

function upsampleFancy2D(sub, cw, ch, x, y, subX, subY) {
  if (subX && subY) {
    const cx = x >> 1;
    const cy = y >> 1;
    const cxN = (x & 1) === 0 ? Math.max(0, cx - 1) : Math.min(cw - 1, cx + 1);
    const cyN = (y & 1) === 0 ? Math.max(0, cy - 1) : Math.min(ch - 1, cy + 1);
    const s00 = sub[cy * cw + cx];
    const s01 = sub[cy * cw + cxN];
    const s10 = sub[cyN * cw + cx];
    const s11 = sub[cyN * cw + cxN];
    // Exact libjpeg-turbo h2v2_fancy_upsample alternating rounding bias (+8 even col, +7 odd col).
    const bias = (x & 1) === 0 ? 8 : 7;
    return (9 * s00 + 3 * s01 + 3 * s10 + s11 + bias) >> 4;
  }
  if (subX) {
    const cx = x >> 1;
    const cxN = (x & 1) === 0 ? Math.max(0, cx - 1) : Math.min(cw - 1, cx + 1);
    const bias = (x & 1) === 0 ? 1 : 2;
    return (3 * sub[y * cw + cx] + sub[y * cw + cxN] + bias) >> 2;
  }
  const cy = y >> 1;
  const cyN = (y & 1) === 0 ? Math.max(0, cy - 1) : Math.min(ch - 1, cy + 1);
  const bias = (y & 1) === 0 ? 1 : 2;
  return (3 * sub[cy * cw + x] + sub[cyN * cw + x] + bias) >> 2;
}

function decodeJpegGreyscale(bytes) {
  const meta = inspectJpegIcc(bytes);
  const isRawRgb = meta.components.length === 3
    && ((meta.adobeTransform === 0)
      || (meta.adobeTransform === null
        && meta.components[0].id === 0x52
        && meta.components[1].id === 0x47
        && meta.components[2].id === 0x42));
  const useRoundedYcbcr = meta.components.length === 3
    && (meta.adobeTransform === null || meta.adobeTransform === 1)
    && !isRawRgb;
  // jpeg-js decodes stored grid order, ignoring EXIF orientation (matching ImageJ & apps/structure-tensor/src/io.js).
  // For standard 3-component YCbCr JPEGs, decode raw Y/Cb/Cr and apply libjpeg-turbo fancy chroma upsampling
  // + rounded 16-bit fixed-point YCbCr->RGB (avoiding jpeg-js's float-to-Uint8 truncation bias).
  const decoded = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    ...(useRoundedYcbcr || isRawRgb ? { colorTransform: false } : {}),
    maxResolutionInMP: 16,
    maxMemoryUsageInMB: 256,
  });
  const { width, height, data: rgba } = decoded;
  const tooLarge = voxelRefusal([width, height, 1]);
  if (tooLarge) throw new Error(tooLarge);
  const out = new Float64Array(width * height);

  if (useRoundedYcbcr) {
    const [c0, c1, c2] = meta.components;
    const subX = c0.h === 2 && c1.h === 1 && c2.h === 1;
    const subY = c0.v === 2 && c1.v === 1 && c2.v === 1;
    if (subX || subY) {
      const cw = subX ? Math.ceil(width / 2) : width;
      const ch = subY ? Math.ceil(height / 2) : height;
      const stepX = subX ? 2 : 1;
      const stepY = subY ? 2 : 1;
      const cbSub = new Uint8Array(cw * ch);
      const crSub = new Uint8Array(cw * ch);
      for (let cy = 0; cy < ch; cy += 1) {
        const sy = cy * stepY;
        for (let cx = 0; cx < cw; cx += 1) {
          const idx = (sy * width + cx * stepX) * 4;
          cbSub[cy * cw + cx] = rgba[idx + 1];
          crSub[cy * cw + cx] = rgba[idx + 2];
        }
      }
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = y * width + x;
          const Y = rgba[4 * i];
          const Cb = upsampleFancy2D(cbSub, cw, ch, x, y, subX, subY) - 128;
          const Cr = upsampleFancy2D(crSub, cw, ch, x, y, subX, subY) - 128;
          const r = clampByte(Y + ((91881 * Cr + 32768) >> 16));
          const g = clampByte(Y + ((-22554 * Cb - 46802 * Cr + 32768) >> 16));
          const b = clampByte(Y + ((116130 * Cb + 32768) >> 16));
          out[i] = (r + g + b) / 3;
        }
      }
    } else {
      for (let i = 0; i < out.length; i += 1) {
        const Y = rgba[4 * i];
        const Cb = rgba[4 * i + 1] - 128;
        const Cr = rgba[4 * i + 2] - 128;
        const r = clampByte(Y + ((91881 * Cr + 32768) >> 16));
        const g = clampByte(Y + ((-22554 * Cb - 46802 * Cr + 32768) >> 16));
        const b = clampByte(Y + ((116130 * Cb + 32768) >> 16));
        out[i] = (r + g + b) / 3;
      }
    }
    return { data: out, dims: [width, height, 1], spacing: [1, 1, 1], unit: "pixel" };
  }

  for (let i = 0; i < out.length; i += 1) {
    out[i] = (rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2]) / 3;
  }
  return { data: out, dims: [width, height, 1], spacing: [1, 1, 1], unit: "pixel" };
}

function refuseNonFinite(name, image) {
  const refusal = nonFiniteRefusal(image);
  if (refusal) throw new Error(`${name}: ${refusal}`);
  return image;
}

/** Reads a single image file (TIFF, NIfTI-1, NIfTI-2, PNG, or JPEG) in pure Node. */
export async function readImageFile(filePath, { maxFileBytes = MAX_CLI_FILE_BYTES } = {}) {
  const { name, bytes, arrayBuffer } = await readBoundedFile(filePath, maxFileBytes);
  const kind = inputKind(name);
  if (!kind) throw new Error(`${name} is not a TIFF, NIfTI, PNG or JPEG image.`);

  if (kind === "nifti") {
    const raw = isGzipped(bytes) ? boundedGunzip(bytes, maxFileBytes) : bytes;
    const rawBuf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const hdr = parseNiftiAnyHeader(rawBuf);
    const rank = Math.max(1, Math.min(7, hdr.dims[0]));
    if (rank > 4 || (rank === 4 && (hdr.dims[4] || 1) !== 1)) {
      throw new Error(`${name}: only 2D/3D or singleton 4D NIfTI volumes are supported.`);
    }
    const dims = [hdr.nx, hdr.ny, hdr.nz];
    const tooLarge = voxelRefusal(dims);
    if (tooLarge) throw new Error(`${name}: ${tooLarge}`);

    const type = NIFTI_DATATYPES[hdr.datatype];
    if (!type) throw new Error(`${name}: unsupported NIfTI datatype ${hdr.datatype}.`);
    const minOffset = hdr.niftiVersion === 2 ? 544 : 352;
    const start = Math.ceil(hdr.voxOffset);
    const total = dims[0] * dims[1] * dims[2];
    if (!Number.isSafeInteger(start) || start < minOffset || start + total * type.bytes > rawBuf.byteLength) {
      throw new Error(`${name}: NIfTI voxel data is truncated.`);
    }

    const data = new Float64Array(total);
    const view = new DataView(rawBuf, start, total * type.bytes);
    for (let i = 0; i < total; i += 1) {
      data[i] = type.read(view, i * type.bytes, hdr.littleEndian) * hdr.sclSlope + hdr.sclInter;
    }
    // Enforce finiteness on Float64 AND after Float32 narrowing.
    refuseNonFinite(name, { data });
    toCheckedFloat32(data, `${name} input volume`);
    return {
      name,
      image: {
        data,
        dims,
        spacing: hdr.voxelSize,
        unit: "mm",
        kind: "nifti",
        niftiVersion: hdr.niftiVersion,
        header: hdr.niftiVersion === 1 ? rawBuf.slice(0, start) : null,
        niftiMeta: hdr,
        affine: hdr.affine,
      },
    };
  }

  if (kind === "tiff") {
    const layout = await tiffLayout(arrayBuffer);
    const tooLarge = voxelRefusal(layout.dims);
    if (tooLarge) throw new Error(`${name}: ${tooLarge}`);
    const tiff = await readTiff(arrayBuffer);
    refuseNonFinite(name, tiff);
    return {
      name,
      image: { ...tiff, kind: "tiff", header: rasterHeader(tiff.dims, tiff.spacing) },
    };
  }

  const raster = isPngBytes(bytes) ? decodePngGreyscale(bytes) : decodeJpegGreyscale(bytes);
  refuseNonFinite(name, raster);
  return {
    name,
    image: { ...raster, kind: "raster", header: rasterHeader(raster.dims, raster.spacing) },
  };
}

/**
 * Resolves CLI input arguments: a single file, a directory of 2D slices, or multiple 2D slice paths.
 * Returns { name, image } matching the webapp's readImages() behavior.
 */
export async function loadInputImages(inputs, { maxFileBytes = MAX_CLI_FILE_BYTES } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("At least one input image path is required.");
  }
  let filePaths = [];
  if (inputs.length === 1) {
    const info = await stat(resolve(inputs[0]));
    if (info.isDirectory()) {
      const entries = (await readdir(resolve(inputs[0])))
        .filter((entry) => !entry.startsWith(".") && inputKind(entry) !== null)
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      if (entries.length === 0) throw new Error(`No supported TIFF, NIfTI, PNG or JPEG images found in '${inputs[0]}'.`);
      filePaths = entries.map((entry) => join(resolve(inputs[0]), entry));
    } else {
      filePaths = [resolve(inputs[0])];
    }
  } else {
    filePaths = [...inputs]
      .map((p) => resolve(p))
      .sort((a, b) => basename(a).localeCompare(basename(b), "en", { numeric: true }));
  }

  if (filePaths.length === 1) {
    return readImageFile(filePaths[0], { maxFileBytes });
  }

  const slices = [];
  for (const p of filePaths) {
    const loaded = await readImageFile(p, { maxFileBytes });
    if (loaded.image.kind === "nifti" || loaded.image.dims[2] !== 1) {
      throw new Error("Choose one image, or several 2D TIFF, PNG or JPEG slices of one stack.");
    }
    if (slices.length > 0) {
      const [nx, ny] = slices[0].image.dims;
      if (loaded.image.dims[0] !== nx || loaded.image.dims[1] !== ny) {
        throw new Error(`${loaded.name} is ${loaded.image.dims[0]} × ${loaded.image.dims[1]}; every slice must match ${slices[0].name}.`);
      }
    }
    slices.push(loaded);
  }

  const [nx, ny] = slices[0].image.dims;
  const nz = slices.length;
  const tooLarge = voxelRefusal([nx, ny, nz]);
  if (tooLarge) throw new Error(`${slices[0].name}: ${tooLarge}`);

  const data = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) {
    data.set(slices[z].image.data, z * nx * ny);
  }
  const dims = [nx, ny, nz];
  const spacing = [slices[0].image.spacing[0], slices[0].image.spacing[1], slices[0].image.spacing[0]];
  return {
    name: slices[0].name,
    image: {
      data,
      dims,
      spacing,
      unit: slices[0].image.unit,
      kind: "tiff",
      header: rasterHeader(dims, spacing),
    },
  };
}

const LINK_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "ENOTSUP", "ENOSYS"]);

function ensureDirectoryChainSync(targetDir, createdOut) {
  const missing = [];
  let cursor = resolve(targetDir);
  while (true) {
    try {
      const info = statSync(cursor);
      if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' collides with an existing non-directory '${cursor}'.`);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    try {
      mkdirSync(missing[i]);
      createdOut.push(missing[i]);
    } catch (error) {
      if (error.code === "EEXIST") {
        const info = statSync(missing[i]);
        if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' collides with an existing non-directory '${missing[i]}'.`);
      } else {
        throw error;
      }
    }
  }
}

function rollbackPublishSync(pubState) {
  if (!pubState || pubState.committed) return true;
  let ok = true;
  const renameRollback = pubState.renameSyncFn ?? renameSync;

  if (pubState.pendingPublish && !pubState.pendingPublish.hadBackup) {
    const { target, partialPath } = pubState.pendingPublish;
    if (!partialPath || !existsSync(partialPath)) {
      try {
        lstatSync(target);
        rmSync(target, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") ok = false;
      }
    }
  }
  pubState.pendingPublish = null;

  while (pubState.published.length > 0) {
    const entry = pubState.published[pubState.published.length - 1];
    if (!entry.hadBackup) {
      try {
        rmSync(entry.target, { force: true });
        pubState.published.pop();
      } catch (error) {
        if (error.code === "ENOENT") pubState.published.pop();
        else {
          ok = false;
          break;
        }
      }
    } else {
      pubState.published.pop();
    }
  }

  if (pubState.pendingBackup) {
    const { target, backup } = pubState.pendingBackup;
    let backupExists = false;
    let targetInfo = null;
    try {
      lstatSync(backup);
      backupExists = true;
    } catch (statError) {
      if (statError.code !== "ENOENT") ok = false;
    }
    try {
      targetInfo = lstatSync(target);
    } catch (statError) {
      if (statError.code !== "ENOENT") ok = false;
    }
    if (backupExists) {
      if (targetInfo) {
        // Target is occupied (e.g. raced symlink/file/dir) while backup still exists;
        // do not clobber target and keep the lock on disk.
        ok = false;
      } else {
        try {
          renameRollback(backup, target);
        } catch {
          ok = false;
        }
      }
    } else if (!targetInfo) {
      // Both target and backup are missing: backup disappeared before post-rename check.
      ok = false;
    }
    pubState.pendingBackup = null;
  }

  const remainingBackups = [];
  while (pubState.backups.length > 0) {
    const entry = pubState.backups.pop();
    try {
      let targetInfo = null;
      try {
        targetInfo = lstatSync(entry.target);
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      if (targetInfo && (targetInfo.isSymbolicLink() || targetInfo.isDirectory())) {
        ok = false;
        remainingBackups.push(entry);
        continue;
      }
      renameRollback(entry.backup, entry.target);
    } catch {
      ok = false;
      remainingBackups.push(entry);
    }
  }
  for (let i = remainingBackups.length - 1; i >= 0; i -= 1) {
    pubState.backups.push(remainingBackups[i]);
  }

  for (const item of pubState.staged) {
    if (!item.partialPath) continue;
    try {
      rmSync(item.partialPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") ok = false;
    }
  }
  return ok;
}

const CLAIM_OPTION_KEYS = new Set(["overwrite", "readdirFn", "openFn"]);

export async function claimOutputDir(outputDir, options) {
  const opts = assertPlainOptions(options, CLAIM_OPTION_KEYS, "claimOutputDir options");
  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const readdirFn = opts.readdirFn ?? readdir;
  const openFn = opts.openFn;
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("Output directory path is required.");
  const dir = resolve(outputDir);
  const lockPath = join(dir, LOCK_NAME);

  const createdDirs = [];
  const activePartials = new Set();
  let lockHeld = false;
  let acquiring = false;
  let pendingSignal = null;
  let handlingSignal = false;
  let activePublish = null;
  let rollbackFailed = false;

  const cleanupSync = ({ removeCreated = false, fromSignal = false } = {}) => {
    let ok = !rollbackFailed;
    if (activePublish && !activePublish.committed) {
      if (!rollbackPublishSync(activePublish)) {
        ok = false;
        rollbackFailed = true;
      } else {
        activePublish = null;
      }
    }
    for (const p of [...activePartials]) {
      try {
        rmSync(p, { recursive: true, force: true });
        activePartials.delete(p);
      } catch {
        if (existsSync(p)) ok = false;
        else activePartials.delete(p);
      }
    }
    if (lockHeld && ok) {
      try {
        unlinkSync(lockPath);
        lockHeld = false;
      } catch (error) {
        if (error.code === "ENOENT") lockHeld = false;
        else ok = false;
      }
    }
    if ((removeCreated || fromSignal) && ok && !lockHeld) {
      for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
        try {
          if (readdirSync(createdDirs[i]).length === 0) rmdirSync(createdDirs[i]);
        } catch {
          // Ignore non-empty or already-removed directory during cleanup.
        }
      }
    }
    return ok;
  };

  const cleanupSyncOnSignal = (signal) => {
    if (handlingSignal) return;
    if (acquiring) {
      pendingSignal = signal;
      return;
    }
    handlingSignal = true;
    cleanupSync({ removeCreated: true, fromSignal: true });
    process.off("SIGINT", cleanupSyncOnSignal);
    process.off("SIGTERM", cleanupSyncOnSignal);
    process.kill(process.pid, signal);
  };

  process.on("SIGINT", cleanupSyncOnSignal);
  process.on("SIGTERM", cleanupSyncOnSignal);

  const release = async ({ removeCreated = false } = {}) => {
    cleanupSync({ removeCreated });
    process.off("SIGINT", cleanupSyncOnSignal);
    process.off("SIGTERM", cleanupSyncOnSignal);
  };

  const lockPayload = `${JSON.stringify({ tool: "structure-tensor", pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`;
  try {
    ensureDirectoryChainSync(dir, createdDirs);
    if (openFn) {
      acquiring = true;
      let handle = null;
      try {
        handle = await openFn(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        lockHeld = true;
      } catch (error) {
        acquiring = false;
        cleanupSync({ removeCreated: true });
        process.off("SIGINT", cleanupSyncOnSignal);
        process.off("SIGTERM", cleanupSyncOnSignal);
        if (pendingSignal) {
          const sig = pendingSignal;
          pendingSignal = null;
          process.kill(process.pid, sig);
        }
        if (error.code === "EEXIST") {
          throw new Error(`Output directory '${outputDir}' is locked by another running CLI process (or contains ${LOCK_NAME}).`);
        }
        throw error;
      }
      acquiring = false;
      if (pendingSignal) {
        if (handle) await handle.close().catch(() => {});
        const sig = pendingSignal;
        pendingSignal = null;
        cleanupSyncOnSignal(sig);
      }
      try {
        await handle.writeFile(lockPayload, "utf8");
      } finally {
        await handle.close();
      }
    } else {
      let fd = null;
      try {
        fd = openSync(lockPath, "wx", 0o600);
        lockHeld = true;
        writeFileSync(fd, lockPayload, "utf8");
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new Error(`Output directory '${outputDir}' is locked by another running CLI process (or contains ${LOCK_NAME}).`);
        }
        throw error;
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            // Ignore close error after lock creation.
          }
        }
      }
    }

    if (!overwrite) {
      const entries = (await readdirFn(dir)).filter((name) => name !== LOCK_NAME);
      if (entries.length > 0) {
        throw new Error(`Output directory '${outputDir}' is not empty. Choose a new directory or pass --overwrite.`);
      }
    }
  } catch (error) {
    await release({ removeCreated: true });
    throw error;
  }

  return {
    dir,
    lockPath,
    createdDirs,
    trackPartial: (p) => { activePartials.add(p); },
    untrackPartial: (p) => { activePartials.delete(p); },
    beginPublish: (pubState) => { activePublish = pubState; },
    endPublish: (pubState) => { if (activePublish === pubState) activePublish = null; },
    markRollbackFailed: () => { rollbackFailed = true; },
    release,
  };
}

function publishFileNonOverwriteSync(partialPath, finalPath, pubState, { linkFn, unlinkFn }) {
  const doLink = linkFn ?? linkSync;
  const doUnlink = unlinkFn ?? unlinkSync;
  try {
    doLink(partialPath, finalPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Output file '${finalPath}' already exists. Choose a new directory or pass --overwrite.`);
    }
    if (LINK_FALLBACK_CODES.has(error.code)) {
      throw new Error(
        `Atomic non-overwrite output publication requires hard-link support for '${finalPath}' (${error.code}).`,
        { cause: error },
      );
    }
    throw error;
  }
  pubState.published.push({ target: finalPath, hadBackup: false, kind: "file" });
  try {
    doUnlink(partialPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function assertBackupNotSpecialSync(backupPath, finalPath, pubState) {
  const movedInfo = lstatSync(backupPath);
  if (movedInfo.isSymbolicLink() || movedInfo.isDirectory()) {
    const kindLabel = movedInfo.isSymbolicLink() ? "symbolic link" : "existing directory";
    try {
      renameSync(backupPath, finalPath);
    } catch {
      pubState.backups.push({ target: finalPath, backup: backupPath });
      pubState.pendingBackup = null;
      throw new Error(`Cannot overwrite ${kindLabel} '${finalPath}'.`);
    }
    pubState.pendingBackup = null;
    throw new Error(`Cannot overwrite ${kindLabel} '${finalPath}'.`);
  }
}

function assertTargetNotSpecialSync(finalPath) {
  try {
    const info = lstatSync(finalPath);
    if (info.isDirectory()) throw new Error(`Cannot overwrite existing directory '${finalPath}'.`);
    if (info.isSymbolicLink()) throw new Error(`Cannot overwrite symbolic link '${finalPath}'.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const COMMIT_OPTION_KEYS = new Set([
  "overwrite",
  "renameFn",
  "writeFileFn",
  "linkFn",
  "unlinkFn",
  "trackPartial",
  "untrackPartial",
  "claim",
]);

export async function commitOutputs(dir, files, options) {
  const opts = assertPlainOptions(options, COMMIT_OPTION_KEYS, "commitOutputs options");
  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const hasCustomRename = opts.renameFn !== undefined && opts.renameFn !== rename;
  const renameFn = opts.renameFn ?? rename;
  const writeFileFn = opts.writeFileFn ?? writeFile;
  const linkFn = opts.linkFn;
  const unlinkFn = opts.unlinkFn;
  const claim = opts.claim;
  const trackPartial = opts.trackPartial ?? claim?.trackPartial;
  const untrackPartial = opts.untrackPartial ?? claim?.untrackPartial;

  const token = randomBytes(6).toString("hex");
  for (const file of files) {
    const target = join(dir, file.name);
    try {
      const info = await lstat(target);
      if (info.isDirectory()) throw new Error(`Cannot write '${file.name}' because '${target}' is a directory.`);
      if (info.isSymbolicLink()) throw new Error(`Cannot overwrite symbolic link '${target}'. Remove the symlink or choose a new output directory.`);
      if (!overwrite) throw new Error(`Output file '${target}' already exists. Choose a new directory or pass --overwrite.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const pubState = {
    staged: [],
    published: [],
    backups: [],
    pendingBackup: null,
    pendingPublish: null,
    committed: false,
    renameSyncFn: renameSync,
  };
  claim?.beginPublish?.(pubState);

  try {
    for (const file of files) {
      const partialPath = join(dir, `.${file.name}.${token}.partial`);
      const entry = { name: file.name, partialPath, finalPath: join(dir, file.name) };
      pubState.staged.push(entry);
      trackPartial?.(partialPath);
      await writeFileFn(partialPath, file.data, { flag: "wx" });
    }

    const backedUpSet = new Set();
    if (overwrite) {
      for (const entry of pubState.staged) {
        let info = null;
        try {
          info = lstatSync(entry.finalPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (info) {
          if (info.isDirectory()) throw new Error(`Cannot overwrite existing directory '${entry.finalPath}'.`);
          if (info.isSymbolicLink()) throw new Error(`Cannot overwrite symbolic link '${entry.finalPath}'.`);
          const backupPath = join(dir, `.${entry.name}.${token}.backup`);
          pubState.pendingBackup = { target: entry.finalPath, backup: backupPath };
          if (hasCustomRename) {
            await renameFn(entry.finalPath, backupPath);
          } else {
            renameSync(entry.finalPath, backupPath);
          }
          assertBackupNotSpecialSync(backupPath, entry.finalPath, pubState);
          pubState.backups.push({ target: entry.finalPath, backup: backupPath });
          backedUpSet.add(entry.finalPath);
          pubState.pendingBackup = null;
        }
      }
    }

    for (const entry of pubState.staged) {
      let hadBackup = backedUpSet.has(entry.finalPath);
      if (!overwrite) {
        publishFileNonOverwriteSync(entry.partialPath, entry.finalPath, pubState, { linkFn, unlinkFn });
        untrackPartial?.(entry.partialPath);
      } else if (!hasCustomRename) {
        const doLink = linkFn ?? linkSync;
        const doUnlink = unlinkFn ?? unlinkSync;
        let linked = false;
        try {
          doLink(entry.partialPath, entry.finalPath);
          linked = true;
        } catch (error) {
          if (error.code === "EEXIST") {
            if (!hadBackup) {
              const backupPath = join(dir, `.${entry.name}.${token}.backup`);
              pubState.pendingBackup = { target: entry.finalPath, backup: backupPath };
              renameSync(entry.finalPath, backupPath);
              assertBackupNotSpecialSync(backupPath, entry.finalPath, pubState);
              pubState.backups.push({ target: entry.finalPath, backup: backupPath });
              backedUpSet.add(entry.finalPath);
              hadBackup = true;
              pubState.pendingBackup = null;
            } else {
              assertTargetNotSpecialSync(entry.finalPath);
            }
          } else if (LINK_FALLBACK_CODES.has(error.code)) {
            assertTargetNotSpecialSync(entry.finalPath);
          } else {
            throw error;
          }
        }
        if (linked) {
          pubState.published.push({ target: entry.finalPath, hadBackup, kind: "file" });
          try {
            doUnlink(entry.partialPath);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          untrackPartial?.(entry.partialPath);
        } else {
          pubState.pendingPublish = { target: entry.finalPath, partialPath: entry.partialPath, hadBackup, kind: "file" };
          renameSync(entry.partialPath, entry.finalPath);
          pubState.published.push({ target: entry.finalPath, hadBackup, kind: "file" });
          pubState.pendingPublish = null;
          untrackPartial?.(entry.partialPath);
        }
      } else {
        assertTargetNotSpecialSync(entry.finalPath);
        pubState.pendingPublish = { target: entry.finalPath, partialPath: entry.partialPath, hadBackup, kind: "file" };
        await renameFn(entry.partialPath, entry.finalPath);
        pubState.published.push({ target: entry.finalPath, hadBackup, kind: "file" });
        pubState.pendingPublish = null;
        untrackPartial?.(entry.partialPath);
      }
    }
    pubState.committed = true;
  } catch (error) {
    const ok = rollbackPublishSync(pubState);
    if (!ok) claim?.markRollbackFailed?.();
    for (const entry of pubState.staged) {
      untrackPartial?.(entry.partialPath);
    }
    claim?.endPublish?.(pubState);
    throw error;
  }

  for (const backup of pubState.backups) await rm(backup.backup, { force: true }).catch(() => {});
  claim?.endPublish?.(pubState);
  return pubState.staged.map((entry) => entry.finalPath);
}

/**
 * Runs 2D or 3D structure-tensor orientation analysis on one image (or a stack of 2D slices)
 * and writes all maps, colour map, orientation distribution CSV, and summary JSON atomically.
 */
const ANALYSE_ARG_KEYS = new Set([
  "inputs",
  "outputDir",
  "options",
  "onProgress",
  "maxFileBytes",
  "renameFn",
  "readdirFn",
  "openFn",
  "linkFn",
  "unlinkFn",
]);

export async function analyseStructureTensorFile(arg) {
  const validated = assertPlainOptions(arg, ANALYSE_ARG_KEYS, "analyseStructureTensorFile arguments");
  const {
    inputs,
    outputDir,
    options = {},
    onProgress,
    maxFileBytes = MAX_CLI_FILE_BYTES,
    renameFn = rename,
    readdirFn = readdir,
    openFn,
    linkFn,
    unlinkFn,
  } = validated;
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new Error("onProgress must be a function.");
  }
  const parsed = parseCliOptions(options);
  const inputList = Array.isArray(inputs) ? inputs : [inputs];
  if (inputList.length === 0 || inputList.some((p) => typeof p !== "string" || !p.trim())) {
    throw new Error("Input file path is required.");
  }
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("Output directory path is required.");

  const { name, image } = await loadInputImages(inputList, { maxFileBytes });
  const refusal = imageRefusal(image, parsed.settings);
  if (refusal) throw new Error(refusal);

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn, ...(openFn ? { openFn } : {}) });
  let committed = false;
  try {
    const started = performance.now();
    const result = analyse(image, parsed.settings, {
      onProgress: (fraction, stage) => onProgress?.(fraction, stage),
    });
    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const mapFormat = image.kind === "nifti" ? "nifti" : "tiff";
    const isNifti2 = image.kind === "nifti" && image.niftiVersion === 2;
    const plan = outputPlan(name, result.dimensions, mapFormat);
    const outputFiles = [];

    const encodeFloatNifti = (f32, dims) => {
      if (isNifti2) {
        return gzipSync(new Uint8Array(writeNifti2Payload(
          new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength),
          image.niftiMeta,
          { dims, datatype: 16, bitpix: 32 },
        )));
      }
      const nii = createNiftiFromData(f32, image.header, { dims, range: "auto", clampCalMax: false });
      return gzipSync(new Uint8Array(nii));
    };

    const encodeMap = (key, values) => {
      const f32 = toCheckedFloat32(values, key);
      if (mapFormat === "nifti") return encodeFloatNifti(f32, image.dims);
      return Buffer.from(writeTiff({ data: f32, dims: image.dims, spacing: image.spacing, unit: image.unit }));
    };

    const mapKeys = result.dimensions === 2
      ? ["orientation", "coherency", "energy"]
      : ["azimuth", "elevation", "coherency", "energy"];

    for (const key of mapKeys) {
      outputFiles.push({ name: plan[key][0], data: encodeMap(key, result.maps[key]) });
    }

    if (result.dimensions === 2) {
      const pngBytes = encodePng({
        width: image.dims[0],
        height: image.dims[1],
        data: result.colour,
        channels: 3,
        depth: 8,
      });
      outputFiles.push({ name: plan.colour[0], data: Buffer.from(pngBytes) });
    } else {
      let colourData;
      if (mapFormat === "nifti") {
        colourData = isNifti2
          ? gzipSync(new Uint8Array(writeNifti2Payload(result.colour, image.niftiMeta, { dims: image.dims, datatype: 128, bitpix: 24 })))
          : gzipSync(new Uint8Array(createRgb24Nifti(result.colour, image.header, image.dims)));
      } else {
        colourData = Buffer.from(writeTiff({ data: result.colour, dims: image.dims, spacing: image.spacing, unit: image.unit, rgb: true }));
      }
      outputFiles.push({ name: plan.colour[0], data: colourData });

      const vectorFrames = toCheckedFloat32(frameMajor(result.maps.vectors), "vectors");
      outputFiles.push({ name: plan.vectors[0], data: encodeFloatNifti(vectorFrames, [...image.dims, 3]) });
    }

    outputFiles.push({ name: plan.distribution[0], data: Buffer.from(distributionCsv(result.distributions), "utf8") });
    const report = {
      ...summary({
        input: name,
        dims: image.dims,
        spacing: image.spacing,
        unit: image.unit,
        settings: parsed.settings,
        dominant: result.dominant,
        distributions: result.distributions,
      }),
      version: packageJson.version,
      seconds,
    };
    outputFiles.push({ name: plan.summary[0], data: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8") });

    const written = await commitOutputs(reservation.dir, outputFiles, {
      overwrite: parsed.overwrite,
      renameFn,
      ...(linkFn ? { linkFn } : {}),
      ...(unlinkFn ? { unlinkFn } : {}),
      claim: reservation,
    });
    committed = true;

    return {
      outputDir: reservation.dir,
      outputs: written,
      primaryOutput: written[0],
      dimensions: result.dimensions,
      dominant: result.dominant,
      summary: report,
      seconds,
    };
  } finally {
    await reservation.release({ removeCreated: !committed });
  }
}

/** Offline self-check: analyses a synthetic 45° grating and verifies exact angle and coherency. */
const CHECK_OPTION_KEYS = new Set(["cacheDir", "cache-dir"]);

export async function checkInstallation(opts) {
  const validated = assertPlainOptions(opts, CHECK_OPTION_KEYS, "checkInstallation options");
  const cacheDirRaw = readAliasedOption(validated, "cache-dir", "cacheDir");
  const cacheDir = cacheDirRaw !== undefined ? assertNonEmptyString(cacheDirRaw, "cache-dir") : undefined;
  const resolvedCache = cacheDir ? resolve(cacheDir) : undefined;
  const n = 32;
  const data = new Float64Array(n * n);
  const theta = (45 * Math.PI) / 180;
  const freq = (2 * Math.PI) / 6;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      data[x + n * y] = Math.cos(freq * (x * Math.sin(theta) + y * Math.cos(theta)));
    }
  }
  const result = analyse({ data, dims: [n, n, 1], spacing: [1, 1, 1] }, { sigma: 1, rho: 3, minCoherency: 0.2, minEnergy: 0.01 });
  const center = 16 + n * 16;
  const angleErr = Math.abs(result.maps.orientation[center] - 45);
  const coh = result.maps.coherency[center];
  if (!(angleErr < 1e-3) || !(coh > 0.99)) {
    throw new Error(`Self-check failed: expected 45° / coherency > 0.99 at center, got ${result.maps.orientation[center]}° / ${coh}.`);
  }
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    executable: process.execPath,
    node: process.version,
    testAngleDeg: Number(result.maps.orientation[center].toFixed(4)),
    testCoherency: Number(coh.toFixed(6)),
    ...(resolvedCache ? { cacheDir: resolvedCache } : {}),
  };
}
