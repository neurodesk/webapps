// Pure downloadable artifact builders (PNG, CSV, JSON). DOM-free so Node tests and workers import it.
import { encode as encodePng } from "fast-png";

/** Strip common image extensions to produce a clean output filename stem. */
export function outputStem(name) {
  return String(name ?? "dermoscopy").replace(/\.(jpe?g|png|webp|tiff?)$/i, "") || "dermoscopy";
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toPrecision(8))) : "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function metricCell(value) {
  if (value === null || value === undefined) return "Unavailable";
  if (typeof value === "number" && !Number.isFinite(value)) return "Unavailable";
  return value;
}

export function formatCsv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

/** Encode an RGBA Uint8Array / Uint8ClampedArray into PNG bytes via fast-png. */
export function encodeRgbaPng(rgba, width, height) {
  const bytes = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return encodePng({
    width,
    height,
    data: bytes,
    channels: 4,
    depth: 8,
  });
}

/** Build the downloadable comparison metrics CSV table. */
export function metricsCsv({ registration, metrics, preprocessing, settings = null }) {
  const scaleFitted = Boolean(settings?.allowScale || metrics?.growthStatus === "indeterminate-scale-fitted");
  const areaLabel = scaleFitted ? "post_alignment_area_diff_pct" : "area_change_pct";
  const diceLabel = scaleFitted ? "post_alignment_shape_dice" : "dice_overlap";
  const jaccardLabel = scaleFitted ? "post_alignment_shape_jaccard" : "jaccard_iou";

  const rows = [
    ["initial_ncc", metricCell(registration.initialNcc), ""],
    ["aligned_ncc", metricCell(registration.alignedNcc), ""],
    ["shift_dx_px", metricCell(registration.dx), "px"],
    ["shift_dy_px", metricCell(registration.dy), "px"],
    ["rotation_deg", metricCell(registration.angleDeg), "deg (clockwise)"],
    ["scale", metricCell(registration.scale), "x"],
    ["overlap_pct", metricCell(registration.overlapPct), "%"],
    ["valid_overlap_px", metricCell(metrics.validOverlapPx), "px^2"],
    ["hair_excluded_px", metricCell(metrics.hairExcludedPx ?? 0), "px^2"],
    ["segmentation_status", metrics.segmentationStatus ?? "ok", ""],
    ["growth_status", metrics.growthStatus ?? "measured", ""],
    ["clipped_by_fov", metrics.clippedByFov ? "true" : "false", ""],
    ["baseline_area_px", metricCell(metrics.baselineAreaPx), "px^2"],
    ["followup_area_px", metricCell(metrics.followupAreaPx), "px^2"],
    [areaLabel, metricCell(metrics.areaChangePct), "%"],
    [diceLabel, metricCell(metrics.dice), ""],
    [jaccardLabel, metricCell(metrics.jaccard), ""],
    ["centroid_shift_px", metricCell(metrics.centroidShiftPx), "px"],
    ["lesion_mean_delta_e2000", metricCell(metrics.lesionMeanDeltaE), "DE2000"],
    ["lesion_p95_delta_e2000", metricCell(metrics.lesionP95DeltaE), "DE2000"],
    ["lesion_delta_e2000_gt10_pct", metricCell(metrics.lesionDeltaEOver10Pct), "%"],
    ["lesion_raw_mean_delta_e2000", metricCell(metrics.rawLesionMeanDeltaE), "DE2000"],
    ["skin_mean_delta_e2000", metricCell(metrics.skinMeanDeltaE), "DE2000"],
    ["skin_p95_delta_e2000", metricCell(metrics.skinP95DeltaE), "DE2000"],
    ["overlap_mean_delta_e2000", metricCell(metrics.overlapMeanDeltaE), "DE2000"],
    ["overlap_p95_delta_e2000", metricCell(metrics.overlapP95DeltaE), "DE2000"],
    ["overlap_raw_mean_delta_e2000", metricCell(metrics.rawOverlapMeanDeltaE), "DE2000"],
    ["baseline_hair_suppressed_pct", preprocessing?.baselineHairPct ?? 0, "%"],
    ["followup_hair_suppressed_pct", preprocessing?.followupHairPct ?? 0, "%"],
    ["baseline_color_gains_rgb", (preprocessing?.baselineGains ?? [1, 1, 1]).join(" "), ""],
    ["followup_color_gains_rgb", (preprocessing?.followupGains ?? [1, 1, 1]).join(" "), ""],
  ];
  if (scaleFitted) {
    rows.push([
      "growth_note",
      "Similarity scaling enabled; fitted magnification can absorb real lesion growth so physical growth is indeterminate",
      "",
    ]);
  }
  return formatCsv(["metric", "value", "unit"], rows);
}

/** Serialize provenance and summary metrics as formatted JSON. */
export function provenanceJson(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}
