// Output builders: fast-png encoding for RYB overlay and mask PNGs, CSV planimetry
// table, JSON provenance record, and inline SVG stacked RYB bar chart.
import { encode } from "fast-png";
import { compositeRybRgba, maskToGrayscale } from "./display.js";

export const RYB_CHART_SERIES = Object.freeze([
  Object.freeze({ key: "red", label: "Red (granulation)", fill: "#dc2626" }),
  Object.freeze({ key: "yellow", label: "Yellow (slough / fibrin)", fill: "#eab308" }),
  Object.freeze({ key: "black", label: "Black (eschar / necrosis)", fill: "#1f2937" }),
  Object.freeze({ key: "unclassified", label: "Unclassified", fill: "#ec4899" }),
]);

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function outputStem(filename) {
  return filename.replace(/\.(jpe?g|png)$/i, "");
}

function sanitizeCsvText(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function fixed(value, digits = 3) {
  return value === null || value === undefined || !Number.isFinite(value) ? "" : Number(value).toFixed(digits);
}

/** Encode composited RYB overlay PNG bytes via fast-png. */
export function encodeRybOverlayPng(baseRgba, rybLabels, boundary, width, height, opacity = 0.55) {
  const data = compositeRybRgba(baseRgba, rybLabels, boundary, width, height, opacity);
  return encode({ width, height, data, channels: 4, depth: 8 });
}

/** Encode binary wound mask (0/255) grayscale PNG bytes via fast-png. */
export function encodeMaskPng(mask, width, height) {
  const data = maskToGrayscale(mask);
  return encode({ width, height, data, channels: 1, depth: 8 });
}

/** Build the planimetry and color-based RYB tissue estimate CSV. */
export function planimetryCsv({ filename, width, height, planimetry, ryb, settings, seed, seedFallback = false }) {
  const woundDetected = planimetry.areaPx > 0;
  const rows = [
    ["metric", "value", "unit"],
    ["image_file", sanitizeCsvText(filename), ""],
    ["image_width", width, "px"],
    ["image_height", height, "px"],
    ["wound_detected", woundDetected ? "true" : "false", ""],
    ["calibrated", planimetry.calibrated ? "true" : "false", ""],
    ["scale_pixels_per_mm", fixed(planimetry.pixelsPerMm, 4), "px/mm"],
    ["wound_area_px", planimetry.areaPx, "px²"],
    ["wound_area_mm2", fixed(planimetry.areaMm2, 2), "mm²"],
    ["wound_area_cm2", fixed(planimetry.areaCm2, 4), "cm²"],
    ["perimeter_px", fixed(planimetry.perimeterPx, 2), "px"],
    ["perimeter_mm", fixed(planimetry.perimeterMm, 2), "mm"],
    ["major_length_px", fixed(planimetry.lengthPx, 2), "px"],
    ["perpendicular_width_px", fixed(planimetry.widthPx, 2), "px"],
    ["major_length_mm", fixed(planimetry.lengthMm, 2), "mm"],
    ["perpendicular_width_mm", fixed(planimetry.widthMm, 2), "mm"],
    ["kundin_ellipsoid_area_px", fixed(planimetry.kundinAreaPx, 2), "px²"],
    ["kundin_ellipsoid_area_mm2", fixed(planimetry.kundinAreaMm2, 2), "mm²"],
    ["kundin_ellipsoid_area_cm2", fixed(planimetry.kundinAreaCm2, 4), "cm²"],
    ["circularity", fixed(planimetry.circularity, 4), ""],
    ["compactness", fixed(planimetry.compactness, 4), ""],
    ["orientation_deg", fixed(planimetry.orientationDeg, 2), "deg"],
    ["ryb_red_granulation_px", ryb.classes.red.pixels, "px²"],
    ["ryb_red_granulation_pct", fixed(ryb.classes.red.percent, 2), "%"],
    ["ryb_red_granulation_cm2", fixed(ryb.classes.red.areaCm2, 4), "cm²"],
    ["ryb_yellow_slough_px", ryb.classes.yellow.pixels, "px²"],
    ["ryb_yellow_slough_pct", fixed(ryb.classes.yellow.percent, 2), "%"],
    ["ryb_yellow_slough_cm2", fixed(ryb.classes.yellow.areaCm2, 4), "cm²"],
    ["ryb_black_eschar_px", ryb.classes.black.pixels, "px²"],
    ["ryb_black_eschar_pct", fixed(ryb.classes.black.percent, 2), "%"],
    ["ryb_black_eschar_cm2", fixed(ryb.classes.black.areaCm2, 4), "cm²"],
    ["ryb_unclassified_px", ryb.classes.unclassified.pixels, "px²"],
    ["ryb_unclassified_pct", fixed(ryb.classes.unclassified.percent, 2), "%"],
    ["ryb_unclassified_cm2", fixed(ryb.classes.unclassified.areaCm2, 4), "cm²"],
    ["ryb_devitalized_pct", fixed(ryb.devitalizedPercent, 2), "%"],
    ["granulation_to_devitalized_ratio", fixed(ryb.granulationToDevitalizedRatio, 3), ""],
    ["sensitivity_bias", settings.sensitivity, ""],
    ["eschar_L_max", settings.escharL, "L*"],
    ["granulation_a_min", settings.granulationA, "a*"],
    ["slough_b_min", settings.sloughB, "b*"],
    ["seed_xy", seed ? `${seed[0]};${seed[1]}` : "", "px"],
    ["seed_fallback", seedFallback ? "true" : "false", ""],
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

/** Build the structured provenance record. */
export function buildProvenance({
  app,
  input,
  settings,
  seed,
  seedFallback = false,
  ruler,
  threshold,
  otsuThreshold,
  planimetry,
  ryb,
  elapsedMs,
}) {
  const woundDetected = planimetry.areaPx > 0;
  const warnings = [];
  if (!woundDetected) warnings.push("No wound bed detected.");
  if (seedFallback) warnings.push("Placed seed fell outside all segmented components; fell back to nearest component.");

  return {
    app: { id: app.id, title: app.title, version: app.version },
    method: "Calibrated digital wound planimetry and heuristic CIE L*a*b* / HSV color-based RYB tissue estimates (not trained clinical tissue classification)",
    reference: "Mukherjee R et al. BioMed Res. Int. 2014;2014:851582 (DOI: 10.1155/2014/851582)",
    researchUseOnly: true,
    woundDetected,
    warnings,
    input: {
      name: input.file.name,
      bytes: input.file.size,
      format: input.format,
      width: input.width,
      height: input.height,
    },
    parameters: {
      ...settings,
      seed: seed ? [seed[0], seed[1]] : null,
      ruler: ruler
        ? {
          p1: ruler.p1,
          p2: ruler.p2,
          pixelDist: Number(ruler.pixelDist.toFixed(3)),
          referenceMm: ruler.referenceMm,
          pixelsPerMm: Number(ruler.pixelsPerMm.toFixed(4)),
        }
        : null,
    },
    segmentation: {
      otsuThreshold: Number(otsuThreshold.toFixed(4)),
      appliedThreshold: Number(threshold.toFixed(4)),
      seedFallback: Boolean(seedFallback),
    },
    planimetry,
    ryb,
    elapsedMs: Number(elapsedMs.toFixed(1)),
  };
}

/** Render an inline SVG stacked horizontal bar chart for color-based RYB tissue percentages. */
export function rybStackedBarSvg(ryb) {
  const width = 420;
  const barHeight = 24;
  const barY = 4;
  let cursor = 0;
  const parts = [];

  if (ryb.totalPx > 0) {
    for (const series of RYB_CHART_SERIES) {
      const pct = ryb.classes[series.key]?.percent ?? 0;
      const segWidth = (pct / 100) * width;
      if (segWidth > 0.25) {
        parts.push(
          `<rect x="${cursor.toFixed(2)}" y="${barY}" width="${segWidth.toFixed(2)}" height="${barHeight}" fill="${series.fill}">` +
          `<title>${series.label}: ${pct.toFixed(1)}%</title></rect>`,
        );
        cursor += segWidth;
      }
    }
  }

  if (!parts.length) {
    parts.push(`<rect x="0" y="${barY}" width="${width}" height="${barHeight}" fill="none" class="nd-chart-axis" stroke-dasharray="4 3"/>`);
  }

  const axisY = barY + barHeight + 4;
  parts.push(`<line x1="0" y1="${axisY}" x2="${width}" y2="${axisY}" class="nd-chart-axis"/>`);
  for (const tick of [0, 25, 50, 75, 100]) {
    const tx = (tick / 100) * width;
    const anchor = tick === 0 ? "start" : tick === 100 ? "end" : "middle";
    parts.push(`<line x1="${tx}" y1="${axisY}" x2="${tx}" y2="${axisY + 4}" class="nd-chart-axis"/>`);
    parts.push(`<text x="${tx}" y="${axisY + 14}" text-anchor="${anchor}">${tick}%</text>`);
  }

  const ariaLabel = ryb.totalPx > 0
    ? "Color-based RYB tissue estimates stacked bar chart"
    : "No wound bed detected — RYB tissue fractions unavailable";
  return `<svg class="nd-chart" viewBox="0 0 ${width} 50" role="img" aria-label="${ariaLabel}">${parts.join("")}</svg>`;
}
