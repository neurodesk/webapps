// End-to-end pure DOM-free skin chromophore and colorimetry pipeline.
import {
  D65_WHITE,
  SRGB_TO_LINEAR_LUT,
  computeIta,
  computeShadesOfGrayGains,
  xyzToLab,
} from "./colorimetry.js";
import {
  REFLECTANCE_MAX,
  REFLECTANCE_MIN,
  TSUMURA_INVERSE,
  VIGNETTE_LUMINANCE_THRESHOLD,
  buildAlphaMask,
  detectVignetteMask,
} from "./chromophores.js";
import { buildRoiMasks, compareRois, summarizeRoi } from "./roi.js";

const LOG10_INV = 1 / Math.LN10;

/** Computes robust [p2, p98] display range over valid pixels of a map. */
export function robustRange(values, validMask) {
  const n = values.length;
  const step = Math.max(1, Math.floor(n / 100000));
  const sample = [];
  for (let i = 0; i < n; i += step) {
    if (!validMask || validMask[i]) sample.push(values[i]);
  }
  if (!sample.length) return [0, 1];
  sample.sort((a, b) => a - b);
  const low = sample[Math.floor(0.02 * (sample.length - 1))];
  const high = sample[Math.floor(0.98 * (sample.length - 1))];
  return high > low + 1e-6 ? [low, high] : [low, low + 1];
}

/**
 * Full per-pixel skin colorimetry & optical chromophore analysis on an RGBA Uint8ClampedArray.
 * Pure JS, zero DOM dependencies, runnable in both Web Workers and Node unit tests.
 */
export function analyzeSkinImage(rgba, width, height, options = {}, onProgress = null) {
  const {
    whiteBalance = false,
    maskVignette = true,
    roiMode = "auto",
    customTarget = null,
    customReference = null,
  } = options;

  const total = width * height;
  if (total === 0) throw new Error("Image has no pixels.");

  onProgress?.(0.05, maskVignette ? "Masking transparent and dark vignette pixels…" : "Checking alpha mask…");
  const { alphaMask, alphaValidCount, alphaExcludedCount } = buildAlphaMask(rgba, width, height);
  let validMask;
  let vignetteCount;
  let validCount;
  let vignetteGuardTriggered;
  if (maskVignette) {
    const detected = detectVignetteMask(rgba, width, height, VIGNETTE_LUMINANCE_THRESHOLD, alphaMask);
    validMask = detected.validMask;
    vignetteCount = detected.vignetteCount;
    validCount = detected.validCount;
    vignetteGuardTriggered = detected.vignetteGuardTriggered;
  } else {
    validMask = new Uint8Array(alphaMask);
    vignetteCount = 0;
    validCount = alphaValidCount;
    vignetteGuardTriggered = false;
  }

  onProgress?.(0.15, whiteBalance ? "Computing Shades of Gray white balance…" : "Linearizing sRGB…");
  const whiteBalanceGains = whiteBalance
    ? computeShadesOfGrayGains(rgba, validMask, 6)
    : { r: 1, g: 1, b: 1 };

  const maps = {
    L: new Float32Array(total),
    a: new Float32Array(total),
    b: new Float32Array(total),
    ita: new Float32Array(total),
    ei: new Float32Array(total),
    mi: new Float32Array(total),
    melanin: new Float32Array(total),
    hemoglobin: new Float32Array(total),
  };

  const gR = whiteBalanceGains.r;
  const gG = whiteBalanceGains.g;
  const gB = whiteBalanceGains.b;
  const inv00 = TSUMURA_INVERSE[0][0];
  const inv01 = TSUMURA_INVERSE[0][1];
  const inv02 = TSUMURA_INVERSE[0][2];
  const inv10 = TSUMURA_INVERSE[1][0];
  const inv11 = TSUMURA_INVERSE[1][1];
  const inv12 = TSUMURA_INVERSE[1][2];

  const reportChunk = Math.max(1, Math.floor(total / 8));
  for (let i = 0; i < total; i++) {
    if (onProgress && i > 0 && i % reportChunk === 0) {
      onProgress(0.2 + 0.55 * (i / total), "Computing Lab, ITA° and chromophores…");
    }
    const base = i << 2;
    let r = SRGB_TO_LINEAR_LUT[rgba[base]] * gR;
    let g = SRGB_TO_LINEAR_LUT[rgba[base + 1]] * gG;
    let b = SRGB_TO_LINEAR_LUT[rgba[base + 2]] * gB;
    if (r > 1) r = 1;
    if (g > 1) g = 1;
    if (b > 1) b = 1;

    // CIE XYZ (D65) -> CIE L*a*b*
    const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    const [L, a, bLab] = xyzToLab(X, Y, Z);
    maps.L[i] = L;
    maps.a[i] = a;
    maps.b[i] = bLab;
    maps.ita[i] = computeIta(L, bLab);

    // Clamped linear reflectance for optical indices and Tsumura log optical density
    const rC = r < REFLECTANCE_MIN ? REFLECTANCE_MIN : r > REFLECTANCE_MAX ? REFLECTANCE_MAX : r;
    const gC = g < REFLECTANCE_MIN ? REFLECTANCE_MIN : g > REFLECTANCE_MAX ? REFLECTANCE_MAX : g;
    const bC = b < REFLECTANCE_MIN ? REFLECTANCE_MIN : b > REFLECTANCE_MAX ? REFLECTANCE_MAX : b;
    const dR = -Math.log(rC);
    const dG = -Math.log(gC);
    const dB = -Math.log(bC);

    // MI = 100 * log10(1 / R) = 100 * dR / ln(10)
    // EI = 100 * log10(R / G) = 100 * (dG - dR) / ln(10)
    maps.mi[i] = 100 * dR * LOG10_INV;
    maps.ei[i] = 100 * (dG - dR) * LOG10_INV;

    const mel = inv00 * dR + inv01 * dG + inv02 * dB;
    const hem = inv10 * dR + inv11 * dG + inv12 * dB;
    maps.melanin[i] = mel > 0 ? mel : 0;
    maps.hemoglobin[i] = hem > 0 ? hem : 0;
  }

  onProgress?.(0.82, "Segmenting Target & Reference ROIs…");
  const roi = evaluateRois({
    width,
    height,
    validMask,
    validCount,
    maps,
    roiMode,
    customTarget,
    customReference,
  });

  onProgress?.(0.95, "Finalizing ranges…");
  const ranges = {
    hemoglobin: robustRange(maps.hemoglobin, validMask),
    melanin: robustRange(maps.melanin, validMask),
    ita: [-60, 75],
  };

  return {
    width,
    height,
    alphaMask,
    alphaExcludedCount,
    validMask,
    vignetteCount,
    vignetteGuardTriggered,
    validCount,
    whiteBalanceGains,
    d65White: D65_WHITE,
    maps,
    ranges,
    roi,
  };
}

/** Recomputes Target/Reference masks and ROI statistics on already-computed maps. */
export function evaluateRois({
  width,
  height,
  validMask,
  validCount,
  maps,
  roiMode = "auto",
  customTarget = null,
  customReference = null,
}) {
  const masks = buildRoiMasks({
    width,
    height,
    validMask,
    validCount,
    maps,
    roiMode,
    customTarget,
    customReference,
  });
  const target = summarizeRoi(maps, masks.targetMask, width, height, validCount);
  const reference = summarizeRoi(maps, masks.referenceMask, width, height, validCount);
  const comparison = compareRois(target, reference);
  return {
    strategy: masks.strategy,
    autoFallback: masks.autoFallback,
    overlapPixels: masks.overlapPixels,
    targetMask: masks.targetMask,
    referenceMask: masks.referenceMask,
    target,
    reference,
    comparison,
  };
}
