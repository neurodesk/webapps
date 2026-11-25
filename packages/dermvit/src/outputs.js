// Pure DOM-free downloadable outputs (predictions CSV, provenance JSON, saliency PNG via fast-png)
// and the inline SVG horizontal bar chart for the classification report view.
import { encode as encodePng } from "fast-png";
import { SALIENCY_EXPORT_OPACITY } from "./config.js";
import { compositeSaliencyRgba } from "./display.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const CSV_DISCLAIMER = "# Research & educational use only — uncalibrated softmax scores; not a clinical diagnosis";

/** Input filename without .jpg, .jpeg or .png extension. */
export function outputStem(name) {
  return String(name).replace(/\.(jpe?g|png)$/i, "") || "lesion";
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toPrecision(7))) : "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Ranked 7-class HAM10000 uncalibrated softmax score table (CSV). */
export function predictionsCsv(summary) {
  const header = ["rank", "class_index", "code", "label", "softmax_score", "softmax_percent", "logit"];
  const rows = summary.ranked.map((item) => [
    item.rank,
    item.index,
    item.code,
    item.label,
    Number(item.probability.toFixed(6)),
    Number((item.probability * 100).toFixed(2)),
    Number(item.logit.toFixed(6)),
  ]);
  const table = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  return `${CSV_DISCLAIMER}\n${table}\n`;
}

/** Formatted provenance JSON string. */
export function provenanceJson(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Encodes a composited saliency overlay image as tightly-backed 8-bit RGBA PNG bytes using fast-png. */
export function encodeSaliencyPng(baseRgba, saliencyMap, width, height, opacity = SALIENCY_EXPORT_OPACITY) {
  const data = compositeSaliencyRgba(baseRgba, saliencyMap, width, height, opacity);
  const encoded = encodePng({
    width,
    height,
    data,
    channels: 4,
    depth: 8,
  });
  if (encoded.byteOffset === 0 && encoded.byteLength === encoded.buffer.byteLength) {
    return encoded;
  }
  return new Uint8Array(encoded);
}

function escapeXml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

/**
 * Inline SVG horizontal bar chart of ranked 7-class HAM10000 uncalibrated softmax scores.
 * Uses only shared .nd-chart classes and --nd-color-* tokens.
 */
export function probabilityChartSvg(summary, { width = 560, height = 218 } = {}) {
  const left = 56;
  const right = 54;
  const top = 10;
  const bottom = 26;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const rows = summary.ranked;
  const rowStep = plotH / Math.max(1, rows.length);
  const barHeight = Math.max(10, Math.min(18, rowStep * 0.62));

  const parts = [
    `<svg xmlns="${SVG_NS}" class="nd-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="HAM10000 7-class uncalibrated softmax scores">`,
  ];

  // Vertical percentage gridlines (0..100%)
  for (const pct of [0, 25, 50, 75, 100]) {
    const x = (left + (pct / 100) * plotW).toFixed(1);
    parts.push(`<line class="nd-chart-gridline" x1="${x}" x2="${x}" y1="${top}" y2="${height - bottom}"/>`);
    parts.push(`<text x="${x}" y="${height - 8}" text-anchor="middle">${pct}%</text>`);
  }

  parts.push(`<line class="nd-chart-axis" x1="${left}" x2="${left}" y1="${top}" y2="${height - bottom}"/>`);
  parts.push(`<line class="nd-chart-axis" x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}"/>`);

  rows.forEach((item, index) => {
    const cy = top + (index + 0.5) * rowStep;
    const by = cy - barHeight / 2;
    const bw = Math.max(1, item.probability * plotW);
    const pctText = `${(item.probability * 100).toFixed(1)}%`;
    const isTop = index === 0;
    const fill = isTop ? "var(--nd-color-primary)" : "var(--nd-color-text-dim)";
    const fillOpacity = isTop ? "0.9" : "0.45";

    parts.push(`<text class="${isTop ? "nd-chart-note" : ""}" x="${left - 8}" y="${(cy + 3).toFixed(1)}" text-anchor="end">${escapeXml(item.code)}</text>`);
    parts.push(
      `<rect x="${left}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${fill}" fill-opacity="${fillOpacity}">` +
      `<title>${escapeXml(`${item.code} (${item.label}): ${pctText}`)}</title></rect>`,
    );
    parts.push(`<text class="${isTop ? "nd-chart-note" : ""}" x="${(left + bw + 6).toFixed(1)}" y="${(cy + 3).toFixed(1)}" text-anchor="start">${escapeXml(pctText)}</text>`);
  });

  parts.push("</svg>");
  return parts.join("");
}
