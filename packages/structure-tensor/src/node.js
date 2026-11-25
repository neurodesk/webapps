// Node command-line interface for @neurodesk/structure-tensor.
// Runs the exact same 2D/3D Gaussian structure-tensor analysis as the Structure Tensor web application,
// using pure-Node TIFF/NIfTI-1/NIfTI-2/PNG/JPEG I/O with atomic output staging and exclusive directory locking.
import { randomBytes } from "node:crypto";
import { constants as fsConstants, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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

export function parseCliOptions(values = {}) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Options must be a plain object.");
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error(`Unknown option '${key}'.`);
    }
  }
  const sigma = parseNumeric(values.sigma, "sigma");
  const rho = parseNumeric(values.rho, "rho");
  const minCoherency = parseNumeric(values["min-coherency"] ?? values.minCoherency, "min-coherency");
  const minEnergy = parseNumeric(values["min-energy"] ?? values.minEnergy, "min-energy");
  const settings = analysisSettings({
    ...(sigma !== undefined ? { sigma } : {}),
    ...(rho !== undefined ? { rho } : {}),
    ...(minCoherency !== undefined ? { minCoherency } : {}),
    ...(minEnergy !== undefined ? { minEnergy } : {}),
  });
  const overwrite = parseBooleanOption(values.overwrite, "overwrite");
  const envOffline = process.env.NEURODESK_OFFLINE === "1";
  if (values.offline !== undefined) {
    const explicit = parseBooleanOption(values.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
  }
  const offline = envOffline || Boolean(values.offline);
  return { settings, overwrite, offline };
}

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
    if (magic === "ni2\0") throw new Error("Two-file .hdr/.img pairs are not supported.");
    if (magic !== "n+2\0") throw new Error("Invalid NIfTI-2 magic.");
    datatype = view.getInt16(12, littleEndian);
    dims = Array.from({ length: 8 }, (_, i) => {
      const val = Number(view.getBigInt64(16 + i * 8, littleEndian));
      if (!Number.isSafeInteger(val)) throw new Error("Unsupported NIfTI-2 image dimensions.");
      return val;
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
    affine = [srow[0].slice(), srow[1].slice(), srow[2].slice(), [0, 0, 0, 1]];
  } else if (qformCode > 0) {
    affine = quaternionToAffine(quatern, qoffset, pixDims);
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

const SRGB_NAME_RE = /\bsrgb\b|srgb2014|iec\s*61966[- ]2\.1/i;
const SRGB_CHRM = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];

function extractIccDescription(iccBytes) {
  if (iccBytes.byteLength < 132) return null;
  const view = new DataView(iccBytes.buffer, iccBytes.byteOffset, iccBytes.byteLength);
  const tagCount = view.getUint32(128, false);
  for (let i = 0; i < tagCount && 132 + (i + 1) * 12 <= iccBytes.byteLength; i += 1) {
    const base = 132 + i * 12;
    const sig = ascii(iccBytes, base, 4);
    if (sig !== "desc") continue;
    const offset = view.getUint32(base + 4, false);
    const size = view.getUint32(base + 8, false);
    if (offset + size > iccBytes.byteLength || size < 12) return null;
    const tagType = ascii(iccBytes, offset, 4);
    if (tagType === "desc") {
      const len = view.getUint32(offset + 8, false);
      const end = Math.min(offset + 12 + len, offset + size);
      return ascii(iccBytes, offset + 12, Math.max(0, end - (offset + 12))).replace(/\0+$/, "");
    }
    if (tagType === "mluc" && size >= 28) {
      const strLen = view.getUint32(offset + 20, false);
      const strOff = view.getUint32(offset + 24, false);
      if (offset + strOff + strLen <= iccBytes.byteLength) {
        let out = "";
        for (let j = 0; j + 1 < strLen; j += 2) {
          out += String.fromCharCode(view.getUint16(offset + strOff + j, false));
        }
        return out.replace(/\0+$/, "");
      }
    }
  }
  return null;
}

function validateIccProfile(iccBytes, profileName, kind) {
  if (iccBytes.byteLength >= 20) {
    const colorSpace = ascii(iccBytes, 16, 4);
    if (colorSpace !== "RGB " && colorSpace !== "GRAY") {
      throw new Error(`Unsupported non-sRGB ICC color space '${colorSpace.trim()}' in ${kind}. Convert to sRGB first.`);
    }
  }
  const desc = extractIccDescription(iccBytes);
  const label = desc || profileName || "unnamed";
  if (!SRGB_NAME_RE.test(label) && !(profileName && SRGB_NAME_RE.test(profileName))) {
    throw new Error(`Unsupported non-sRGB ICC profile '${label}' in ${kind}. Convert to sRGB first.`);
  }
}

function linearToSrgbByte(linear) {
  const clamped = Math.max(0, Math.min(1, linear));
  const srgb = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

function buildGamaToSrgbLut(gamma) {
  const inv = 1 / gamma;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    lut[i] = linearToSrgbByte((i / 255) ** inv);
  }
  return lut;
}

/**
 * Validates every PNG chunk's IEEE CRC32, checks IHDR dimensions against the voxel budget,
 * validates color profile chunks (iCCP, cHRM, cICP), and returns gAMA metadata for sRGB parity.
 */
function inspectPngChunks(bytes) {
  if (!isPngBytes(bytes)) throw new Error("Invalid PNG signature.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let hasIhdr = false;
  let hasIend = false;
  let hasSrgb = false;
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
      hasIhdr = true;
      const tooLarge = voxelRefusal([width, height, 1]);
      if (tooLarge) throw new Error(tooLarge);
    } else if (type === "sRGB") {
      hasSrgb = true;
    } else if (type === "gAMA" && length === 4) {
      const raw = view.getUint32(dataStart, false);
      if (raw > 0) gama = raw / 100000;
    } else if (type === "cHRM" && length === 32) {
      chrm = Array.from({ length: 8 }, (_, k) => view.getUint32(dataStart + k * 4, false));
    } else if (type === "cICP" && length >= 3) {
      const primaries = bytes[dataStart];
      const transfer = bytes[dataStart + 1];
      const matrix = bytes[dataStart + 2];
      if (primaries !== 1 || transfer !== 13 || matrix !== 0) {
        throw new Error(`Unsupported non-sRGB PNG color profile (cICP ${primaries}/${transfer}/${matrix}). Convert to sRGB first.`);
      }
    } else if (type === "iCCP" && length > 2) {
      let nul = dataStart;
      while (nul < chunkEnd && bytes[nul] !== 0) nul += 1;
      if (nul + 2 > chunkEnd) throw new Error("Invalid PNG iCCP chunk.");
      const profileName = ascii(bytes, dataStart, nul - dataStart);
      const method = bytes[nul + 1];
      if (method !== 0) throw new Error(`Unsupported PNG iCCP compression method ${method}.`);
      const compressed = bytes.subarray(nul + 2, chunkEnd);
      const inflated = inflateSync(compressed, { maxOutputLength: 2 * 1024 * 1024 });
      iccp = { profileName, bytes: inflated };
    } else if (type === "IEND") {
      hasIend = true;
      break;
    }
    pos = chunkEnd + 4;
  }

  if (!hasIhdr || !hasIend) throw new Error("Incomplete PNG file (missing IHDR or IEND).");
  if (!hasSrgb) {
    if (iccp) {
      validateIccProfile(iccp.bytes, iccp.profileName, "PNG");
    } else if (chrm) {
      const nonSrgb = chrm.some((val, idx) => Math.abs(val - SRGB_CHRM[idx]) > 500);
      if (nonSrgb) {
        throw new Error("Unsupported non-sRGB PNG chromaticity (cHRM). Convert to sRGB first.");
      }
    }
  }
  return { width, height, hasSrgb, gama: hasSrgb || iccp ? null : gama };
}

/**
 * Decodes a PNG in pure Node via pngjs@7.0.0 with full per-chunk CRC32 checks,
 * color-profile validation, gAMA->sRGB transfer, and Chromium Canvas2D alpha parity
 * (transparent pixels zero RGB; 0 < a < 255 matches 8-bit premultiply/unpremultiply).
 */
export function decodePngGreyscale(bytes) {
  const meta = inspectPngChunks(bytes);
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    checkCRC: true,
    skipRescale: false,
  });
  const { width, height, data: rgba } = png;
  const tooLarge = voxelRefusal([width, height, 1]);
  if (tooLarge) throw new Error(tooLarge);

  const gamaLut = meta.gama !== null ? buildGamaToSrgbLut(meta.gama) : null;
  const n = width * height;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = rgba[4 * i + 3];
    if (a === 0) {
      out[i] = 0;
      continue;
    }
    let r = rgba[4 * i];
    let g = rgba[4 * i + 1];
    let b = rgba[4 * i + 2];
    if (gamaLut) {
      r = gamaLut[r];
      g = gamaLut[g];
      b = gamaLut[b];
    }
    if (a < 255) {
      const pm = (c) => Math.min(255, Math.round((Math.round((c * a) / 255) * 255) / a));
      r = pm(r);
      g = pm(g);
      b = pm(b);
    }
    out[i] = (r + g + b) / 3;
  }
  return { data: out, dims: [width, height, 1], spacing: [1, 1, 1], unit: "pixel" };
}

function inspectJpegIcc(bytes) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid JPEG signature.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const iccChunks = new Map();
  let totalIccChunks = 0;
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
    if (segEnd > bytes.byteLength) break;
    if (marker === 0xe2 && segLen >= 16 && ascii(bytes, segDataStart, 12) === "ICC_PROFILE\0") {
      const seqNo = bytes[segDataStart + 12];
      const count = bytes[segDataStart + 13];
      totalIccChunks = Math.max(totalIccChunks, count);
      iccChunks.set(seqNo, bytes.subarray(segDataStart + 14, segEnd));
    }
    pos = segEnd;
  }
  if (iccChunks.size > 0) {
    const parts = [];
    for (let i = 1; i <= totalIccChunks; i += 1) {
      const part = iccChunks.get(i);
      if (part) parts.push(part);
    }
    const assembled = Buffer.concat(parts);
    validateIccProfile(assembled, null, "JPEG");
  }
}

function decodeJpegGreyscale(bytes) {
  inspectJpegIcc(bytes);
  // jpeg-js decodes stored grid order, ignoring EXIF orientation (matching ImageJ & apps/structure-tensor/src/io.js).
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 256 });
  const { width, height, data: rgba } = decoded;
  const tooLarge = voxelRefusal([width, height, 1]);
  if (tooLarge) throw new Error(tooLarge);
  const out = new Float64Array(width * height);
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
    const minOffset = hdr.niftiVersion === 2 ? 540 : 348;
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

async function ensureDirectoryChain(targetDir) {
  const missing = [];
  let cursor = resolve(targetDir);
  while (true) {
    try {
      const info = await stat(cursor);
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
  const created = [];
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    try {
      await mkdir(missing[i]);
      created.push(missing[i]);
    } catch (error) {
      if (error.code === "EEXIST") {
        const info = await stat(missing[i]);
        if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' collides with an existing non-directory '${missing[i]}'.`);
      } else {
        for (let j = created.length - 1; j >= 0; j -= 1) await rmdir(created[j]).catch(() => {});
        throw error;
      }
    }
  }
  return created;
}

export async function claimOutputDir(outputDir, { overwrite = false, readdirFn = readdir } = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("Output directory path is required.");
  const dir = resolve(outputDir);
  const createdDirs = await ensureDirectoryChain(dir);
  const lockPath = join(dir, LOCK_NAME);
  let lockAcquired = false;
  let lockHandle = null;
  const activePartials = new Set();

  const cleanupSyncOnSignal = (signal) => {
    for (const p of activePartials) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Ignore best-effort cleanup error on terminating signal.
      }
    }
    activePartials.clear();
    if (lockAcquired) {
      lockAcquired = false;
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore best-effort lock unlink error on terminating signal.
      }
    }
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      try {
        rmdirSync(createdDirs[i]);
      } catch {
        // Ignore non-empty or already-removed directory on terminating signal.
      }
    }
    process.off("SIGINT", cleanupSyncOnSignal);
    process.off("SIGTERM", cleanupSyncOnSignal);
    process.kill(process.pid, signal);
  };

  const release = async ({ removeCreated = false } = {}) => {
    process.off("SIGINT", cleanupSyncOnSignal);
    process.off("SIGTERM", cleanupSyncOnSignal);
    for (const p of activePartials) {
      await rm(p, { recursive: true, force: true }).catch(() => {});
    }
    activePartials.clear();
    if (lockAcquired) {
      lockAcquired = false;
      await unlink(lockPath).catch(() => {});
    }
    if (removeCreated) {
      for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
        await rmdir(createdDirs[i]).catch(() => {});
      }
    }
  };

  try {
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
    try {
      lockHandle = await open(lockPath, flags, 0o600);
      lockAcquired = true;
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(`Output directory '${outputDir}' is locked by another running CLI process (or contains ${LOCK_NAME}).`);
      }
      throw error;
    }
    process.on("SIGINT", cleanupSyncOnSignal);
    process.on("SIGTERM", cleanupSyncOnSignal);

    await lockHandle.writeFile(JSON.stringify({ tool: "structure-tensor", pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }), "utf8");
    await lockHandle.close();
    lockHandle = null;

    if (!overwrite) {
      const entries = (await readdirFn(dir)).filter((name) => name !== LOCK_NAME);
      if (entries.length > 0) {
        throw new Error(`Output directory '${outputDir}' is not empty. Choose a new directory or pass --overwrite.`);
      }
    }
  } catch (error) {
    if (lockHandle) await lockHandle.close().catch(() => {});
    await release({ removeCreated: true });
    throw error;
  }
  return {
    dir,
    createdDirs,
    trackPartial: (p) => { activePartials.add(p); },
    untrackPartial: (p) => { activePartials.delete(p); },
    release,
  };
}

export async function commitOutputs(
  dir,
  files,
  { overwrite = false, renameFn = rename, writeFileFn = writeFile, trackPartial, untrackPartial } = {},
) {
  const token = randomBytes(6).toString("hex");
  for (const file of files) {
    const target = join(dir, file.name);
    try {
      const info = await lstat(target);
      if (info.isDirectory()) throw new Error(`Cannot write '${file.name}' because '${target}' is a directory.`);
      if (!overwrite) throw new Error(`Output file '${target}' already exists. Choose a new directory or pass --overwrite.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const staged = [];
  try {
    for (const file of files) {
      const partialPath = join(dir, `.${file.name}.${token}.partial`);
      const entry = { name: file.name, partialPath, finalPath: join(dir, file.name) };
      staged.push(entry);
      trackPartial?.(partialPath);
      await writeFileFn(partialPath, file.data, { flag: "wx" });
    }
  } catch (error) {
    for (const entry of staged) {
      await rm(entry.partialPath, { force: true }).catch(() => {});
      untrackPartial?.(entry.partialPath);
    }
    throw error;
  }

  const backedUp = [];
  const committed = [];
  try {
    if (overwrite) {
      for (const entry of staged) {
        let info = null;
        try {
          info = await lstat(entry.finalPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (info) {
          if (info.isDirectory()) throw new Error(`Cannot overwrite existing directory '${entry.finalPath}'.`);
          const backupPath = join(dir, `.${entry.name}.${token}.backup`);
          await renameFn(entry.finalPath, backupPath);
          backedUp.push({ finalPath: entry.finalPath, backupPath });
        }
      }
    }
    for (const entry of staged) {
      await renameFn(entry.partialPath, entry.finalPath);
      untrackPartial?.(entry.partialPath);
      committed.push(entry);
    }
  } catch (error) {
    for (let i = committed.length - 1; i >= 0; i -= 1) await unlink(committed[i].finalPath).catch(() => {});
    for (let i = backedUp.length - 1; i >= 0; i -= 1) await rename(backedUp[i].backupPath, backedUp[i].finalPath).catch(() => {});
    for (const entry of staged) {
      await rm(entry.partialPath, { force: true }).catch(() => {});
      untrackPartial?.(entry.partialPath);
    }
    throw error;
  }

  for (const backup of backedUp) await rm(backup.backupPath, { force: true }).catch(() => {});
  return committed.map((entry) => entry.finalPath);
}

/**
 * Runs 2D or 3D structure-tensor orientation analysis on one image (or a stack of 2D slices)
 * and writes all maps, colour map, orientation distribution CSV, and summary JSON atomically.
 */
export async function analyseStructureTensorFile({
  inputs,
  outputDir,
  options = {},
  onProgress,
  maxFileBytes = MAX_CLI_FILE_BYTES,
  renameFn = rename,
  readdirFn = readdir,
} = {}) {
  const parsed = parseCliOptions(options);
  const inputList = Array.isArray(inputs) ? inputs : [inputs];
  if (inputList.length === 0 || inputList.some((p) => typeof p !== "string" || !p.trim())) {
    throw new Error("Input file path is required.");
  }
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("Output directory path is required.");

  const { name, image } = await loadInputImages(inputList, { maxFileBytes });
  const refusal = imageRefusal(image, parsed.settings);
  if (refusal) throw new Error(refusal);

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn });
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
      trackPartial: reservation.trackPartial,
      untrackPartial: reservation.untrackPartial,
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
export async function checkInstallation(opts = {}) {
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new Error("Options must be a plain object.");
  }
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined && key !== "cacheDir") {
      throw new Error(`Unknown option '${key}' for checkInstallation.`);
    }
  }
  const cacheDir = opts.cacheDir !== undefined ? assertNonEmptyString(opts.cacheDir, "cache-dir") : undefined;
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
