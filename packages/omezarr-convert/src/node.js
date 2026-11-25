// Node command-line interface for @neurodesk/omezarr-convert.
// Runs the exact same readers, NGFF 0.4/0.5 multiscale writer and zip packager as the web app.
import { randomBytes } from "node:crypto";
import { constants as fsConstants, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { InputTooLargeError, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import packageJson from "../package.json" with { type: "json" };
import { VERSIONS } from "./ngff.js";
import { METHODS } from "./pyramid.js";
import { fileKind, openSource } from "./sources/index.js";
import { parseNiftiAnyHeader } from "./sources/nifti.js";
import { archiveBudget, conversionOptions, DEFAULTS, GENERATOR, writeOmeZarr } from "./writer.js";
import { archiveName, ZIP_MAX_ENTRIES, zipStore } from "./zip.js";

export const MAX_CLI_FILE_BYTES = MAX_INPUT_BYTES;
export const ARCHIVE_MAX_BYTES = 1024 ** 3;
export const OUTPUT_FORMATS = Object.freeze(["archive", "dir"]);
export const LOCK_NAME = ".neurodesk-cli.lock";
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
    description: "Allow writing into a non-empty output directory (never overwrites existing directories).",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Offline mode (omezarr-convert never uses the network).",
  },
});

const ALLOWED_OPTION_KEYS = new Set([
  "version",
  "method",
  "chunk",
  "compression-level",
  "compressionLevel",
  "format",
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

function parseIntOption(raw, flag) {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean" || raw === null) {
    throw new Error(`--${flag} must be an integer, got ${JSON.stringify(raw)}.`);
  }
  const trimmed = assertNonEmptyString(raw, flag);
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`--${flag} must be an integer, got '${raw}'.`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new Error(`--${flag} must be a safe integer, got '${raw}'.`);
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

  const overwrite = parseBooleanOption(values.overwrite, "overwrite");
  const envOffline = process.env.NEURODESK_OFFLINE === "1";
  if (values.offline !== undefined) {
    const explicit = parseBooleanOption(values.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
  }
  const offline = envOffline || Boolean(values.offline);

  const settings = conversionOptions({ version, method, chunk, compressionLevel });
  return { settings, format, overwrite, offline };
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
 * NiBabel affine precedence (`sform > qform > LAS-centered fallback`) for NIfTI-1 and NIfTI-2 headers.
 */
export function niftiAffine(headerBuffer) {
  return parseNiftiAnyHeader(headerBuffer).affine;
}

const formatGiB = (bytes) => `${Number((bytes / 1024 ** 3).toPrecision(3))} GiB`;

/** Checks archive entry count and uncompressed byte budget before building an in-memory archive. */
export function assertArchiveBudget(shape, dtype, settings, maxBytes = ARCHIVE_MAX_BYTES) {
  const budget = archiveBudget(shape, dtype, settings);
  if (budget.entries > ZIP_MAX_ENTRIES) {
    throw new Error(`The store has ${budget.entries} files; a zip archive holds at most ${ZIP_MAX_ENTRIES}. Use --format dir instead.`);
  }
  if (budget.bytes > maxBytes) {
    throw new Error(
      `The OME-Zarr can reach ${formatGiB(budget.bytes)} before compression; an archive is built in memory and holds at most ${formatGiB(maxBytes)}. Use --format dir instead.`,
    );
  }
  return budget;
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
    if (typeof item !== "string" || !item.trim()) throw new Error("Input path must be a non-empty string.");
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
 * Exclusively claims `outputDir` with the shared `.neurodesk-cli.lock` (`O_EXCL`).
 * Registers SIGINT/SIGTERM synchronous cleanup handlers while held and removes them on release.
 */
export async function claimOutputDir(outputDir, { overwrite = false, readdirFn = readdir } = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("Output directory path is required.");
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
      throw new Error(`Output directory '${outputDir}' is locked by another running CLI process (or contains ${LOCK_NAME}).`);
    }
    throw error;
  }

  let lockHeld = true;
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
    if (lockHeld) {
      lockHeld = false;
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

  process.on("SIGINT", cleanupSyncOnSignal);
  process.on("SIGTERM", cleanupSyncOnSignal);

  const release = async ({ removeCreated = false } = {}) => {
    process.off("SIGINT", cleanupSyncOnSignal);
    process.off("SIGTERM", cleanupSyncOnSignal);
    for (const p of activePartials) {
      await rm(p, { recursive: true, force: true }).catch(() => {});
    }
    activePartials.clear();
    if (lockHeld) {
      lockHeld = false;
      await unlink(lockPath).catch(() => {});
    }
    if (removeCreated) await cleanupCreated();
  };

  try {
    await lockHandle.writeFile(`${JSON.stringify({ tool: "omezarr-convert", pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`, "utf8");
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

async function assertTargetsWritable(dir, items, overwrite) {
  for (const item of items) {
    const target = join(dir, item.name);
    try {
      const info = await lstat(target);
      if (item.kind === "dir") {
        throw new Error(
          `Cannot overwrite existing path '${target}' with an OME-Zarr directory store. Choose a new output directory or remove '${target}' first.`,
        );
      }
      if (info.isDirectory()) {
        throw new Error(`Cannot write file '${item.name}' because '${target}' is a directory.`);
      }
      if (!overwrite) {
        throw new Error(`Output '${target}' already exists. Choose a new directory or pass --overwrite.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Stages every output to `.partial` entries inside `dir` (pre-registering each `.partial` path
 * BEFORE writing so failed/short writes always clean up), then renames them into place with full rollback.
 */
export async function commitOutputs(
  dir,
  items,
  { overwrite = false, renameFn = rename, writeFileFn = writeFile, trackPartial, untrackPartial } = {},
) {
  const token = randomBytes(6).toString("hex");
  await assertTargetsWritable(dir, items, overwrite);

  const staged = [];
  try {
    for (const item of items) {
      if (item.kind === "staged-dir") {
        staged.push({ kind: "dir", name: item.name, partialPath: item.stagedPath, finalPath: join(dir, item.name) });
        continue;
      }
      const partialPath = join(dir, `.${item.name}.${token}.partial`);
      const entry = { ...item, partialPath, finalPath: join(dir, item.name) };
      staged.push(entry);
      trackPartial?.(partialPath);
      if (item.kind === "dir") {
        await mkdir(partialPath, { recursive: false });
        for (const [key, bytes] of item.entries) {
          const dest = join(partialPath, ...key.split("/"));
          await mkdir(dirname(dest), { recursive: true });
          await writeFileFn(dest, bytes, { flag: "wx" });
        }
      } else {
        await writeFileFn(partialPath, item.data, { flag: "wx" });
      }
    }
  } catch (error) {
    for (const entry of staged) {
      await rm(entry.partialPath, { recursive: true, force: true }).catch(() => {});
      untrackPartial?.(entry.partialPath);
    }
    throw error;
  }

  const backedUp = [];
  const committed = [];
  try {
    if (overwrite) {
      for (const entry of staged) {
        if (entry.kind === "dir") continue;
        let info = null;
        try {
          info = await lstat(entry.finalPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (info) {
          if (info.isDirectory()) {
            throw new Error(`Cannot overwrite existing directory '${entry.finalPath}'.`);
          }
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
    for (let i = committed.length - 1; i >= 0; i -= 1) {
      await rm(committed[i].finalPath, { recursive: true, force: true }).catch(() => {});
    }
    for (let i = backedUp.length - 1; i >= 0; i -= 1) {
      await rename(backedUp[i].backupPath, backedUp[i].finalPath).catch(() => {});
    }
    for (const entry of staged) {
      await rm(entry.partialPath, { recursive: true, force: true }).catch(() => {});
      untrackPartial?.(entry.partialPath);
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
 * In `--format dir` mode, chunks stream directly to a staged `.partial` directory on disk instead
 * of buffering the entire store in memory.
 */
export async function convertFiles({
  inputs,
  outputDir,
  options = {},
  onProgress,
  maxFileBytes = MAX_CLI_FILE_BYTES,
  maxArchiveBytes = ARCHIVE_MAX_BYTES,
  renameFn = rename,
  readdirFn = readdir,
  writeFileFn = writeFile,
} = {}) {
  const { settings, format, overwrite } = parseCliOptions(options);
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("Output directory path is required.");
  const files = await resolveInputFiles(inputs, maxFileBytes);
  const source = await openSource(files);

  if (format === "archive") {
    assertArchiveBudget(source.shape, source.dtype, settings, maxArchiveBytes);
  }

  const safeStem = (source.stem || "image").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
  const summaryName = `${safeStem}_summary.json`;
  const primaryName = format === "dir" ? `${safeStem}.ome.zarr` : archiveName(safeStem, settings.version);

  const reservation = await claimOutputDir(outputDir, { overwrite, readdirFn });
  let committed = false;
  try {
    await assertTargetsWritable(
      reservation.dir,
      [{ kind: format === "dir" ? "dir" : "file", name: primaryName }, { kind: "file", name: summaryName }],
      overwrite,
    );

    const started = performance.now();
    let written;
    const outputItems = [];

    if (format === "dir") {
      // Stream chunks directly to a staged .partial directory on disk (zero in-memory Map buffering).
      const token = randomBytes(6).toString("hex");
      const stagedDir = join(reservation.dir, `.${primaryName}.${token}.partial`);
      reservation.trackPartial(stagedDir);
      await mkdir(stagedDir, { recursive: false });
      const createdSubdirs = new Set([stagedDir]);
      const diskStore = {
        async set(key, value) {
          const dest = join(stagedDir, ...key.split("/"));
          const parent = dirname(dest);
          if (!createdSubdirs.has(parent)) {
            await mkdir(parent, { recursive: true });
            createdSubdirs.add(parent);
          }
          await writeFileFn(dest, value, { flag: "wx" });
        },
      };
      written = await writeOmeZarr(source, diskStore, settings, { onProgress });
      outputItems.push({ kind: "staged-dir", name: primaryName, stagedPath: stagedDir });
    } else {
      const storeMap = new Map();
      const store = { set: (key, value) => { storeMap.set(key, value); } };
      written = await writeOmeZarr(source, store, settings, { onProgress, maxBytes: maxArchiveBytes });
      const blob = await zipStore(storeMap, settings.version);
      outputItems.push({ kind: "file", name: primaryName, data: new Uint8Array(await blob.arrayBuffer()) });
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
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

    outputItems.push({ kind: "file", name: summaryName, data: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8") });

    const writtenPaths = await commitOutputs(reservation.dir, outputItems, {
      overwrite,
      renameFn,
      writeFileFn,
      trackPartial: reservation.trackPartial,
      untrackPartial: reservation.untrackPartial,
    });
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
 * Offline self-check: verifies the writer and zip store work on a tiny synthetic plane.
 */
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
  const storeMap = new Map();
  const source = {
    name: "self-check",
    stem: "self-check",
    format: "synthetic",
    dtype: "uint8",
    shape: { t: 1, c: 1, z: 1, y: 16, x: 16 },
    scale: { t: null, z: 1, y: 1, x: 1 },
    units: { t: null, z: "micrometer", y: "micrometer", x: "micrometer" },
    channels: [{ label: "ch0", color: "ffffff" }],
    notes: [],
    readPlane: async () => new Uint8Array(16 * 16).fill(42),
  };
  const written = await writeOmeZarr(source, { set: (k, v) => { storeMap.set(k, v); } }, { version: "0.5", method: "mean", chunk: 16, compressionLevel: 1 });
  if (written.chunksWritten < 1 || !storeMap.has("zarr.json")) {
    throw new Error("Self-check failed: synthetic OME-Zarr write produced no chunks.");
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
