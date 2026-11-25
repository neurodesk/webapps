// Node command-line interface for @neurodesk/microscope-qc.
// Runs the exact same MetroloJ_QC bead PSF FWHM and field illumination uniformity pipelines
// as the Microscope QC web application.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
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

const OUTPUT_LOCK_FILE = ".neurodesk-microscope-qc.lock";

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

function parseNumberOpt(raw, flag, { min = -Infinity, max = Infinity, exclusiveMin = false, integer = false } = {}) {
  if (raw === undefined) return undefined;
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
  const analysis = values.analysis ?? "auto";
  if (analysis !== "auto" && !(analysis in ANALYSES)) {
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
  if (values.microscope !== undefined && !(values.microscope in MICROSCOPES)) {
    throw new Error(`Option --microscope must be one of ${Object.keys(MICROSCOPES).join(", ")}.`);
  }

  const na = parseNumberOpt(values.na, "na", { min: 0, max: 1.7, exclusiveMin: true });
  const refractiveIndex = parseNumberOpt(values["refractive-index"], "refractive-index", { min: 1, max: 2 });
  if (na !== undefined && refractiveIndex !== undefined && na >= refractiveIndex) {
    throw new Error(`Option --na (${na}) must be below --refractive-index (${refractiveIndex}).`);
  }

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
    minR2: parseNumberOpt(values["min-r2"], "min-r2", { min: 0, max: 1 }) ?? 0.95,
    excludeSaturated: !values["include-saturated"],
    step: parseNumberOpt(values.step, "step", { min: 1, max: 50, integer: true }) ?? 10,
    blur: !values["no-blur"],
    referenceZone: !values["reference-max"],
    hasPsfFlags: PSF_ONLY_FLAGS.some((flag) => values[flag] !== undefined),
    hasFieldFlags: FIELD_ONLY_FLAGS.some((flag) => values[flag] !== undefined),
  };
}

/**
 * Exclusively claims `outputDir` with an O_EXCL lock file, cleaning up the lock AND any newly
 * created directory on ANY failure (including write/readdir errors or non-empty directory).
 */
export async function claimOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Output directory must be a non-empty path.");
  }
  const directory = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new Error(`Output path '${directory}' exists and is not a directory.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
    createdDir = true;
  }

  const lockPath = join(directory, OUTPUT_LOCK_FILE);
  let handle = null;
  let lockAcquired = false;
  try {
    handle = await open(lockPath, "wx");
    lockAcquired = true;
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
    handle = null;

    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== OUTPUT_LOCK_FILE) {
      throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (lockAcquired) {
      await rm(lockPath, { force: true }).catch(() => {});
    }
    if (createdDir) {
      await rmdir(directory).catch(() => {});
    }
    if (error.code === "EEXIST") {
      throw new Error(`Output directory ${directory} is already in use by another run or not empty. Choose a new or empty directory.`);
    }
    throw error;
  }

  return {
    directory,
    createdDir,
    async release({ removeDirIfEmpty = false } = {}) {
      await rm(lockPath, { force: true }).catch(() => {});
      if (removeDirIfEmpty && createdDir) {
        await rmdir(directory).catch(() => {});
      }
    },
  };
}

/**
 * Stages every output file to a `.partial` path first, then renames all files into place.
 * Rolls back already-renamed outputs and removes all `.partial` files if any step fails.
 */
export async function writeStagedOutputs(directory, files, { renameFn = rename } = {}) {
  const runId = randomUUID().slice(0, 8);
  const staged = [];
  const renamed = [];
  try {
    for (const { name, bytes } of files) {
      const partialPath = join(directory, `.${name}.${runId}.partial`);
      const finalPath = join(directory, name);
      await writeFile(partialPath, bytes, { flag: "wx" });
      staged.push({ name, partialPath, finalPath });
    }
    for (const item of staged) {
      await renameFn(item.partialPath, item.finalPath);
      renamed.push(item.finalPath);
    }
    return staged.map((item) => item.name);
  } catch (error) {
    for (const item of staged) {
      await rm(item.partialPath, { force: true }).catch(() => {});
    }
    for (const finalPath of renamed) {
      await rm(finalPath, { force: true }).catch(() => {});
    }
    throw error;
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
  renameFn = rename,
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

    const written = await writeStagedOutputs(claim.directory, outputs, { renameFn });
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
