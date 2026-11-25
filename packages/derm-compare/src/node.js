// Node command-line adapter for @neurodesk/derm-compare.
// Runs the exact same uniform pair downscaling, preprocessing, multi-scale NCC registration,
// CIEDE2000 analysis, and PNG/CSV/JSON serializers as the DermCompare web application.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { LIMITS, buildProvenance, readSettings } from "./config.js";
import { runComparison } from "./core/pipeline.js";
import { buildChangeMapRgba } from "./display.js";
import { encodeRgbaPng, metricsCsv, outputStem, provenanceJson } from "./outputs.js";
import { readRasterImageFile } from "./raster.js";

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

export const SHARED_OUTPUT_LOCK = ".neurodesk-cli.lock";

export async function reserveOutputDir(outputDir, { overwrite = false, tool = "derm-compare" } = {}) {
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
  maxAngle,
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (
    !baseline ||
    !followup ||
    !outputDir ||
    String(baseline).trim() === "" ||
    String(followup).trim() === "" ||
    String(outputDir).trim() === ""
  ) {
    throw new Error("Provide a baseline image, a follow-up image, and an output directory.");
  }
  const started = performance.now();
  const parsedMaxAngle = maxAngle === undefined ? 25 : parseStrictNumber(maxAngle, "--max-angle");
  const settings = readSettings({ normalizeColor, suppressHair, allowScale, maxAngle: parsedMaxAngle });
  const reservation = await reserveOutputDir(outputDir, { overwrite, tool: "derm-compare" });
  let published = false;

  try {
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
    const outputs = await publishOutputs(
      reservation.dir,
      [
        { name: `${stem}_metrics.csv`, bytes: Buffer.from(metricsCsv({ ...result, settings }), "utf8") },
        { name: `${stem}_provenance.json`, bytes: Buffer.from(provenanceJson(provenance), "utf8") },
        { name: `${stem}_aligned.png`, bytes: alignedPng },
        { name: `${stem}_deltaE2000.png`, bytes: changeMapPng },
      ],
      { overwrite },
    );
    published = true;

    onProgress(1, "Comparison complete");
    return {
      outputDir: reservation.dir,
      outputs,
      primaryOutput: outputs[0],
      result,
      provenance,
      seconds: elapsedSeconds,
    };
  } finally {
    await reservation.release({ removeIfEmpty: !published });
  }
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
