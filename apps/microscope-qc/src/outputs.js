// Downloadable tables (CSV), the report (JSON) and the field profile chart (SVG). Pure: Node
// tests import it.
import { REJECTIONS } from "./core/psf.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The input name without .tif, .tiff or .ome.tif(f). */
export function outputStem(name) {
  return String(name).replace(/(\.ome)?\.tiff?$/i, "") || "image";
}

function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toPrecision(8))) : "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(cell).join(",")).join("\n")}\n`;
}

/** Bead status: used, poor fit, or the rejection reason. */
export function beadStatus(bead) {
  if (bead.rejection) return `rejected: ${REJECTIONS[bead.rejection]}`;
  return bead.goodFit ? "used" : "poor fit";
}

export function beadsCsv(beads, spacing) {
  const header = ["bead", "status", "x_px", "y_px", "z_px", "x_um", "y_um", "z_um", "fwhm_x_um", "fwhm_y_um", "fwhm_z_um", "r2_x", "r2_y", "r2_z", "lateral_asymmetry", "peak", "prominence"];
  const rows = beads.map((bead) => [
    bead.id,
    beadStatus(bead),
    bead.x ?? bead.peakX,
    bead.y ?? bead.peakY,
    bead.z ?? null,
    (bead.x ?? bead.peakX) * spacing.x,
    (bead.y ?? bead.peakY) * spacing.y,
    bead.z === undefined ? null : bead.z * spacing.z,
    bead.fwhm?.x,
    bead.fwhm?.y,
    bead.fwhm?.z,
    bead.r2?.x,
    bead.r2?.y,
    bead.r2?.z,
    bead.lar,
    bead.peak ?? null,
    bead.prominence,
  ]);
  return csv(header, rows);
}

export function psfSummaryCsv(summary) {
  const rows = ["x", "y", "z"].map((axis) => {
    const s = summary[axis];
    return [axis, s.n, s.mean, s.sd, s.median, s.min, s.max, s.theoretical, s.ratio];
  });
  rows.push(["lateral asymmetry", summary.lar.n, summary.lar.mean, summary.lar.sd, summary.lar.median, summary.lar.min, summary.lar.max, null, null]);
  return csv(["axis", "beads", "fwhm_mean_um", "fwhm_sd_um", "fwhm_median_um", "fwhm_min_um", "fwhm_max_um", "theoretical_um", "mean_to_theoretical"], rows);
}

/** Every fitted bead's x, y and z profile with the fitted curve. */
export function profilesCsv(beads, spacing) {
  const rows = [];
  for (const bead of beads) {
    if (!bead.profiles) continue;
    for (const axis of ["x", "y", "z"]) {
      const fit = bead.fits[axis];
      bead.profiles[axis].forEach((value, i) => {
        const position = i * spacing[axis];
        const model = fit ? fit.baseline + (fit.peak - fit.baseline) * Math.exp(-((position - fit.centre) ** 2) / (2 * fit.sigma ** 2)) : null;
        rows.push([bead.id, axis, i, position, value, model]);
      });
    }
  }
  return csv(["bead", "axis", "index", "position_um", "intensity", "fit"], rows);
}

export function fieldMetricsCsv(field) {
  return csv(["metric", "value"], [
    ["uniformity_percent", field.uniformity],
    ["field_uniformity_percent", field.fieldUniformity],
    ["centering_accuracy_percent", field.centeringAccuracy],
    ["max_intensity", field.max],
    ["min_intensity", field.min],
    ["reference_x_px", field.reference.x],
    ["reference_y_px", field.reference.y],
    ["reference_zone_pixels", field.referencePixels],
    ["saturated_pixels", field.saturatedPixels],
  ]);
}

export function fieldPointsCsv(field) {
  return csv(["point", "x_px", "y_px", "intensity", "relative_intensity", "distance_to_centre_px"], field.points.map((p) => [p.name, p.x, p.y, p.intensity, p.relative, p.distanceToCentre]));
}

const PROFILE_LABELS = Object.freeze({
  horizontal: "Horizontal, through the centre",
  vertical: "Vertical, through the centre",
  diagonalTlBr: "Diagonal, top left to bottom right",
  diagonalTrBl: "Diagonal, top right to bottom left",
});

export function fieldProfilesCsv(field) {
  const rows = [];
  for (const [key, profile] of Object.entries(field.profiles)) {
    profile.values.forEach((value, i) => rows.push([key, i, profile.distance[i], value, value / field.max]));
  }
  return csv(["profile", "index", "distance_px", "intensity", "relative_intensity"], rows);
}

const DASHES = { horizontal: null, vertical: "6 3", diagonalTlBr: "2 2", diagonalTrBl: "8 2 2 2" };

function escape(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** The four profiles as relative intensity against position along the line (0–1). */
export function fieldProfileSvg(field, { width = 640, height = 220 } = {}) {
  const left = 36;
  const right = 8;
  const top = 8;
  const bottom = 24;
  const x = (t) => left + t * (width - left - right);
  const y = (v) => top + (1 - v) * (height - top - bottom);
  const parts = [
    `<svg xmlns="${SVG_NS}" class="nd-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Intensity profiles" font-family="sans-serif" font-size="9">`,
  ];
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    parts.push(`<line class="nd-chart-gridline" x1="${left}" x2="${width - right}" y1="${y(level).toFixed(1)}" y2="${y(level).toFixed(1)}" stroke="currentColor" stroke-opacity="0.2"/>`);
    parts.push(`<text x="${left - 4}" y="${(y(level) + 3).toFixed(1)}" text-anchor="end">${Math.round(level * 100)}%</text>`);
  }
  for (const [key, profile] of Object.entries(field.profiles)) {
    const n = profile.values.length;
    const points = Array.from(profile.values, (value, i) => `${x(n > 1 ? i / (n - 1) : 0).toFixed(1)},${y(value / field.max).toFixed(1)}`).join(" ");
    const dash = DASHES[key] ? ` stroke-dasharray="${DASHES[key]}"` : "";
    parts.push(`<polyline class="nd-chart-median" fill="none" stroke="currentColor" stroke-width="1.3"${dash} points="${points}"><title>${escape(PROFILE_LABELS[key])}</title></polyline>`);
  }
  parts.push(`<line class="nd-chart-axis" x1="${left}" x2="${width - right}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" stroke-opacity="0.4"/>`);
  parts.push(`<text x="${left}" y="${height - 6}">start of line</text>`);
  parts.push(`<text x="${width - right}" y="${height - 6}" text-anchor="end">end of line</text>`);
  parts.push("</svg>");
  return parts.join("");
}

/** The legend for fieldProfileSvg's line styles. */
export function fieldProfileLegend() {
  return Object.entries(PROFILE_LABELS).map(([key, label]) => ({ label, dash: DASHES[key] }));
}

/** The JSON report: provenance, summary and per-bead or per-point results (profiles left out). */
export function reportJson(record, results) {
  return `${JSON.stringify({ ...record, results }, null, 2)}\n`;
}

/** Per-bead results for the JSON report, without the raw profiles. */
export function beadRecords(beads) {
  return beads.map(({ profiles: _profiles, fits, ...bead }) => ({ ...bead, status: beadStatus(bead), fits: fits ? Object.fromEntries(Object.entries(fits).map(([axis, fit]) => [axis, fit && { baseline: fit.baseline, peak: fit.peak, centreUm: fit.centre, sigmaUm: fit.sigma, fwhmUm: fit.fwhm, r2: fit.r2 }])) : undefined }));
}
