// Node command-line interface for @neurodesk/spot-detection.
// Runs the exact same Big-FISH LoG detector, elbow threshold, sub-pixel fit, per-cell counter
// and NIfTI spot-ring overlay writer as the Spot detection web application.
import { randomBytes } from "node:crypto";
import { constants as fsConstants, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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

export function parseCliOptions(values = {}) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Options must be a plain object.");
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error(`Unknown option '${key}'.`);
    }
  }
  const labelsPath = assertNonEmptyString(values.labels, "labels") ?? null;
  const voxelZ = parseNumeric(values["voxel-z"] ?? values.voxelZ, "voxel-z", { min: 0, exclusiveMin: true, float32Positive: true, float32Mm: true });
  const voxelYx = parseNumeric(values["voxel-yx"] ?? values.voxelYx, "voxel-yx", { min: 0, exclusiveMin: true, float32Positive: true, float32Mm: true });
  const radiusZ = parseNumeric(values["radius-z"] ?? values.radiusZ, "radius-z", { min: 0, exclusiveMin: true, float32Positive: true });
  const radiusYx = parseNumeric(values["radius-yx"] ?? values.radiusYx, "radius-yx", { min: 0, exclusiveMin: true, float32Positive: true });
  const threshold = parseNumeric(values.threshold, "threshold", { min: 0 });
  const projection = parseBooleanOption(values.projection, "projection");
  const subpixel = !parseBooleanOption(values["no-subpixel"] ?? values.noSubpixel, "no-subpixel");
  const overwrite = parseBooleanOption(values.overwrite, "overwrite");
  const envOffline = process.env.NEURODESK_OFFLINE === "1";
  if (values.offline !== undefined) {
    const explicit = parseBooleanOption(values.offline, "offline");
    if (envOffline && explicit === false) {
      throw new Error("Cannot set offline: false while NEURODESK_OFFLINE=1 is active.");
    }
  }
  const offline = envOffline || Boolean(values.offline);

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

async function mkdirTracking(targetDir) {
  const created = [];
  let cursor = resolve(targetDir);
  const toCreate = [];
  while (true) {
    try {
      const info = await stat(cursor);
      if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
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
        if (!info.isDirectory()) throw new Error(`Output path '${targetDir}' exists and is not a directory.`);
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
  const createdDirs = await mkdirTracking(dir);
  const cleanupCreated = async () => {
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) await rmdir(createdDirs[i]).catch(() => {});
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
    await lockHandle.writeFile(`${JSON.stringify({ tool: "spot-detection", pid: process.pid, host: hostname(), startedAt: Date.now() })}\n`, "utf8");
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
 * Detects smFISH spots in one TIFF image or stack (with optional cell labels TIFF) and writes
 * spots CSV, gzipped NIfTI overlay, optional per-cell counts CSV, and provenance JSON atomically.
 */
export async function detectSpotsFile({
  input,
  outputDir,
  options = {},
  onProgress,
  maxFileBytes = MAX_CLI_FILE_BYTES,
  renameFn = rename,
  readdirFn = readdir,
} = {}) {
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

  const reservation = await claimOutputDir(outputDir, { overwrite: parsed.overwrite, readdirFn });
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
      trackPartial: reservation.trackPartial,
      untrackPartial: reservation.untrackPartial,
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
