// Node command-line adapter for @neurodesk/wound-planimetry.
// Runs the exact same CIE L*a*b*/HSV conversion, Otsu wound-bed segmentation,
// calibrated planimetry, RYB tissue classification, and PNG/CSV/JSON serializers
// as the Wound Planimetry web application.
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { APP, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, readReferenceMm, readSettings } from "./config.js";
import { rgbaToColorArrays } from "./core/color.js";
import { calibrationFromRuler, measurePlanimetry } from "./core/planimetry.js";
import { classifyRyb } from "./core/ryb.js";
import { segmentWound } from "./core/segment.js";
import { buildProvenance, encodeMaskPng, encodeRybOverlayPng, outputStem, planimetryCsv } from "./outputs.js";
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

function parseStrictCoords(raw, count, label, formatHint) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${label} must be formatted as ${formatHint} with finite numbers, got "${raw}".`);
  }
  const tokens = raw.split(",");
  if (tokens.length !== count) {
    throw new Error(`${label} must be formatted as ${formatHint} with finite numbers, got "${raw}".`);
  }
  const values = tokens.map((token) => {
    const trimmed = token.trim();
    if (trimmed === "") return NaN;
    return Number(trimmed);
  });
  if (!values.every(Number.isFinite)) {
    throw new Error(`${label} must be formatted as ${formatHint} with finite numbers, got "${raw}".`);
  }
  return values;
}

export async function reserveOutputDir(outputDir, { overwrite = false, tool = "wound-planimetry" } = {}) {
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

function parsePair(raw, label) {
  const [x, y] = parseStrictCoords(raw, 2, label, "X,Y");
  return [x, y];
}

function parseRulerCoords(raw) {
  const [x1, y1, x2, y2] = parseStrictCoords(raw, 4, "--ruler", "X1,Y1,X2,Y2");
  return { p1: [x1, y1], p2: [x2, y2] };
}

/**
 * Resolve calibration scale from mutually exclusive CLI flags:
 *   - --pixels-per-mm N
 *   - --mm-per-pixel N
 *   - --scale-mm N with --scale-px P or --ruler X1,Y1,X2,Y2
 * Defaults to uncalibrated (pixelsPerMm = 0), matching the webapp.
 */
export function resolveCalibration({ pixelsPerMm, mmPerPixel, scaleMm, scalePx, ruler } = {}) {
  const hasPpm = pixelsPerMm !== undefined;
  const hasMpp = mmPerPixel !== undefined;
  const hasScaleMm = scaleMm !== undefined;
  const hasScalePx = scalePx !== undefined;
  const hasRuler = ruler !== undefined;

  const modes = [hasPpm, hasMpp, hasScaleMm || hasScalePx || hasRuler].filter(Boolean).length;
  if (modes > 1) {
    throw new Error("Specify only one calibration method: --pixels-per-mm, --mm-per-pixel, or --scale-mm with --scale-px/--ruler.");
  }

  if (hasPpm) {
    return { pixelsPerMm: parseStrictNumber(pixelsPerMm, "--pixels-per-mm"), ruler: null };
  }

  if (hasMpp) {
    const mpp = parseStrictNumber(mmPerPixel, "--mm-per-pixel");
    if (mpp <= 0) {
      throw new Error(`--mm-per-pixel must be a positive finite number, got "${mmPerPixel}".`);
    }
    return { pixelsPerMm: 1 / mpp, ruler: null };
  }

  if (hasScaleMm || hasScalePx || hasRuler) {
    if (!hasScaleMm) {
      throw new Error("--scale-px and --ruler require --scale-mm N (reference physical length in mm).");
    }
    if (hasScalePx && hasRuler) {
      throw new Error("Specify either --scale-px or --ruler with --scale-mm, not both.");
    }
    if (!hasScalePx && !hasRuler) {
      throw new Error("--scale-mm requires either --scale-px P or --ruler X1,Y1,X2,Y2 (or use --mm-per-pixel / --pixels-per-mm).");
    }
    const parsedScaleMm = parseStrictNumber(scaleMm, "--scale-mm");
    const referenceMm = readReferenceMm(parsedScaleMm);
    if (hasRuler) {
      const { p1, p2 } = parseRulerCoords(ruler);
      const cal = calibrationFromRuler(p1, p2, referenceMm);
      return {
        pixelsPerMm: cal.pixelsPerMm,
        ruler: { p1, p2, ...cal },
      };
    }
    const pixelDist = parseStrictNumber(scalePx, "--scale-px");
    if (pixelDist < 1) {
      throw new Error(`--scale-px must be a finite number >= 1, got "${scalePx}".`);
    }
    const cal = calibrationFromRuler([0, 0], [pixelDist, 0], referenceMm);
    return {
      pixelsPerMm: cal.pixelsPerMm,
      ruler: { p1: [0, 0], p2: [pixelDist, 0], ...cal },
    };
  }

  return { pixelsPerMm: 0, ruler: null };
}

export async function measureFile({
  input,
  outputDir,
  pixelsPerMm,
  mmPerPixel,
  scaleMm,
  scalePx,
  ruler,
  sensitivity,
  escharL,
  granulationA,
  sloughB,
  seed,
  overlayOpacity = 0.55,
  overwrite = false,
  onProgress = () => {},
} = {}) {
  if (!input || !outputDir || String(input).trim() === "" || String(outputDir).trim() === "") {
    throw new Error("Provide an input JPEG/PNG wound image and an output directory.");
  }
  const started = performance.now();
  const calibration = resolveCalibration({ pixelsPerMm, mmPerPixel, scaleMm, scalePx, ruler });
  const parsedSensitivity = sensitivity === undefined ? undefined : parseStrictNumber(sensitivity, "--sensitivity");
  const parsedEscharL = escharL === undefined ? undefined : parseStrictNumber(escharL, "--eschar-l");
  const parsedGranulationA =
    granulationA === undefined ? undefined : parseStrictNumber(granulationA, "--granulation-a");
  const parsedSloughB = sloughB === undefined ? undefined : parseStrictNumber(sloughB, "--slough-b");
  const settings = readSettings({
    pixelsPerMm: calibration.pixelsPerMm,
    sensitivity: parsedSensitivity,
    escharL: parsedEscharL,
    granulationA: parsedGranulationA,
    sloughB: parsedSloughB,
  });
  const parsedOpacity = parseStrictNumber(overlayOpacity, "--overlay-opacity");
  if (parsedOpacity < 0 || parsedOpacity > 1) {
    throw new Error(`--overlay-opacity must be between 0 and 1, got "${overlayOpacity}".`);
  }
  const parsedSeed = seed !== undefined ? parsePair(seed, "--seed") : null;

  const reservation = await reserveOutputDir(outputDir, { overwrite, tool: "wound-planimetry" });
  let published = false;

  try {
    onProgress(0.05, "Decoding input image…");
    const decoded = await readRasterImageFile(resolve(input), { maxBytes: MAX_IMAGE_BYTES });
    if (decoded.width * decoded.height > MAX_IMAGE_PIXELS) {
      throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()} pixel analysis limit.`);
    }
    if (parsedSeed) {
      const [sx, sy] = parsedSeed;
      if (sx < 0 || sy < 0 || sx >= decoded.width || sy >= decoded.height) {
        throw new Error(`--seed (${sx},${sy}) is outside image bounds (${decoded.width}x${decoded.height}).`);
      }
    }

    onProgress(0.15, "Converting image to CIE L*a*b*…");
    const colors = rgbaToColorArrays(decoded.rgba, decoded.width, decoded.height);

    onProgress(0.4, "Segmenting wound bed…");
    const { mask, otsuThreshold, threshold, seedFallback } = segmentWound(colors, decoded.width, decoded.height, {
      sensitivity: settings.sensitivity,
      seed: parsedSeed,
    });

    onProgress(0.65, "Measuring planimetry geometry…");
    const { boundary, ...planimetry } = measurePlanimetry(
      mask,
      decoded.width,
      decoded.height,
      settings.pixelsPerMm,
      colors.opaque,
    );

    onProgress(0.8, "Estimating color-based RYB tissues…");
    const { labels: rybLabels, ...ryb } = classifyRyb(colors, mask, {
      escharL: settings.escharL,
      granulationA: settings.granulationA,
      sloughB: settings.sloughB,
      pixelsPerMm: settings.pixelsPerMm,
    });

    onProgress(0.9, "Encoding PNG, CSV, and JSON outputs…");
    const rybPngBytes = encodeRybOverlayPng(decoded.rgba, rybLabels, boundary, decoded.width, decoded.height, parsedOpacity);
    const maskPngBytes = encodeMaskPng(mask, decoded.width, decoded.height);
    const elapsedMs = performance.now() - started;

    const csvText = planimetryCsv({
      filename: decoded.name,
      width: decoded.width,
      height: decoded.height,
      planimetry,
      ryb,
      settings,
      seed: parsedSeed,
      seedFallback,
    });
    const provenance = buildProvenance({
      app: APP,
      input: {
        file: { name: decoded.name, size: decoded.size },
        format: decoded.format,
        width: decoded.width,
        height: decoded.height,
      },
      settings,
      seed: parsedSeed,
      seedFallback,
      ruler: calibration.ruler,
      threshold,
      otsuThreshold,
      planimetry,
      ryb,
      elapsedMs,
    });

    const stem = outputStem(decoded.name);
    const outputs = await publishOutputs(
      reservation.dir,
      [
        { name: `${stem}_wound-planimetry.csv`, bytes: Buffer.from(csvText, "utf8") },
        { name: `${stem}_wound-provenance.json`, bytes: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8") },
        { name: `${stem}_wound-ryb-overlay.png`, bytes: rybPngBytes },
        { name: `${stem}_wound-mask.png`, bytes: maskPngBytes },
      ],
      { overwrite },
    );
    published = true;

    onProgress(1, "Measurement complete");
    return {
      outputDir: reservation.dir,
      outputs,
      primaryOutput: outputs[0],
      planimetry,
      ryb,
      provenance,
      seconds: elapsedMs / 1000,
    };
  } finally {
    await reservation.release({ removeIfEmpty: !published });
  }
}

/** Offline self-check running segmentation, planimetry, and RYB classification on a synthetic wound image. */
export async function checkInstallation() {
  const width = 64;
  const height = 64;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - 32;
      const dy = y - 32;
      const inWound = dx * dx + dy * dy <= 14 * 14;
      const o = (y * width + x) * 4;
      rgba[o] = inWound ? 185 : 220;
      rgba[o + 1] = inWound ? 52 : 185;
      rgba[o + 2] = inWound ? 48 : 158;
      rgba[o + 3] = 255;
    }
  }
  const colors = rgbaToColorArrays(rgba, width, height);
  const { mask } = segmentWound(colors, width, height, { sensitivity: 0 });
  const planimetry = measurePlanimetry(mask, width, height, 10, colors.opaque);
  const ryb = classifyRyb(colors, mask, { pixelsPerMm: 10 });
  if (!(planimetry.areaPx > 200 && planimetry.areaMm2 > 0 && ryb.classes.red.percent > 50)) {
    throw new Error("Self-check failed: synthetic wound planimetry or RYB classification failed.");
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
