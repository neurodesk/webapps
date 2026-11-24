// Node command-line interface for @neurodesk/denoise.
// Runs the exact same self-supervised denoising core and calibrated TIFF/NIfTI encoders
// as the Denoise web application.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import {
  DEFAULT_SETTINGS,
  MAX_SCALES,
  METHODS,
  MODES,
  NOISE_MODELS,
  denoiseVolume,
  runSettings,
} from "./core/denoise.js";
import { createNormalRng, createRng } from "./core/rng.js";
import { exportNiftiBuffer, outputNames, provenance, stackTiff } from "./format.js";
import { readVolume } from "./input.js";

/** Maximum decoded Float32 voxel bytes accepted by the CLI (256 MiB = 67.1M voxels). */
export const MAX_CLI_INPUT_BYTES = 2 ** 28;
const CLI_METADATA_BYTES = 2 ** 25;

const LOCK_NAME = ".denoise-run.lock";
const LOCK_TMP_PREFIX = ".denoise-lock-tmp-";
const STAGE_PREFIX = ".denoise-stage-";
const TRASH_PREFIX = ".denoise-trash-";
const PRESERVED_BACKUP_PREFIX = ".denoise-preserved-backup-";
const OWNER_FILE_RE = /^owner-([0-9a-f]+)\.json$/;

export const OUTPUT_FORMATS = Object.freeze(["auto", "tiff", "nifti", "both"]);

export const OPTIONS = Object.freeze({
  method: {
    type: "string",
    enum: Object.keys(METHODS),
    default: DEFAULT_SETTINGS.method,
    description: "Self-supervised or classical denoising method.",
  },
  mode: {
    type: "string",
    enum: [...MODES],
    default: DEFAULT_SETTINGS.mode,
    description: "Processing mode for FGR and VST-NLM (auto uses 3D on stacks, 2D on single planes).",
  },
  nTrees: {
    type: "integer",
    flag: "trees",
    minimum: 10,
    maximum: 200,
    default: DEFAULT_SETTINGS.nTrees,
    description: "Boosted trees count for fgr-gbdt.",
  },
  maxDepth: {
    type: "integer",
    flag: "depth",
    minimum: 2,
    maximum: 6,
    default: DEFAULT_SETTINGS.maxDepth,
    description: "Maximum tree depth for fgr-gbdt.",
  },
  maxScale: {
    type: "integer",
    flag: "max-scale",
    enum: [...MAX_SCALES],
    default: DEFAULT_SETTINGS.maxScale,
    description: "Maximum J-invariant feature radius in pixels for FGR.",
  },
  iterations: {
    type: "integer",
    minimum: 50,
    maximum: 1500,
    default: DEFAULT_SETTINGS.iterations,
    description: "Adam optimization steps for zs-n2n.",
  },
  channels: {
    type: "integer",
    minimum: 16,
    maximum: 48,
    default: DEFAULT_SETTINGS.channels,
    description: "Residual CNN channel width for zs-n2n.",
  },
  noiseModel: {
    type: "string",
    flag: "noise-model",
    enum: [...NOISE_MODELS],
    default: DEFAULT_SETTINGS.noiseModel,
    description: "Noise variance model for vst-nlm.",
  },
  nlmStrength: {
    type: "number",
    flag: "nlm-strength",
    minimum: 0.2,
    maximum: 3.0,
    default: DEFAULT_SETTINGS.nlmStrength,
    description: "Non-local means filter strength multiplier for vst-nlm.",
  },
  seed: {
    type: "integer",
    minimum: 0,
    maximum: 2147483647,
    default: DEFAULT_SETTINGS.seed,
    description: "Deterministic random seed for FGR and zs-n2n.",
  },
  format: {
    type: "string",
    enum: [...OUTPUT_FORMATS],
    default: "auto",
    description: "Output image format (auto matches input format; both writes TIFF and NIfTI).",
  },
  residual: {
    type: "boolean",
    default: false,
    description: "Also write the noise residual map (input minus denoised).",
  },
  overwrite: {
    type: "boolean",
    default: false,
    description: "Allow writing into a non-empty output directory.",
  },
});

export function optionName(key) {
  return OPTIONS[key]?.flag ?? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function parseNumeric(raw, label, { integer = false } = {}) {
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`--${label} requires a value.`);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`--${label} must be a finite number, got '${raw}'.`);
  if (integer && !Number.isInteger(value)) throw new Error(`--${label} must be an integer, got '${raw}'.`);
  return value;
}

/** Parses CLI option values into validated denoising settings + output flags. */
export function parseCliOptions(values = {}) {
  const format = values.format ?? "auto";
  if (!OUTPUT_FORMATS.includes(format)) {
    throw new Error(`--format must be one of: ${OUTPUT_FORMATS.join(", ")}.`);
  }
  const settings = runSettings({
    method: values.method,
    mode: values.mode,
    nTrees: parseNumeric(values.trees ?? values.nTrees, "trees", { integer: true }),
    maxDepth: parseNumeric(values.depth ?? values.maxDepth, "depth", { integer: true }),
    maxScale: parseNumeric(values["max-scale"] ?? values.maxScale, "max-scale", { integer: true }),
    iterations: parseNumeric(values.iterations, "iterations", { integer: true }),
    channels: parseNumeric(values.channels, "channels", { integer: true }),
    noiseModel: values["noise-model"] ?? values.noiseModel,
    nlmStrength: parseNumeric(values["nlm-strength"] ?? values.nlmStrength, "nlm-strength"),
    seed: parseNumeric(values.seed, "seed", { integer: true }),
  });
  return {
    settings,
    format,
    residual: Boolean(values.residual),
    overwrite: Boolean(values.overwrite),
  };
}

/**
 * Opens an input file non-blockingly (`O_NONBLOCK` on POSIX so FIFOs/pipes never hang),
 * rejects non-regular files and oversized files before reading, and reads at most `maxFileBytes`.
 * Returns a zero-copy File-like object compatible with `readVolume` and `assertNiftiDecodedSize`.
 */
async function readBoundedInputFile(resolvedInput, inputName, maxFileBytes) {
  // O_NONBLOCK prevents open() from blocking indefinitely on a named pipe (FIFO) with no writer;
  // POSIX ignores O_NONBLOCK for regular files.
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);
  const fh = await open(resolvedInput, openFlags);
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error(`${inputName} is not a regular file.`);
    if (info.size === 0) throw new Error(`${inputName} is empty.`);
    if (info.size > maxFileBytes) {
      throw new InputTooLargeError(info.size, maxFileBytes, { subject: inputName });
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
        throw new InputTooLargeError(total, maxFileBytes, { subject: inputName });
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }

    const combined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
    const bytes = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
    const makeSlice = (start = 0, end = bytes.byteLength) => {
      const len = bytes.byteLength;
      const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
      const e = end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
      const view = bytes.subarray(s, Math.max(s, e));
      return {
        size: view.byteLength,
        arrayBuffer: async () => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
        stream: () => new Blob([view]).stream(),
      };
    };

    return {
      name: inputName,
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      slice: makeSlice,
      stream: () => new Blob([bytes]).stream(),
    };
  } finally {
    await fh.close();
  }
}

function isLocalProcessDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH means no process with this PID exists; EPERM means it exists under another user.
    return error.code === "ESRCH";
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isLockContentionError(error) {
  return (
    error.code === "EEXIST" ||
    error.code === "ENOTEMPTY" ||
    error.code === "EPERM" ||
    error.code === "EACCES"
  );
}

/**
 * Safely clears a provably stale owner token inside `.denoise-run.lock/` left by a crashed local
 * process (`ESRCH`). Because each lock directory holds a unique `owner-<token>.json` file and
 * live owners enter atomically via `rename(nonEmptyTmpDir, lockDir)`, unlinking only the verified
 * dead `owner-<deadToken>.json` file and `rmdir`ing only if empty can never remove a concurrent
 * live owner's lock.
 */
async function tryClearStaleLock(lockPath, { onLockInspect } = {}) {
  let entries;
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }

  if (entries.length === 0) {
    // An empty lock directory only occurs mid-release or right after unlinking a dead owner;
    // rmdir() atomically refuses (ENOTEMPTY) if a live owner populates it in the meantime.
    await rmdir(lockPath).catch(() => {});
    return true;
  }

  if (entries.length !== 1) return false;
  const ownerEntry = entries[0];
  const match = ownerEntry.match(OWNER_FILE_RE);
  if (!match) return false;

  const ownerPath = join(lockPath, ownerEntry);
  let raw;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (
    !parsed ||
    parsed.host !== hostname() ||
    parsed.token !== match[1] ||
    !isLocalProcessDead(parsed.pid)
  ) {
    return false;
  }

  await onLockInspect?.({ lockPath, ownerEntry, ownerPath, parsed });

  try {
    // Identity-locked removal: only removes the exact dead token file we verified above.
    await unlink(ownerPath);
  } catch {
    // Another contender already removed this exact dead owner token (and may now own the lock).
    return false;
  }

  await rmdir(lockPath).catch(() => {});
  return true;
}

/**
 * Atomically moves a completed or fully recovered staging directory out of the `.denoise-stage-*`
 * recovery namespace into `.denoise-trash-*` before recursively deleting it. A `SIGKILL` midway
 * through recursive deletion (e.g. after unlinking a staged output file or `_committed`, before
 * unlinking `_manifest.json`) can then never cause the next run to misclassify already-restored
 * or already-committed files in `resolvedDir` as partial outputs.
 *
 * Must be called only while holding the exclusive directory lock on `resolvedDir`.
 */
async function discardStageDir(resolvedDir, stagePath) {
  const trashPath = join(resolvedDir, `${TRASH_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await rename(stagePath, trashPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    // Fallback if rename fails: disarm `_manifest.json` first so recovery can never delete files
    // in `resolvedDir`; if disarming also fails, leave `stagePath` intact rather than half-deleting.
    try {
      await unlink(join(stagePath, "_manifest.json"));
    } catch (unlinkErr) {
      if (unlinkErr.code !== "ENOENT") return;
    }
    await rm(stagePath, { recursive: true, force: true }).catch(() => {});
    return;
  }
  await rm(trashPath, { recursive: true, force: true }).catch(() => {});
}

/**
 * Recovers any interrupted staging directories left by crashed local runs (or blocks if a prior
 * failed rollback preserved backups in `_backup` that require manual resolution). Must be called
 * only while holding the exclusive directory lock on `resolvedDir`.
 */
async function recoverInterruptedStages(resolvedDir, outputDir) {
  const entries = await readdir(resolvedDir);
  for (const entry of entries) {
    if (entry.startsWith(TRASH_PREFIX)) {
      await rm(join(resolvedDir, entry), { recursive: true, force: true }).catch(() => {});
      continue;
    }

    if (entry.startsWith(LOCK_TMP_PREFIX)) {
      const tmpPath = join(resolvedDir, entry);
      let info;
      try {
        info = await lstat(tmpPath);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      let tmpEntries;
      try {
        tmpEntries = await readdir(tmpPath);
      } catch {
        continue;
      }
      if (tmpEntries.length === 1 && OWNER_FILE_RE.test(tmpEntries[0])) {
        const parsed = await readJsonIfPresent(join(tmpPath, tmpEntries[0]));
        if (parsed && parsed.host === hostname() && isLocalProcessDead(parsed.pid)) {
          await rm(tmpPath, { recursive: true, force: true }).catch(() => {});
        }
      }
      continue;
    }

    if (entry.startsWith(PRESERVED_BACKUP_PREFIX)) {
      const preservedPath = join(resolvedDir, entry);
      let info;
      try {
        info = await lstat(preservedPath);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      const preservedBackup = join(preservedPath, "_backup");
      throw new Error(
        `Output directory '${outputDir}' contains preserved backup(s) from a failed rollback in '${preservedBackup}'. Restore or remove them manually before retrying.`,
      );
    }

    if (!entry.startsWith(STAGE_PREFIX)) continue;
    const stagePath = join(resolvedDir, entry);
    let info;
    try {
      info = await lstat(stagePath);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;

    const backupDir = join(stagePath, "_backup");
    const rollbackFailed = await readJsonIfPresent(join(stagePath, "_rollback-failed.json"));
    if (rollbackFailed) {
      throw new Error(
        `Output directory '${outputDir}' contains preserved backup(s) from a failed rollback in '${backupDir}'. Restore or remove them manually before retrying.`,
      );
    }

    const meta = (await readJsonIfPresent(join(stagePath, "_meta.json"))) ??
      (await readJsonIfPresent(join(stagePath, "_manifest.json")));

    let isDeadLocal = false;
    if (meta) {
      isDeadLocal = meta.host === hostname() && isLocalProcessDead(meta.pid);
    } else {
      const pidMatch = entry.match(/^\.denoise-stage-(\d+)-[0-9a-f]+$/);
      const parsedPid = pidMatch ? Number(pidMatch[1]) : NaN;
      const stageContents = await readdir(stagePath);
      if (isLocalProcessDead(parsedPid) && stageContents.length === 0) {
        await discardStageDir(resolvedDir, stagePath);
        continue;
      }
      if (await pathExists(backupDir)) {
        const backups = await readdir(backupDir).catch(() => []);
        if (backups.length > 0) {
          throw new Error(
            `Output directory '${outputDir}' contains unrecovered backup(s) in '${backupDir}'. Restore or remove them manually before retrying.`,
          );
        }
      }
      continue;
    }

    if (!isDeadLocal) continue;

    // If the interrupted run already finished publishing all outputs before dying during cleanup,
    // the outputs in `resolvedDir` are complete and `_backup` is obsolete.
    if (await pathExists(join(stagePath, "_committed"))) {
      await discardStageDir(resolvedDir, stagePath);
      continue;
    }

    const manifest = await readJsonIfPresent(join(stagePath, "_manifest.json"));
    let backupFiles = [];
    try {
      backupFiles = await readdir(backupDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (!manifest && backupFiles.length === 0) {
      // Crashed before publish touched any destination file.
      await discardStageDir(resolvedDir, stagePath);
      continue;
    }

    const recoveryFailures = [];
    const stagedFiles = Array.isArray(manifest?.stagedFiles) ? manifest.stagedFiles : [];
    const backupSet = new Set(backupFiles);
    const blockedNames = new Set();

    // Move any partial outputs that the killed run already moved into `resolvedDir` back into
    // `stagePath` BEFORE restoring any `_backup` files. This preserves the invariant that
    // `stagePath/<name>` exists whenever `resolvedDir/<name>` holds a restored original, so even
    // a second SIGKILL mid-recovery cannot mistake a restored original for a partial output.
    for (const name of stagedFiles) {
      const stagedTarget = join(stagePath, name);
      if (await pathExists(stagedTarget)) continue;
      const target = join(resolvedDir, name);
      try {
        const targetInfo = await lstat(target);
        if (targetInfo.isDirectory()) {
          recoveryFailures.push(`${name} (destination is a directory)`);
          blockedNames.add(name);
        } else {
          await rename(target, stagedTarget);
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          if (backupSet.has(name)) {
            try {
              await writeFile(stagedTarget, "");
            } catch (markerErr) {
              recoveryFailures.push(`${name} (${markerErr.code || markerErr.message})`);
              blockedNames.add(name);
            }
          }
        } else {
          recoveryFailures.push(`${name} (${error.code || error.message})`);
          blockedNames.add(name);
        }
      }
    }

    // Restore every backed-up original file into `resolvedDir` without clobbering unexpected entries.
    for (const name of backupFiles) {
      if (blockedNames.has(name)) continue;
      const src = join(backupDir, name);
      const dst = join(resolvedDir, name);
      if (await pathExists(dst)) {
        recoveryFailures.push(`${name} (destination already exists)`);
        continue;
      }
      try {
        await rename(src, dst);
      } catch (error) {
        recoveryFailures.push(`${name} (${error.code || error.message})`);
      }
    }

    const remainingBackups = await readdir(backupDir).catch(() => []);
    if (recoveryFailures.length > 0 || remainingBackups.length > 0) {
      throw new Error(
        `Cannot recover interrupted run in '${outputDir}': ${recoveryFailures.join(", ") || "backups remain"}; original backup(s) preserved in '${backupDir}'.`,
      );
    }

    await discardStageDir(resolvedDir, stagePath);
  }
}

/**
 * Exclusively reserves `outputDir` before processing by atomically renaming a pre-populated
 * lock directory (containing `owner-<token>.json`) onto `.denoise-run.lock`. Because live lock
 * directories are never empty, concurrent renames fail atomically and stale-lock recovery can
 * unlink only a verified dead token file without ever disturbing a live owner.
 */
async function reserveOutputDir(outputDir, { overwrite = false, onLockInspect } = {}) {
  const resolved = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`Output path '${outputDir}' exists and is not a directory.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(resolved, { recursive: true });
    createdDir = true;
  }

  const lockPath = join(resolved, LOCK_NAME);
  const token = randomBytes(8).toString("hex");
  const ownerFile = `owner-${token}.json`;
  const stageLockDir = join(resolved, `${LOCK_TMP_PREFIX}${process.pid}-${token}`);
  const lockPayload = `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now(), token })}\n`;

  await mkdir(stageLockDir, { recursive: false });
  let acquired = false;
  try {
    await writeFile(join(stageLockDir, ownerFile), lockPayload, "utf8");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(stageLockDir, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (error.code === "ENOTDIR") {
          throw new Error(
            `Output directory '${outputDir}' is locked by another running denoise process (or contains ${LOCK_NAME}).`,
          );
        }
        if (isLockContentionError(error)) {
          if (attempt < 2 && (await tryClearStaleLock(lockPath, { onLockInspect }))) {
            continue;
          }
          throw new Error(
            `Output directory '${outputDir}' is locked by another running denoise process (or contains ${LOCK_NAME}).`,
          );
        }
        throw error;
      }
    }
  } finally {
    if (!acquired) {
      await rm(stageLockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const release = async ({ removeIfEmpty = false } = {}) => {
    await unlink(join(lockPath, ownerFile)).catch(() => {});
    await rmdir(lockPath).catch(() => {});
    if (removeIfEmpty && createdDir) {
      await rmdir(resolved).catch(() => {});
    }
  };

  try {
    await recoverInterruptedStages(resolved, outputDir);
    if (!overwrite) {
      const entries = (await readdir(resolved)).filter(
        (name) => name !== LOCK_NAME && !name.startsWith(LOCK_TMP_PREFIX),
      );
      if (entries.length > 0) {
        throw new Error(`Output directory '${outputDir}' is not empty. Choose a new directory or pass --overwrite.`);
      }
    }
  } catch (error) {
    await release({ removeIfEmpty: true });
    throw error;
  }

  return { dir: resolved, createdDir, release };
}

/**
 * Validates all target destination paths before publishing staged outputs so a colliding
 * directory or blocked path fails cleanly without leaving partial outputs behind.
 */
async function assertPublishableTargets(dir, filenames, { overwrite }) {
  for (const name of filenames) {
    const target = join(dir, name);
    try {
      const info = await lstat(target);
      if (info.isDirectory()) {
        throw new Error(`Cannot write '${name}' because '${target}' is a directory.`);
      }
      if (!overwrite) {
        throw new Error(`Output file '${target}' already exists. Choose a new directory or pass --overwrite.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Publishes all staged files into `dir` with transactional rollback: records a commit manifest,
 * backs up any existing targets that would be overwritten, renames every staged file into place,
 * marks commit complete, and on any failure removes newly published files and restores every
 * backed-up original file. If restoration fails, preserves `_backup` intact and reports its path.
 */
async function publishStagedFiles(dir, stageDir, stagedFiles, { overwrite, renameFn = rename } = {}) {
  const backupDir = join(stageDir, "_backup");
  const backedUp = [];
  const publishedNames = [];

  await writeFile(
    join(stageDir, "_manifest.json"),
    `${JSON.stringify({ pid: process.pid, host: hostname(), stagedFiles, overwrite })}\n`,
    "utf8",
  );

  try {
    if (overwrite) {
      for (const name of stagedFiles) {
        const target = join(dir, name);
        let exists = false;
        try {
          await lstat(target);
          exists = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (exists) {
          if (!backedUp.length) await mkdir(backupDir, { recursive: false });
          await renameFn(target, join(backupDir, name));
          backedUp.push(name);
        }
      }
    }

    const written = [];
    for (const name of stagedFiles) {
      const finalPath = join(dir, name);
      await renameFn(join(stageDir, name), finalPath);
      publishedNames.push(name);
      written.push(finalPath);
    }

    await writeFile(join(stageDir, "_committed"), "ok\n", "utf8");
    return written;
  } catch (error) {
    // Move newly published files back into `stageDir` before restoring `_backup` so that even a
    // hard kill mid-rollback preserves the invariant that `stageDir/<name>` exists whenever
    // `dir/<name>` holds an original file.
    const clearFailures = new Map();
    for (const name of publishedNames) {
      const dst = join(dir, name);
      const staged = join(stageDir, name);
      try {
        await rename(dst, staged);
      } catch (moveErr) {
        if (moveErr.code === "ENOENT") {
          if (backedUp.includes(name)) {
            try {
              await writeFile(staged, "");
            } catch (markerErr) {
              clearFailures.set(name, markerErr);
            }
          }
        } else {
          clearFailures.set(name, moveErr);
        }
      }
    }

    const restoreFailures = [];
    for (const name of backedUp) {
      const src = join(backupDir, name);
      const dst = join(dir, name);
      if (clearFailures.has(name)) {
        restoreFailures.push({ name, backupPath: src, error: clearFailures.get(name) });
        continue;
      }
      try {
        await rename(src, dst);
      } catch (restoreErr) {
        restoreFailures.push({ name, backupPath: src, error: restoreErr });
      }
    }

    const unremovedNew = [...clearFailures.entries()]
      .filter(([name]) => !backedUp.includes(name))
      .map(([name, err]) => ({ name, error: err }));

    if (restoreFailures.length > 0 || unremovedNew.length > 0) {
      let reportedBackupDir = backupDir;
      let protectionError = null;
      if (restoreFailures.length > 0) {
        // Layer 1: Atomically rename `stageDir` to `.denoise-preserved-backup-*` (requires zero
        // new disk blocks and does not depend on writeFile succeeding).
        const preservedDir = join(dir, `${PRESERVED_BACKUP_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`);
        let protectedByRename = false;
        try {
          await rename(stageDir, preservedDir);
          protectedByRename = true;
          reportedBackupDir = join(preservedDir, "_backup");
        } catch (renameErr) {
          protectionError = renameErr;
        }

        // Layer 2: Write diagnostic `_rollback-failed.json` inside the preserved directory.
        const markerDir = protectedByRename ? preservedDir : stageDir;
        let protectedByMarker = false;
        try {
          await writeFile(
            join(markerDir, "_rollback-failed.json"),
            `${JSON.stringify(
              {
                pid: process.pid,
                host: hostname(),
                failedAt: Date.now(),
                backupDir: reportedBackupDir,
                unrestored: restoreFailures.map((f) => ({ name: f.name, reason: f.error.message })),
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
          protectedByMarker = true;
        } catch (markerErr) {
          if (!protectedByRename) protectionError = markerErr;
        }

        if (protectedByRename || protectedByMarker) {
          protectionError = null;
        } else {
          // Layer 3 (fail-closed last resort): remove `_manifest.json` and `_meta.json` so
          // recoverInterruptedStages refuses to auto-recover or overwrite non-empty `_backup`.
          try {
            await unlink(join(stageDir, "_manifest.json")).catch((e) => {
              if (e.code !== "ENOENT") throw e;
            });
            await unlink(join(stageDir, "_meta.json")).catch((e) => {
              if (e.code !== "ENOENT") throw e;
            });
            protectionError = null;
          } catch (unlinkErr) {
            protectionError = unlinkErr;
          }
        }
      }
      const parts = [];
      if (restoreFailures.length > 0) {
        const names = restoreFailures.map((f) => `${f.name} (${f.error.code || f.error.message})`).join(", ");
        parts.push(`rollback failed to restore ${names}; original backup(s) preserved in '${reportedBackupDir}'`);
        if (protectionError) {
          parts.push(`could not mark backup as protected (${protectionError.code || protectionError.message})`);
        }
      }
      if (unremovedNew.length > 0) {
        const names = unremovedNew.map((f) => `${f.name} (${f.error.code || f.error.message})`).join(", ");
        parts.push(`failed to remove partial output(s): ${names}`);
      }
      const wrapped = new Error(`${error.message}; ${parts.join("; ")}`, { cause: error });
      wrapped.code = error.code;
      if (restoreFailures.length > 0) {
        wrapped.preservedBackupDir = reportedBackupDir;
      }
      throw wrapped;
    }

    throw error;
  }
}

/**
 * Denoises one TIFF/OME-TIFF/NIfTI file on disk and writes calibrated outputs + provenance JSON
 * atomically into `outputDir`.
 */
export async function denoiseFile({
  input,
  outputDir,
  options = {},
  onProgress,
  maxBytes = MAX_CLI_INPUT_BYTES,
  maxFileBytes = maxBytes + CLI_METADATA_BYTES,
  renameFn = rename,
  onLockInspect,
}) {
  if (!input) throw new Error("Input file path is required.");
  if (!outputDir) throw new Error("Output directory path is required.");

  const { settings, format, residual: writeResidual, overwrite } = parseCliOptions(options);
  const resolvedInput = resolve(input);
  const inputName = basename(resolvedInput);
  const file = await readBoundedInputFile(resolvedInput, inputName, maxFileBytes);
  const volume = await readVolume(file, { maxBytes, maxFileBytes });

  const reservation = await reserveOutputDir(outputDir, { overwrite, onLockInspect });
  const stageDir = join(reservation.dir, `${STAGE_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`);
  let published = false;
  let preserveStageDir = false;

  try {
    const names = outputNames(inputName);
    const targetFormat = format === "auto" ? volume.format : format;
    const writeTiff = targetFormat === "tiff" || targetFormat === "both";
    const writeNifti = targetFormat === "nifti" || targetFormat === "both";

    const plannedNames = [];
    if (writeTiff) {
      plannedNames.push(names.tiff);
      if (writeResidual) plannedNames.push(names.residualTiff);
    }
    if (writeNifti) {
      plannedNames.push(names.nifti);
      if (writeResidual) plannedNames.push(names.residualNifti);
    }
    plannedNames.push(names.provenance);

    // Reject unwritable targets (e.g. a directory at the provenance path) before heavy compute.
    await assertPublishableTargets(reservation.dir, plannedNames, { overwrite });

    const started = performance.now();
    const result = denoiseVolume(volume.data, volume.dims, settings, (fraction, stage) => {
      onProgress?.(fraction, stage);
    });
    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const exportOpts = { axisKind: volume.axisKind, frameInterval: volume.frameInterval };
    const record = provenance({
      input: inputName,
      dims: volume.dims,
      axisKind: volume.axisKind,
      settings: result.settings,
      details: result.details,
      diagnostics: result.diagnostics,
      seconds,
    });

    const stagedFiles = [];
    await mkdir(stageDir, { recursive: false });
    await writeFile(
      join(stageDir, "_meta.json"),
      `${JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() })}\n`,
      "utf8",
    );
    if (writeTiff) {
      const data = new Uint8Array(stackTiff(result.denoised, volume.dims, volume.spacingUm, exportOpts));
      await writeFile(join(stageDir, names.tiff), data);
      stagedFiles.push(names.tiff);
      if (writeResidual) {
        const resData = new Uint8Array(stackTiff(result.residual, volume.dims, volume.spacingUm, exportOpts));
        await writeFile(join(stageDir, names.residualTiff), resData);
        stagedFiles.push(names.residualTiff);
      }
    }
    if (writeNifti) {
      const niftiBuf = exportNiftiBuffer(result.denoised, volume);
      await writeFile(join(stageDir, names.nifti), gzipSync(new Uint8Array(niftiBuf)));
      stagedFiles.push(names.nifti);
      if (writeResidual) {
        const resBuf = exportNiftiBuffer(result.residual, volume);
        await writeFile(join(stageDir, names.residualNifti), gzipSync(new Uint8Array(resBuf)));
        stagedFiles.push(names.residualNifti);
      }
    }
    await writeFile(join(stageDir, names.provenance), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    stagedFiles.push(names.provenance);

    // Re-check targets right before commit, then publish atomically with rollback on failure.
    await assertPublishableTargets(reservation.dir, stagedFiles, { overwrite });
    const written = await publishStagedFiles(reservation.dir, stageDir, stagedFiles, { overwrite, renameFn });
    published = true;

    return {
      outputDir: reservation.dir,
      outputs: written,
      primaryOutput: written[0],
      provenance: record,
      diagnostics: result.diagnostics,
      details: result.details,
      seconds,
    };
  } catch (error) {
    if (error?.preservedBackupDir) {
      preserveStageDir = true;
    }
    throw error;
  } finally {
    if (!preserveStageDir) {
      await discardStageDir(reservation.dir, stageDir);
    }
    await reservation.release({ removeIfEmpty: !published && !preserveStageDir });
  }
}

/**
 * Self-check verifying the installed runtime and core denoising methods offline on a tiny
 * synthetic image (used by `denoise self-check` and the portable release verifier).
 */
export async function checkInstallation() {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const h = 24;
  const w = 24;
  const rng = createRng(1337);
  const randn = createNormalRng(rng);
  const noisy = new Float32Array(h * w);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const clean = 50 + 30 * Math.sin(x / 4) * Math.cos(y / 4);
      noisy[y * w + x] = clean + randn() * 6;
    }
  }
  const fgr = denoiseVolume(noisy, [1, h, w], { method: "fgr-ridge", maxScale: 4, seed: 7 });
  const nlm = denoiseVolume(noisy, [1, h, w], { method: "vst-nlm", noiseModel: "gaussian" });
  const zs = denoiseVolume(noisy, [1, h, w], { method: "zs-n2n", iterations: 50, channels: 16, seed: 7 });
  if (!(fgr.diagnostics.noiseFloorDropDb > 0 && nlm.diagnostics.noiseFloorDropDb > 0 && zs.diagnostics.noiseFloorDropDb > 0)) {
    throw new Error("Self-check failed: denoiser did not reduce synthetic noise floor.");
  }
  return {
    ok: true,
    package: pkg.name,
    version: pkg.version,
    executable: process.execPath,
    node: process.version,
    methods: Object.keys(METHODS),
  };
}
