// Pure DOM-independent configuration, settings validation, and NiiVue label colormap for InstanSeg.
import { DEFAULTS } from "@neurodesk/instanseg";

export const APP = Object.freeze({
  id: "instanseg",
  title: "InstanSeg",
});

function bounded(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === "" || Number.isNaN(Number(value))) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return num;
}

export const MAX_DISPLAY_LABELS = 4096;

export function normalizeSettings(raw = {}, imagePixelSize = null) {
  const pixelSize = raw.pixelSize === undefined || raw.pixelSize === null || raw.pixelSize === ""
    ? imagePixelSize
    : bounded(raw.pixelSize, imagePixelSize, 0.05, 2, "Pixel size");
  const tileSize = Math.trunc(bounded(raw.tileSize, DEFAULTS.tileSize, 256, 1024, "Tile size"));
  const backend = raw.backend === "wasm" ? "wasm" : "auto";
  return {
    pixelSize,
    seedThreshold: bounded(raw.seedThreshold, DEFAULTS.seedThreshold, 0.05, 0.95, "Seed threshold"),
    maskThreshold: bounded(raw.maskThreshold, DEFAULTS.maskThreshold, 0.05, 0.95, "Mask threshold"),
    overlapThreshold: bounded(raw.overlapThreshold, DEFAULTS.overlapThreshold, 0.05, 0.95, "Overlap threshold"),
    tileSize,
    backend,
  };
}

export function outputName(stem, suffix) {
  const safe = String(stem || "image").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
  return `${safe}_instanseg_${suffix}`;
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] = hue < 60
    ? [chroma, x, 0]
    : hue < 120
      ? [x, chroma, 0]
      : hue < 180
        ? [0, chroma, x]
        : hue < 240
          ? [0, x, chroma]
          : hue < 300
            ? [x, 0, chroma]
            : [chroma, 0, x];
  return [r, g, b].map((v) => Math.round(255 * (v + m)));
}

/** Map arbitrary instance IDs into [1, MAX_DISPLAY_LABELS] for NiiVue LUT texture limits (downloads keep exact IDs). */
export function displayLabels(labels) {
  const out = new Float32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    out[i] = id > 0 ? ((id - 1) % MAX_DISPLAY_LABELS) + 1 : 0;
  }
  return out;
}

/** Well-separated golden-angle NiiVue instance label colormap (0 = transparent, capped at MAX_DISPLAY_LABELS). */
export function labelColormap(count) {
  const capped = Math.min(Math.max(0, Math.trunc(count || 0)), MAX_DISPLAY_LABELS);
  const R = [0];
  const G = [0];
  const B = [0];
  const A = [0];
  const I = [0];
  for (let label = 1; label <= capped; label++) {
    const hue = (label * 137.508) % 360;
    const [r, g, b] = hslToRgb(hue, 0.78, 0.56);
    R.push(r);
    G.push(g);
    B.push(b);
    A.push(255);
    I.push(label);
  }
  return { R, G, B, A, I };
}
