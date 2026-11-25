// Node command-line interface for @neurodesk/structure-tensor.
// Runs the exact same 2D/3D Gaussian structure-tensor analysis as the Structure Tensor web application,
// using pure-Node TIFF/NIfTI/PNG/JPEG I/O with atomic output staging and exclusive directory locking.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  createNiftiFromData,
  createRgb24Nifti,
  isGzipped,
  parseNiftiHeader,
  parseNiftiVolume,
} from "@neurodesk/webapp-components/file-io";
import { InputTooLargeError, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
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
const LOCK_NAME = ".structure-tensor-run.lock";

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

export function optionName(key) {
  return OPTIONS[key]?.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function assertNonEmptyString(raw, flag) {
  if (raw === undefined) return undefined;
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

function parseNumeric(raw, flag) {
  if (raw === undefined) return undefined;
  const trimmed = assertNonEmptyString(raw, flag);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`--${flag} must be a finite number, got '${raw}'.`);
  return value;
}

export function parseCliOptions(values = {}) {
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
  return {
    settings,
    overwrite: Boolean(values.overwrite),
    offline: Boolean(values.offline),
  };
}

/**
 * Computes a NIfTI-1 4x4 affine following NiBabel's precedence:
 *   1. sform (when sform_code > 0)
 *   2. qform (when qform_code > 0)
 *   3. LAS-centered fallback (diag(-pixdim1, pixdim2, pixdim3) centered on the volume midpoint)
 */
export function extractNibabelAffine(bufferLike) {
  const view = bufferLike instanceof DataView
    ? bufferLike
    : new DataView(bufferLike.buffer ?? bufferLike, bufferLike.byteOffset ?? 0, bufferLike.byteLength);
  const le = view.getInt32(0, true) === 348;
  const be = view.getInt32(0, false) === 348;
  if (!le && !be) throw new Error("Invalid NIfTI-1 header (sizeof_hdr != 348).");
  const littleEndian = le;
  const sformCode = view.getInt16(254, littleEndian);
  const qformCode = view.getInt16(252, littleEndian);

  if (sformCode > 0) {
    return [
      [view.getFloat32(280, littleEndian), view.getFloat32(284, littleEndian), view.getFloat32(288, littleEndian), view.getFloat32(292, littleEndian)],
      [view.getFloat32(296, littleEndian), view.getFloat32(300, littleEndian), view.getFloat32(304, littleEndian), view.getFloat32(308, littleEndian)],
      [view.getFloat32(312, littleEndian), view.getFloat32(316, littleEndian), view.getFloat32(320, littleEndian), view.getFloat32(324, littleEndian)],
      [0, 0, 0, 1],
    ];
  }

  if (qformCode > 0) {
    const b = view.getFloat32(256, littleEndian);
    const c = view.getFloat32(260, littleEndian);
    const d = view.getFloat32(264, littleEndian);
    const aSq = Math.max(0, 1 - (b * b + c * c + d * d));
    const a = Math.sqrt(aSq);
    const qfac = view.getFloat32(76, littleEndian) < 0 ? -1 : 1;
    const dx = Math.abs(view.getFloat32(80, littleEndian)) || 1;
    const dy = Math.abs(view.getFloat32(84, littleEndian)) || 1;
    const dz = (Math.abs(view.getFloat32(88, littleEndian)) || 1) * qfac;
    const qx = view.getFloat32(268, littleEndian);
    const qy = view.getFloat32(272, littleEndian);
    const qz = view.getFloat32(276, littleEndian);
    return [
      [(a * a + b * b - c * c - d * d) * dx, 2 * (b * c - a * d) * dy, 2 * (b * d + a * c) * dz, qx],
      [2 * (b * c + a * d) * dx, (a * a + c * c - b * b - d * d) * dy, 2 * (c * d - a * b) * dz, qy],
      [2 * (b * d - a * c) * dx, 2 * (c * d + a * b) * dy, (a * a + d * d - b * b - c * c) * dz, qz],
      [0, 0, 0, 1],
    ];
  }

  // NiBabel base/fallback affine: LAS centered at (dims - 1) / 2
  const nx = Math.max(1, view.getInt16(42, littleEndian));
  const ny = Math.max(1, view.getInt16(44, littleEndian));
  const nz = Math.max(1, view.getInt16(46, littleEndian));
  const dx = Math.abs(view.getFloat32(80, littleEndian)) || 1;
  const dy = Math.abs(view.getFloat32(84, littleEndian)) || 1;
  const dz = Math.abs(view.getFloat32(88, littleEndian)) || 1;
  return [
    [-dx, 0, 0, ((nx - 1) / 2) * dx],
    [0, dy, 0, -((ny - 1) / 2) * dy],
    [0, 0, dz, -((nz - 1) / 2) * dz],
    [0, 0, 0, 1],
  ];
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

function readBoundedFile(filePath, maxBytes = MAX_CLI_FILE_BYTES) {
  return (async () => {
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
  })();
}

function isPngBytes(bytes) {
  return bytes.byteLength >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function decodePngGreyscale(bytes) {
  if (bytes.byteLength >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = view.getUint32(16, false);
    const h = view.getUint32(20, false);
    const tooLarge = voxelRefusal([w, h, 1]);
    if (tooLarge) throw new Error(tooLarge);
  }
  const png = decodePng(bytes);
  const { width, height, channels, depth, data, palette } = png;
  const tooLarge = voxelRefusal([width, height, 1]);
  if (tooLarge) throw new Error(tooLarge);

  const n = width * height;
  const out = new Float64Array(n);

  if (palette && palette.length > 0) {
    const indices = unpackSubByte(data, n, depth);
    for (let i = 0; i < n; i += 1) {
      const entry = palette[indices[i]] ?? [0, 0, 0];
      out[i] = (entry[0] + entry[1] + entry[2]) / 3;
    }
  } else if (depth < 8) {
    const unpacked = unpackSubByte(data, n * channels, depth);
    const scale = 255 / ((1 << depth) - 1);
    for (let i = 0; i < n; i += 1) {
      if (channels === 1 || channels === 2) {
        out[i] = unpacked[i * channels] * scale;
      } else {
        const base = i * channels;
        out[i] = ((unpacked[base] + unpacked[base + 1] + unpacked[base + 2]) / 3) * scale;
      }
    }
  } else {
    const scale = depth === 16 ? 1 / 257 : 1;
    for (let i = 0; i < n; i += 1) {
      if (channels === 1 || channels === 2) {
        out[i] = data[i * channels] * scale;
      } else {
        const base = i * channels;
        out[i] = ((data[base] + data[base + 1] + data[base + 2]) / 3) * scale;
      }
    }
  }
  return { data: out, dims: [width, height, 1], spacing: [1, 1, 1], unit: "pixel" };
}

function unpackSubByte(packed, count, depth) {
  const out = new Uint8Array(count);
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  for (let i = 0; i < count; i += 1) {
    const byteIdx = Math.floor(i / perByte);
    const shift = 8 - depth - (i % perByte) * depth;
    out[i] = (packed[byteIdx] >> shift) & mask;
  }
  return out;
}

function decodeJpegGreyscale(bytes) {
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

/** Reads a single image file (TIFF, NIfTI, PNG, or JPEG) in pure Node. */
export async function readImageFile(filePath, { maxFileBytes = MAX_CLI_FILE_BYTES } = {}) {
  const { name, bytes, arrayBuffer } = await readBoundedFile(filePath, maxFileBytes);
  const kind = inputKind(name);
  if (!kind) throw new Error(`${name} is not a TIFF, NIfTI, PNG or JPEG image.`);

  if (kind === "nifti") {
    const raw = isGzipped(bytes) ? boundedGunzip(bytes, maxFileBytes) : bytes;
    const rawBuf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const hdr = parseNiftiHeader(rawBuf);
    const rank = Math.max(1, Math.min(7, hdr.dims[0]));
    const dimsFromHdr = Array.from({ length: rank }, (_, k) => Math.max(1, hdr.dims[k + 1]));
    const tooLarge = voxelRefusal(dimsFromHdr);
    if (tooLarge) throw new Error(`${name}: ${tooLarge}`);
    const affine = extractNibabelAffine(rawBuf);
    const volume = parseNiftiVolume(rawBuf, { OutputCtor: Float64Array });
    // Enforce finiteness on Float64 AND after Float32 narrowing.
    refuseNonFinite(name, { data: volume.imageData });
    toCheckedFloat32(volume.imageData, `${name} input volume`);
    return {
      name,
      image: {
        data: volume.imageData,
        dims: volume.dims,
        spacing: volume.voxelSize,
        unit: "mm",
        kind: "nifti",
        header: volume.headerBytes,
        affine,
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
  const dir = resolve(outputDir);
  const createdDirs = await ensureDirectoryChain(dir);
  const lockPath = join(dir, LOCK_NAME);
  let lockAcquired = false;
  let lockHandle = null;

  const release = async ({ removeCreated = false } = {}) => {
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
        throw new Error(`Output directory '${outputDir}' is already in use by another structure-tensor process.`);
      }
      throw error;
    }
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }), "utf8");
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
  return { dir, createdDirs, release };
}

export async function commitOutputs(dir, files, { overwrite = false, renameFn = rename } = {}) {
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
      await writeFile(partialPath, file.data, { flag: "wx" });
      staged.push({ name: file.name, partialPath, finalPath: join(dir, file.name) });
    }
  } catch (error) {
    for (const entry of staged) await rm(entry.partialPath, { force: true }).catch(() => {});
    throw error;
  }

  const backedUp = [];
  const committed = [];
  try {
    if (overwrite) {
      for (const entry of staged) {
        let exists = false;
        try {
          await lstat(entry.finalPath);
          exists = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (exists) {
          const backupPath = join(dir, `.${entry.name}.${token}.backup`);
          await renameFn(entry.finalPath, backupPath);
          backedUp.push({ finalPath: entry.finalPath, backupPath });
        }
      }
    }
    for (const entry of staged) {
      await renameFn(entry.partialPath, entry.finalPath);
      committed.push(entry);
    }
  } catch (error) {
    for (let i = committed.length - 1; i >= 0; i -= 1) await unlink(committed[i].finalPath).catch(() => {});
    for (let i = backedUp.length - 1; i >= 0; i -= 1) await rename(backedUp[i].backupPath, backedUp[i].finalPath).catch(() => {});
    for (const entry of staged) await rm(entry.partialPath, { force: true }).catch(() => {});
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
  if (inputList.length === 0 || inputList.some((p) => !p || !String(p).trim())) {
    throw new Error("Input file path is required.");
  }
  if (!outputDir || !String(outputDir).trim()) throw new Error("Output directory path is required.");

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
    const plan = outputPlan(name, result.dimensions, mapFormat);
    const outputFiles = [];

    const encodeMap = (key, values) => {
      const f32 = toCheckedFloat32(values, key);
      if (mapFormat === "nifti") {
        const nii = createNiftiFromData(f32, image.header, { dims: image.dims, range: "auto", clampCalMax: false });
        return gzipSync(new Uint8Array(nii));
      }
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
      const colourData = mapFormat === "nifti"
        ? gzipSync(new Uint8Array(createRgb24Nifti(result.colour, image.header, image.dims)))
        : Buffer.from(writeTiff({ data: result.colour, dims: image.dims, spacing: image.spacing, unit: image.unit, rgb: true }));
      outputFiles.push({ name: plan.colour[0], data: colourData });

      const vectorFrames = toCheckedFloat32(frameMajor(result.maps.vectors), "vectors");
      const vectorsNii = createNiftiFromData(vectorFrames, image.header, {
        dims: [...image.dims, 3],
        range: "auto",
        clampCalMax: false,
      });
      outputFiles.push({ name: plan.vectors[0], data: gzipSync(new Uint8Array(vectorsNii)) });
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

    const written = await commitOutputs(reservation.dir, outputFiles, { overwrite: parsed.overwrite, renameFn });
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
export async function checkInstallation({ cacheDir } = {}) {
  const resolvedCache = cacheDir ? resolve(cacheDir) : undefined;
  const n = 32;
  const data = new Float64Array(n * n);
  const theta = (45 * Math.PI) / 180;
  const freq = (2 * Math.PI) / 6;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      // Stripes oriented at +45° (ccw from +x, y downward) vary perpendicular to (+cos, -sin).
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
