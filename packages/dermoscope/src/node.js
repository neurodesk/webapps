// Node command-line adapter for @neurodesk/dermoscope.
// Runs the exact same DullRazor, Shades of Gray, Otsu segmentation, ABCD morphometry,
// and PNG/CSV/JSON serializers as the Dermoscope ABCD web application.
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { readSettings } from "./config.js";
import { runDermoscopyPipeline } from "./core/pipeline.js";
import { encodeMaskPng, encodeRgbaPng, metricsCsv, outputStem, provenanceRecord } from "./outputs.js";
import { readRasterImageFile } from "./raster.js";

export const MAX_DECODED_BYTES = 128 * 1024 * 1024;

function parseStrictNumber(raw, label) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error(`${label} must be a finite number, got "${raw}".`);
    return raw;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${label} must be a finite number, got "${raw}".`);
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number, got "${raw}".`);
  }
  return value;
}

export async function reserveOutputDir(outputDir, { overwrite = false, tool = "dermoscope" } = {}) {
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

  const lockName = `.${tool}.lock`;
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
        `Output directory ${dir} is locked by another ${tool} run (${lockName}). Wait for it to finish or remove a stale lock file.`,
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

export async function publishOutputs(dir, files, { overwrite = false } = {}) {
  const token = randomUUID();
  const staged = [];
  const backups = [];
  const committed = [];

  try {
    for (const { name, bytes } of files) {
      const target = join(dir, name);
      const partial = join(dir, `.${name}.${token}.partial`);
      await writeFile(partial, bytes, { flag: "wx" });
      staged.push({ name, target, partial, moved: false });
    }

    for (const item of staged) {
      let existingInfo = null;
      try {
        existingInfo = await stat(item.target);
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
        await rename(item.target, backup);
        backups.push({ target: item.target, backup });
      }
      await rename(item.partial, item.target);
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
      await rename(backup, target).catch(() => {});
    }
    for (const item of staged) {
      if (!item.moved) {
        await rm(item.partial, { force: true }).catch(() => {});
      }
    }
    throw error;
  }
}

export function resolvePixelsPerMm({ pixelsPerMm, mmPerPixel } = {}) {
  const hasPpm = pixelsPerMm !== undefined;
  const hasMpp = mmPerPixel !== undefined;
  if (hasPpm && hasMpp) {
    throw new Error("Specify either --pixels-per-mm or --mm-per-pixel, not both.");
  }
  if (hasMpp) {
    const mpp = parseStrictNumber(mmPerPixel, "--mm-per-pixel");
    if (mpp <= 0) {
      throw new Error("--mm-per-pixel must be a positive finite number.");
    }
    return 1 / mpp;
  }
  if (hasPpm) {
    return parseStrictNumber(pixelsPerMm, "--pixels-per-mm");
  }
  return 0;
}

export async function analyzeFile({
  input,
  outputDir,
  removeHair = true,
  colorConstancy = true,
  thresholdBias,
  pixelsPerMm,
  mmPerPixel,
  differentialStructures,
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (!input || !outputDir || String(input).trim() === "" || String(outputDir).trim() === "") {
    throw new Error("Provide an input JPEG/PNG image and an output directory.");
  }
  const started = performance.now();
  const resolvedPpm = resolvePixelsPerMm({ pixelsPerMm, mmPerPixel });
  const parsedThresholdBias =
    thresholdBias === undefined ? 0 : parseStrictNumber(thresholdBias, "--threshold-bias");
  const parsedDifferentialStructures =
    differentialStructures === undefined
      ? 0
      : parseStrictNumber(differentialStructures, "--differential-structures");
  const settings = readSettings({
    removeHair,
    colorConstancy,
    thresholdBias: parsedThresholdBias,
    pixelsPerMm: resolvedPpm,
    differentialStructures: parsedDifferentialStructures,
  });

  const reservation = await reserveOutputDir(outputDir, { overwrite, tool: "dermoscope" });
  let published = false;

  try {
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

    const outputs = await publishOutputs(
      reservation.dir,
      [
        { name: `${stem}_abcd_metrics.csv`, bytes: Buffer.from(csvText, "utf8") },
        { name: `${stem}_provenance.json`, bytes: Buffer.from(jsonText, "utf8") },
        { name: `${stem}_preprocessed.png`, bytes: preprocessedBytes },
        { name: `${stem}_mask.png`, bytes: maskBytes },
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
      run,
      provenance: record,
      seconds,
    };
  } finally {
    await reservation.release({ removeIfEmpty: !published });
  }
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
