// Node command-line interface for @neurodesk/omezarr-convert.
// Runs the exact same readers, NGFF 0.4/0.5 multiscale writer and zip packager as the web app.
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
import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

  const versionRaw = assertNonEmptyString(opts.version, "version");
  const version = versionRaw ?? DEFAULTS.version;
  if (!VERSIONS.includes(version)) {
    throw new Error(`--version must be one of: ${VERSIONS.join(", ")}.`);
  }

  const methodRaw = assertNonEmptyString(opts.method, "method");
  const method = methodRaw ?? DEFAULTS.method;
  if (!METHODS.includes(method)) {
    throw new Error(`--method must be one of: ${METHODS.join(", ")}.`);
  }

  const chunk = parseIntOption(opts.chunk, "chunk") ?? DEFAULTS.chunk;
  if (!CHUNK_CHOICES.includes(chunk)) {
    throw new Error(`--chunk must be one of: ${CHUNK_CHOICES.join(", ")}.`);
  }

  const compressionLevel = parseIntOption(
    readAliasedOption(opts, "compression-level", "compressionLevel"),
    "compression-level",
  ) ?? DEFAULTS.compressionLevel;
  if (compressionLevel < 0 || compressionLevel > 9) {
    throw new Error("--compression-level must be an integer from 0 to 9.");
  }

  const formatRaw = assertNonEmptyString(opts.format, "format");
  const format = formatRaw ?? "archive";
  if (!OUTPUT_FORMATS.includes(format)) {
    throw new Error(`--format must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
  }

  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const envOffline = process.env.NEURODESK_OFFLINE === "1";
  if (Object.hasOwn(opts, "offline") && opts.offline !== undefined) {
    const explicit = parseBooleanOption(opts.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
  }
  const offline = envOffline || Boolean(opts.offline);

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

const LINK_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "ENOTSUP", "ENOSYS"]);

function ensureDirectoryChainSync(targetDir, createdOut) {
  const missing = [];
  let cursor = resolve(targetDir);
  while (true) {
    try {
      const info = statSync(cursor);
      if (!info.isDirectory()) {
        throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      missing.push(cursor);
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
        if (!info.isDirectory()) {
          throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
        }
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
    const { target, partialPath, kind } = pubState.pendingPublish;
    if (!partialPath || !existsSync(partialPath)) {
      try {
        lstatSync(target);
        rmSync(target, { recursive: kind === "dir", force: true });
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
        rmSync(entry.target, { recursive: entry.kind === "dir", force: true });
        pubState.published.pop();
      } catch (error) {
        if (error.code === "ENOENT") {
          pubState.published.pop();
        } else {
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
      rmSync(item.partialPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT") ok = false;
    }
  }
  return ok;
}

const CLAIM_OPTION_KEYS = new Set(["overwrite", "readdirFn", "openFn"]);

/**
 * Exclusively claims `outputDir` with the shared `.neurodesk-cli.lock` (`O_EXCL`).
 * Registers SIGINT/SIGTERM synchronous cleanup handlers BEFORE creating directories or the lock,
 * rolls back active publications on signal, and retains the lock if rollback fails.
 */
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
          if (readdirSync(createdDirs[i]).length === 0) {
            rmdirSync(createdDirs[i]);
          }
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

  // Register signal handlers BEFORE creating directories or acquiring .neurodesk-cli.lock.
  process.on("SIGINT", cleanupSyncOnSignal);
  process.on("SIGTERM", cleanupSyncOnSignal);

  const release = async ({ removeCreated = false } = {}) => {
    cleanupSync({ removeCreated });
    process.off("SIGINT", cleanupSyncOnSignal);
    process.off("SIGTERM", cleanupSyncOnSignal);
  };

  const lockPayload = `${JSON.stringify({ tool: "omezarr-convert", pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`;
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

async function assertTargetsWritable(dir, items, overwrite) {
  for (const item of items) {
    const target = join(dir, item.name);
    try {
      const info = await lstat(target);
      if (item.kind === "dir" || item.kind === "staged-dir") {
        throw new Error(
          `Cannot overwrite existing path '${target}' with an OME-Zarr directory store. Choose a new output directory or remove '${target}' first.`,
        );
      }
      if (info.isDirectory()) {
        throw new Error(`Cannot write file '${item.name}' because '${target}' is a directory.`);
      }
      if (info.isSymbolicLink()) {
        throw new Error(`Cannot overwrite symbolic link '${target}'. Remove the symlink or choose a new output directory.`);
      }
      if (!overwrite) {
        throw new Error(`Output '${target}' already exists. Choose a new directory or pass --overwrite.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function publishFileNonOverwriteSync(partialPath, finalPath, pubState, { linkFn, unlinkFn }) {
  const doLink = linkFn ?? linkSync;
  const doUnlink = unlinkFn ?? unlinkSync;
  try {
    doLink(partialPath, finalPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Output '${finalPath}' already exists. Choose a new directory or pass --overwrite.`);
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

function publishDirectoryAtomicallySync(partialDir, finalDir, pubState, { mkdirFn, renameSyncFn }) {
  const doMkdir = mkdirFn ?? mkdirSync;
  const doRename = renameSyncFn ?? renameSync;
  // Atomically claim finalDir via mkdirSync (EEXIST on any existing file, symlink, empty or non-empty dir).
  try {
    doMkdir(finalDir);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Cannot overwrite existing path '${finalDir}' with an OME-Zarr directory store. Choose a new output directory or remove '${finalDir}' first.`,
      );
    }
    throw error;
  }
  pubState.published.push({ target: finalDir, hadBackup: false, kind: "dir" });
  const children = readdirSync(partialDir);
  for (const child of children) {
    doRename(join(partialDir, child), join(finalDir, child));
  }
  try {
    rmdirSync(partialDir);
  } catch {
    // Ignore if already removed.
  }
}

const COMMIT_OPTION_KEYS = new Set([
  "overwrite",
  "renameFn",
  "writeFileFn",
  "linkFn",
  "unlinkFn",
  "mkdirFn",
  "trackPartial",
  "untrackPartial",
  "claim",
]);

/**
 * Stages every output to `.partial` entries inside `dir` (pre-registering each `.partial` path
 * BEFORE writing so failed/short writes always clean up), then publishes atomically with
 * synchronous rollback on errors or signals.
 */
export async function commitOutputs(dir, items, options) {
  const opts = assertPlainOptions(options, COMMIT_OPTION_KEYS, "commitOutputs options");
  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const hasCustomRename = opts.renameFn !== undefined && opts.renameFn !== rename;
  const renameFn = opts.renameFn ?? rename;
  const writeFileFn = opts.writeFileFn ?? writeFile;
  const linkFn = opts.linkFn;
  const unlinkFn = opts.unlinkFn;
  const mkdirFn = opts.mkdirFn;
  const claim = opts.claim;
  const trackPartial = opts.trackPartial ?? claim?.trackPartial;
  const untrackPartial = opts.untrackPartial ?? claim?.untrackPartial;

  const token = randomBytes(6).toString("hex");
  await assertTargetsWritable(dir, items, overwrite);

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
    for (const item of items) {
      if (item.kind === "staged-dir") {
        pubState.staged.push({ kind: "dir", name: item.name, partialPath: item.stagedPath, finalPath: join(dir, item.name) });
        continue;
      }
      const partialPath = join(dir, `.${item.name}.${token}.partial`);
      const entry = { ...item, partialPath, finalPath: join(dir, item.name) };
      pubState.staged.push(entry);
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

    const backedUpSet = new Set();
    if (overwrite) {
      for (const entry of pubState.staged) {
        if (entry.kind === "dir") continue;
        let info = null;
        try {
          info = lstatSync(entry.finalPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (info) {
          if (info.isDirectory()) {
            throw new Error(`Cannot overwrite existing directory '${entry.finalPath}'.`);
          }
          if (info.isSymbolicLink()) {
            throw new Error(`Cannot overwrite symbolic link '${entry.finalPath}'.`);
          }
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
      if (entry.kind === "dir") {
        publishDirectoryAtomicallySync(entry.partialPath, entry.finalPath, pubState, { mkdirFn, renameSyncFn: renameSync });
        untrackPartial?.(entry.partialPath);
      } else if (!overwrite) {
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

  for (const backup of pubState.backups) {
    await rm(backup.backup, { recursive: true, force: true }).catch(() => {});
  }
  claim?.endPublish?.(pubState);
  return pubState.staged.map((entry) => entry.finalPath);
}

/**
 * Converts one input file (or sequence / directory of slices) to an OME-Zarr archive or directory
 * and writes a JSON conversion summary into `outputDir`.
 * In `--format dir` mode, chunks stream directly to a staged `.partial` directory on disk instead
 * of buffering the entire store in memory.
 */
const CONVERT_ARG_KEYS = new Set([
  "inputs",
  "outputDir",
  "options",
  "onProgress",
  "maxFileBytes",
  "maxArchiveBytes",
  "renameFn",
  "readdirFn",
  "writeFileFn",
  "linkFn",
  "unlinkFn",
  "mkdirFn",
  "openFn",
]);

export async function convertFiles(arg) {
  const validated = assertPlainOptions(arg, CONVERT_ARG_KEYS, "convertFiles arguments");
  const {
    inputs,
    outputDir,
    options = {},
    onProgress,
    maxFileBytes = MAX_CLI_FILE_BYTES,
    maxArchiveBytes = ARCHIVE_MAX_BYTES,
    renameFn = rename,
    readdirFn = readdir,
    writeFileFn = writeFile,
    linkFn,
    unlinkFn,
    mkdirFn,
    openFn,
  } = validated;
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new Error("onProgress must be a function.");
  }
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

  const reservation = await claimOutputDir(outputDir, { overwrite, readdirFn, ...(openFn ? { openFn } : {}) });
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
      ...(linkFn ? { linkFn } : {}),
      ...(unlinkFn ? { unlinkFn } : {}),
      ...(mkdirFn ? { mkdirFn } : {}),
      claim: reservation,
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
const CHECK_OPTION_KEYS = new Set(["cacheDir", "cache-dir"]);

export async function checkInstallation(opts) {
  const validated = assertPlainOptions(opts, CHECK_OPTION_KEYS, "checkInstallation options");
  const cacheDirRaw = readAliasedOption(validated, "cache-dir", "cacheDir");
  const cacheDir = cacheDirRaw !== undefined ? assertNonEmptyString(cacheDirRaw, "cache-dir") : undefined;
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
