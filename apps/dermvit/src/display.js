// Saliency heatmap colormap and RGBA compositing for canvas display and PNG export.

const STOPS = [
  [0.0, 24, 18, 84],
  [0.25, 118, 30, 128],
  [0.5, 206, 66, 86],
  [0.75, 249, 146, 28],
  [1.0, 252, 244, 144],
];

/** Maps a normalized saliency value t in [0, 1] to an RGB triple [r, g, b] in 0..255. */
export function heatColor(t) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, r0, g0, b0] = STOPS[i];
    const [t1, r1, g1, b1] = STOPS[i + 1];
    if (clamped <= t1) {
      const u = t1 > t0 ? (clamped - t0) / (t1 - t0) : 0;
      return [
        Math.round(r0 + (r1 - r0) * u),
        Math.round(g0 + (g1 - g0) * u),
        Math.round(b0 + (b1 - b0) * u),
      ];
    }
  }
  const last = STOPS[STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

/**
 * Renders an RGBA overlay layer for a normalized saliency map [0, 1].
 * Low-response regions smoothly fade out so the underlying lesion stays legible.
 */
export function saliencyOverlayRgba(saliencyMap, width, height, opacity = 0.6) {
  const count = width * height;
  const rgba = new Uint8ClampedArray(count * 4);
  const scaleAlpha = Math.max(0, Math.min(1, opacity));
  for (let i = 0; i < count; i++) {
    const value = saliencyMap[i];
    if (value <= 0.02) continue;
    const [r, g, b] = heatColor(value);
    const alpha = Math.round(255 * scaleAlpha * Math.pow(value, 0.7));
    const offset = i * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = alpha;
  }
  return rgba;
}

/**
 * Alpha-composites the saliency overlay onto the base dermoscopy RGBA image for
 * standalone PNG export.
 */
export function compositeSaliencyRgba(baseRgba, saliencyMap, width, height, opacity = 0.6) {
  const count = width * height;
  const out = new Uint8ClampedArray(count * 4);
  const scaleAlpha = Math.max(0, Math.min(1, opacity));
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    const value = saliencyMap[i];
    const br = baseRgba[offset];
    const bg = baseRgba[offset + 1];
    const bb = baseRgba[offset + 2];
    if (value <= 0.02 || scaleAlpha <= 0) {
      out[offset] = br;
      out[offset + 1] = bg;
      out[offset + 2] = bb;
      out[offset + 3] = 255;
      continue;
    }
    const [hr, hg, hb] = heatColor(value);
    const a = scaleAlpha * Math.pow(value, 0.7);
    const invA = 1 - a;
    out[offset] = Math.round(br * invA + hr * a);
    out[offset + 1] = Math.round(bg * invA + hg * a);
    out[offset + 2] = Math.round(bb * invA + hb * a);
    out[offset + 3] = 255;
  }
  return out;
}
