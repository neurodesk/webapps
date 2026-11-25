// Node command-line adapter for @neurodesk/skin-chromophore.
// Runs the exact same CIE L*a*b*, ITA°, CIEDE2000, RGB EI/MI, fixed-basis melanin/hemoglobin
// OD proxies, ROI analysis, and PNG/CSV/JSON serializers as the Skin Chromophore web app.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  MAX_ANALYSIS_SIDE,
  MAX_DECODED_BYTES,
  buildProvenance,
  computeAnalysisDimensions,
  readSettings,
} from "./config.js";
import { analyzeSkinImage } from "./core/analyze.js";
import { colorimetryCsv, encodeMapPng, outputStem, provenanceJson } from "./outputs.js";
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

/** Area-averaged bilinear downsampling of an RGBA image to (outWidth x outHeight). */
export function downsampleRgbaBilinear(rgba, width, height, outWidth, outHeight) {
  if (width === outWidth && height === outHeight) return rgba;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const scaleX = width / outWidth;
  const scaleY = height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const sy0 = Math.floor(y * scaleY);
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < outWidth; x += 1) {
      const sx0 = Math.floor(x * scaleX);
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.ceil((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        const row = sy * width;
        for (let sx = sx0; sx < sx1; sx += 1) {
          const p = (row + sx) * 4;
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
          a += rgba[p + 3];
          count += 1;
        }
      }
      const dst = (y * outWidth + x) * 4;
      out[dst] = Math.round(r / count);
      out[dst + 1] = Math.round(g / count);
      out[dst + 2] = Math.round(b / count);
      out[dst + 3] = Math.round(a / count);
    }
  }
  return out;
}

export async function analyzeFile({
  input,
  outputDir,
  whiteBalance = false,
  maskVignette = true,
  roiMode = "auto",
  maxSide = MAX_ANALYSIS_SIDE,
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (!input || !outputDir) {
    throw new Error("Provide an input JPEG/PNG image and an output directory.");
  }
  const parsedMaxSide = Number(maxSide);
  if (!Number.isInteger(parsedMaxSide) || parsedMaxSide < 32 || parsedMaxSide > 8192) {
    throw new Error(`--max-side must be an integer between 32 and 8192, got "${maxSide}".`);
  }
  const started = performance.now();
  const settings = readSettings({ whiteBalance, maskVignette, roiMode });
  const destination = resolve(outputDir);
  await assertOutputDir(destination, { overwrite });

  onProgress(0.05, "Decoding input image…");
  const decoded = await readRasterImageFile(resolve(input), { maxBytes: MAX_DECODED_BYTES });
  const dims = computeAnalysisDimensions(decoded.width, decoded.height, parsedMaxSide);
  const workingRgba = dims.downscaled
    ? downsampleRgbaBilinear(decoded.rgba, decoded.width, decoded.height, dims.width, dims.height)
    : decoded.rgba;

  const analysis = analyzeSkinImage(
    workingRgba,
    dims.width,
    dims.height,
    settings,
    (value, message) => onProgress(0.1 + 0.72 * value, message),
  );

  onProgress(0.85, "Encoding hemoglobin, melanin, and ITA° PNG maps…");
  const hemoglobinPng = encodeMapPng("hemoglobin", analysis);
  const melaninPng = encodeMapPng("melanin", analysis);
  const itaPng = encodeMapPng("ita", analysis);
  const csvText = colorimetryCsv(analysis);
  const record = buildProvenance({
    file: { name: decoded.name, size: decoded.size },
    width: dims.width,
    height: dims.height,
    originalWidth: decoded.width,
    originalHeight: decoded.height,
    downscaled: dims.downscaled,
    format: decoded.format,
    settings,
    analysis,
    manualRoi: null,
  });
  const jsonText = provenanceJson(record);

  const stem = outputStem(decoded.name);
  await mkdir(destination, { recursive: true });
  const hbPath = join(destination, `${stem}_hemoglobin.png`);
  const melPath = join(destination, `${stem}_melanin.png`);
  const itaPath = join(destination, `${stem}_ita.png`);
  const csvPath = join(destination, `${stem}_colorimetry.csv`);
  const jsonPath = join(destination, `${stem}_provenance.json`);

  await writeAtomically(hbPath, hemoglobinPng);
  await writeAtomically(melPath, melaninPng);
  await writeAtomically(itaPath, itaPng);
  await writeAtomically(csvPath, Buffer.from(csvText, "utf8"));
  await writeAtomically(jsonPath, Buffer.from(jsonText, "utf8"));

  const seconds = (performance.now() - started) / 1000;
  onProgress(1, "Analysis complete");
  return {
    outputDir: destination,
    outputs: [csvPath, jsonPath, hbPath, melPath, itaPath],
    primaryOutput: csvPath,
    analysis,
    provenance: record,
    seconds,
  };
}

/** Offline self-check running colorimetry and chromophore proxy analysis on a synthetic skin image. */
export async function checkInstallation() {
  const width = 48;
  const height = 48;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - 24;
      const dy = y - 24;
      const inTarget = dx * dx + dy * dy <= 10 * 10;
      const o = (y * width + x) * 4;
      rgba[o] = inTarget ? 150 : 216;
      rgba[o + 1] = inTarget ? 78 : 178;
      rgba[o + 2] = inTarget ? 72 : 148;
      rgba[o + 3] = 255;
    }
  }
  const result = analyzeSkinImage(rgba, width, height, { whiteBalance: false, maskVignette: true, roiMode: "auto" });
  if (!(result.roi.target.pixelCount > 0 && result.roi.reference.pixelCount > 0 && result.roi.comparison.deltaE2000 > 5)) {
    throw new Error("Self-check failed: synthetic skin chromophore contrast was not detected.");
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
