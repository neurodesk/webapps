// Node command-line interface for @neurodesk/calcium-imaging.
// Runs the exact same motion correction, ROI extraction, ΔF/F trace, and OASIS deconvolution
// pipeline as the Calcium imaging web application.
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import { imagejDescription, inspectTiffStack, readTiffStack, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import packageJson from "../package.json" with { type: "json" };
import { MAX_MOVIE_BYTES, MOTION_LABELS, checkMovie, provenance, readSettings } from "./config.js";
import { DEFAULTS, analyse, borderMargin, motionCorrect } from "./core/pipeline.js";
import { outputStem, roisCsv, shiftSvg, shiftsCsv, toInputType, traceSvg, tracesCsv } from "./outputs.js";

export const OUTPUT_LOCK_FILE = ".neurodesk-cli.lock";
const LINK_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"]);
const MAX_INPUT_FILE_BYTES = 1024 ** 3;
const NORMALIZATIONS = new Set(["none", "phase"]);
const ALLOWED_OPTION_KEYS = new Set([
  "frame-rate",
  "motion",
  "max-shift",
  "upsample",
  "normalization",
  "template-passes",
  "patch-size",
  "patch-overlap",
  "max-deviation",
  "diameter",
  "seed-z",
  "neuropil-coefficient",
  "baseline-window",
  "baseline-percentile",
  "no-deconvolution",
  "no-registered",
  "offline",
]);

function assertPlainOptions(values) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("Options must be a plain object.");
  }
  const proto = Object.getPrototypeOf(values);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("Options must be a plain object.");
  }
  for (const key of Object.keys(values)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error(`Unknown option '--${key}'.`);
    }
  }
}

function parseBooleanOpt(raw, flag) {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new Error(`Option --${flag} must be a boolean, got ${typeof raw}.`);
  }
  return raw;
}

function parseScalarNumberInput(raw, flag) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new Error(`Option --${flag} must be a finite number, got ${typeof raw}.`);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`Option --${flag} requires a non-empty value.`);
  return trimmed;
}

/** Validates CLI flags before reading the movie or claiming OUTPUT_DIR. */
export function parseCliOptions(values = {}) {
  assertPlainOptions(values);
  const motion = values.motion === undefined ? DEFAULTS.motion : values.motion;
  if (typeof motion !== "string" || !Object.hasOwn(MOTION_LABELS, motion)) {
    throw new Error(`Option --motion must be one of ${Object.keys(MOTION_LABELS).join(", ")}, got '${values.motion}'.`);
  }
  const normalization = values.normalization === undefined ? DEFAULTS.normalization : values.normalization;
  if (typeof normalization !== "string" || !NORMALIZATIONS.has(normalization)) {
    throw new Error(`Option --normalization must be one of none, phase, got '${values.normalization}'.`);
  }
  const noDeconvolution = parseBooleanOpt(values["no-deconvolution"], "no-deconvolution");
  const noRegistered = parseBooleanOpt(values["no-registered"], "no-registered");
  parseBooleanOpt(values.offline, "offline");

  const frameRate = parseScalarNumberInput(values["frame-rate"], "frame-rate");
  const raw = {
    motion,
    normalization,
    deconvolution: !noDeconvolution,
    frameRate: frameRate === undefined ? 10 : frameRate,
    maxShift: parseScalarNumberInput(values["max-shift"], "max-shift"),
    upsample: parseScalarNumberInput(values.upsample, "upsample"),
    templatePasses: parseScalarNumberInput(values["template-passes"], "template-passes"),
    patchSize: parseScalarNumberInput(values["patch-size"], "patch-size"),
    patchOverlap: parseScalarNumberInput(values["patch-overlap"], "patch-overlap"),
    maxDeviation: parseScalarNumberInput(values["max-deviation"], "max-deviation"),
    diameter: parseScalarNumberInput(values.diameter, "diameter"),
    seedZ: parseScalarNumberInput(values["seed-z"], "seed-z"),
    neuropilCoefficient: parseScalarNumberInput(values["neuropil-coefficient"], "neuropil-coefficient"),
    baselineWindow: parseScalarNumberInput(values["baseline-window"], "baseline-window"),
    baselinePercentile: parseScalarNumberInput(values["baseline-percentile"], "baseline-percentile"),
  };
  const validated = readSettings(raw);
  return {
    settings: validated,
    explicitFrameRate: frameRate !== undefined,
    writeRegistered: !noRegistered,
  };
}

function rollbackPublishSync(pub) {
  let clean = true;
  if (pub.pendingRename) {
    const { finalPath, dev, ino } = pub.pendingRename;
    try {
      const info = lstatSync(finalPath);
      if (info.isFile() && !info.isSymbolicLink() && info.dev === dev && info.ino === ino) {
        unlinkSync(finalPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  for (const item of [...pub.published].reverse()) {
    try {
      const info = lstatSync(item.finalPath);
      if (info.isFile() && !info.isSymbolicLink() && info.dev === item.dev && info.ino === item.ino) {
        unlinkSync(item.finalPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  for (const backup of [...pub.backups].reverse()) {
    try {
      renameSync(backup.backupPath, backup.targetPath);
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  for (const item of pub.staged) {
    try {
      const info = lstatSync(item.partialPath);
      if (info.isFile() && !info.isSymbolicLink()) {
        unlinkSync(item.partialPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") clean = false;
    }
  }
  return clean;
}

/**
 * Exclusively claims `outputDir` with the shared `.neurodesk-cli.lock` O_EXCL lock file,
 * registering SIGINT/SIGTERM handlers BEFORE creating the directory/lock, using synchronous
 * lock acquisition (zero async window), rolling back mid-publication on signal, and keeping
 * `.neurodesk-cli.lock` on disk if rollback fails.
 */
export async function claimOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Output directory must be a non-empty path.");
  }
  const directory = resolve(outputDir);
  const lockPath = join(directory, OUTPUT_LOCK_FILE);
  let createdDir = false;
  let lockOwned = false;
  let signalsRegistered = false;
  let activePublish = null;
  let rollbackFailed = false;

  const unregisterSignals = () => {
    if (!signalsRegistered) return;
    signalsRegistered = false;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  };

  const handleSignal = (signal) => {
    unregisterSignals();
    let canReleaseLock = !rollbackFailed;
    if (activePublish) {
      if (!activePublish.committed) {
        canReleaseLock = rollbackPublishSync(activePublish) && canReleaseLock;
      } else {
        for (const backup of activePublish.backups) {
          try {
            unlinkSync(backup.backupPath);
          } catch {
            // ignore
          }
        }
      }
    }
    if (canReleaseLock && lockOwned) {
      lockOwned = false;
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
      if (createdDir && (!activePublish || !activePublish.committed)) {
        try {
          rmdirSync(directory);
        } catch {
          // leave non-empty dir intact
        }
      }
    }
    if (process.platform === "win32") {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    process.kill(process.pid, signal);
  };
  const onSigInt = () => handleSignal("SIGINT");
  const onSigTerm = () => handleSignal("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  signalsRegistered = true;

  let fd = null;
  try {
    try {
      const info = lstatSync(directory);
      if (info.isSymbolicLink()) {
        throw new Error(`Output path '${directory}' must not be a symbolic link.`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Output path '${directory}' exists and is not a directory.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(directory, { recursive: true });
      createdDir = true;
      const createdInfo = lstatSync(directory);
      if (createdInfo.isSymbolicLink() || !createdInfo.isDirectory()) {
        throw new Error(`Output path '${directory}' is not a regular directory.`);
      }
    }

    fd = openSync(lockPath, "wx");
    lockOwned = true;
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    closeSync(fd);
    fd = null;

    const entries = readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== OUTPUT_LOCK_FILE) {
      throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    unregisterSignals();
    if (lockOwned) {
      lockOwned = false;
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
    if (createdDir) {
      try {
        rmdirSync(directory);
      } catch {
        // ignore
      }
    }
    if (error.code === "EEXIST") {
      throw new Error(`Output directory ${directory} is already in use by another run or not empty. Choose a new or empty directory.`);
    }
    throw error;
  }

  return {
    directory,
    createdDir,
    attachPublish(state) {
      activePublish = state;
    },
    detachPublish() {
      activePublish = null;
    },
    markRollbackFailed() {
      rollbackFailed = true;
    },
    async release({ removeDirIfEmpty = false } = {}) {
      unregisterSignals();
      if (rollbackFailed) return;
      if (lockOwned) {
        lockOwned = false;
        await rm(lockPath, { force: true }).catch(() => {});
      }
      if (removeDirIfEmpty && createdDir) {
        await rmdir(directory).catch(() => {});
      }
    },
  };
}

/**
 * Stages every output file to a `.partial` path first (registering each path BEFORE `writeFile`),
 * then atomically publishes via hard link (`link` + `unlink`, failing with `EEXIST` without
 * overwriting if a destination already exists, falling back to atomic `copyFileSync(..., COPYFILE_EXCL)` only when the
 * filesystem does not support hard links). Rolls back ONLY files this run created (verified by
 * `lstat` + `dev`/`ino`), and marks the lock on incomplete rollback.
 */
export async function writeStagedOutputs(
  directory,
  files,
  { claim = null, linkFn = linkSync, writeFileFn = writeFile } = {},
) {
  const runId = randomUUID().slice(0, 8);
  const pub = {
    staged: [],
    published: [],
    backups: [],
    pendingBackup: null,
    pendingRename: null,
    committed: false,
  };
  const seenNames = new Set();
  claim?.attachPublish?.(pub);
  try {
    for (const { name, bytes } of files) {
      if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        throw new Error(`Invalid output filename '${name}'.`);
      }
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) {
        throw new Error(`Duplicate output filename '${name}'.`);
      }
      seenNames.add(lower);

      const partialPath = join(directory, `.${name}.${runId}.partial`);
      const finalPath = join(directory, name);
      const item = { name, partialPath, finalPath, dev: null, ino: null };
      pub.staged.push(item);
      await writeFileFn(partialPath, bytes, { flag: "wx" });
      const stagedInfo = await lstat(partialPath);
      item.dev = stagedInfo.dev;
      item.ino = stagedInfo.ino;
    }
    const useSyncLink = linkFn === linkSync;
    for (const item of pub.staged) {
      pub.pendingRename = { finalPath: item.finalPath, dev: item.dev, ino: item.ino };
      try {
        if (useSyncLink) {
          // Synchronous hard link + unlink eliminates any async libuv window where
          // SIGTERM rollback could race with an in-flight link(2) syscall.
          linkSync(item.partialPath, item.finalPath);
          pub.published.push({ finalPath: item.finalPath, dev: item.dev, ino: item.ino });
          pub.pendingRename = null;
          unlinkSync(item.partialPath);
        } else {
          await linkFn(item.partialPath, item.finalPath);
          pub.published.push({ finalPath: item.finalPath, dev: item.dev, ino: item.ino });
          pub.pendingRename = null;
          await unlink(item.partialPath);
        }
      } catch (error) {
        pub.pendingRename = null;
        if (error.code === "EEXIST") {
          throw new Error(`Refusing to overwrite existing output '${item.name}'.`, { cause: error });
        }
        if (LINK_FALLBACK_CODES.has(error.code)) {
          throw new Error(
            `Atomic non-overwrite output publication requires hard-link support on '${directory}' (${error.code}).`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    pub.committed = true;
    for (const backup of pub.backups) {
      await unlink(backup.backupPath).catch(() => {});
    }
    return pub.staged.map((item) => item.name);
  } catch (error) {
    const rollbackClean = rollbackPublishSync(pub);
    if (!rollbackClean) {
      claim?.markRollbackFailed?.();
    }
    throw error;
  } finally {
    claim?.detachPublish?.();
  }
}

async function readMovieFile(inputPath) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Input '${inputPath}' is not a regular file.`);
  if (info.size === 0) throw new Error(`Input '${inputPath}' is empty.`);
  if (info.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`Input '${inputPath}' exceeds the 1 GiB file size limit.`);
  }
  const name = basename(resolved);
  if (!/\.tiff?$/i.test(name)) {
    throw new Error(`${name} is not a TIFF (.tif, .tiff or .ome.tif) movie.`);
  }
  const bytes = await readFile(resolved);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const tiffInfo = await inspectTiffStack(buffer);
  checkMovie(tiffInfo, name);
  let stack;
  try {
    stack = await readTiffStack(buffer, { Type: Float32Array, maxBytes: MAX_MOVIE_BYTES });
  } catch (error) {
    if (!(error instanceof InputTooLargeError)) throw error;
    throw new Error(`This movie needs ${(error.actualBytes / 1e9).toFixed(2)} GB as float32; the limit is ${(MAX_MOVIE_BYTES / 1e9).toFixed(1)} GB.`);
  }
  for (let i = 0; i < stack.data.length; i++) {
    if (!Number.isFinite(stack.data[i])) {
      throw new Error(`${name} contains NaN or infinite pixel values; clean non-finite pixels first.`);
    }
  }
  return {
    name,
    size: info.size,
    movie: stack.data,
    dims: {
      width: stack.width,
      height: stack.height,
      frames: stack.pages,
      dtype: stack.dtype,
      pixelSize: stack.metadata.pixelSize,
      frameInterval: stack.metadata.frameInterval,
      metadataKind: stack.metadata.kind,
    },
  };
}

function encodeTiff(data, { width, height, frames, frameRate, pixelSize }) {
  const description = imagejDescription({
    frames,
    frameInterval: frames > 1 ? 1 / frameRate : null,
    unit: pixelSize?.x ? "micron" : null,
  });
  return writeTiffStack({
    width,
    height,
    data,
    description,
    pixelSize: pixelSize?.x && pixelSize?.y ? pixelSize : null,
  });
}

/** Runs motion correction, ROI extraction, ΔF/F traces and OASIS deconvolution on a TIFF movie. */
export async function runCalciumImaging({
  input,
  outputDir,
  options = {},
  onLog = () => {},
  linkFn = linkSync,
} = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Input movie path is required.");
  }
  const parsed = parseCliOptions(options);
  const loaded = await readMovieFile(input);

  let frameRate;
  if (parsed.explicitFrameRate) {
    frameRate = parsed.settings.frameRate;
  } else if (loaded.dims.frameInterval && loaded.dims.frameInterval > 0) {
    frameRate = 1 / loaded.dims.frameInterval;
    // Validate metadata-derived frame rate against the same bounds
    readSettings({ ...parsed.settings, frameRate });
  } else {
    throw new Error("Frame rate (Hz) is not recorded in the TIFF metadata; pass --frame-rate N.");
  }
  const settings = { ...parsed.settings, frameRate };

  const claim = await claimOutputDirectory(outputDir);
  let succeeded = false;
  try {
    const started = performance.now();
    onLog(`Motion correction (${settings.motion}) on ${loaded.dims.frames} frames (${loaded.dims.width} × ${loaded.dims.height})…`);
    const regStart = performance.now();
    const registration = motionCorrect(loaded.movie, loaded.dims, settings);
    const registrationSeconds = Number(((performance.now() - regStart) / 1000).toFixed(2));
    const margin = borderMargin(registration.shifts, registration.patches);

    onLog(`Extracting ROIs and ΔF/F traces (border margin ${margin} px)…`);
    const analysisStart = performance.now();
    const analysis = analyse(
      registration.registered,
      { ...loaded.dims, frameRate: settings.frameRate },
      settings,
      null,
      { margin },
    );
    const analysisSeconds = Number(((performance.now() - analysisStart) / 1000).toFixed(2));
    const totalSeconds = Number(((performance.now() - started) / 1000).toFixed(2));

    const stem = outputStem(loaded.name);
    const encoder = new TextEncoder();
    const record = provenance({
      input: { name: loaded.name, size: loaded.size },
      settings,
      dims: loaded.dims,
      roiSource: "detected",
      cells: analysis.cells,
      detection: analysis.detection,
      timings: { registrationSeconds, analysisSeconds, totalSeconds },
      version: packageJson.version,
    });

    const outputs = [];
    if (parsed.writeRegistered) {
      outputs.push({
        name: `${stem}_registered.tif`,
        bytes: encodeTiff(toInputType(registration.registered, loaded.dims.dtype), {
          ...loaded.dims,
          frameRate: settings.frameRate,
        }),
      });
    }
    outputs.push(
      { name: `${stem}_shifts.csv`, bytes: encoder.encode(shiftsCsv(registration, settings.frameRate)) },
      { name: `${stem}_mean.tif`, bytes: encodeTiff(analysis.mean, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_max.tif`, bytes: encodeTiff(analysis.max, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_correlation.tif`, bytes: encodeTiff(analysis.correlation, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_rois.tif`, bytes: encodeTiff(analysis.labels, { ...loaded.dims, frames: 1, frameRate: settings.frameRate }) },
      { name: `${stem}_traces.csv`, bytes: encoder.encode(tracesCsv(analysis.cells, loaded.dims.frames, settings.frameRate)) },
      { name: `${stem}_rois.csv`, bytes: encoder.encode(roisCsv(analysis.cells)) },
      { name: `${stem}_traces.svg`, bytes: encoder.encode(traceSvg(analysis.cells, loaded.dims.frames, settings.frameRate)) },
      { name: `${stem}_shifts.svg`, bytes: encoder.encode(shiftSvg(registration.shifts, settings.frameRate)) },
      { name: `${stem}_provenance.json`, bytes: encoder.encode(`${JSON.stringify(record, null, 2)}\n`) },
    );

    const written = await writeStagedOutputs(claim.directory, outputs, { claim, linkFn });
    succeeded = true;
    return {
      outputDir: claim.directory,
      files: written,
      roiCount: analysis.cells.length,
      provenance: record,
    };
  } finally {
    await claim.release({ removeDirIfEmpty: !succeeded });
  }
}

/** Verifies the runtime with a synthetic shifted movie containing a firing neuron. */
export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir.trim())) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  const width = 48;
  const height = 48;
  const frames = 24;
  const plane = width * height;
  const movie = new Float32Array(frames * plane);
  for (let f = 0; f < frames; f++) {
    const dy = f >= 12 ? 2 : 0;
    const dx = f >= 12 ? -1 : 0;
    const spike = f === 8 || f === 16 ? 250 : 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = x - dx;
        const sy = y - dy;
        const cell = Math.exp(-((sx - 24) ** 2 + (sy - 24) ** 2) / 18);
        const landmark = 60 * Math.exp(-((sx - 12) ** 2 + (sy - 14) ** 2) / 12);
        movie[f * plane + y * width + x] = 100 + landmark + (80 + spike) * cell;
      }
    }
  }
  const reg = motionCorrect(movie, { width, height, frames }, { ...DEFAULTS, maxShift: 6, templatePasses: 2 });
  const shiftDiffY = Math.abs((reg.shifts[16][0] - reg.shifts[4][0]) - (-2));
  const shiftDiffX = Math.abs((reg.shifts[16][1] - reg.shifts[4][1]) - 1);
  if (!(shiftDiffY < 0.25 && shiftDiffX < 0.25)) {
    throw new Error(`Calcium imaging self-check registration failed (dy err ${shiftDiffY.toFixed(2)}, dx err ${shiftDiffX.toFixed(2)}).`);
  }
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    version: packageJson.version,
    ...(cacheDir !== undefined ? { cacheDir: resolve(cacheDir) } : {}),
    phantom: {
      shiftErrorPx: { y: Number(shiftDiffY.toFixed(4)), x: Number(shiftDiffX.toFixed(4)) },
    },
  };
}
