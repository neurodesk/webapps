// Node command-line interface for @neurodesk/cellpose.
// Runs the exact same Cellpose 3 2D/3D normalization, tiling, flow dynamics, mask clustering
// and TIFF/CSV writers as the Cellpose web application, on ONNX Runtime CPU.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
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
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import packageJson from "../package.json" with { type: "json" };
import { segment2D, segment3D } from "./cellpose.js";
import { MAX_DECODED_BYTES, cellsCsv, cellsCsv3D, readImage, writeLabelsTiff } from "./image-io.js";
import { DEFAULT_MODEL_ID, MODEL_ASSETS, MODEL_IDS, manifest, resolveModel } from "./models.js";
import { outputName, segmentationSettings } from "./settings.js";

// Unconditionally disable ONNX Runtime telemetry before lazily importing onnxruntime-node.
process.env.ORT_DISABLE_TELEMETRY = "1";

let ortPromise = null;
async function loadOrt() {
  process.env.ORT_DISABLE_TELEMETRY = "1";
  ortPromise ??= import("onnxruntime-node");
  return ortPromise;
}

const IDENTITY_MODEL = Buffer.from("CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN", "base64");

export const LOCK_NAME = ".neurodesk-cli.lock";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === "1";

export const OPTIONS = Object.freeze({
  model: {
    type: "string",
    enum: [...MODEL_IDS],
    default: DEFAULT_MODEL_ID,
    description: "Pretrained Cellpose 3 model: cyto3 (cells/cytoplasm) or nuclei.",
  },
  channel: {
    type: "integer",
    minimum: 1,
    maximum: 256,
    default: 1,
    description: "1-based primary channel to segment.",
  },
  nuclearChannel: {
    type: "integer",
    flag: "nuclear-channel",
    minimum: 0,
    maximum: 256,
    default: 0,
    description: "Optional 1-based nuclear channel to guide cyto3 (0 means none).",
  },
  diameter: {
    type: "number",
    minimum: 5,
    maximum: 500,
    description: "Expected object diameter in pixels (default: 30 cyto3, 17 nuclei).",
  },
  flowThresh: {
    type: "number",
    flag: "flow-thresh",
    minimum: 0,
    maximum: 3,
    default: 0.4,
    description: "Maximum allowed flow error in 2D (0 disables flow filtering).",
  },
  cellprobThresh: {
    type: "number",
    flag: "cellprob-thresh",
    minimum: -6,
    maximum: 6,
    default: 0,
    description: "Cell probability logit threshold.",
  },
  minSize: {
    type: "integer",
    flag: "min-size",
    minimum: 1,
    maximum: 100000,
    default: 15,
    description: "Minimum mask area in pixels (2D) or volume in voxels (3D).",
  },
  do3D: {
    type: "boolean",
    flag: "do-3d",
    default: false,
    description: "Run 3D ortho-plane (YX, ZY, ZX) segmentation on a 3D multi-page stack.",
  },
  anisotropy: {
    type: "number",
    minimum: 0.1,
    maximum: 20,
    default: 1,
    description: "Ratio of Z spacing to XY pixel spacing for 3D segmentation.",
  },
  threads: {
    type: "integer",
    minimum: 1,
    description: "ONNX Runtime CPU threads (default: SLURM_CPUS_PER_TASK or all cores).",
  },
  cacheDir: {
    type: "string",
    flag: "cache-dir",
    description: "Model directory (default: NEURODESK_CELLPOSE_MODEL_DIR or ~/.cache/neurodesk/cellpose/<rev>).",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Never download models; fail if a required model file is missing.",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
});

const ALLOWED_OPTION_KEYS = new Set([
  "model",
  "channel",
  "nuclear-channel",
  "nuclearChannel",
  "diameter",
  "flow-thresh",
  "flowThresh",
  "cellprob-thresh",
  "cellprobThresh",
  "min-size",
  "minSize",
  "do-3d",
  "do3D",
  "anisotropy",
  "threads",
  "cache-dir",
  "cacheDir",
  "offline",
  "overwrite",
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

function parseNumeric(raw, flag, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean" || raw === null) {
    throw new Error(`--${flag} must be a finite number, got ${JSON.stringify(raw)}.`);
  }
  const trimmed = assertNonEmptyString(raw, flag);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`--${flag} must be a finite number, got '${raw}'.`);
  if (integer && !Number.isInteger(value)) throw new Error(`--${flag} must be an integer, got '${raw}'.`);
  if (value < min || value > max) throw new Error(`--${flag} must be between ${min} and ${max}.`);
  return value;
}

export function resolveThreads(raw = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) throw new Error(`--threads must be a positive integer, got '${raw}'.`);
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--threads must be a positive integer, got '${raw}'.`);
    return parsed;
  }
  if (!Number.isSafeInteger(raw) || raw < 1) throw new Error(`--threads must be a positive integer, got '${raw}'.`);
  return raw;
}

export function defaultCacheDir() {
  if (process.env.NEURODESK_CELLPOSE_MODEL_DIR) return process.env.NEURODESK_CELLPOSE_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "neurodesk", "cellpose", manifest.revision.slice(0, 12));
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
  const modelId = assertNonEmptyString(opts.model, "model") ?? DEFAULT_MODEL_ID;
  const model = resolveModel(modelId);

  const channel = parseNumeric(opts.channel, "channel", { integer: true, min: 1, max: 256 });
  const nuclearChannel = parseNumeric(readAliasedOption(opts, "nuclear-channel", "nuclearChannel"), "nuclear-channel", { integer: true, min: 0, max: 256 });
  const diameter = parseNumeric(opts.diameter, "diameter", { min: 5, max: 500 });
  const flowThresh = parseNumeric(readAliasedOption(opts, "flow-thresh", "flowThresh"), "flow-thresh", { min: 0, max: 3 });
  const cellprobThresh = parseNumeric(readAliasedOption(opts, "cellprob-thresh", "cellprobThresh"), "cellprob-thresh", { min: -6, max: 6 });
  const minSize = parseNumeric(readAliasedOption(opts, "min-size", "minSize"), "min-size", { integer: true, min: 1, max: 100000 });
  const anisotropy = parseNumeric(opts.anisotropy, "anisotropy", { min: 0.1, max: 20 });
  const do3D = parseBooleanOption(readAliasedOption(opts, "do-3d", "do3D"), "do-3d");
  const threadsRaw = Object.hasOwn(opts, "threads") && opts.threads !== undefined ? assertNonEmptyString(opts.threads, "threads") : undefined;
  const threads = resolveThreads(threadsRaw);
  const cacheDir = assertNonEmptyString(readAliasedOption(opts, "cache-dir", "cacheDir"), "cache-dir") ?? defaultCacheDir();

  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const envOffline = offlineByDefault();
  let offline = envOffline;
  if (Object.hasOwn(opts, "offline") && opts.offline !== undefined) {
    const explicit = parseBooleanOption(opts.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
    offline = envOffline || explicit;
  }

  const settings = segmentationSettings(
    { model: model.name, channel, nuclearChannel, diameter, flowThresh, cellprobThresh, minSize, do3D, anisotropy },
    model,
  );
  return {
    model,
    settings,
    threads,
    cacheDir,
    offline,
    overwrite,
  };
}

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

async function writeAtomically(filePath, bytes) {
  const partial = `${filePath}.${randomBytes(6).toString("hex")}.partial`;
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    await rename(partial, filePath);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadModelAsset(asset, { cacheDir, offline, onProgress }) {
  const path = join(cacheDir, asset.filename);
  const verified = (bytes) => bytes.byteLength === asset.bytes && sha256(bytes) === asset.sha256;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (bytes) {
    if (!verified(bytes)) {
      throw new Error(`Cached ${asset.filename} failed checksum verification. Delete ${path} and download it again.`);
    }
    return bytes;
  }
  if (offline) {
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "cellpose download-models" while online, or reinstall the complete release.`);
  }
  onProgress?.(`Downloading ${asset.filename}…`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

const DOWNLOAD_OPTION_KEYS = new Set(["cacheDir", "cache-dir", "offline", "onProgress"]);

export async function downloadModels(opts) {
  const validated = assertPlainOptions(opts, DOWNLOAD_OPTION_KEYS, "downloadModels options");
  const cacheDirRaw = readAliasedOption(validated, "cache-dir", "cacheDir");
  const cacheDir = cacheDirRaw !== undefined ? assertNonEmptyString(cacheDirRaw, "cache-dir") : defaultCacheDir();
  const envOffline = offlineByDefault();
  let offline = envOffline;
  if (Object.hasOwn(validated, "offline") && validated.offline !== undefined) {
    const explicit = parseBooleanOption(validated.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
    offline = envOffline || explicit;
  }
  if (validated.onProgress !== undefined && typeof validated.onProgress !== "function") {
    throw new Error("onProgress must be a function.");
  }
  const onProgress = validated.onProgress ?? (() => {});
  for (const asset of MODEL_ASSETS) {
    await loadModelAsset(asset, { cacheDir, offline, onProgress });
  }
  return {
    directory: resolve(cacheDir),
    count: MODEL_ASSETS.length,
    installedSha256: installedSha256(MODEL_ASSETS),
  };
}

async function readBoundedInputFile(filePath, maxFileBytes = MAX_DECODED_BYTES) {
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

  const lockPayload = `${JSON.stringify({ tool: "cellpose", pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`;
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

function publishFileNonOverwriteSync(partialPath, finalPath, { linkFn, copyFileFn }) {
  const doLink = linkFn ?? linkSync;
  const doCopy = copyFileFn ?? ((src, dst) => copyFileSync(src, dst, fsConstants.COPYFILE_EXCL));
  try {
    doLink(partialPath, finalPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Output file '${finalPath}' already exists. Choose a new directory or pass --overwrite.`);
    }
    if (LINK_FALLBACK_CODES.has(error.code)) {
      try {
        doCopy(partialPath, finalPath);
      } catch (copyError) {
        if (copyError.code === "EEXIST") {
          throw new Error(`Output file '${finalPath}' already exists. Choose a new directory or pass --overwrite.`);
        }
        throw copyError;
      }
    } else {
      throw error;
    }
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

function exportSpacingFor(image, is3d, anisotropy) {
  const sp = image.spacing;
  const hasX = sp?.x > 0;
  const hasY = sp?.y > 0;
  if (!is3d) {
    if (hasX && hasY) return sp;
    if (hasX || hasY) {
      const xy = hasX ? sp.x : sp.y;
      return { x: xy, y: xy, z: sp.z ?? null, unit: sp.unit ?? "micron" };
    }
    return null;
  }
  if (hasX || hasY) {
    const x = hasX ? sp.x : sp.y;
    const y = hasY ? sp.y : sp.x;
    return { x, y, z: anisotropy * x, unit: sp.unit ?? "micron" };
  }
  return { x: null, y: null, z: anisotropy, unit: null };
}

function prepareInputForRun(image, name, model, settings) {
  if (settings.do3D) {
    if (!image.stack || image.stack.depth < 2) {
      throw new Error(`3D segmentation requires a multi-page 3D TIFF stack (at least 2 slices); ${name} has ${image.depth}.`);
    }
    const primary = image.stack.channels[settings.channel - 1];
    if (!primary) {
      throw new Error(`${name} has ${image.stack.channels.length} channels; channel ${settings.channel} does not exist.`);
    }
    const nuclear = model.supportsNuclearChannel && settings.nuclearChannel > 0
      ? image.stack.channels[settings.nuclearChannel - 1]
      : null;
    if (model.supportsNuclearChannel && settings.nuclearChannel > 0 && !nuclear) {
      throw new Error(`${name} has ${image.stack.channels.length} channels; nuclear channel ${settings.nuclearChannel} does not exist.`);
    }
    return {
      primary: primary.data,
      nuclear: nuclear ? nuclear.data : null,
      depth: image.stack.depth,
      channelLabel: nuclear ? `${primary.label} + ${nuclear.label}` : primary.label,
    };
  }
  const primary = image.planes[settings.channel - 1];
  if (!primary) {
    throw new Error(`${name} has ${image.planes.length} channels; channel ${settings.channel} does not exist.`);
  }
  const nuclear = model.supportsNuclearChannel && settings.nuclearChannel > 0
    ? image.planes[settings.nuclearChannel - 1]
    : null;
  if (model.supportsNuclearChannel && settings.nuclearChannel > 0 && !nuclear) {
    throw new Error(`${name} has ${image.planes.length} channels; nuclear channel ${settings.nuclearChannel} does not exist.`);
  }
  return {
    primary: primary.data,
    nuclear: nuclear ? nuclear.data : null,
    depth: 1,
    channelLabel: nuclear ? `${primary.label} + ${nuclear.label}` : primary.label,
  };
}

/**
 * Segments one 2D image or 3D TIFF stack with Cellpose 3 (`cyto3` or `nuclei`) and writes
 * label TIFF, per-cell CSV, and provenance JSON atomically into `outputDir`.
 */
const SEGMENT_ARG_KEYS = new Set([
  "input",
  "outputDir",
  "options",
  "onProgress",
  "runBatch",
  "renameFn",
  "readdirFn",
  "openFn",
  "linkFn",
  "copyFileFn",
]);

export async function segmentFile(arg) {
  const validated = assertPlainOptions(arg, SEGMENT_ARG_KEYS, "segmentFile arguments");
  const {
    input,
    outputDir,
    options = {},
    onProgress,
    runBatch,
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

  const { name, buffer } = await readBoundedInputFile(input);
  const image = await readImage(name, buffer);
  const prepared = prepareInputForRun(image, name, parsed.model, parsed.settings);

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn, ...(openFn ? { openFn } : {}) });
  let committed = false;
  try {
    const started = performance.now();
    let result;
    let ortVersion = null;

    if (runBatch) {
      result = parsed.settings.do3D
        ? await segment3D(prepared.primary, prepared.nuclear, prepared.depth, image.height, image.width, parsed.model, {
          diameter: parsed.settings.diameter,
          anisotropy: parsed.settings.anisotropy,
          cellprobThresh: parsed.settings.cellprobThresh,
          minSize: parsed.settings.minSize,
          runBatch,
        })
        : await segment2D(prepared.primary, prepared.nuclear, image.height, image.width, parsed.model, {
          diameter: parsed.settings.diameter,
          flowThresh: parsed.settings.flowThresh,
          cellprobThresh: parsed.settings.cellprobThresh,
          minSize: parsed.settings.minSize,
          runBatch,
        });
    } else {
      const asset = MODEL_ASSETS.find((item) => item.filename === parsed.model.filename);
      const modelBytes = await loadModelAsset(asset, {
        cacheDir: parsed.cacheDir,
        offline: parsed.offline,
        onProgress: (msg) => onProgress?.(0.05, msg),
      });
      const ort = await loadOrt();
      ortVersion = ort.env.versions.node;
      const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: parsed.threads,
        interOpNumThreads: 1,
      });
      try {
        const execBatch = async (inputData, batchSize, height, width) => {
          const output = await session.run({
            [parsed.model.input]: new ort.Tensor("float32", inputData, [batchSize, parsed.model.channels, height, width]),
          });
          return output.flows.data;
        };
        if (parsed.settings.do3D) {
          result = await segment3D(prepared.primary, prepared.nuclear, prepared.depth, image.height, image.width, parsed.model, {
            diameter: parsed.settings.diameter,
            anisotropy: parsed.settings.anisotropy,
            cellprobThresh: parsed.settings.cellprobThresh,
            minSize: parsed.settings.minSize,
            runBatch: execBatch,
            onPlane: (done, total, axis) => onProgress?.(0.12 + 0.72 * (done / total), `Predicting 3D (${axis}) · ${done} of ${total} slices`),
            onStage: (stage) => onProgress?.(stage === "dynamics" ? 0.86 : 0.94, stage === "dynamics" ? "Following 3D flows…" : "Clustering 3D masks…"),
          });
        } else {
          result = await segment2D(prepared.primary, prepared.nuclear, image.height, image.width, parsed.model, {
            diameter: parsed.settings.diameter,
            flowThresh: parsed.settings.flowThresh,
            cellprobThresh: parsed.settings.cellprobThresh,
            minSize: parsed.settings.minSize,
            runBatch: execBatch,
            onTile: (done, total) => onProgress?.(0.12 + 0.7 * (done / total), total > 1 ? `Predicting · tile ${done} of ${total}` : "Predicting"),
            onStage: (stage) => onProgress?.(stage === "dynamics" ? 0.84 : stage === "masks" ? 0.92 : 0.96, `Stage: ${stage}`),
          });
        }
      } finally {
        await session.release();
      }
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
    const base = name.replace(/\.(ome\.)?(tiff?|png)$/i, "");
    const exportSpacing = exportSpacingFor(image, parsed.settings.do3D, parsed.settings.anisotropy);
    const labelsName = outputName(base, "labels.tif");
    const tableName = outputName(base, "cells.csv");
    const provName = outputName(base, "provenance.json");

    const labelsBytes = new Uint8Array(
      writeLabelsTiff(result.labels, image.width, image.height, prepared.depth, exportSpacing),
    );
    const csvText = parsed.settings.do3D ? cellsCsv3D(result.cells) : cellsCsv(result.cells);
    const provenance = {
      app: "cellpose",
      version: packageJson.version,
      input: name,
      model: parsed.model.name,
      do3D: parsed.settings.do3D,
      dimensions: parsed.settings.do3D
        ? { x: image.width, y: image.height, z: prepared.depth }
        : { x: image.width, y: image.height },
      channel: prepared.channelLabel,
      diameter: parsed.settings.diameter,
      flowThresh: parsed.settings.flowThresh,
      cellprobThresh: parsed.settings.cellprobThresh,
      minSize: parsed.settings.minSize,
      anisotropy: parsed.settings.anisotropy,
      count: result.count,
      onnxRuntime: ortVersion,
      threads: parsed.threads,
      seconds,
    };

    const written = await commitOutputs(
      reservation.dir,
      [
        { name: labelsName, data: labelsBytes },
        { name: tableName, data: Buffer.from(csvText, "utf8") },
        { name: provName, data: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8") },
      ],
      {
        overwrite: parsed.overwrite,
        renameFn,
        ...(linkFn ? { linkFn } : {}),
        ...(copyFileFn ? { copyFileFn } : {}),
        claim: reservation,
      },
    );
    committed = true;

    return {
      outputDir: reservation.dir,
      outputs: written,
      primaryOutput: written[0],
      count: result.count,
      provenance,
      seconds,
    };
  } finally {
    await reservation.release({ removeCreated: !committed });
  }
}

const CHECK_OPTION_KEYS = new Set(["cacheDir", "cache-dir"]);

export async function checkInstallation(opts) {
  const validated = assertPlainOptions(opts, CHECK_OPTION_KEYS, "checkInstallation options");
  const cacheDirRaw = readAliasedOption(validated, "cache-dir", "cacheDir");
  const cacheDir = cacheDirRaw !== undefined ? assertNonEmptyString(cacheDirRaw, "cache-dir") : undefined;
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ["cpu"] });
  let output;
  try {
    const { y } = await session.run({ x: new ort.Tensor("float32", Float32Array.of(42), [1]) });
    output = y.data[0];
  } finally {
    await session.release();
  }
  if (output !== 42) throw new Error("ONNX Runtime CPU check failed.");
  const explicitDir = cacheDir ?? process.env.NEURODESK_CELLPOSE_MODEL_DIR;
  const models = explicitDir ? await downloadModels({ cacheDir: explicitDir, offline: true }) : null;
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: "cpu",
    modelIds: [...MODEL_IDS],
    ...(models ? { models } : {}),
  };
}
