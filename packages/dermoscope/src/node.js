// Node command-line adapter for @neurodesk/dermoscope.
// Runs the exact same DullRazor, Shades of Gray, Otsu segmentation, ABCD morphometry,
// and PNG/CSV/JSON serializers as the Dermoscope ABCD web application.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { readSettings } from "./config.js";
import { runDermoscopyPipeline } from "./core/pipeline.js";
import { encodeMaskPng, encodeRgbaPng, metricsCsv, outputStem, provenanceRecord } from "./outputs.js";
import { readRasterImageFile } from "./raster.js";

export const MAX_DECODED_BYTES = 128 * 1024 * 1024;

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

export function resolvePixelsPerMm({ pixelsPerMm, mmPerPixel } = {}) {
  const hasPpm = pixelsPerMm !== undefined && pixelsPerMm !== "";
  const hasMpp = mmPerPixel !== undefined && mmPerPixel !== "";
  if (hasPpm && hasMpp) {
    throw new Error("Specify either --pixels-per-mm or --mm-per-pixel, not both.");
  }
  if (hasMpp) {
    const mpp = Number(mmPerPixel);
    if (!Number.isFinite(mpp) || mpp <= 0) {
      throw new Error("--mm-per-pixel must be a positive finite number.");
    }
    return 1 / mpp;
  }
  return hasPpm ? Number(pixelsPerMm) : 0;
}

export async function analyzeFile({
  input,
  outputDir,
  removeHair = true,
  colorConstancy = true,
  thresholdBias = 0,
  pixelsPerMm,
  mmPerPixel,
  differentialStructures = 0,
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (!input || !outputDir) {
    throw new Error("Provide an input JPEG/PNG image and an output directory.");
  }
  const started = performance.now();
  const resolvedPpm = resolvePixelsPerMm({ pixelsPerMm, mmPerPixel });
  const settings = readSettings({
    removeHair,
    colorConstancy,
    thresholdBias,
    pixelsPerMm: resolvedPpm,
    differentialStructures,
  });

  const destination = resolve(outputDir);
  await assertOutputDir(destination, { overwrite });

  onProgress(0.05, "Decoding input image…");
  const decoded = await readRasterImageFile(resolve(input), { maxBytes: MAX_DECODED_BYTES });
  const run = runDermoscopyPipeline(decoded.rgba, decoded.width, decoded.height, settings, {
    onProgress: (value, message) => onProgress(0.1 + 0.8 * value, message),
  });

  onProgress(0.92, "Writing PNG, CSV, and JSON outputs…");
  const inputMeta = { name: decoded.name, size: decoded.size, format: decoded.format };
  const stem = outputStem(decoded.name);
  const preprocessedBytes = encodeRgbaPng(run.preprocessedRgba, run.width, run.height);
  const maskBytes = encodeMaskPng(run.mask, run.width, run.height);
  const csvText = metricsCsv(run, decoded.name);
  const record = provenanceRecord(run, inputMeta);
  const jsonText = `${JSON.stringify(record, null, 2)}\n`;

  await mkdir(destination, { recursive: true });
  const preprocessedPath = join(destination, `${stem}_preprocessed.png`);
  const maskPath = join(destination, `${stem}_mask.png`);
  const csvPath = join(destination, `${stem}_abcd_metrics.csv`);
  const jsonPath = join(destination, `${stem}_provenance.json`);

  await writeAtomically(preprocessedPath, preprocessedBytes);
  await writeAtomically(maskPath, maskBytes);
  await writeAtomically(csvPath, Buffer.from(csvText, "utf8"));
  await writeAtomically(jsonPath, Buffer.from(jsonText, "utf8"));

  const seconds = (performance.now() - started) / 1000;
  onProgress(1, "Analysis complete");
  return {
    outputDir: destination,
    outputs: [csvPath, jsonPath, preprocessedPath, maskPath],
    primaryOutput: csvPath,
    run,
    provenance: record,
    seconds,
  };
}

/** Offline self-check running the full Dermoscope ABCD pipeline on a synthetic lesion image. */
export async function checkInstallation() {
  const width = 64;
  const height = 64;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - 32;
      const dy = y - 32;
      const inLesion = dx * dx + dy * dy <= 14 * 14;
      const o = (y * width + x) * 4;
      rgba[o] = inLesion ? 92 : 212;
      rgba[o + 1] = inLesion ? 58 : 172;
      rgba[o + 2] = inLesion ? 44 : 148;
      rgba[o + 3] = 255;
    }
  }
  const result = runDermoscopyPipeline(rgba, width, height, { removeHair: true, colorConstancy: true });
  if (!result.segmented || result.abcd.geometry.areaPx <= 0) {
    throw new Error("Self-check failed: synthetic lesion was not segmented.");
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
