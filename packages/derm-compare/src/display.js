// Pure RGBA compositing helpers for Curtain, Checkerboard, ΔE2000 heatmap, and lesion contours.
// DOM-free so both the Web Worker (PNG export) and Node tests can import it.
import { ALPHA_VALID_THRESHOLD } from "./core/preprocess.js";

export const DELTA_E_SCALE_MAX = 30;

export const HEAT_STOPS = Object.freeze([
  [0, 18, 22, 54],
  [6, 102, 34, 132],
  [12, 212, 68, 48],
  [21, 250, 168, 24],
  [30, 255, 244, 156],
]);

export const CONTOUR_COLORS = Object.freeze({
  baseline: [56, 224, 255],
  followup: [160, 255, 96],
  both: [255, 255, 255],
});

/** Map a CIEDE2000 value (0..30+) to an RGB triple on an Inferno-like perceptual ramp. */
export function deltaERgb(deltaE) {
  const clamped = Math.max(0, Math.min(DELTA_E_SCALE_MAX, Number.isFinite(deltaE) ? deltaE : 0));
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    const [x0, r0, g0, b0] = HEAT_STOPS[i];
    const [x1, r1, g1, b1] = HEAT_STOPS[i + 1];
    if (clamped <= x1) {
      const t = x1 > x0 ? (clamped - x0) / (x1 - x0) : 0;
      return [
        Math.round(r0 + (r1 - r0) * t),
        Math.round(g0 + (g1 - g0) * t),
        Math.round(b0 + (b1 - b0) * t),
      ];
    }
  }
  const last = HEAT_STOPS[HEAT_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

function isBoundary(mask, x, y, width, height) {
  const idx = y * width + x;
  if (!mask[idx]) return false;
  if (x === 0 || x === width - 1 || y === 0 || y === height - 1) return true;
  return !mask[idx - 1] || !mask[idx + 1] || !mask[idx - width] || !mask[idx + width];
}

/**
 * Underlay for ΔE2000 view: baseline at full intensity inside `validMask`,
 * dimmed outside `validMask` for spatial context, and transparent wherever baseline alpha < 128.
 */
export function buildDiffUnderlayRgba({ baselineRgba, validMask, width, height }) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = baselineRgba[p + 3];
    if (a < ALPHA_VALID_THRESHOLD) {
      out[p + 3] = 0;
      continue;
    }
    if (validMask[i]) {
      out[p] = baselineRgba[p];
      out[p + 1] = baselineRgba[p + 1];
      out[p + 2] = baselineRgba[p + 2];
      out[p + 3] = a;
    } else {
      out[p] = Math.round(baselineRgba[p] * 0.35);
      out[p + 1] = Math.round(baselineRgba[p + 1] * 0.35);
      out[p + 2] = Math.round(baselineRgba[p + 2] * 0.35);
      out[p + 3] = a;
    }
  }
  return out;
}

/**
 * Full-opacity ΔE2000 heatmap layer (alpha = 255 inside `deltaEMask`, alpha = 0 outside)
 * so the viewer can composite any opacity smoothly with Canvas `globalAlpha` without rebuilding buffers.
 */
export function buildDeltaEHeatmapRgba({ deltaEMap, deltaEMask, validMask = null, width, height }) {
  const mask = deltaEMask ?? validMask;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  if (!mask) return out;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!mask[i]) continue;
    const [hr, hg, hb] = deltaERgb(deltaEMap[i]);
    out[p] = hr;
    out[p + 1] = hg;
    out[p + 2] = hb;
    out[p + 3] = 255;
  }
  return out;
}

/**
 * Composite the ΔE2000 heatmap over the baseline image with optional lesion contours (for PNG export).
 * Respects `opacity === 0`, `validMask`, `deltaEMask` (hair exclusion), and baseline alpha.
 */
export function buildChangeMapRgba({
  baselineRgba,
  deltaEMap,
  validMask = null,
  deltaEMask = null,
  overlapMask = null,
  baselineMask = null,
  followupMask = null,
  width,
  height,
  opacity = 0.72,
  showContours = true,
}) {
  const mask = validMask ?? overlapMask;
  const heatMask = deltaEMask ?? mask;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const alpha = Math.max(0, Math.min(1, opacity));

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const p = idx * 4;
      const baseAlpha = baselineRgba[p + 3];
      if (baseAlpha < ALPHA_VALID_THRESHOLD) {
        out[p + 3] = 0;
        continue;
      }
      if (!mask[idx]) {
        // Non-overlapping or invalid-FOV margin rendered dimmed for spatial context.
        out[p] = Math.round(baselineRgba[p] * 0.35);
        out[p + 1] = Math.round(baselineRgba[p + 1] * 0.35);
        out[p + 2] = Math.round(baselineRgba[p + 2] * 0.35);
        out[p + 3] = baseAlpha;
        continue;
      }
      if (alpha > 0 && heatMask[idx]) {
        const [hr, hg, hb] = deltaERgb(deltaEMap[idx]);
        out[p] = Math.round(baselineRgba[p] * (1 - alpha) + hr * alpha);
        out[p + 1] = Math.round(baselineRgba[p + 1] * (1 - alpha) + hg * alpha);
        out[p + 2] = Math.round(baselineRgba[p + 2] * (1 - alpha) + hb * alpha);
      } else {
        out[p] = baselineRgba[p];
        out[p + 1] = baselineRgba[p + 1];
        out[p + 2] = baselineRgba[p + 2];
      }
      out[p + 3] = baseAlpha;

      if (showContours && baselineMask && followupMask) {
        const bEdge = isBoundary(baselineMask, x, y, width, height);
        const fEdge = isBoundary(followupMask, x, y, width, height);
        if (bEdge && fEdge) {
          [out[p], out[p + 1], out[p + 2]] = CONTOUR_COLORS.both;
        } else if (bEdge) {
          [out[p], out[p + 1], out[p + 2]] = CONTOUR_COLORS.baseline;
        } else if (fEdge) {
          [out[p], out[p + 1], out[p + 2]] = CONTOUR_COLORS.followup;
        }
      }
    }
  }
  return out;
}

/**
 * Composite an alternating checkerboard of baseline and aligned follow-up tiles,
 * preserving transparency (alpha) on both baseline and follow-up tiles.
 */
export function buildCheckerRgba({
  baselineRgba,
  warpedFollowupRgba,
  validMask = null,
  overlapMask = null,
  width,
  height,
  tileSize = null,
}) {
  const mask = validMask ?? overlapMask;
  const tile = tileSize ?? Math.max(24, Math.round(Math.min(width, height) / 10));
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < height; y++) {
    const ty = Math.floor(y / tile);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const tx = Math.floor(x / tile);
      const idx = row + x;
      const p = idx * 4;
      const useFollowup = ((tx + ty) & 1) === 1;
      if (useFollowup) {
        if (mask[idx] && warpedFollowupRgba[p + 3] >= ALPHA_VALID_THRESHOLD) {
          out[p] = warpedFollowupRgba[p];
          out[p + 1] = warpedFollowupRgba[p + 1];
          out[p + 2] = warpedFollowupRgba[p + 2];
          out[p + 3] = warpedFollowupRgba[p + 3];
        } else {
          out[p] = 0;
          out[p + 1] = 0;
          out[p + 2] = 0;
          out[p + 3] = 0;
        }
      } else {
        out[p] = baselineRgba[p];
        out[p + 1] = baselineRgba[p + 1];
        out[p + 2] = baselineRgba[p + 2];
        out[p + 3] = baselineRgba[p + 3];
      }
    }
  }
  return out;
}

/**
 * Transparent contour overlay marking baseline (cyan), follow-up (lime), and shared (white) borders.
 * Defaults to full alpha (opacity = 1) so the viewer can scale opacity dynamically via `globalAlpha`.
 */
export function buildContourOverlayRgba({ baselineMask, followupMask, width, height, opacity = 1 }) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  if (a === 0 || !baselineMask || !followupMask) return out;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const bEdge = isBoundary(baselineMask, x, y, width, height);
      const fEdge = isBoundary(followupMask, x, y, width, height);
      if (!bEdge && !fEdge) continue;
      const p = (row + x) * 4;
      if (bEdge && fEdge) {
        [out[p], out[p + 1], out[p + 2]] = CONTOUR_COLORS.both;
      } else if (bEdge) {
        [out[p], out[p + 1], out[p + 2]] = CONTOUR_COLORS.baseline;
      } else {
        [out[p], out[p + 1], out[p + 2]] = CONTOUR_COLORS.followup;
      }
      out[p + 3] = a;
    }
  }
  return out;
}
