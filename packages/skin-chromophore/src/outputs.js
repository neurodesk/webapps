// Pure DOM-free downloadable outputs (PNG maps via fast-png, colorimetry CSV, provenance JSON)
// and the inline SVG L*–b* ITA° typology diagram for the report view.
import { encode as encodePng } from "fast-png";
import { ITA_MIN_B, ITA_UNAVAILABLE_LABEL, classifyIta, computeIta } from "./core/colorimetry.js";
import { renderMapRgba } from "./display.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEG_TO_RAD = Math.PI / 180;
const PROXY_MODEL_NOTE = "Uncalibrated fixed-basis RGB optical-density proxies (not per-image ICA or calibrated spectrophotometry)";

/** Input filename without .jpg, .jpeg or .png extension. */
export function outputStem(name) {
  return String(name).replace(/\.(jpe?g|png)$/i, "") || "skin-image";
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toPrecision(7))) : "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatCsv(header, rows) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

/** Encodes a chromophore OD proxy or ITA° map to 8-bit RGBA PNG bytes using fast-png. */
export function encodeMapPng(kind, analysis) {
  const data = renderMapRgba(kind, analysis, { opaque: true });
  const encoded = encodePng({
    width: analysis.width,
    height: analysis.height,
    data,
    channels: 4,
    depth: 8,
  });
  return encoded.byteOffset === 0 && encoded.byteLength === encoded.buffer.byteLength
    ? encoded
    : encoded.slice();
}

/** Per-ROI colorimetry & uncalibrated RGB chromophore proxy summary table (CSV). */
export function colorimetryCsv(analysis) {
  const { target, reference, comparison, autoFallback, overlapPixels } = analysis.roi;
  const header = [
    "roi",
    "pixel_count",
    "area_fraction",
    "ita_valid_pixels",
    "dominant_ita_band",
    "mean_coord_ita_deg",
    "L_mean",
    "L_sd",
    "L_median",
    "a_mean",
    "a_sd",
    "a_median",
    "b_mean",
    "b_sd",
    "b_median",
    "ita_deg_mean",
    "ita_deg_sd",
    "ita_deg_median",
    "rgb_ei_proxy_mean",
    "rgb_ei_proxy_sd",
    "rgb_ei_proxy_median",
    "rgb_mi_proxy_mean",
    "rgb_mi_proxy_sd",
    "rgb_mi_proxy_median",
    "melanin_od_proxy_mean",
    "melanin_od_proxy_sd",
    "melanin_od_proxy_median",
    "hemoglobin_od_proxy_mean",
    "hemoglobin_od_proxy_sd",
    "hemoglobin_od_proxy_median",
    "notes",
    "delta_e2000",
  ];

  const roiNote = (stats) => {
    const parts = [PROXY_MODEL_NOTE];
    if (stats.pixelCount === 0) parts.push("ROI empty (0 valid pixels)");
    else if (stats.itaValidPixels === 0) parts.push("All ROI pixels outside ITA skin domain (b* <= 1)");
    return parts.join("; ");
  };

  const roiRow = (name, stats) => [
    name,
    stats.pixelCount,
    stats.areaFraction,
    stats.itaValidPixels,
    stats.dominantItaBand,
    stats.meanCoordIta,
    stats.L.mean,
    stats.L.sd,
    stats.L.median,
    stats.a.mean,
    stats.a.sd,
    stats.a.median,
    stats.b.mean,
    stats.b.sd,
    stats.b.median,
    stats.ita.mean,
    stats.ita.sd,
    stats.ita.median,
    stats.ei.mean,
    stats.ei.sd,
    stats.ei.median,
    stats.mi.mean,
    stats.mi.sd,
    stats.mi.median,
    stats.melanin.mean,
    stats.melanin.sd,
    stats.melanin.median,
    stats.hemoglobin.mean,
    stats.hemoglobin.sd,
    stats.hemoglobin.median,
    roiNote(stats),
    null,
  ];

  const hasBoth = target.pixelCount > 0 && reference.pixelCount > 0;
  const diffNotes = [PROXY_MODEL_NOTE];
  if (!hasBoth) diffNotes.push("Comparison unavailable (one or both ROIs have 0 valid pixels)");
  if (overlapPixels > 0) diffNotes.push(`Target and Reference ROIs overlap by ${overlapPixels} px`);
  if (autoFallback) diffNotes.push("Auto segmentation fell back to central 25% disk");

  const diffRow = [
    "target_minus_reference",
    hasBoth ? target.pixelCount - reference.pixelCount : null,
    hasBoth && target.areaFraction !== null && reference.areaFraction !== null
      ? target.areaFraction - reference.areaFraction
      : null,
    hasBoth ? target.itaValidPixels - reference.itaValidPixels : null,
    hasBoth && target.dominantItaBand && reference.dominantItaBand
      ? `${target.dominantItaBand} vs ${reference.dominantItaBand}`
      : null,
    comparison.deltaMeanCoordITA ?? null,
    comparison.deltaL,
    null,
    null,
    comparison.deltaA,
    null,
    null,
    comparison.deltaB,
    null,
    null,
    comparison.deltaITA,
    null,
    null,
    comparison.deltaEI,
    null,
    null,
    comparison.deltaMI,
    null,
    null,
    comparison.deltaMelanin,
    null,
    null,
    comparison.deltaHemoglobin,
    null,
    null,
    diffNotes.join("; "),
    comparison.deltaE2000,
  ];

  return formatCsv(header, [
    roiRow("target", target),
    roiRow("reference", reference),
    diffRow,
  ]);
}

/** Provenance JSON string. */
export function provenanceJson(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function escapeXml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

function formatMeanCoordIta(L, b) {
  const angle = computeIta(L, b);
  if (!Number.isFinite(angle)) return { short: "n/a", detail: `n/a (${ITA_UNAVAILABLE_LABEL})` };
  const band = classifyIta(angle);
  return { short: `${angle.toFixed(1)}°`, detail: `${angle.toFixed(1)}° (${band})` };
}

/**
 * Inline SVG L*–b* ITA° typology zone diagram (Chardon et al. 1991; Del Bino & Bernerd 2013)
 * plotting the 5 ITA° zone boundaries (55°, 41°, 28°, 10°, −30°), the b* <= 1 excluded domain,
 * and available Target & Reference ROI mean coordinates. Unavailable ROIs are omitted, and
 * ITA° at plotted (mean L*, mean b*) is labeled separately from pixel-wise ITA° summaries.
 */
export function itaDiagramSvg(target, reference, comparison, { width = 560, height = 280 } = {}) {
  const left = 46;
  const right = 20;
  const top = 16;
  const bottom = 34;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const hasTarget = Boolean(
    target && target.pixelCount > 0 && Number.isFinite(target.L?.mean) && Number.isFinite(target.b?.mean),
  );
  const hasReference = Boolean(
    reference && reference.pixelCount > 0 && Number.isFinite(reference.L?.mean) && Number.isFinite(reference.b?.mean),
  );

  const bValues = [];
  if (hasTarget) bValues.push(target.b.mean);
  if (hasReference) bValues.push(reference.b.mean);
  const minVal = bValues.length ? Math.min(...bValues) : 0;
  const maxVal = bValues.length ? Math.max(...bValues) : 40;

  const bMin = Math.min(-5, Math.floor(minVal / 5) * 5 - 5);
  const bMax = Math.max(45, Math.ceil(maxVal / 5) * 5 + 5);
  const lMin = 0;
  const lMax = 100;

  const mapX = (b) => left + ((b - bMin) / (bMax - bMin)) * plotW;
  const mapY = (L) => top + (1 - (L - lMin) / (lMax - lMin)) * plotH;

  const parts = [
    `<svg xmlns="${SVG_NS}" class="nd-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="CIE L* vs b* Individual Typology Angle diagram showing available Target and Reference ROI mean coordinates">`,
  ];

  // Shade non-skin ITA domain (b* <= 1)
  if (bMin < ITA_MIN_B) {
    const shadeRight = mapX(Math.min(bMax, ITA_MIN_B));
    parts.push(`<rect x="${left}" y="${top}" width="${Math.max(0, shadeRight - left).toFixed(1)}" height="${plotH}" fill="var(--nd-color-border)" fill-opacity="0.22"/>`);
    parts.push(`<line class="nd-chart-range" x1="${shadeRight.toFixed(1)}" x2="${shadeRight.toFixed(1)}" y1="${top}" y2="${height - bottom}"/>`);
    parts.push(`<text x="${(shadeRight - 3).toFixed(1)}" y="${(top + 11).toFixed(1)}" text-anchor="end">b*≤1 (n/a)</text>`);
  }

  // Horizontal L* gridlines
  for (const L of [0, 20, 40, 50, 60, 80, 100]) {
    const y = mapY(L).toFixed(1);
    parts.push(`<line class="nd-chart-gridline" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text x="${left - 6}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end">${L}</text>`);
  }

  // Vertical b* gridlines
  for (let b = Math.ceil(bMin / 10) * 10; b <= bMax; b += 10) {
    const x = mapX(b).toFixed(1);
    parts.push(`<line class="nd-chart-gridline" x1="${x}" x2="${x}" y1="${top}" y2="${height - bottom}"/>`);
    parts.push(`<text x="${x}" y="${height - bottom + 13}" text-anchor="middle">${b}</text>`);
  }

  // ITA° boundary rays radiating from (b* = 0, L* = 50): L* = 50 + b* * tan(angle), drawn for b* >= 1
  const boundaries = [
    { angle: 55, label: "55°" },
    { angle: 41, label: "41°" },
    { angle: 28, label: "28°" },
    { angle: 10, label: "10°" },
    { angle: -30, label: "-30°" },
  ];

  for (const { angle, label } of boundaries) {
    const slope = Math.tan(angle * DEG_TO_RAD);
    const startB = ITA_MIN_B;
    const startL = 50 + startB * slope;
    let endB = bMax;
    let endL = 50 + endB * slope;
    if (endL > lMax) {
      endL = lMax;
      endB = (lMax - 50) / slope;
    } else if (endL < lMin) {
      endL = lMin;
      endB = (lMin - 50) / slope;
    }
    const sx = mapX(startB);
    const sy = mapY(Math.max(lMin, Math.min(lMax, startL)));
    const ex = mapX(endB);
    const ey = mapY(endL);
    parts.push(`<line class="nd-chart-range" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"/>`);
    const lx = Math.min(width - right - 2, ex - 2);
    const ly = Math.max(top + 10, Math.min(height - bottom - 4, ey - 2));
    parts.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end">${escapeXml(label)}</text>`);
  }

  // Typology zone captions placed along the positive b* side
  const zoneLabels = [
    { text: "Very Light", b: 14, L: 86 },
    { text: "Light", b: 28, L: 82 },
    { text: "Intermediate", b: 36, L: 75 },
    { text: "Tan", b: 38, L: 64 },
    { text: "Brown", b: 38, L: 44 },
    { text: "Dark", b: 32, L: 18 },
  ];
  for (const z of zoneLabels) {
    if (z.b <= bMax) {
      parts.push(`<text x="${mapX(z.b).toFixed(1)}" y="${mapY(z.L).toFixed(1)}" text-anchor="middle">${escapeXml(z.text)}</text>`);
    }
  }

  // Axes
  parts.push(`<line class="nd-chart-axis" x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}"/>`);
  parts.push(`<line class="nd-chart-axis" x1="${left}" x2="${left}" y1="${top}" y2="${height - bottom}"/>`);
  parts.push(`<text x="${(left + width - right) / 2}" y="${height - 5}" text-anchor="middle">CIE b* (blue–yellow)</text>`);
  parts.push(`<text x="12" y="${(top + height - bottom) / 2}" text-anchor="middle" transform="rotate(-90 12 ${(top + height - bottom) / 2})">CIE L* (lightness)</text>`);

  const tx = hasTarget ? mapX(Math.max(bMin, Math.min(bMax, target.b.mean))) : null;
  const ty = hasTarget ? mapY(Math.max(lMin, Math.min(lMax, target.L.mean))) : null;
  const rx = hasReference ? mapX(Math.max(bMin, Math.min(bMax, reference.b.mean))) : null;
  const ry = hasReference ? mapY(Math.max(lMin, Math.min(lMax, reference.L.mean))) : null;

  // Vector connecting Reference -> Target only when both ROIs are available
  if (hasTarget && hasReference) {
    parts.push(`<line class="nd-chart-median" stroke-dasharray="4 3" x1="${rx.toFixed(1)}" y1="${ry.toFixed(1)}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}"/>`);
  }

  if (hasReference) {
    const refMeanIta = formatMeanCoordIta(reference.L.mean, reference.b.mean);
    const refPixelIta = Number.isFinite(reference.ita?.mean)
      ? `${reference.ita.mean.toFixed(1)}°`
      : "n/a";
    const refTitle = `Reference mean (L* ${reference.L.mean.toFixed(1)}, b* ${reference.b.mean.toFixed(1)}): ITA at mean coord ${refMeanIta.detail}; pixel-wise ITA mean ${refPixelIta} (${reference.dominantItaBand ?? "Unavailable"}, ${reference.itaValidPixels}/${reference.pixelCount} valid px)`;
    parts.push(`<circle cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="5" fill="var(--nd-color-bg)" stroke="var(--nd-color-text)" stroke-width="2"><title>${escapeXml(refTitle)}</title></circle>`);
    parts.push(`<text class="nd-chart-note" x="${(rx + 8).toFixed(1)}" y="${(ry + 3).toFixed(1)}">${escapeXml(`Reference (coord ITA ${refMeanIta.short})`)}</text>`);
  }

  if (hasTarget) {
    const tgtMeanIta = formatMeanCoordIta(target.L.mean, target.b.mean);
    const tgtPixelIta = Number.isFinite(target.ita?.mean)
      ? `${target.ita.mean.toFixed(1)}°`
      : "n/a";
    const tgtTitle = `Target mean (L* ${target.L.mean.toFixed(1)}, b* ${target.b.mean.toFixed(1)}): ITA at mean coord ${tgtMeanIta.detail}; pixel-wise ITA mean ${tgtPixelIta} (${target.dominantItaBand ?? "Unavailable"}, ${target.itaValidPixels}/${target.pixelCount} valid px)`;
    const deltaLabel = hasReference && Number.isFinite(comparison?.deltaE2000)
      ? `, ΔE2000 ${comparison.deltaE2000.toFixed(1)}`
      : "";
    parts.push(`<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="5.5" fill="var(--nd-color-primary)" stroke="var(--nd-color-bg)" stroke-width="1.5"><title>${escapeXml(tgtTitle)}</title></circle>`);
    parts.push(`<text class="nd-chart-note" x="${(tx + 8).toFixed(1)}" y="${(ty - 4).toFixed(1)}">${escapeXml(`Target (coord ITA ${tgtMeanIta.short}${deltaLabel})`)}</text>`);
  }

  if (!hasTarget && !hasReference) {
    parts.push(`<text class="nd-chart-note" x="${(left + width - right) / 2}" y="${(top + height - bottom) / 2}" text-anchor="middle">No valid ROI pixels available</text>`);
  }

  parts.push("</svg>");
  return parts.join("");
}
