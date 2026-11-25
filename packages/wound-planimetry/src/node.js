// Node command-line adapter for @neurodesk/wound-planimetry.
// Runs the exact same CIE L*a*b*/HSV conversion, Otsu wound-bed segmentation,
// calibrated planimetry, RYB tissue classification, and PNG/CSV/JSON serializers
// as the Wound Planimetry web application.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { APP, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, readReferenceMm, readSettings } from "./config.js";
import { rgbaToColorArrays } from "./core/color.js";
import { calibrationFromRuler, measurePlanimetry } from "./core/planimetry.js";
import { classifyRyb } from "./core/ryb.js";
import { segmentWound } from "./core/segment.js";
import { buildProvenance, encodeMaskPng, encodeRybOverlayPng, outputStem, planimetryCsv } from "./outputs.js";
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

function parsePair(raw, label) {
  const parts = String(raw).split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) {
    throw new Error(`${label} must be formatted as X,Y with finite numbers, got "${raw}".`);
  }
  return [parts[0], parts[1]];
}

function parseRulerCoords(raw) {
  const parts = String(raw).split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error(`--ruler must be formatted as X1,Y1,X2,Y2 with finite numbers, got "${raw}".`);
  }
  return { p1: [parts[0], parts[1]], p2: [parts[2], parts[3]] };
}

/**
 * Resolve calibration scale from mutually exclusive CLI flags:
 *   - --pixels-per-mm N
 *   - --mm-per-pixel N
 *   - --scale-mm N with --scale-px P or --ruler X1,Y1,X2,Y2
 * Defaults to uncalibrated (pixelsPerMm = 0), matching the webapp.
 */
export function resolveCalibration({ pixelsPerMm, mmPerPixel, scaleMm, scalePx, ruler } = {}) {
  const hasPpm = pixelsPerMm !== undefined && pixelsPerMm !== "";
  const hasMpp = mmPerPixel !== undefined && mmPerPixel !== "";
  const hasScaleMm = scaleMm !== undefined && scaleMm !== "";
  const hasScalePx = scalePx !== undefined && scalePx !== "";
  const hasRuler = ruler !== undefined && ruler !== "";

  const modes = [hasPpm, hasMpp, hasScaleMm || hasScalePx || hasRuler].filter(Boolean).length;
  if (modes > 1) {
    throw new Error("Specify only one calibration method: --pixels-per-mm, --mm-per-pixel, or --scale-mm with --scale-px/--ruler.");
  }

  if (hasPpm) {
    return { pixelsPerMm: Number(pixelsPerMm), ruler: null };
  }

  if (hasMpp) {
    const mpp = Number(mmPerPixel);
    if (!Number.isFinite(mpp) || mpp <= 0) {
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
    const referenceMm = readReferenceMm(scaleMm);
    if (hasRuler) {
      const { p1, p2 } = parseRulerCoords(ruler);
      const cal = calibrationFromRuler(p1, p2, referenceMm);
      return {
        pixelsPerMm: cal.pixelsPerMm,
        ruler: { p1, p2, ...cal },
      };
    }
    const pixelDist = Number(scalePx);
    if (!Number.isFinite(pixelDist) || pixelDist < 1) {
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
  if (!input || !outputDir) {
    throw new Error("Provide an input JPEG/PNG wound image and an output directory.");
  }
  const started = performance.now();
  const calibration = resolveCalibration({ pixelsPerMm, mmPerPixel, scaleMm, scalePx, ruler });
  const settings = readSettings({
    pixelsPerMm: calibration.pixelsPerMm,
    sensitivity,
    escharL,
    granulationA,
    sloughB,
  });
  const parsedOpacity = Number(overlayOpacity);
  if (!Number.isFinite(parsedOpacity) || parsedOpacity < 0 || parsedOpacity > 1) {
    throw new Error(`--overlay-opacity must be between 0 and 1, got "${overlayOpacity}".`);
  }
  const parsedSeed = seed !== undefined && seed !== "" ? parsePair(seed, "--seed") : null;

  const destination = resolve(outputDir);
  await assertOutputDir(destination, { overwrite });

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
  await mkdir(destination, { recursive: true });
  const overlayPath = join(destination, `${stem}_wound-ryb-overlay.png`);
  const maskPath = join(destination, `${stem}_wound-mask.png`);
  const csvPath = join(destination, `${stem}_wound-planimetry.csv`);
  const jsonPath = join(destination, `${stem}_wound-provenance.json`);

  await writeAtomically(overlayPath, rybPngBytes);
  await writeAtomically(maskPath, maskPngBytes);
  await writeAtomically(csvPath, Buffer.from(csvText, "utf8"));
  await writeAtomically(jsonPath, Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8"));

  onProgress(1, "Measurement complete");
  return {
    outputDir: destination,
    outputs: [csvPath, jsonPath, overlayPath, maskPath],
    primaryOutput: csvPath,
    planimetry,
    ryb,
    provenance,
    seconds: elapsedMs / 1000,
  };
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
