// Node command-line interface for @neurodesk/microscope-qc.
// Runs the exact same MetroloJ_QC bead PSF FWHM and field illumination uniformity pipelines
// as the Microscope QC web application.
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectTiffStack, readTiffStack, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import packageJson from "../package.json" with { type: "json" };
import {
  ANALYSES,
  MAX_FILE_BYTES,
  MAX_PEAK_BYTES,
  boxHalfWidth,
  checkStack,
  provenance,
  readSettings,
  saturationLevel,
  suggestedAnalysis,
} from "./config.js";
import { analyseField } from "./core/field.js";
import { MICROSCOPES, omeOptics } from "./core/optics.js";
import { analyseBeads, summariseBeads } from "./core/psf.js";
import {
  beadOverlay,
  beadRecords,
  beadsCsv,
  fieldMetricsCsv,
  fieldPointsCsv,
  fieldProfileSvg,
  fieldProfilesCsv,
  outputStem,
  profilesCsv,
  psfSummaryCsv,
  reportJson,
} from "./outputs.js";

export const OUTPUT_LOCK_FILE = ".neurodesk-cli.lock";
const LINK_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"]);

const PSF_ONLY_FLAGS = [
  "microscope",
  "na",
  "refractive-index",
  "emission",
  "excitation",
  "pixel-x",
  "pixel-y",
  "z-step",
  "box-radius",
  "prominence",
  "min-r2",
  "include-saturated",
];

const FIELD_ONLY_FLAGS = ["step", "no-blur", "reference-max"];

const ALLOWED_OPTION_KEYS = new Set([
  "analysis",
  "offline",
  ...PSF_ONLY_FLAGS,
  ...FIELD_ONLY_FLAGS,
]);

function parseBooleanOpt(raw, flag) {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new Error(`Option --${flag} must be a boolean, got ${typeof raw}.`);
  }
  return raw;
}

function parseNumberOpt(raw, flag, { min = -Infinity, max = Infinity, exclusiveMin = false, integer = false } = {}) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new Error(`Option --${flag} must be a finite number, got ${typeof raw}.`);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`Option --${flag} requires a non-empty value.`);
  const value = Number(trimmed);
  const low = exclusiveMin ? value <= min : value < min;
  if (!Number.isFinite(value) || low || value > max) {
    throw new Error(`Option --${flag} must be a finite number ${exclusiveMin ? ">" : ">="} ${min}${Number.isFinite(max) ? ` and <= ${max}` : ""}, got '${raw}'.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`Option --${flag} must be an integer, got '${raw}'.`);
  }
  return value;
}

/** Validates all CLI options before touching input files or claiming OUTPUT_DIR. */
export function parseCliOptions(values = {}) {
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
  const analysis = values.analysis === undefined ? "auto" : values.analysis;
  if (typeof analysis !== "string" || (analysis !== "auto" && !Object.hasOwn(ANALYSES, analysis))) {
    throw new Error(`Option --analysis must be one of auto, ${Object.keys(ANALYSES).join(", ")}.`);
  }
  if (analysis === "psf") {
    for (const flag of FIELD_ONLY_FLAGS) {
      if (values[flag] !== undefined) throw new Error(`Option --${flag} is only valid for field illumination analysis.`);
    }
  }
  if (analysis === "field") {
    for (const flag of PSF_ONLY_FLAGS) {
      if (values[flag] !== undefined) throw new Error(`Option --${flag} is only valid for PSF bead analysis.`);
    }
  }
  if (values.microscope !== undefined && (typeof values.microscope !== "string" || !Object.hasOwn(MICROSCOPES, values.microscope))) {
    throw new Error(`Option --microscope must be one of ${Object.keys(MICROSCOPES).join(", ")}.`);
  }

  const na = parseNumberOpt(values.na, "na", { min: 0, max: 1.7, exclusiveMin: true });
  const refractiveIndex = parseNumberOpt(values["refractive-index"], "refractive-index", { min: 1, max: 2 });
  if (na !== undefined && refractiveIndex !== undefined && na >= refractiveIndex) {
    throw new Error(`Option --na (${na}) must be below --refractive-index (${refractiveIndex}).`);
  }

  const includeSaturated = parseBooleanOpt(values["include-saturated"], "include-saturated");
  const noBlur = parseBooleanOpt(values["no-blur"], "no-blur");
  const referenceMax = parseBooleanOpt(values["reference-max"], "reference-max");
  parseBooleanOpt(values.offline, "offline");

  return {
    analysis,
    microscope: values.microscope,
    na,
    refractiveIndex,
    emission: parseNumberOpt(values.emission, "emission", { min: 200, max: 2000 }),
    excitation: parseNumberOpt(values.excitation, "excitation", { min: 200, max: 2000 }),
    pixelX: parseNumberOpt(values["pixel-x"], "pixel-x", { min: 0, max: 100, exclusiveMin: true }),
    pixelY: parseNumberOpt(values["pixel-y"], "pixel-y", { min: 0, max: 100, exclusiveMin: true }),
    zStep: parseNumberOpt(values["z-step"], "z-step", { min: 0, max: 100, exclusiveMin: true }),
    boxRadius: parseNumberOpt(values["box-radius"], "box-radius", { min: 0, max: 100, exclusiveMin: true }),
    prominence: parseNumberOpt(values.prominence, "prominence", { min: 0, exclusiveMin: true }),
    minR2: values["min-r2"] === undefined ? 0.95 : parseNumberOpt(values["min-r2"], "min-r2", { min: 0, max: 1 }),
    excludeSaturated: !includeSaturated,
    step: values.step === undefined ? 10 : parseNumberOpt(values.step, "step", { min: 1, max: 50, integer: true }),
    blur: !noBlur,
    referenceZone: !referenceMax,
    hasPsfFlags: PSF_ONLY_FLAGS.some((flag) => values[flag] !== undefined),
    hasFieldFlags: FIELD_ONLY_FLAGS.some((flag) => values[flag] !== undefined),
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

async function readQcImage(inputPath) {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Input '${inputPath}' is not a regular file.`);
  if (info.size === 0) throw new Error(`Input '${inputPath}' is empty.`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`${basename(resolved)} is ${(info.size / 1e9).toFixed(2)} GB; the limit is ${(MAX_FILE_BYTES / 1e9).toFixed(1)} GB.`);
  }
  const name = basename(resolved);
  if (!/\.tiff?$/i.test(name)) {
    throw new Error(`${name} is not a TIFF (.tif, .tiff or .ome.tif) image.`);
  }
  const bytes = await readFile(resolved);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const tiffInfo = await inspectTiffStack(buffer);
  checkStack(tiffInfo, buffer.byteLength);
  const stack = await readTiffStack(buffer, { Type: Float32Array, maxBytes: MAX_PEAK_BYTES });
  for (let i = 0; i < stack.data.length; i++) {
    if (!Number.isFinite(stack.data[i])) {
      const plane = Math.floor(i / (stack.width * stack.height));
      throw new Error(`Plane ${plane + 1} holds a NaN or infinite value; replace non-finite pixels before quality control.`);
    }
  }
  return {
    name,
    size: info.size,
    data: stack.data,
    dims: {
      width: stack.width,
      height: stack.height,
      planes: stack.pages,
      dtype: stack.dtype,
      pixelSize: stack.metadata.pixelSize,
      metadataKind: stack.metadata.kind,
    },
    optics: omeOptics(stack.metadata.description),
  };
}

/** Runs MetroloJ_QC PSF bead FWHM or field illumination QC on a TIFF/OME-TIFF image or stack. */
export async function runMicroscopeQc({
  input,
  outputDir,
  options = {},
  onLog = () => {},
  linkFn = linkSync,
} = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Input TIFF path is required.");
  }
  const parsed = parseCliOptions(options);
  const loaded = await readQcImage(input);
  const { width, height, planes, dtype, pixelSize } = loaded.dims;
  const resolvedAnalysis = parsed.analysis === "auto" ? suggestedAnalysis(planes) : parsed.analysis;

  if (resolvedAnalysis === "psf" && planes < 3) {
    throw new Error(`PSF needs a bead z-stack (>= 3 planes); ${loaded.name} has ${planes} plane${planes === 1 ? "" : "s"}.`);
  }
  if (resolvedAnalysis === "field" && planes !== 1) {
    throw new Error(`Field illumination needs one 2D image; ${loaded.name} has ${planes} planes.`);
  }
  if (resolvedAnalysis === "psf" && parsed.hasFieldFlags) {
    throw new Error("Field illumination options (--step, --no-blur, --reference-max) cannot be used on a PSF z-stack.");
  }
  if (resolvedAnalysis === "field" && parsed.hasPsfFlags) {
    throw new Error("PSF optics/bead options cannot be used on a 2D field illumination image.");
  }

  let settings;
  if (resolvedAnalysis === "psf") {
    settings = readSettings({
      analysis: "psf",
      microscope: parsed.microscope ?? loaded.optics.type ?? "widefield",
      na: parsed.na ?? loaded.optics.na,
      refractiveIndex: parsed.refractiveIndex ?? loaded.optics.refractiveIndex,
      emission: parsed.emission ?? loaded.optics.emission,
      excitation: parsed.excitation ?? loaded.optics.excitation,
      pixelX: parsed.pixelX ?? pixelSize?.x,
      pixelY: parsed.pixelY ?? pixelSize?.y,
      zStep: parsed.zStep ?? pixelSize?.z,
      boxRadius: parsed.boxRadius,
      prominence: parsed.prominence,
      minR2: parsed.minR2,
      excludeSaturated: parsed.excludeSaturated,
    });
  } else {
    settings = readSettings({
      analysis: "field",
      blur: parsed.blur,
      referenceZone: parsed.referenceZone,
      step: parsed.step,
    });
  }

  const claim = await claimOutputDirectory(outputDir);
  let succeeded = false;
  try {
    const stem = outputStem(loaded.name);
    const saturation = saturationLevel(dtype);
    const encoder = new TextEncoder();
    const outputs = [];
    let summaryOut;

    if (settings.analysis === "psf") {
      const spacing = { x: settings.pixelX, y: settings.pixelY, z: settings.zStep };
      const halfBox = boxHalfWidth(settings);
      onLog(`Running bead PSF QC (${width} × ${height} × ${planes}, halfBox ${halfBox} px)…`);
      const analysis = analyseBeads(
        loaded.data,
        { nx: width, ny: height, nz: planes, spacing },
        {
          halfBox,
          prominence: settings.prominence,
          autoProminence: 10,
          minR2: settings.minR2,
          saturation: settings.excludeSaturated ? saturation : null,
        },
      );
      const summary = summariseBeads(analysis.beads, settings.theory);
      const record = provenance({
        input: { name: loaded.name, size: loaded.size },
        settings,
        dims: loaded.dims,
        extra: { boxHalfWidthPx: halfBox, prominence: analysis.prominence, background: analysis.background, summary },
        version: packageJson.version,
      });
      const overlay = beadOverlay(analysis.beads, { width, height }, halfBox);
      outputs.push(
        { name: `${stem}_beads.tif`, bytes: writeTiffStack({ width, height, data: overlay, pixelSize: { x: spacing.x, y: spacing.y } }) },
        { name: `${stem}_psf_summary.csv`, bytes: encoder.encode(psfSummaryCsv(summary)) },
        { name: `${stem}_beads.csv`, bytes: encoder.encode(beadsCsv(analysis.beads, spacing)) },
        { name: `${stem}_profiles.csv`, bytes: encoder.encode(profilesCsv(analysis.beads, spacing)) },
        { name: `${stem}_psf_report.json`, bytes: encoder.encode(reportJson(record, beadRecords(analysis.beads))) },
      );
      summaryOut = summary;
      onLog(`Beads: ${analysis.maximaCount} maxima, ${summary.measured} measured, ${summary.used} used`);
    } else {
      onLog(`Running field illumination QC (${width} × ${height}, step ${settings.step} %)…`);
      const field = analyseField(
        loaded.data,
        { width, height, dtype },
        { blur: settings.blur, step: settings.step, referenceZone: settings.referenceZone, saturation },
      );
      const { zones, profiles: _profiles, smoothed: _smoothed, ...fieldSummary } = field;
      const record = provenance({
        input: { name: loaded.name, size: loaded.size },
        settings,
        dims: loaded.dims,
        extra: { metrics: { uniformity: field.uniformity, fieldUniformity: field.fieldUniformity, centeringAccuracy: field.centeringAccuracy } },
        version: packageJson.version,
      });
      outputs.push(
        { name: `${stem}_zones.tif`, bytes: writeTiffStack({ width, height, data: zones }) },
        { name: `${stem}_field_metrics.csv`, bytes: encoder.encode(fieldMetricsCsv(field)) },
        { name: `${stem}_field_points.csv`, bytes: encoder.encode(fieldPointsCsv(field)) },
        { name: `${stem}_field_profiles.csv`, bytes: encoder.encode(fieldProfilesCsv(field)) },
        { name: `${stem}_field_profiles.svg`, bytes: encoder.encode(fieldProfileSvg(field)) },
        { name: `${stem}_field_report.json`, bytes: encoder.encode(reportJson(record, fieldSummary)) },
      );
      summaryOut = {
        uniformity: field.uniformity,
        fieldUniformity: field.fieldUniformity,
        centeringAccuracy: field.centeringAccuracy,
      };
      onLog(`Field: uniformity ${field.uniformity.toFixed(2)} %, field uniformity ${field.fieldUniformity.toFixed(2)} %, centering ${field.centeringAccuracy.toFixed(2)} %`);
    }

    const written = await writeStagedOutputs(claim.directory, outputs, { claim, linkFn });
    succeeded = true;
    return {
      outputDir: claim.directory,
      analysis: settings.analysis,
      files: written,
      summary: summaryOut,
    };
  } finally {
    await claim.release({ removeDirIfEmpty: !succeeded });
  }
}

/** Verifies the runtime with a synthetic Gaussian bead z-stack. */
export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir.trim())) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  const nx = 32;
  const ny = 32;
  const nz = 21;
  const spacing = { x: 0.1, y: 0.1, z: 0.2 };
  const sigmaXY = 0.2;
  const sigmaZ = 0.5;
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const dx = (x - 16) * spacing.x;
        const dy = (y - 16) * spacing.y;
        const dz = (z - 10) * spacing.z;
        const bg = 10 + ((x * 3 + y * 5 + z * 7) % 3) * 0.5;
        data[(z * ny + y) * nx + x] = bg + 1000 * Math.exp(-(dx * dx + dy * dy) / (2 * sigmaXY * sigmaXY) - (dz * dz) / (2 * sigmaZ * sigmaZ));
      }
    }
  }
  const res = analyseBeads(data, { nx, ny, nz, spacing }, { halfBox: 6, prominence: 100, minR2: 0.99, saturation: null });
  const sum = summariseBeads(res.beads);
  const expectedXY = 2 * Math.sqrt(2 * Math.LN2) * sigmaXY;
  const expectedZ = 2 * Math.sqrt(2 * Math.LN2) * sigmaZ;
  if (sum.used !== 1 || Math.abs(sum.x.mean - expectedXY) > 0.01 || Math.abs(sum.z.mean - expectedZ) > 0.02) {
    throw new Error("Microscope QC self-check failed: synthetic bead FWHM mismatch.");
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
      beadsUsed: sum.used,
      fwhmXUm: Number(sum.x.mean.toFixed(4)),
      fwhmZUm: Number(sum.z.mean.toFixed(4)),
    },
  };
}
