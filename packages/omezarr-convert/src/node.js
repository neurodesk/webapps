// Node command-line interface for @neurodesk/omezarr-convert.
// Runs the exact same readers, NGFF 0.4/0.5 multiscale writer and zip packager as the web app.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { InputTooLargeError, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { parseNiftiHeader } from "@neurodesk/webapp-components/file-io/nifti";
import packageJson from "../package.json" with { type: "json" };
import { VERSIONS } from "./ngff.js";
import { METHODS } from "./pyramid.js";
import { fileKind, openSource } from "./sources/index.js";
import { archiveBudget, conversionOptions, DEFAULTS, GENERATOR, writeOmeZarr } from "./writer.js";
import { archiveName, ZIP_MAX_ENTRIES, zipStore } from "./zip.js";

export const MAX_CLI_FILE_BYTES = MAX_INPUT_BYTES;
export const OUTPUT_FORMATS = Object.freeze(["archive", "dir"]);
const LOCK_NAME = ".omezarr-convert-run.lock";
const CHUNK_CHOICES = Object.freeze([128, 256, 512, 1024]);

export const OPTIONS = Object.freeze({
  version: {
    type: "string",
    enum: [...VERSIONS],
    default: DEFAULTS.version,
    description: "OME-NGFF version: 0.5 (Zarr v3) or 0.4 (Zarr v2).",
  },
  method: {
    type: "string",
    enum: [...METHODS],
    default: DEFAULTS.method,
    description: "Pyramid downsampling method: mean (intensity) or nearest (labels).",
  },
  chunk: {
    type: "integer",
    enum: [...CHUNK_CHOICES],
    default: DEFAULTS.chunk,
    description: "Chunk size in Y and X in pixels (128, 256, 512 or 1024).",
  },
  compressionLevel: {
    type: "integer",
    flag: "compression-level",
    minimum: 0,
    maximum: 9,
    default: DEFAULTS.compressionLevel,
    description: "zlib (0.4) or gzip (0.5) compression level (0 to 9).",
  },
  format: {
    type: "string",
    enum: [...OUTPUT_FORMATS],
    default: "archive",
    description: "Output layout: archive (.ozx / .ome.zarr.zip) or dir (<stem>.ome.zarr/).",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Offline mode (omezarr-convert never uses the network).",
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

function parseIntOption(raw, flag) {
  if (raw === undefined) return undefined;
  const trimmed = assertNonEmptyString(raw, flag);
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`--${flag} must be an integer, got '${raw}'.`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new Error(`--${flag} must be a safe integer, got '${raw}'.`);
  return value;
}

export function parseCliOptions(values = {}) {
  const versionRaw = assertNonEmptyString(values.version, "version");
  const version = versionRaw ?? DEFAULTS.version;
  if (!VERSIONS.includes(version)) {
    throw new Error(`--version must be one of: ${VERSIONS.join(", ")}.`);
  }

  const methodRaw = assertNonEmptyString(values.method, "method");
  const method = methodRaw ?? DEFAULTS.method;
  if (!METHODS.includes(method)) {
    throw new Error(`--method must be one of: ${METHODS.join(", ")}.`);
  }

  const chunk = parseIntOption(values.chunk, "chunk") ?? DEFAULTS.chunk;
  if (!CHUNK_CHOICES.includes(chunk)) {
    throw new Error(`--chunk must be one of: ${CHUNK_CHOICES.join(", ")}.`);
  }

  const compressionLevel = parseIntOption(
    values["compression-level"] ?? values.compressionLevel,
    "compression-level",
  ) ?? DEFAULTS.compressionLevel;
  if (compressionLevel < 0 || compressionLevel > 9) {
    throw new Error("--compression-level must be an integer from 0 to 9.");
  }

  const formatRaw = assertNonEmptyString(values.format, "format");
  const format = formatRaw ?? "archive";
  if (!OUTPUT_FORMATS.includes(format)) {
    throw new Error(`--format must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
  }

  const settings = conversionOptions({ version, method, chunk, compressionLevel });
  return {
    settings,
    format,
    overwrite: Boolean(values.overwrite),
    offline: Boolean(values.offline),
  };
}

/**
 * Bounded native gunzip with CRC32/ISIZE validation and strict maxOutputLength enforcement.
 */
export function gunzipBounded(bytes, maxOutputLength = MAX_CLI_FILE_BYTES, subject = "Compressed file") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    const out = gunzipSync(view, { maxOutputLength });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new InputTooLargeError(maxOutputLength + 1, maxOutputLength, { subject });
    }
    throw new Error(`${subject}: invalid gzip stream (${error.message}).`, { cause: error });
  }
}

/**
 * NiBabel affine precedence (`sform > qform > LAS-centered fallback`) for NIfTI-1 inspection.
 */
export function niftiAffine(headerBuffer) {
  const header = parseNiftiHeader(headerBuffer);
  if (header.sformCode > 0 || header.qformCode > 0) return header.affine;
  const dx = Math.abs(header.pixDims[1]) || 1;
  const dy = Math.abs(header.pixDims[2]) || 1;
  const dz = Math.abs(header.pixDims[3]) || 1;
  const nx = Math.max(1, header.nx);
  const ny = Math.max(1, header.ny);
  const nz = Math.max(1, header.nz);
  return [
    new Float64Array([-dx, 0, 0, ((nx - 1) / 2) * dx]),
    new Float64Array([0, dy, 0, -((ny - 1) / 2) * dy]),
    new Float64Array([0, 0, dz, -((nz - 1) / 2) * dz]),
    new Float64Array([0, 0, 0, 1]),
  ];
}

async function readBoundedFile(filePath, maxFileBytes = MAX_CLI_FILE_BYTES) {
  const resolved = resolve(filePath);
  const name = basename(resolved);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
  const fh = await open(resolved, flags);
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error(`${name} is not a regular file.`);
    if (info.size === 0) throw new Error(`${name} is empty.`);
    if (info.size > maxFileBytes) {
      throw new InputTooLargeError(info.size, maxFileBytes, { subject: name });
    }
    const chunks = [];
    let total = 0;
    const chunkSize = Math.min(info.size + 1, 4 * 1024 * 1024);
    while (true) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxFileBytes) {
        throw new InputTooLargeError(total, maxFileBytes, { subject: name });
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
    const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
    let bytes = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
    let effectiveName = name;
    if (/\.nii\.gz$/i.test(name) || (fileKind(name) === "nifti" && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      const inflated = gunzipBounded(bytes, maxFileBytes, name);
      bytes = new Uint8Array(inflated);
      effectiveName = name.replace(/\.gz$/i, "");
    }
    return new File([bytes], effectiveName);
  } finally {
    await fh.close();
  }
}

async function resolveInputFiles(inputs, maxFileBytes) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  if (!list.length) throw new Error("Provide at least one input file or directory.");
  const paths = [];
  for (const item of list) {
    if (!item || !String(item).trim()) throw new Error("Input path must be non-empty.");
    const resolved = resolve(item);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      const entries = await readdir(resolved, { withFileTypes: true });
      const images = entries
        .filter((e) => e.isFile() && !e.name.startsWith(".") && fileKind(e.name))
        .map((e) => join(resolved, e.name))
        .sort();
      if (!images.length) throw new Error(`Directory '${item}' contains no supported TIFF, PNG, JPEG or NIfTI files.`);
      paths.push(...images);
    } else {
      paths.push(resolved);
    }
  }
  const files = [];
  for (const p of paths) files.push(await readBoundedFile(p, maxFileBytes));
  return files;
}

async function mkdirTracking(targetDir) {
  const created = [];
  let cursor = resolve(targetDir);
  const toCreate = [];
  while (true) {
    try {
      const info = await stat(cursor);
      if (!info.isDirectory()) {
        throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      toCreate.push(cursor);
      cursor = parent;
    }
  }
  for (let i = toCreate.length - 1; i >= 0; i -= 1) {
    try {
      await mkdir(toCreate[i]);
      created.push(toCreate[i]);
    } catch (error) {
      if (error.code === "EEXIST") {
        const info = await stat(toCreate[i]);
        if (!info.isDirectory()) {
          throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
        }
      } else {
        for (let j = created.length - 1; j >= 0; j -= 1) {
          await rmdir(created[j]).catch(() => {});
        }
        throw error;
      }
    }
  }
  return created;
}

/**
 * Exclusively claims `outputDir` with an O_EXCL lock file. Cleans up the lock and any
 * directories newly created by this call on any error (including readdir failures).
 */
export async function claimOutputDir(outputDir, { overwrite = false, readdirFn = readdir } = {}) {
  if (!outputDir || !String(outputDir).trim()) throw new Error("Output directory path is required.");
  const dir = resolve(outputDir);
  const createdDirs = await mkdirTracking(dir);
  const cleanupCreated = async () => {
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      await rmdir(createdDirs[i]).catch(() => {});
    }
  };

  const lockPath = join(dir, LOCK_NAME);
  let lockHandle;
  try {
    lockHandle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    await cleanupCreated();
    if (error.code === "EEXIST") {
      throw new Error(`Output directory '${outputDir}' is locked by another running omezarr-convert process (or contains ${LOCK_NAME}).`);
    }
    throw error;
  }

  let lockHeld = true;
  const release = async ({ removeCreated = false } = {}) => {
    if (lockHeld) {
      lockHeld = false;
      await unlink(lockPath).catch(() => {});
    }
    if (removeCreated) await cleanupCreated();
  };

  try {
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`, "utf8");
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

async function assertTargetsWritable(dir, items, overwrite) {
  for (const item of items) {
    const target = join(dir, item.name);
    try {
      const info = await lstat(target);
      if (!overwrite) {
        throw new Error(`Output '${target}' already exists. Choose a new directory or pass --overwrite.`);
      }
      if (item.kind !== "dir" && info.isDirectory()) {
        throw new Error(`Cannot write file '${item.name}' because '${target}' is a directory.`);
      }
      if (item.kind === "dir" && !info.isDirectory()) {
        throw new Error(`Cannot write directory '${item.name}' because '${target}' is a file.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Stages every output to `.partial` entries inside `dir`, then renames them into place.
 * If any rename fails, rolls back all already-renamed outputs and restores any overwritten backups.
 */
export async function commitOutputs(dir, items, { overwrite = false, renameFn = rename } = {}) {
  const token = randomBytes(6).toString("hex");
  await assertTargetsWritable(dir, items, overwrite);

  const staged = [];
  try {
    for (const item of items) {
      const partialPath = join(dir, `.${item.name}.${token}.partial`);
      if (item.kind === "dir") {
        await mkdir(partialPath, { recursive: false });
        staged.push({ ...item, partialPath, finalPath: join(dir, item.name) });
        for (const [key, bytes] of item.entries) {
          const dest = join(partialPath, ...key.split("/"));
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, bytes, { flag: "wx" });
        }
      } else {
        await writeFile(partialPath, item.data, { flag: "wx" });
        staged.push({ ...item, partialPath, finalPath: join(dir, item.name) });
      }
    }
  } catch (error) {
    for (const entry of staged) {
      await rm(entry.partialPath, { recursive: true, force: true }).catch(() => {});
    }
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
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      await rm(committed[i].finalPath, { recursive: true, force: true }).catch(() => {});
    }
    for (let i = backedUp.length - 1; i >= 0; i -= 1) {
      await rename(backedUp[i].backupPath, backedUp[i].finalPath).catch(() => {});
    }
    for (const entry of staged) {
      await rm(entry.partialPath, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }

  for (const backup of backedUp) {
    await rm(backup.backupPath, { recursive: true, force: true }).catch(() => {});
  }
  return committed.map((entry) => entry.finalPath);
}

/**
 * Converts one input file (or sequence / directory of slices) to an OME-Zarr archive or directory
 * and writes a JSON conversion summary into `outputDir`.
 */
export async function convertFiles({
  inputs,
  outputDir,
  options = {},
  onProgress,
  maxFileBytes = MAX_CLI_FILE_BYTES,
  renameFn = rename,
  readdirFn = readdir,
} = {}) {
  const { settings, format, overwrite } = parseCliOptions(options);
  if (!outputDir || !String(outputDir).trim()) throw new Error("Output directory path is required.");
  const files = await resolveInputFiles(inputs, maxFileBytes);
  const source = await openSource(files);

  if (format === "archive") {
    const budget = archiveBudget(source.shape, source.dtype, settings);
    if (budget.entries > ZIP_MAX_ENTRIES) {
      throw new Error(`The store has ${budget.entries} files; a zip archive holds at most ${ZIP_MAX_ENTRIES}. Use --format dir instead.`);
    }
  }

  const reservation = await claimOutputDir(outputDir, { overwrite, readdirFn });
  let committed = false;
  try {
    const started = performance.now();
    const storeMap = new Map();
    const store = { set: (key, value) => { storeMap.set(key, value); } };
    const written = await writeOmeZarr(source, store, settings, { onProgress });
    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const safeStem = (source.stem || "image").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
    const summaryName = `${safeStem}_summary.json`;
    const primaryName = format === "dir" ? `${safeStem}.ome.zarr` : archiveName(safeStem, settings.version);

    const summary = {
      generator: GENERATOR,
      input: source.files ?? [files[0].name],
      format: source.format,
      output: primaryName,
      outputFormat: format,
      ngffVersion: settings.version,
      method: settings.method,
      chunk: settings.chunk,
      compressionLevel: settings.compressionLevel,
      dtype: source.dtype,
      shape: source.shape,
      scale: source.scale,
      units: source.units,
      levels: written.plan.map((level, index) => ({ level: String(index), shape: level.shape, chunks: level.chunks })),
      ranges: written.ranges,
      chunksWritten: written.chunksWritten,
      bytesWritten: written.bytesWritten,
      notes: source.notes,
      seconds,
    };

    const outputItems = [];
    if (format === "dir") {
      outputItems.push({ kind: "dir", name: primaryName, entries: storeMap });
    } else {
      const blob = await zipStore(storeMap, settings.version);
      outputItems.push({ kind: "file", name: primaryName, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    outputItems.push({ kind: "file", name: summaryName, data: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8") });

    const writtenPaths = await commitOutputs(reservation.dir, outputItems, { overwrite, renameFn });
    committed = true;
    return {
      outputDir: reservation.dir,
      outputs: writtenPaths,
      primaryOutput: writtenPaths[0],
      summary,
      seconds,
    };
  } finally {
    await reservation.release({ removeCreated: !committed });
  }
}

/**
 * Offline self-check: verifies NGFF 0.5 and 0.4 pyramid writing and zip packaging on a tiny synthetic plane.
 */
export async function checkInstallation({ cacheDir } = {}) {
  const resolvedCache = cacheDir ? resolve(cacheDir) : undefined;
  const plane = Uint16Array.from({ length: 16 * 16 }, (_, i) => i * 16);
  const source = {
    name: "self-check",
    stem: "self-check",
    format: "synthetic",
    dtype: "uint16",
    shape: { t: 1, c: 1, z: 1, y: 16, x: 16 },
    scale: { t: null, z: null, y: 0.5, x: 0.5 },
    units: { t: null, z: null, y: "micrometer", x: "micrometer" },
    channels: [{ label: "Intensity", color: null }],
    notes: [],
    readPlane: async () => plane,
  };
  for (const version of VERSIONS) {
    const map = new Map();
    const res = await writeOmeZarr(source, { set: (k, v) => map.set(k, v) }, { version, method: "mean", chunk: 16 });
    if (res.chunksWritten < 1) throw new Error(`Self-check failed for NGFF ${version}: no chunks written.`);
    const blob = await zipStore(map, version);
    if (blob.size < 64) throw new Error(`Self-check failed for NGFF ${version}: empty archive.`);
  }
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    executable: process.execPath,
    node: process.version,
    versions: [...VERSIONS],
    methods: [...METHODS],
    ...(resolvedCache ? { cacheDir: resolvedCache } : {}),
  };
}
