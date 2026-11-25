// Node command-line interface for @neurodesk/spot-detection.
// Runs the exact same Big-FISH LoG detector, elbow threshold, sub-pixel fit, per-cell counter
// and NIfTI spot-ring overlay writer as the Spot detection web application.
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
import { lstat, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { InputTooLargeError, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import packageJson from "../package.json" with { type: "json" };
import { readImageStack } from "./image-stack.js";
import { analyse } from "./pipeline.js";
import { checkRun, DEFAULTS, detectionSettings, outputNames, provenance, voxelFromFile } from "./settings.js";
import { syntheticImage } from "./synthetic.js";
import { niftiBuffer, overlayVolume } from "./volumes.js";

export const MAX_CLI_FILE_BYTES = MAX_INPUT_BYTES;
export const LOCK_NAME = ".neurodesk-cli.lock";

export const OPTIONS = Object.freeze({
  labels: {
    type: "string",
    description: "Optional integer cell label TIFF (2D y×x plane or 3D stack matching the image).",
  },
  voxelZ: {
    type: "number",
    flag: "voxel-z",
    minimum: 1e-6,
    description: `Voxel size along z in nm (omit to use TIFF metadata, else ${DEFAULTS.voxelZ}).`,
  },
  voxelYx: {
    type: "number",
    flag: "voxel-yx",
    minimum: 1e-6,
    description: `Pixel size in y and x in nm (omit to use TIFF metadata, else ${DEFAULTS.voxelYx}).`,
  },
  radiusZ: {
    type: "number",
    flag: "radius-z",
    minimum: 1e-6,
    default: DEFAULTS.radiusZ,
    description: "Spot radius along z in nm.",
  },
  radiusYx: {
    type: "number",
    flag: "radius-yx",
    minimum: 1e-6,
    default: DEFAULTS.radiusYx,
    description: "Spot radius in y and x in nm.",
  },
  threshold: {
    type: "number",
    minimum: 0,
    description: "Manual LoG response threshold (omit for Big-FISH automatic elbow threshold).",
  },
  projection: {
    type: "boolean",
    default: false,
    description: "Detect spots in the 2D maximum intensity projection of a 3D stack.",
  },
  noSubpixel: {
    type: "boolean",
    flag: "no-subpixel",
    default: false,
    description: "Skip Gaussian sub-pixel localization and report integer voxel coordinates.",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Offline mode (spot-detection never uses the network).",
  },
});

const ALLOWED_OPTION_KEYS = new Set([
  "labels",
  "voxel-z",
  "voxelZ",
  "voxel-yx",
  "voxelYx",
  "radius-z",
  "radiusZ",
  "radius-yx",
  "radiusYx",
  "threshold",
  "projection",
  "no-subpixel",
  "noSubpixel",
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

function parseNumeric(raw, flag, { min = -Infinity, exclusiveMin = false, float32Positive = false, float32Mm = false } = {}) {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean" || raw === null) {
    throw new Error(`--${flag} must be a finite number, got ${JSON.stringify(raw)}.`);
  }
  const trimmed = assertNonEmptyString(raw, flag);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`--${flag} must be a finite number, got '${raw}'.`);
  if (exclusiveMin ? !(value > min) : value < min) {
    throw new Error(`--${flag} must be ${exclusiveMin ? "greater than" : "at least"} ${min}.`);
  }
  if (float32Positive) {
    const f32 = Math.fround(value);
    if (!Number.isFinite(f32) || !(f32 > 0)) {
      throw new Error(`--${flag} (${raw}) must be representable as a positive finite float32.`);
    }
  }
  if (float32Mm) {
    const mmF32 = Math.fround(value / 1e6);
    if (!Number.isFinite(mmF32) || !(mmF32 > 0)) {
      throw new Error(`--${flag} (${raw} nm) overflows or underflows NIfTI-1 float32 spacing.`);
    }
  }
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
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option '${key}'.`);
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
  const labelsPath = assertNonEmptyString(opts.labels, "labels") ?? null;
  const voxelZ = parseNumeric(readAliasedOption(opts, "voxel-z", "voxelZ"), "voxel-z", { min: 0, exclusiveMin: true, float32Positive: true, float32Mm: true });
  const voxelYx = parseNumeric(readAliasedOption(opts, "voxel-yx", "voxelYx"), "voxel-yx", { min: 0, exclusiveMin: true, float32Positive: true, float32Mm: true });
  const radiusZ = parseNumeric(readAliasedOption(opts, "radius-z", "radiusZ"), "radius-z", { min: 0, exclusiveMin: true, float32Positive: true });
  const radiusYx = parseNumeric(readAliasedOption(opts, "radius-yx", "radiusYx"), "radius-yx", { min: 0, exclusiveMin: true, float32Positive: true });
  const threshold = parseNumeric(opts.threshold, "threshold", { min: 0 });
  const projection = parseBooleanOption(opts.projection, "projection");
  const subpixel = !parseBooleanOption(readAliasedOption(opts, "no-subpixel", "noSubpixel"), "no-subpixel");
  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const envOffline = process.env.NEURODESK_OFFLINE === "1";
  if (Object.hasOwn(opts, "offline") && opts.offline !== undefined) {
    const explicit = parseBooleanOption(opts.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
  }
  const offline = envOffline || Boolean(opts.offline);

  // Validate eagerly before any file I/O using default voxel sizes if omitted.
  detectionSettings({
    voxelZ: voxelZ ?? DEFAULTS.voxelZ,
    voxelYx: voxelYx ?? DEFAULTS.voxelYx,
    radiusZ: radiusZ ?? DEFAULTS.radiusZ,
    radiusYx: radiusYx ?? DEFAULTS.radiusYx,
    threshold,
    projection,
    subpixel,
  });

  return {
    labelsPath,
    voxelZ,
    voxelYx,
    radiusZ: radiusZ ?? DEFAULTS.radiusZ,
    radiusYx: radiusYx ?? DEFAULTS.radiusYx,
    threshold: threshold ?? null,
    projection,
    subpixel,
    overwrite,
    offline,
  };
}

async function readBoundedInputFile(filePath, maxFileBytes = MAX_CLI_FILE_BYTES) {
  const resolved = resolve(filePath);
  const name = basename(resolved);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
  const fh = await open(resolved, flags);
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error(`${name} is not a regular file.`);
    if (info.size === 0) throw new Error(`${name} is empty.`);
    if (info.size > maxFileBytes) throw new InputTooLargeError(info.size, maxFileBytes, { subject: name });
    const chunks = [];
    let total = 0;
    const chunkSize = Math.min(info.size + 1, 4 * 1024 * 1024);
    while (true) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxFileBytes) throw new InputTooLargeError(total, maxFileBytes, { subject: name });
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
    const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
    return {
      name,
      buffer: combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength),
    };
  } finally {
    await fh.close();
  }
}

const LINK_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "ENOTSUP", "ENOSYS"]);

function ensureDirectoryChainSync(targetDir, createdOut) {
  const missing = [];
  let cursor = resolve(targetDir);
  while (true) {
    try {
      const info = statSync(cursor);
      if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
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
        if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
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
    let targetExists = false;
    try {
      lstatSync(backup);
      backupExists = true;
    } catch {
      // Backup was not created before interruption.
    }
    try {
      lstatSync(target);
      targetExists = true;
    } catch {
      // Target is absent and needs restore.
    }
    if (backupExists && !targetExists) {
      try {
        renameRollback(backup, target);
      } catch {
        ok = false;
      }
    }
    pubState.pendingBackup = null;
  }

  while (pubState.backups.length > 0) {
    const entry = pubState.backups[pubState.backups.length - 1];
    try {
      renameRollback(entry.backup, entry.target);
      pubState.backups.pop();
    } catch (error) {
      if (error.code === "ENOENT") pubState.backups.pop();
      else {
        ok = false;
        break;
      }
    }
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

  const lockPayload = `${JSON.stringify({ tool: "spot-detection", pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`;
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

function publishFileNonOverwriteSync(partialPath, finalPath, { linkFn }) {
  const doLink = linkFn ?? linkSync;
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
  try {
    unlinkSync(partialPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const COMMIT_OPTION_KEYS = new Set([
  "overwrite",
  "renameFn",
  "writeFileFn",
  "linkFn",
  "copyFileFn",
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
  const copyFileFn = opts.copyFileFn;
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
          pubState.backups.push({ target: entry.finalPath, backup: backupPath });
          backedUpSet.add(entry.finalPath);
          pubState.pendingBackup = null;
        }
      }
    }

    for (const entry of pubState.staged) {
      const hadBackup = backedUpSet.has(entry.finalPath);
      if (!overwrite && !hasCustomRename) {
        publishFileNonOverwriteSync(entry.partialPath, entry.finalPath, { linkFn, copyFileFn });
        pubState.published.push({ target: entry.finalPath, hadBackup: false, kind: "file" });
        untrackPartial?.(entry.partialPath);
      } else {
        pubState.pendingPublish = { target: entry.finalPath, partialPath: entry.partialPath, hadBackup, kind: "file" };
        if (hasCustomRename) {
          await renameFn(entry.partialPath, entry.finalPath);
        } else {
          renameSync(entry.partialPath, entry.finalPath);
        }
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
 * Detects smFISH spots in one TIFF image or stack (with optional cell labels TIFF) and writes
 * spots CSV, gzipped NIfTI overlay, optional per-cell counts CSV, and provenance JSON atomically.
 */
const DETECT_ARG_KEYS = new Set([
  "input",
  "outputDir",
  "options",
  "onProgress",
  "maxFileBytes",
  "renameFn",
  "readdirFn",
  "openFn",
  "linkFn",
  "copyFileFn",
]);

export async function detectSpotsFile(arg) {
  const validated = assertPlainOptions(arg, DETECT_ARG_KEYS, "detectSpotsFile arguments");
  const {
    input,
    outputDir,
    options = {},
    onProgress,
    maxFileBytes = MAX_CLI_FILE_BYTES,
    renameFn = rename,
    readdirFn = readdir,
    openFn,
    linkFn,
    copyFileFn,
  } = validated;
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new Error("onProgress must be a function.");
  }
  const parsed = parseCliOptions(options);
  if (!input || !String(input).trim()) throw new Error("Input file path is required.");
  if (!outputDir || !String(outputDir).trim()) throw new Error("Output directory path is required.");

  const { name, buffer } = await readBoundedInputFile(input, maxFileBytes);
  const image = await readImageStack(buffer);

  let labels = null;
  let labelsName = null;
  if (parsed.labelsPath) {
    const labelFile = await readBoundedInputFile(parsed.labelsPath, maxFileBytes);
    labelsName = labelFile.name;
    const loadedLabels = await readImageStack(labelFile.buffer);
    if (!["uint8", "uint16"].includes(loadedLabels.dtype)) {
      throw new Error(`Cell labels (${labelsName}) must be an integer TIFF (uint8 or uint16), got ${loadedLabels.dtype}.`);
    }
    labels = loadedLabels;
  }

  const fromMeta = voxelFromFile(image.voxelSize);
  const settings = detectionSettings({
    voxelZ: parsed.voxelZ ?? fromMeta.voxelZ ?? DEFAULTS.voxelZ,
    voxelYx: parsed.voxelYx ?? fromMeta.voxelYx ?? DEFAULTS.voxelYx,
    radiusZ: parsed.radiusZ,
    radiusYx: parsed.radiusYx,
    threshold: parsed.threshold,
    projection: parsed.projection,
    subpixel: parsed.subpixel,
  });
  checkRun(image, settings, labels);

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn, ...(openFn ? { openFn } : {}) });
  let committed = false;
  try {
    const started = performance.now();
    const result = analyse(image, {
      ...settings,
      labels,
      onProgress: (stage, fraction) => onProgress?.(fraction, stage),
    });
    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const names = outputNames(name, result.image.shape.length === 2 && image.shape.length === 3);
    const provenanceName = names.spots.replace(/_spots\.csv$/, "_provenance.json");
    const overlay = overlayVolume(result.image.shape, result.spots);
    const overlayGz = gzipSync(new Uint8Array(niftiBuffer(overlay, settings.voxelSize)));
    const record = {
      ...provenance({ input: name, labels: labelsName, settings, result }),
      version: packageJson.version,
      seconds,
    };

    const outputFiles = [
      { name: names.spots, data: Buffer.from(result.spotsCsv, "utf8") },
      { name: names.overlay, data: overlayGz },
      ...(result.cellsCsv ? [{ name: names.cells, data: Buffer.from(result.cellsCsv, "utf8") }] : []),
      { name: provenanceName, data: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8") },
    ];

    const written = await commitOutputs(reservation.dir, outputFiles, {
      overwrite: parsed.overwrite,
      renameFn,
      ...(linkFn ? { linkFn } : {}),
      ...(copyFileFn ? { copyFileFn } : {}),
      claim: reservation,
    });
    committed = true;

    return {
      outputDir: reservation.dir,
      outputs: written,
      primaryOutput: written[0],
      spots: result.spots.length,
      threshold: result.threshold,
      provenance: record,
      seconds,
    };
  } finally {
    await reservation.release({ removeCreated: !committed });
  }
}

/** Offline self-check: detects synthetic diffraction-limited spots and verifies exact recovery. */
const CHECK_OPTION_KEYS = new Set(["cacheDir", "cache-dir"]);

export async function checkInstallation(opts) {
  const validated = assertPlainOptions(opts, CHECK_OPTION_KEYS, "checkInstallation options");
  const cacheDirRaw = readAliasedOption(validated, "cache-dir", "cacheDir");
  const cacheDir = cacheDirRaw !== undefined ? assertNonEmptyString(cacheDirRaw, "cache-dir") : undefined;
  const resolvedCache = cacheDir ? resolve(cacheDir) : undefined;
  const image = syntheticImage([64, 64], 12, 3);
  const result = analyse(image, {
    voxelSize: [300, 100, 100],
    spotRadius: [350, 90, 90],
    threshold: null,
    subpixel: true,
  });
  if (result.spots.length !== 12 || result.threshold !== 30) {
    throw new Error(`Self-check failed: expected 12 spots at threshold 30, got ${result.spots.length} at ${result.threshold}.`);
  }
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    executable: process.execPath,
    node: process.version,
    spotsRecovered: result.spots.length,
    threshold: result.threshold,
    ...(resolvedCache ? { cacheDir: resolvedCache } : {}),
  };
}
