// Node command-line adapter for @neurodesk/skin-chromophore.
// Runs the exact same CIE L*a*b*, ITA°, CIEDE2000, RGB EI/MI, fixed-basis melanin/hemoglobin
// OD proxies, ROI analysis, and PNG/CSV/JSON serializers as the Skin Chromophore web app.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
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

function parseStrictInteger(raw, label) {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) throw new Error(`${label} must be an integer, got "${raw}".`);
    return raw;
  }
  if (typeof raw !== "string" || !/^[+-]?\d+$/.test(raw.trim())) {
    throw new Error(`${label} must be an integer, got "${raw}".`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer, got "${raw}".`);
  }
  return value;
}

export const SHARED_OUTPUT_LOCK = ".neurodesk-cli.lock";

export async function reserveOutputDir(outputDir, { overwrite = false, tool = "skin-chromophore" } = {}) {
  const dir = resolve(outputDir);
  let createdDir = false;
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(`Output path ${dir} exists and is not a directory.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(dir, { recursive: true });
    createdDir = true;
  }

  const lockName = SHARED_OUTPUT_LOCK;
  const lockPath = join(dir, lockName);
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (createdDir) {
      await rmdir(dir).catch(() => {});
    }
    if (error.code === "EEXIST") {
      throw new Error(
        `Output directory ${dir} is locked by another Neurodesk CLI run (${lockName}). Wait for it to finish or remove a stale lock file.`,
      );
    }
    throw error;
  }

  let released = false;
  const release = async ({ removeIfEmpty = false } = {}) => {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true }).catch(() => {});
    if (removeIfEmpty && createdDir) {
      const remaining = await readdir(dir).catch(() => null);
      if (remaining && remaining.length === 0) {
        await rmdir(dir).catch(() => {});
      }
    }
  };

  try {
    const meta = JSON.stringify({ pid: process.pid, tool, startedAt: new Date().toISOString() });
    await handle.writeFile(`${meta}\n`, "utf8");
    await handle.close();
    handle = null;

    const entries = await readdir(dir);
    const others = entries.filter((entry) => entry !== lockName);
    if (!overwrite && others.length > 0) {
      throw new Error(`Output directory ${dir} is not empty. Choose a new directory or pass --overwrite.`);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await release({ removeIfEmpty: true });
    throw error;
  }

  return { dir, lockPath, createdDir, release };
}

export async function publishOutputs(
  dir,
  files,
  { overwrite = false, writeFileImpl = writeFile, renameImpl = rename } = {},
) {
  const token = randomUUID();
  const staged = [];
  const backups = [];
  const committed = [];

  try {
    for (const { name, bytes } of files) {
      const target = join(dir, name);
      const partial = join(dir, `.${name}.${token}.partial`);
      const item = { name, target, partial, moved: false };
      staged.push(item);
      await writeFileImpl(partial, bytes, { flag: "wx" });
    }

    for (const item of staged) {
      let existingInfo = null;
      try {
        existingInfo = await lstat(item.target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existingInfo) {
        if (existingInfo.isDirectory()) {
          throw new Error(`Output file path ${item.target} is a directory.`);
        }
        if (!overwrite) {
          throw new Error(`Output file ${item.target} already exists. Pass --overwrite to replace it.`);
        }
        const backup = join(dir, `.${item.name}.${token}.backup`);
        await renameImpl(item.target, backup);
        backups.push({ target: item.target, backup });
      }
      await renameImpl(item.partial, item.target);
      item.moved = true;
      committed.push(item.target);
    }

    for (const { backup } of backups) {
      await rm(backup, { force: true }).catch(() => {});
    }
    return committed;
  } catch (error) {
    const backedUpTargets = new Set(backups.map((b) => b.target));
    for (const target of [...committed].reverse()) {
      if (!backedUpTargets.has(target)) {
        await rm(target, { force: true }).catch(() => {});
      }
    }
    for (const { target, backup } of [...backups].reverse()) {
      await renameImpl(backup, target).catch(() => {});
    }
    for (const item of staged) {
      if (!item.moved) {
        await rm(item.partial, { force: true }).catch(() => {});
      }
    }
    throw error;
  }
}

/** Exact fractional premultiplied-alpha area-weighted downsampling of an RGBA image. */
export function downsampleRgbaBilinear(rgba, width, height, outWidth, outHeight) {
  if (width === outWidth && height === outHeight) return rgba;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  const scaleX = width / outWidth;
  const scaleY = height / outHeight;
  for (let y = 0; y < outHeight; y += 1) {
    const y0 = y * scaleY;
    const y1 = (y + 1) * scaleY;
    const sy0 = Math.floor(y0);
    const sy1 = Math.min(height, Math.ceil(y1));
    for (let x = 0; x < outWidth; x += 1) {
      const x0 = x * scaleX;
      const x1 = (x + 1) * scaleX;
      const sx0 = Math.floor(x0);
      const sx1 = Math.min(width, Math.ceil(x1));
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let sumW = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        const row = sy * width;
        for (let sx = sx0; sx < sx1; sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const p = (row + sx) * 4;
          const alpha = rgba[p + 3];
          const aw = alpha * w;
          sumR += rgba[p] * aw;
          sumG += rgba[p + 1] * aw;
          sumB += rgba[p + 2] * aw;
          sumA += aw;
          sumW += w;
        }
      }
      const dst = (y * outWidth + x) * 4;
      if (sumA > 0) {
        out[dst] = Math.round(sumR / sumA);
        out[dst + 1] = Math.round(sumG / sumA);
        out[dst + 2] = Math.round(sumB / sumA);
        out[dst + 3] = Math.round(sumA / sumW);
      } else {
        out[dst] = 0;
        out[dst + 1] = 0;
        out[dst + 2] = 0;
        out[dst + 3] = 0;
      }
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
  if (!input || !outputDir || String(input).trim() === "" || String(outputDir).trim() === "") {
    throw new Error("Provide an input JPEG/PNG image and an output directory.");
  }
  if (typeof roiMode !== "string" || roiMode.trim() === "") {
    throw new Error(`--roi-mode must be a non-empty value ("auto" or "central"), got "${roiMode}".`);
  }
  const parsedMaxSide = parseStrictInteger(maxSide, "--max-side");
  if (parsedMaxSide < 32 || parsedMaxSide > 8192) {
    throw new Error(`--max-side must be an integer between 32 and 8192, got "${maxSide}".`);
  }
  const started = performance.now();
  const settings = readSettings({ whiteBalance, maskVignette, roiMode: roiMode.trim() });
  const reservation = await reserveOutputDir(outputDir, { overwrite, tool: "skin-chromophore" });
  let published = false;

  try {
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
      colorSpace: decoded.colorSpaceDescription,
      settings,
      analysis,
      manualRoi: null,
    });
    const jsonText = provenanceJson(record);

    const stem = outputStem(decoded.name);
    const outputs = await publishOutputs(
      reservation.dir,
      [
        { name: `${stem}_colorimetry.csv`, bytes: Buffer.from(csvText, "utf8") },
        { name: `${stem}_provenance.json`, bytes: Buffer.from(jsonText, "utf8") },
        { name: `${stem}_hemoglobin.png`, bytes: hemoglobinPng },
        { name: `${stem}_melanin.png`, bytes: melaninPng },
        { name: `${stem}_ita.png`, bytes: itaPng },
      ],
      { overwrite },
    );
    published = true;

    const seconds = (performance.now() - started) / 1000;
    onProgress(1, "Analysis complete");
    return {
      outputDir: reservation.dir,
      outputs,
      primaryOutput: outputs[0],
      analysis,
      provenance: record,
      seconds,
    };
  } finally {
    await reservation.release({ removeIfEmpty: !published });
  }
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
