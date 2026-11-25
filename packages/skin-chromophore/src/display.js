// Colormap rendering for hemoglobin/melanin OD proxy maps, ITA° typology maps and ROI contours.
// Pure JS (DOM-free) so both the browser viewer and worker/Node PNG encoding can call it.
import { ITA_UNAVAILABLE_BAND, itaBandIndex } from "./core/colorimetry.js";

const HEMOGLOBIN_STOPS = [
  [0.0, 252, 244, 240],
  [0.3, 244, 174, 158],
  [0.6, 217, 74, 72],
  [0.85, 153, 22, 34],
  [1.0, 79, 8, 18],
];

const MELANIN_STOPS = [
  [0.0, 250, 245, 232],
  [0.3, 224, 188, 136],
  [0.6, 166, 108, 56],
  [0.85, 102, 54, 24],
  [1.0, 44, 20, 10],
];

// Six Del Bino / Chardon ITA° typology band colors: Very Light -> Dark.
export const ITA_BAND_COLORS = Object.freeze([
  Object.freeze([245, 226, 205]), // Very Light (>55°)
  Object.freeze([234, 202, 168]), // Light (41–55°)
  Object.freeze([213, 170, 126]), // Intermediate (28–41°)
  Object.freeze([181, 130, 84]),  // Tan (10–28°)
  Object.freeze([132, 82, 48]),   // Brown (-30–10°)
  Object.freeze([76, 44, 28]),    // Dark (<=-30°)
]);

// Distinct cool slate color for pixels outside the valid ITA° skin domain (b* <= 1).
export const ITA_UNAVAILABLE_RGB = Object.freeze([120, 130, 142]);

const VIGNETTE_RGB = [24, 24, 28];

function sampleRamp(stops, t) {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const next = stops[i];
    if (clamped <= next[0]) {
      const f = (clamped - prev[0]) / Math.max(1e-6, next[0] - prev[0]);
      return [
        Math.round(prev[1] + (next[1] - prev[1]) * f),
        Math.round(prev[2] + (next[2] - prev[2]) * f),
        Math.round(prev[3] + (next[3] - prev[3]) * f),
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

function buildLut(stops) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = sampleRamp(stops, i / 255);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

const HEMOGLOBIN_LUT = buildLut(HEMOGLOBIN_STOPS);
const MELANIN_LUT = buildLut(MELANIN_STOPS);

/**
 * Renders a chromophore OD proxy or ITA° map to an RGBA Uint8ClampedArray.
 * When `opaque` is true (PNG export), vignette-excluded pixels are filled dark charcoal at
 * alpha=255 while transparent input pixels (alphaMask === 0) remain transparent (alpha=0).
 * When `opaque` is false (viewer overlay), alpha is scaled by `opacity` and all excluded
 * pixels are transparent.
 */
export function renderMapRgba(kind, analysis, { opaque = true, opacity = 0.7 } = {}) {
  const { width, height, validMask, alphaMask, maps, ranges } = analysis;
  const total = width * height;
  const out = new Uint8ClampedArray(total * 4);
  const alpha = opaque ? 255 : Math.round(Math.max(0, Math.min(1, opacity)) * 255);

  if (kind === "ita") {
    const ita = maps.ita;
    const bLab = maps.b;
    for (let i = 0; i < total; i++) {
      const base = i << 2;
      if (!validMask[i]) {
        if (opaque && (!alphaMask || alphaMask[i])) {
          out[base] = VIGNETTE_RGB[0];
          out[base + 1] = VIGNETTE_RGB[1];
          out[base + 2] = VIGNETTE_RGB[2];
          out[base + 3] = 255;
        }
        continue;
      }
      const band = itaBandIndex(ita[i], bLab[i]);
      const rgb = band === ITA_UNAVAILABLE_BAND ? ITA_UNAVAILABLE_RGB : ITA_BAND_COLORS[band];
      out[base] = rgb[0];
      out[base + 1] = rgb[1];
      out[base + 2] = rgb[2];
      out[base + 3] = alpha;
    }
    return out;
  }

  const values = kind === "hemoglobin" ? maps.hemoglobin : maps.melanin;
  const [low, high] = kind === "hemoglobin" ? ranges.hemoglobin : ranges.melanin;
  const lut = kind === "hemoglobin" ? HEMOGLOBIN_LUT : MELANIN_LUT;
  const invSpan = 255 / Math.max(1e-6, high - low);

  for (let i = 0; i < total; i++) {
    const base = i << 2;
    if (!validMask[i]) {
      if (opaque && (!alphaMask || alphaMask[i])) {
        out[base] = VIGNETTE_RGB[0];
        out[base + 1] = VIGNETTE_RGB[1];
        out[base + 2] = VIGNETTE_RGB[2];
        out[base + 3] = 255;
      }
      continue;
    }
    const raw = (values[i] - low) * invSpan;
    const idx = raw <= 0 ? 0 : raw >= 255 ? 255 : Math.round(raw);
    const offset = idx * 3;
    out[base] = lut[offset];
    out[base + 1] = lut[offset + 1];
    out[base + 2] = lut[offset + 2];
    out[base + 3] = alpha;
  }
  return out;
}

/**
 * Renders crisp 1-pixel boundary contours of Target ROI (primary emerald) and
 * Perilesional Reference ROI (sky blue) into an RGBA overlay buffer.
 */
export function renderRoiContoursRgba(targetMask, referenceMask, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  const isEdge = (mask, x, y) => {
    const idx = y * width + x;
    if (!mask[idx]) return false;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
    return !mask[idx - 1] || !mask[idx + 1] || !mask[idx - width] || !mask[idx + width];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) << 2;
      if (targetMask && isEdge(targetMask, x, y)) {
        out[base] = 52;
        out[base + 1] = 211;
        out[base + 2] = 153;
        out[base + 3] = 240;
      } else if (referenceMask && isEdge(referenceMask, x, y)) {
        out[base] = 56;
        out[base + 1] = 189;
        out[base + 2] = 248;
        out[base + 3] = 220;
      }
    }
  }
  return out;
}
