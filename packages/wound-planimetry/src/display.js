// Pure pixel-buffer rendering helpers for the color-based RYB tissue overlay,
// wound boundary contour, and downloadable binary mask.

export const RYB_PALETTE = Object.freeze({
  1: Object.freeze([220, 38, 38]),   // Red: granulation
  2: Object.freeze([234, 179, 8]),   // Yellow: slough / fibrin
  3: Object.freeze([31, 41, 55]),    // Black: eschar / necrosis
  4: Object.freeze([236, 72, 153]),  // Unclassified
});

export const BOUNDARY_RGB = Object.freeze([0, 229, 255]);

export const RYB_CLASS_NAMES = Object.freeze({
  0: "Surrounding skin",
  1: "Red (granulation)",
  2: "Yellow (slough / fibrin)",
  3: "Black (eschar / necrosis)",
  4: "Unclassified",
});

/**
 * Render the transparent RGBA overlay canvas layer for the active viewer mode.
 */
export function overlayLayerRgba({ rybLabels, boundary, width, height, mode, opacity = 0.5 }) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  if (!rybLabels || !boundary || mode === "image" || mode === "report") return out;

  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  const boundaryAlpha = mode === "boundary" ? Math.round(Math.max(0.65, opacity) * 255) : 235;

  for (let i = 0; i < count; i++) {
    const p = i * 4;
    if (boundary[i]) {
      out[p] = BOUNDARY_RGB[0];
      out[p + 1] = BOUNDARY_RGB[1];
      out[p + 2] = BOUNDARY_RGB[2];
      out[p + 3] = boundaryAlpha;
      continue;
    }
    if (mode === "ryb") {
      const cls = rybLabels[i];
      if (!cls) continue;
      const rgb = RYB_PALETTE[cls];
      out[p] = rgb[0];
      out[p + 1] = rgb[1];
      out[p + 2] = rgb[2];
      out[p + 3] = alpha;
    }
  }
  return out;
}

/**
 * Composite the color-based RYB overlay and contour boundary onto the input RGBA image
 * for the downloadable rybOverlay PNG. Preserves transparency outside the wound mask.
 */
export function compositeRybRgba(baseRgba, rybLabels, boundary, width, height, opacity = 0.55) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  const a = Math.max(0, Math.min(1, opacity));
  const invA = 1 - a;

  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const br = baseRgba[p];
    const bg = baseRgba[p + 1];
    const bb = baseRgba[p + 2];
    const ba = baseRgba[p + 3];
    if (boundary[i]) {
      out[p] = BOUNDARY_RGB[0];
      out[p + 1] = BOUNDARY_RGB[1];
      out[p + 2] = BOUNDARY_RGB[2];
      out[p + 3] = 255;
      continue;
    }
    const cls = rybLabels[i];
    if (cls) {
      const rgb = RYB_PALETTE[cls];
      out[p] = Math.round(br * invA + rgb[0] * a);
      out[p + 1] = Math.round(bg * invA + rgb[1] * a);
      out[p + 2] = Math.round(bb * invA + rgb[2] * a);
      out[p + 3] = 255;
    } else {
      out[p] = br;
      out[p + 1] = bg;
      out[p + 2] = bb;
      out[p + 3] = ba;
    }
  }
  return out;
}

/**
 * Convert a binary 0/1 wound mask to an 8-bit 0/255 grayscale array for PNG encoding.
 */
export function maskToGrayscale(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 255 : 0;
  return out;
}

/**
 * Convert an image coordinate into an integer pixel index, or null when outside bounds.
 */
export function imagePixel(x, y, width, height) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return null;
  return [px, py];
}
