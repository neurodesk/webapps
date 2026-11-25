// Node command-line adapter for @neurodesk/derm-compare.
// Runs the exact same uniform pair downscaling, preprocessing, multi-scale NCC registration,
// CIEDE2000 analysis, and PNG/CSV/JSON serializers as the DermCompare web application.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { LIMITS, buildProvenance, readSettings } from "./config.js";
import { runComparison } from "./core/pipeline.js";
import { buildChangeMapRgba } from "./display.js";
import { encodeRgbaPng, metricsCsv, outputStem, provenanceJson } from "./outputs.js";
import { readRasterImageFile } from "./raster.js";

async function writeAtomically(filePath, bytes) {
  const partial = `${filePath}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    await rename(partial, filePath);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function assertOutputDir(directory, { overwrite = false } = {}) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!overwrite && entries.length > 0) {
    throw new Error(`Output directory ${directory} is not empty. Choose a new directory or pass --overwrite.`);
  }
}

function validateDimensions(image, label) {
  if (image.width < LIMITS.minDimension || image.height < LIMITS.minDimension) {
    throw new Error(`${label} is ${image.width}x${image.height}; minimum dimension is ${LIMITS.minDimension}px.`);
  }
  if (image.width > LIMITS.maxDimension || image.height > LIMITS.maxDimension) {
    throw new Error(`${label} is ${image.width}x${image.height}; maximum dimension is ${LIMITS.maxDimension}px.`);
  }
}

export async function compareFiles({
  baseline,
  followup,
  outputDir,
  normalizeColor = true,
  suppressHair = true,
  allowScale = false,
  maxAngle = 25,
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (!baseline || !followup || !outputDir) {
    throw new Error("Provide a baseline image, a follow-up image, and an output directory.");
  }
  const started = performance.now();
  const settings = readSettings({ normalizeColor, suppressHair, allowScale, maxAngle });
  const destination = resolve(outputDir);
  await assertOutputDir(destination, { overwrite });

  const maxDecodedBytes = LIMITS.maxDecodedPixels * 4;
  onProgress(0.03, "Decoding baseline and follow-up images…");
  const baseImg = await readRasterImageFile(resolve(baseline), { maxBytes: maxDecodedBytes });
  const follImg = await readRasterImageFile(resolve(followup), { maxBytes: maxDecodedBytes });
  validateDimensions(baseImg, baseImg.name);
  validateDimensions(follImg, follImg.name);

  const result = runComparison({
    baselineRgba: baseImg.rgba,
    baselineWidth: baseImg.width,
    baselineHeight: baseImg.height,
    followupRgba: follImg.rgba,
    followupWidth: follImg.width,
    followupHeight: follImg.height,
    settings,
    maxWorkingDimension: LIMITS.maxWorkingDimension,
    onProgress: (value, message) => onProgress(0.08 + 0.82 * value, message),
  });

  if (!result.registered) {
    throw new Error(result.reason || "Insufficient image texture or overlap for registration.");
  }

  onProgress(0.92, "Encoding PNG, CSV, and JSON outputs…");
  const changeMapRgba = buildChangeMapRgba({
    baselineRgba: result.baselineRgba,
    deltaEMap: result.deltaEMap,
    validMask: result.validMask,
    deltaEMask: result.deltaEMask,
    baselineMask: result.baselineMask,
    followupMask: result.followupMask,
    width: result.width,
    height: result.height,
    opacity: 0.72,
    showContours: true,
  });
  const alignedPng = encodeRgbaPng(result.warpedFollowupRgba, result.width, result.height);
  const changeMapPng = encodeRgbaPng(changeMapRgba, result.width, result.height);
  const elapsedSeconds = (performance.now() - started) / 1000;

  const provenance = buildProvenance({
    baseline: {
      name: baseImg.name,
      width: result.width,
      height: result.height,
      originalWidth: baseImg.width,
      originalHeight: baseImg.height,
    },
    followup: {
      name: follImg.name,
      width: result.followupWidth ?? follImg.width,
      height: result.followupHeight ?? follImg.height,
      originalWidth: follImg.width,
      originalHeight: follImg.height,
    },
    settings,
    preprocessing: result.preprocessing,
    registration: result.registration,
    metrics: result.metrics,
    elapsedSeconds,
  });

  const stem = `${outputStem(baseImg.name)}_vs_${outputStem(follImg.name)}`;
  await mkdir(destination, { recursive: true });
  const alignedPath = join(destination, `${stem}_aligned.png`);
  const deltaEPath = join(destination, `${stem}_deltaE2000.png`);
  const csvPath = join(destination, `${stem}_metrics.csv`);
  const jsonPath = join(destination, `${stem}_provenance.json`);

  await writeAtomically(alignedPath, alignedPng);
  await writeAtomically(deltaEPath, changeMapPng);
  await writeAtomically(csvPath, Buffer.from(metricsCsv({ ...result, settings }), "utf8"));
  await writeAtomically(jsonPath, Buffer.from(provenanceJson(provenance), "utf8"));

  onProgress(1, "Comparison complete");
  return {
    outputDir: destination,
    outputs: [csvPath, jsonPath, alignedPath, deltaEPath],
    primaryOutput: csvPath,
    result,
    provenance,
    seconds: elapsedSeconds,
  };
}

/** Offline self-check verifying rigid registration and CIEDE2000 on a synthetic shifted pair. */
export async function checkInstallation() {
  const width = 64;
  const height = 64;
  const makePair = (dx, dy) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const lx = x - (32 + dx);
        const ly = y - (32 + dy);
        const r2 = (lx * lx) / 144 + (ly * ly) / 81;
        const o = (y * width + x) * 4;
        const tex = Math.round(12 * Math.sin((x - dx) * 0.4) * Math.cos((y - dy) * 0.4));
        const inLesion = r2 <= 1;
        rgba[o] = Math.max(0, Math.min(255, (inLesion ? 96 : 210) + tex));
        rgba[o + 1] = Math.max(0, Math.min(255, (inLesion ? 64 : 172) + tex));
        rgba[o + 2] = Math.max(0, Math.min(255, (inLesion ? 48 : 148) + tex));
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  };
  const base = makePair(0, 0);
  const foll = makePair(3, -2);
  const res = runComparison({
    baselineRgba: base,
    baselineWidth: width,
    baselineHeight: height,
    followupRgba: foll,
    followupWidth: width,
    followupHeight: height,
    settings: { normalizeColor: true, suppressHair: false, allowScale: false, maxAngle: 15 },
  });
  if (!res.registered || res.registration.alignedNcc < 0.9) {
    throw new Error("Self-check failed: synthetic dermoscopy pair did not register cleanly.");
  }
  return {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
  };
}
