// Node loader and command-line interface for @neurodesk/deconvolution.
// Runs the exact same WebAssembly Gibson-Lanni PSF and Richardson-Lucy / RL-TV solver
// and calibrated TIFF/NIfTI encoders as the Deconvolution web application.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
import { gunzipSync, gzipSync } from "node:zlib";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import packageJson from "../package.json" with { type: "json" };
import { Deconvolver, gibsonLanniPsf, initSync, paddedDims } from "../wasm/deconvolution_wasm.js";
import {
  DEFAULT_OPTICS,
  checkPsfSpacing,
  deconvolvedNifti,
  outputNames,
  provenance,
  spacingComplete,
  stackTiff,
} from "./format.js";
import {
  MAX_ITERATIONS,
  MAX_PSF_SIDE,
  MAX_TV_WEIGHT,
  METHODS,
  autoPsfSize,
  checkSampling,
  memoryPlan,
  normaliseSum,
  opticsSettings,
  prepareImage,
  prepareMeasuredPsf,
  runSettings,
} from "./index.js";
import { MAX_INPUT_BYTES, readVolume } from "./input.js";

let loaded = null;

export function loadDeconvolution() {
  if (!loaded) {
    initSync({ module: readFileSync(new URL("../wasm/deconvolution_wasm_bg.wasm", import.meta.url)) });
    loaded = Object.freeze({ gibsonLanniPsf, paddedDims, Deconvolver });
  }
  return loaded;
}

export const MAX_CLI_INPUT_BYTES = MAX_INPUT_BYTES;
const CLI_METADATA_BYTES = 2 ** 26;
export const LOCK_NAME = ".neurodesk-cli.lock";

export const OPTIONS = Object.freeze({
  modality: {
    type: "string",
    enum: ["widefield", "confocal"],
    default: DEFAULT_OPTICS.modality,
    description: "Microscope modality for theoretical Gibson-Lanni PSF.",
  },
  method: {
    type: "string",
    enum: Object.keys(METHODS),
    default: "rl",
    description: "Deconvolution method: rl (Richardson-Lucy) or rltv (total variation).",
  },
  iterations: {
    type: "integer",
    minimum: 1,
    maximum: MAX_ITERATIONS,
    default: 20,
    description: "Richardson-Lucy iteration count.",
  },
  tvWeight: {
    type: "number",
    flag: "tv-weight",
    minimum: 0.0001,
    maximum: MAX_TV_WEIGHT,
    default: 0.002,
    description: "Total-variation weight lambda (rltv only).",
  },
  na: {
    type: "number",
    minimum: 0.05,
    maximum: 1.7,
    default: DEFAULT_OPTICS.na,
    description: "Objective numerical aperture (below immersion index).",
  },
  immersionIndex: {
    type: "number",
    flag: "immersion-index",
    minimum: 1,
    maximum: 2,
    default: DEFAULT_OPTICS.immersionIndex,
    description: "Immersion medium refractive index.",
  },
  sampleIndex: {
    type: "number",
    flag: "sample-index",
    minimum: 1,
    maximum: 2,
    default: DEFAULT_OPTICS.sampleIndex,
    description: "Sample refractive index (matters when depth > 0).",
  },
  emissionNm: {
    type: "number",
    flag: "emission-nm",
    minimum: 300,
    maximum: 1500,
    default: DEFAULT_OPTICS.emissionNm,
    description: "Emission wavelength in nanometres.",
  },
  excitationNm: {
    type: "number",
    flag: "excitation-nm",
    minimum: 300,
    maximum: 1500,
    default: DEFAULT_OPTICS.excitationNm,
    description: "Excitation wavelength in nanometres (confocal only).",
  },
  depthUm: {
    type: "number",
    flag: "depth-um",
    minimum: 0,
    maximum: 200,
    default: DEFAULT_OPTICS.depthUm,
    description: "Imaged depth below coverslip in micrometres.",
  },
  voxelXy: {
    type: "number",
    flag: "voxel-xy",
    minimum: 0.001,
    maximum: 100,
    description: "Lateral voxel size in micrometres (overrides file metadata).",
  },
  voxelZ: {
    type: "number",
    flag: "voxel-z",
    minimum: 0.001,
    maximum: 100,
    description: "Axial voxel size in micrometres (overrides file metadata).",
  },
  psfXy: {
    type: "integer",
    flag: "psf-xy",
    minimum: 1,
    maximum: MAX_PSF_SIDE,
    description: "Odd lateral PSF size in voxels (overrides automatic sizing).",
  },
  psfZ: {
    type: "integer",
    flag: "psf-z",
    minimum: 1,
    maximum: MAX_PSF_SIDE,
    description: "Odd axial PSF size in voxels (overrides automatic sizing).",
  },
  psf: {
    type: "string",
    description: "Path to a measured PSF stack (TIFF or NIfTI); replaces theoretical PSF.",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
  offline: {
    type: "boolean",
    default: false,
    description: "Offline mode (deconvolution never uses the network).",
  },
});

const ALLOWED_OPTION_KEYS = new Set([
  "modality",
  "method",
  "iterations",
  "tv-weight",
  "tvWeight",
  "na",
  "immersion-index",
  "immersionIndex",
  "sample-index",
  "sampleIndex",
  "emission-nm",
  "emissionNm",
  "excitation-nm",
  "excitationNm",
  "depth-um",
  "depthUm",
  "voxel-xy",
  "voxelXy",
  "voxel-z",
  "voxelZ",
  "psf-xy",
  "psfXy",
  "psf-z",
  "psfZ",
  "psf",
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

  const method = assertNonEmptyString(opts.method, "method") ?? "rl";
  if (!Object.hasOwn(METHODS, method)) {
    throw new Error(`--method must be one of: ${Object.keys(METHODS).join(", ")}.`);
  }
  const modality = assertNonEmptyString(opts.modality, "modality") ?? DEFAULT_OPTICS.modality;
  if (modality !== "widefield" && modality !== "confocal") {
    throw new Error("--modality must be one of: widefield, confocal.");
  }

  const iterations = parseNumeric(opts.iterations, "iterations", { integer: true, min: 1, max: MAX_ITERATIONS }) ?? 20;
  const tvWeightRaw = parseNumeric(readAliasedOption(opts, "tv-weight", "tvWeight"), "tv-weight", { min: 0.0001, max: MAX_TV_WEIGHT });
  const settings = runSettings({ method, iterations, tvWeight: tvWeightRaw ?? 0.002 });

  const psfPath = assertNonEmptyString(opts.psf, "psf");
  const na = parseNumeric(opts.na, "na", { min: 0.05, max: 1.7 }) ?? DEFAULT_OPTICS.na;
  const immersionIndex = parseNumeric(readAliasedOption(opts, "immersion-index", "immersionIndex"), "immersion-index", { min: 1, max: 2 }) ?? DEFAULT_OPTICS.immersionIndex;
  const sampleIndex = parseNumeric(readAliasedOption(opts, "sample-index", "sampleIndex"), "sample-index", { min: 1, max: 2 }) ?? DEFAULT_OPTICS.sampleIndex;
  const emissionNm = parseNumeric(readAliasedOption(opts, "emission-nm", "emissionNm"), "emission-nm", { min: 300, max: 1500 }) ?? DEFAULT_OPTICS.emissionNm;
  const excitationNm = parseNumeric(readAliasedOption(opts, "excitation-nm", "excitationNm"), "excitation-nm", { min: 300, max: 1500 }) ?? DEFAULT_OPTICS.excitationNm;
  const depthUm = parseNumeric(readAliasedOption(opts, "depth-um", "depthUm"), "depth-um", { min: 0, max: 200 }) ?? DEFAULT_OPTICS.depthUm;

  const optics = psfPath
    ? null
    : opticsSettings({ modality, na, immersionIndex, sampleIndex, emissionNm, excitationNm, depthUm });

  const voxelXy = parseNumeric(readAliasedOption(opts, "voxel-xy", "voxelXy"), "voxel-xy", { min: 0.001, max: 100 });
  const voxelZ = parseNumeric(readAliasedOption(opts, "voxel-z", "voxelZ"), "voxel-z", { min: 0.001, max: 100 });
  const psfXy = parseNumeric(readAliasedOption(opts, "psf-xy", "psfXy"), "psf-xy", { integer: true, min: 1, max: MAX_PSF_SIDE });
  const psfZ = parseNumeric(readAliasedOption(opts, "psf-z", "psfZ"), "psf-z", { integer: true, min: 1, max: MAX_PSF_SIDE });
  if (psfXy !== undefined && psfXy % 2 === 0) throw new Error(`--psf-xy must be an odd integer from 1 to ${MAX_PSF_SIDE}.`);
  if (psfZ !== undefined && psfZ % 2 === 0) throw new Error(`--psf-z must be an odd integer from 1 to ${MAX_PSF_SIDE}.`);

  const overwrite = parseBooleanOption(opts.overwrite, "overwrite");
  const envOffline = process.env.NEURODESK_OFFLINE === "1";
  if (Object.hasOwn(opts, "offline") && opts.offline !== undefined) {
    const explicit = parseBooleanOption(opts.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
  }
  const offline = envOffline || Boolean(opts.offline);

  return {
    settings,
    optics,
    psfPath: psfPath ?? null,
    voxelXy,
    voxelZ,
    psfXy,
    psfZ,
    overwrite,
    offline,
  };
}

/** Bounded native gunzip with CRC32/ISIZE validation and strict maxOutputLength enforcement. */
export function gunzipBounded(bytes, maxOutputLength = MAX_CLI_INPUT_BYTES + CLI_METADATA_BYTES, subject = "Compressed file") {
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

async function readBoundedInputFile(filePath, maxFileBytes) {
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
    const bytes = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
    return new File([bytes], name);
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

  const lockPayload = `${JSON.stringify({ tool: "deconvolution", pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`;
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

/**
 * Deconvolves one TIFF/OME-TIFF/NIfTI stack on disk and writes calibrated TIFF, gzipped NIfTI,
 * PSF TIFF, and provenance JSON atomically into `outputDir`.
 */
const DECONVOLVE_ARG_KEYS = new Set([
  "input",
  "outputDir",
  "options",
  "onProgress",
  "maxBytes",
  "maxFileBytes",
  "renameFn",
  "readdirFn",
  "openFn",
  "linkFn",
  "copyFileFn",
]);

export async function deconvolveFile(arg) {
  const validated = assertPlainOptions(arg, DECONVOLVE_ARG_KEYS, "deconvolveFile arguments");
  const {
    input,
    outputDir,
    options = {},
    onProgress,
    maxBytes = MAX_CLI_INPUT_BYTES,
    maxFileBytes = maxBytes + CLI_METADATA_BYTES,
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

  const inputFile = await readBoundedInputFile(input, maxFileBytes);
  const volume = await readVolume(inputFile, { maxBytes, maxFileBytes, gunzip: gunzipBounded });
  const spacingUm = {
    x: parsed.voxelXy ?? volume.spacingUm.x,
    y: parsed.voxelXy ?? volume.spacingUm.y,
    z: parsed.voxelZ ?? volume.spacingUm.z,
  };
  if (!spacingComplete(spacingUm)) {
    throw new Error("Voxel size is incomplete; pass --voxel-xy and --voxel-z in micrometres.");
  }

  let measuredVolume = null;
  if (parsed.psfPath) {
    const psfFile = await readBoundedInputFile(parsed.psfPath, maxFileBytes);
    measuredVolume = await readVolume(psfFile, { maxBytes, maxFileBytes, gunzip: gunzipBounded });
  }

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn, ...(openFn ? { openFn } : {}) });
  let committed = false;
  try {
    const wasm = loadDeconvolution();
    const started = performance.now();
    onProgress?.(0.02, "Computing PSF…");

    let psf;
    if (measuredVolume) {
      checkPsfSpacing(measuredVolume.spacingUm, spacingUm, measuredVolume.name);
      const prepared = prepareMeasuredPsf(measuredVolume.data, measuredVolume.dims);
      const peak = prepared.data.reduce((max, v) => Math.max(max, v), 0);
      psf = {
        data: prepared.data.map((v) => v / peak),
        dims: prepared.dims,
        source: "measured",
        file: measuredVolume.name,
        background: prepared.background,
      };
    } else {
      checkSampling({ ...parsed.optics, spacingUm, dims: volume.dims });
      const auto = autoPsfSize({ ...parsed.optics, spacingUm, dims: volume.dims });
      const size = {
        xy: parsed.psfXy ?? auto.xy,
        z: volume.dims[0] === 1 ? 1 : (parsed.psfZ ?? auto.z),
      };
      const rawPsf = wasm.gibsonLanniPsf(
        parsed.optics.na,
        parsed.optics.ni,
        parsed.optics.ns,
        parsed.optics.emissionUm,
        parsed.optics.excitationUm,
        spacingUm.x,
        spacingUm.z,
        size.xy,
        size.z,
        parsed.optics.depthUm,
      );
      psf = { data: rawPsf, dims: [size.z, size.xy, size.xy], source: "theoretical" };
    }

    const plan = memoryPlan(volume.dims, psf.dims, { tv: parsed.settings.tvWeight > 0 });
    if (!plan.fits) {
      throw new Error(`This stack and PSF need about ${Math.round(plan.bytes / 2 ** 20)} MB; crop the stack or shrink the PSF.`);
    }

    const { data: image } = prepareImage(volume.data);
    const solver = new wasm.Deconvolver(
      image,
      Uint32Array.from(volume.dims),
      normaliseSum(psf.data),
      Uint32Array.from(psf.dims),
      parsed.settings.tvWeight,
    );
    let estimate;
    try {
      for (let i = 1; i <= parsed.settings.iterations; i += 1) {
        solver.iterate(1);
        onProgress?.(0.05 + (0.9 * i) / parsed.settings.iterations, `${METHODS[parsed.settings.method].label}: iteration ${i} of ${parsed.settings.iterations}`);
      }
      estimate = Float32Array.from(solver.estimate());
      for (let i = 0; i < estimate.length; i += 1) {
        if (!Number.isFinite(estimate[i])) {
          throw new Error(`Deconvolved output contains a non-finite float32 value at voxel ${i}.`);
        }
      }
    } finally {
      solver.free();
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
    const names = outputNames(volume.name);
    const provenanceName = names.tiff.replace(/_deconvolved\.tif$/, "_provenance.json");
    const tiffBytes = new Uint8Array(stackTiff(estimate, volume.dims, spacingUm));
    const spacingOverridden = parsed.voxelXy !== undefined || parsed.voxelZ !== undefined;
    const niftiRaw = deconvolvedNifti(estimate, volume, spacingUm, { spacingOverridden });
    const niftiGz = gzipSync(new Uint8Array(niftiRaw));
    const psfTiffBytes = new Uint8Array(stackTiff(Float32Array.from(psf.data), psf.dims, spacingUm));
    const record = provenance({
      input: volume.name,
      dims: volume.dims,
      spacingUm,
      optics: parsed.optics,
      psf,
      settings: parsed.settings,
      seconds,
    });

    const written = await commitOutputs(
      reservation.dir,
      [
        { name: names.tiff, data: tiffBytes },
        { name: names.nifti, data: niftiGz },
        { name: names.psfTiff, data: psfTiffBytes },
        { name: provenanceName, data: Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8") },
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
      provenance: record,
      dims: volume.dims,
      psfDims: psf.dims,
      seconds,
    };
  } finally {
    await reservation.release({ removeCreated: !committed });
  }
}

/** Offline self-check: verifies WASM module loading, Gibson-Lanni PSF and RL solver on a tiny 3D phantom. */
const CHECK_OPTION_KEYS = new Set(["cacheDir", "cache-dir"]);

export async function checkInstallation(opts) {
  const validated = assertPlainOptions(opts, CHECK_OPTION_KEYS, "checkInstallation options");
  const cacheDirRaw = readAliasedOption(validated, "cache-dir", "cacheDir");
  const cacheDir = cacheDirRaw !== undefined ? assertNonEmptyString(cacheDirRaw, "cache-dir") : undefined;
  const resolvedCache = cacheDir ? resolve(cacheDir) : undefined;
  const wasm = loadDeconvolution();
  const psf = wasm.gibsonLanniPsf(1.4, 1.518, 1.47, 0.52, 0.0, 0.1, 0.2, 5, 5, 0.0);
  if (psf.length !== 125 || !(psf[62] > 0)) {
    throw new Error("Self-check failed: Gibson-Lanni PSF did not peak at center.");
  }
  const image = new Float64Array(8 * 8 * 8);
  image[(4 * 8 + 4) * 8 + 4] = 100;
  const solver = new wasm.Deconvolver(image, Uint32Array.from([8, 8, 8]), normaliseSum(psf), Uint32Array.from([5, 5, 5]), 0);
  let out;
  try {
    solver.iterate(1);
    out = Float32Array.from(solver.estimate());
  } finally {
    solver.free();
  }
  if (out.length !== 512 || !Number.isFinite(out[0])) {
    throw new Error("Self-check failed: Richardson-Lucy solver returned invalid output.");
  }
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    executable: process.execPath,
    node: process.version,
    methods: Object.keys(METHODS),
    ...(resolvedCache ? { cacheDir: resolvedCache } : {}),
  };
}
