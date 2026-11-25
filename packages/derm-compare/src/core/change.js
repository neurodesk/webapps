// Pure DOM-free dermoscopy change quantification:
// - sRGB -> CIE L*a*b* (D65)
// - Exact CIEDE2000 (ΔE2000) per Sharma, Wu & Dalal (2005)
// - Otsu lesion segmentation on skin-contrast score inside the valid FOV+alpha overlap mask
// - Hair-excluded normalized & raw ΔE2000 statistics, FOV-clipping detection, and honest null morphometry.
import { ALPHA_VALID_THRESHOLD, detectValidFov } from "./preprocess.js";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const POW25_7 = 25 ** 7;
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

// Precomputed sRGB [0..255] -> linear light [0..1] lookup table.
const SRGB_LUT = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LUT[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function labF(t) {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

/** Convert an 8-bit sRGB triple to CIE L*a*b* (D65 illuminant). */
export function rgbToLab(r, g, b) {
  const rl = SRGB_LUT[r & 255];
  const gl = SRGB_LUT[g & 255];
  const bl = SRGB_LUT[b & 255];
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / 1.00000;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Exact CIEDE2000 (ΔE2000) color difference formula (Sharma, Wu & Dalal 2005)
 * with parametric weighting factors kL = kC = kH = 1.
 */
export function ciede2000(L1, a1, b1, L2, a2, b2) {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = 0.5 * (C1 + C2);
  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  let h1p = C1p === 0 ? 0 : Math.atan2(b1, a1p) * RAD_TO_DEG;
  if (h1p < 0) h1p += 360;
  let h2p = C2p === 0 ? 0 : Math.atan2(b2, a2p) * RAD_TO_DEG;
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(0.5 * dhp * DEG_TO_RAD);

  const Lbarp = 0.5 * (L1 + L2);
  const Cbarp = 0.5 * (C1p + C2p);
  let hbarp;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = 0.5 * (h1p + h2p);
  } else if (h1p + h2p < 360) {
    hbarp = 0.5 * (h1p + h2p + 360);
  } else {
    hbarp = 0.5 * (h1p + h2p - 360);
  }

  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * DEG_TO_RAD)
    + 0.24 * Math.cos(2 * hbarp * DEG_TO_RAD)
    + 0.32 * Math.cos((3 * hbarp + 6) * DEG_TO_RAD)
    - 0.20 * Math.cos((4 * hbarp - 63) * DEG_TO_RAD);

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Lm50Sq = (Lbarp - 50) ** 2;
  const SL = 1 + (0.015 * Lm50Sq) / Math.sqrt(20 + Lm50Sq);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * DEG_TO_RAD) * RC;

  const tL = dLp / SL;
  const tC = dCp / SC;
  const tH = dHp / SH;
  const val = tL * tL + tC * tC + tH * tH + RT * tC * tH;
  return val > 0 ? Math.sqrt(val) : 0;
}

/** Convert an RGBA image buffer to planar Float32 CIE L*a*b* arrays over valid pixels. */
function rgbaToLabPlanes(rgba, validMask, width, height) {
  const n = width * height;
  const L = new Float32Array(n);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!validMask[i]) continue;
    const rl = SRGB_LUT[rgba[p]];
    const gl = SRGB_LUT[rgba[p + 1]];
    const bl = SRGB_LUT[rgba[p + 2]];
    const fx = labF((0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047);
    const fy = labF(0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl);
    const fz = labF((0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883);
    L[i] = 116 * fy - 16;
    a[i] = 500 * (fx - fy);
    b[i] = 200 * (fy - fz);
  }
  return { L, a, b };
}

/** Separable box blur over valid pixels. */
function smoothField(src, valid, width, height, radius = 2) {
  const n = width * height;
  const temp = new Float32Array(n);
  const out = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!valid[idx]) continue;
      let sum = 0;
      let cnt = 0;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let kx = x0; kx <= x1; kx++) {
        const k = row + kx;
        if (valid[k]) {
          sum += src[k];
          cnt++;
        }
      }
      temp[idx] = cnt > 0 ? sum / cnt : src[idx];
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!valid[idx]) continue;
      let sum = 0;
      let cnt = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let ky = y0; ky <= y1; ky++) {
        const k = ky * width + x;
        if (valid[k]) {
          sum += temp[k];
          cnt++;
        }
      }
      out[idx] = cnt > 0 ? sum / cnt : temp[idx];
    }
  }
  return out;
}

/**
 * Otsu threshold over 256 histogram bins for valid pixels in `values`.
 * Returns the exact upper boundary of `bestBin` (`min + (bestBin + 1) / invSpan`)
 * so `values[i] >= threshold` partitions bins `0..bestBin` vs `bestBin+1..255` identically
 * to the histogram search.
 */
function otsuThreshold(values, valid) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (!valid[i]) continue;
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (count < 16 || max - min < 4) return null;

  const bins = 256;
  const hist = new Uint32Array(bins);
  const invSpan = (bins - 1) / (max - min);
  for (let i = 0; i < values.length; i++) {
    if (!valid[i]) continue;
    const b = Math.min(bins - 1, Math.max(0, Math.floor((values[i] - min) * invSpan)));
    hist[b]++;
  }

  let totalMean = 0;
  for (let i = 0; i < bins; i++) totalMean += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let bestVar = -1;
  let bestBin = 128;
  for (let i = 0; i < bins - 1; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = count - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (totalMean - sumB) / wF;
    const diff = mB - mF;
    const between = wB * wF * diff * diff;
    if (between > bestVar) {
      bestVar = between;
      bestBin = i;
    }
  }
  return min + (bestBin + 1) / invSpan;
}

/** Keep the largest 4-connected component and fill interior holes only inside `validMask`. */
function keepLargestComponentAndFill(binary, validMask, width, height) {
  const n = width * height;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  let bestPixels = null;

  for (let i = 0; i < n; i++) {
    if (!binary[i] || !validMask[i] || visited[i]) continue;
    let head = 0;
    let tail = 0;
    visited[i] = 1;
    queue[tail++] = i;
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0 && binary[idx - 1] && validMask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; queue[tail++] = idx - 1; }
      if (x + 1 < width && binary[idx + 1] && validMask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; queue[tail++] = idx + 1; }
      if (y > 0 && binary[idx - width] && validMask[idx - width] && !visited[idx - width]) { visited[idx - width] = 1; queue[tail++] = idx - width; }
      if (y + 1 < height && binary[idx + width] && validMask[idx + width] && !visited[idx + width]) { visited[idx + width] = 1; queue[tail++] = idx + width; }
    }
    if (!bestPixels || tail > bestPixels.length) {
      bestPixels = queue.slice(0, tail);
    }
  }

  const out = new Uint8Array(n);
  if (!bestPixels || bestPixels.length < 4) return out;
  for (let i = 0; i < bestPixels.length; i++) out[bestPixels[i]] = 1;

  // Fill interior holes by flood-filling background from image borders,
  // while strictly respecting `validMask` so excluded/transparent pixels are never filled.
  const exterior = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  const seed = (idx) => {
    if (!out[idx] && !exterior[idx]) {
      exterior[idx] = 1;
      queue[tail++] = idx;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    seed(y * width);
    seed(y * width + (width - 1));
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) seed(idx - 1);
    if (x + 1 < width) seed(idx + 1);
    if (y > 0) seed(idx - width);
    if (y + 1 < height) seed(idx + width);
  }
  for (let i = 0; i < n; i++) {
    if (!exterior[i] && validMask[i]) out[i] = 1;
  }
  return out;
}

/**
 * Segment lesion mask inside `validMask` using Otsu thresholding on a CIELAB
 * skin-contrast score relative to surrounding peripheral skin color.
 */
export function segmentLesion(lab, validMask, width, height) {
  const n = width * height;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  let validCount = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!validMask[row + x]) continue;
      validCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (validCount < 16) return new Uint8Array(n);

  const ringX = Math.max(2, Math.round((maxX - minX + 1) * 0.15));
  const ringY = Math.max(2, Math.round((maxY - minY + 1) * 0.15));
  const step = Math.max(1, Math.floor(validCount / 8000));
  const ringSamples = [];
  for (let y = minY; y <= maxY; y++) {
    const onY = y < minY + ringY || y > maxY - ringY;
    const row = y * width;
    for (let x = minX; x <= maxX; x++) {
      if (!onY && x >= minX + ringX && x <= maxX - ringX) continue;
      const idx = row + x;
      if (!validMask[idx] || idx % step !== 0) continue;
      ringSamples.push(idx);
    }
  }
  if (ringSamples.length < 16) {
    for (let i = 0; i < n; i += step) {
      if (validMask[i]) ringSamples.push(i);
    }
  }
  if (!ringSamples.length) return new Uint8Array(n);

  ringSamples.sort((i, j) => lab.L[i] - lab.L[j]);
  // Take upper-half luminance samples in peripheral ring so a border-touching lesion does not bias skin color.
  const start = Math.floor(ringSamples.length * 0.45);
  const bright = ringSamples.slice(start);
  const medianOf = (arr) => {
    arr.sort((x, y) => x - y);
    return arr[Math.floor(arr.length / 2)];
  };
  const Ls = medianOf(bright.map((idx) => lab.L[idx]));
  const as = medianOf(bright.map((idx) => lab.a[idx]));
  const bs = medianOf(bright.map((idx) => lab.b[idx]));

  const contrast = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!validMask[i]) continue;
    const dL = lab.L[i] - Ls;
    const dark = Ls - lab.L[i] > 0 ? Ls - lab.L[i] : 0;
    const da = lab.a[i] - as;
    const db = lab.b[i] - bs;
    contrast[i] = Math.sqrt(dark * dark + 0.5 * dL * dL + da * da + db * db);
  }

  const smoothRadius = Math.max(1, Math.min(3, Math.round(Math.min(width, height) / 180)));
  const smoothed = smoothField(contrast, validMask, width, height, smoothRadius);
  const threshold = otsuThreshold(smoothed, validMask);
  if (threshold === null) return new Uint8Array(n);

  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (validMask[i] && smoothed[i] >= threshold) raw[i] = 1;
  }
  return keepLargestComponentAndFill(raw, validMask, width, height);
}

/** Detect whether a binary lesion mask touches the outer image frame or any invalid FOV pixel. */
function touchesValidBoundary(mask, validMask, width, height) {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) return true;
      if (!validMask[idx - 1] || !validMask[idx + 1] || !validMask[idx - width] || !validMask[idx + width]) {
        return true;
      }
    }
  }
  return false;
}

function summarizeValues(values) {
  if (!values.length) return { mean: null, p95: null, over10Pct: null };
  let sum = 0;
  let over10 = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    if (v > 10) over10++;
  }
  values.sort((a, b) => a - b);
  const p95Idx = Math.min(values.length - 1, Math.floor(0.95 * (values.length - 1)));
  return {
    mean: sum / values.length,
    p95: values[p95Idx],
    over10Pct: (over10 / values.length) * 100,
  };
}

function roundOrNull(value, digits) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

/**
 * Compute per-pixel CIEDE2000 color difference and Otsu lesion morphometry between
 * baseline and aligned follow-up RGBA images over the strictly intersected FOV+alpha valid mask.
 *
 * - Never falls back to raw geometric overlap when valid FOV/alpha pixels are insufficient.
 * - Excludes detected hair pixels (`excludedHairMask`) from ΔE2000 statistics instead of
 *   measuring ΔE2000 on synthetic inpainted pixels.
 * - Sets morphometry metrics to `null` (never 0) if either lesion mask is empty.
 * - Reports both normalized and raw mean ΔE2000, FOV clipping flags, and honest `growthStatus`.
 */
export function analyzeChange({
  baselineRgba,
  warpedFollowupRgba,
  baselineColorRgba = null,
  warpedColorRgba = null,
  baselineRawRgba = null,
  warpedRawRgba = null,
  baselineValid = null,
  overlapMask,
  excludedHairMask = null,
  allowScale = false,
  width,
  height,
}) {
  const n = width * height;
  const bFov = baselineValid ?? detectValidFov(baselineRgba, width, height);
  const fFov = detectValidFov(warpedFollowupRgba, width, height);
  const validMask = new Uint8Array(n);
  const deltaEMask = new Uint8Array(n);
  let validCount = 0;
  let hairExcludedPx = 0;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (
      overlapMask[i]
      && bFov[i]
      && fFov[i]
      && baselineRgba[p + 3] >= ALPHA_VALID_THRESHOLD
      && warpedFollowupRgba[p + 3] >= ALPHA_VALID_THRESHOLD
    ) {
      validMask[i] = 1;
      validCount++;
      if (excludedHairMask && excludedHairMask[i]) {
        hairExcludedPx++;
      } else {
        deltaEMask[i] = 1;
      }
    }
  }

  // Lesion segmentation runs on preprocessed (hair-suppressed) images over validMask.
  const baseSegLab = rgbaToLabPlanes(baselineRgba, validMask, width, height);
  const follSegLab = rgbaToLabPlanes(warpedFollowupRgba, validMask, width, height);
  const baselineMask = segmentLesion(baseSegLab, validMask, width, height);
  const followupMask = segmentLesion(follSegLab, validMask, width, height);

  // Per-pixel CIEDE2000 runs on non-inpainted color images over deltaEMask (excluding hair pixels).
  const bColor = baselineColorRgba ?? baselineRgba;
  const fColor = warpedColorRgba ?? warpedFollowupRgba;
  const baseColorLab = bColor === baselineRgba ? baseSegLab : rgbaToLabPlanes(bColor, deltaEMask, width, height);
  const follColorLab = fColor === warpedFollowupRgba ? follSegLab : rgbaToLabPlanes(fColor, deltaEMask, width, height);

  const deltaEMap = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!deltaEMask[i]) continue;
    deltaEMap[i] = ciede2000(
      baseColorLab.L[i], baseColorLab.a[i], baseColorLab.b[i],
      follColorLab.L[i], follColorLab.a[i], follColorLab.b[i],
    );
  }

  // Optional raw (pre-color-normalization) ΔE2000 comparison when color constancy was applied.
  const hasSeparateRaw = Boolean(
    baselineRawRgba && warpedRawRgba
    && (baselineRawRgba !== bColor || warpedRawRgba !== fColor),
  );
  const baseRawLab = hasSeparateRaw ? rgbaToLabPlanes(baselineRawRgba, deltaEMask, width, height) : null;
  const follRawLab = hasSeparateRaw ? rgbaToLabPlanes(warpedRawRgba, deltaEMask, width, height) : null;

  let baselineAreaPx = 0;
  let followupAreaPx = 0;
  let intersectionPx = 0;
  let unionPx = 0;
  let bxSum = 0;
  let bySum = 0;
  let fxSum = 0;
  let fySum = 0;
  const lesionDeltaE = [];
  const skinDeltaE = [];
  const overlapDeltaE = [];
  let rawLesionSum = 0;
  let rawLesionCount = 0;
  let rawOverlapSum = 0;
  let rawOverlapCount = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!validMask[i]) continue;
      const inB = baselineMask[i] === 1;
      const inF = followupMask[i] === 1;
      if (inB) {
        baselineAreaPx++;
        bxSum += x;
        bySum += y;
      }
      if (inF) {
        followupAreaPx++;
        fxSum += x;
        fySum += y;
      }
      if (inB && inF) intersectionPx++;
      if (inB || inF) unionPx++;

      if (deltaEMask[i]) {
        const dE = deltaEMap[i];
        overlapDeltaE.push(dE);
        if (inB || inF) lesionDeltaE.push(dE);
        else skinDeltaE.push(dE);

        if (hasSeparateRaw) {
          const rawDE = ciede2000(
            baseRawLab.L[i], baseRawLab.a[i], baseRawLab.b[i],
            follRawLab.L[i], follRawLab.a[i], follRawLab.b[i],
          );
          rawOverlapSum += rawDE;
          rawOverlapCount++;
          if (inB || inF) {
            rawLesionSum += rawDE;
            rawLesionCount++;
          }
        }
      }
    }
  }

  let segmentationStatus = "ok";
  if (baselineAreaPx === 0 && followupAreaPx === 0) segmentationStatus = "both-empty";
  else if (baselineAreaPx === 0) segmentationStatus = "baseline-empty";
  else if (followupAreaPx === 0) segmentationStatus = "followup-empty";

  const bothSegmented = segmentationStatus === "ok";
  const areaChangePct = bothSegmented ? ((followupAreaPx - baselineAreaPx) / baselineAreaPx) * 100 : null;
  const dice = bothSegmented ? (2 * intersectionPx) / (baselineAreaPx + followupAreaPx) : null;
  const jaccard = bothSegmented && unionPx > 0 ? intersectionPx / unionPx : null;
  const baselineCentroid = baselineAreaPx > 0 ? [bxSum / baselineAreaPx, bySum / baselineAreaPx] : null;
  const followupCentroid = followupAreaPx > 0 ? [fxSum / followupAreaPx, fySum / followupAreaPx] : null;
  const centroidShiftPx = bothSegmented && baselineCentroid && followupCentroid
    ? Math.hypot(followupCentroid[0] - baselineCentroid[0], followupCentroid[1] - baselineCentroid[1])
    : null;

  const baselineClippedByFov = baselineAreaPx > 0 && touchesValidBoundary(baselineMask, validMask, width, height);
  const followupClippedByFov = followupAreaPx > 0 && touchesValidBoundary(followupMask, validMask, width, height);
  const clippedByFov = baselineClippedByFov || followupClippedByFov;

  let growthStatus = "measured";
  if (!bothSegmented) growthStatus = "unavailable-empty-segmentation";
  else if (allowScale) growthStatus = "indeterminate-scale-fitted";
  else if (clippedByFov) growthStatus = "indeterminate-fov-clipped";

  const lesionStats = summarizeValues(lesionDeltaE);
  const skinStats = summarizeValues(skinDeltaE);
  const overlapStats = summarizeValues(overlapDeltaE);

  const rawLesionMeanDeltaE = hasSeparateRaw
    ? (rawLesionCount > 0 ? rawLesionSum / rawLesionCount : null)
    : lesionStats.mean;
  const rawOverlapMeanDeltaE = hasSeparateRaw
    ? (rawOverlapCount > 0 ? rawOverlapSum / rawOverlapCount : null)
    : overlapStats.mean;

  return {
    deltaEMap,
    deltaEMask,
    baselineMask,
    followupMask,
    validMask,
    metrics: {
      validOverlapPx: validCount,
      hairExcludedPx,
      segmentationStatus,
      growthStatus,
      clippedByFov,
      baselineClippedByFov,
      followupClippedByFov,
      baselineAreaPx,
      followupAreaPx,
      areaChangePct: roundOrNull(areaChangePct, 2),
      intersectionPx,
      unionPx,
      dice: roundOrNull(dice, 4),
      jaccard: roundOrNull(jaccard, 4),
      baselineCentroid: baselineCentroid ? [Number(baselineCentroid[0].toFixed(2)), Number(baselineCentroid[1].toFixed(2))] : null,
      followupCentroid: followupCentroid ? [Number(followupCentroid[0].toFixed(2)), Number(followupCentroid[1].toFixed(2))] : null,
      centroidShiftPx: roundOrNull(centroidShiftPx, 2),
      lesionMeanDeltaE: roundOrNull(lesionStats.mean, 3),
      lesionP95DeltaE: roundOrNull(lesionStats.p95, 3),
      lesionDeltaEOver10Pct: roundOrNull(lesionStats.over10Pct, 2),
      rawLesionMeanDeltaE: roundOrNull(rawLesionMeanDeltaE, 3),
      skinMeanDeltaE: roundOrNull(skinStats.mean, 3),
      skinP95DeltaE: roundOrNull(skinStats.p95, 3),
      overlapMeanDeltaE: roundOrNull(overlapStats.mean, 3),
      overlapP95DeltaE: roundOrNull(overlapStats.p95, 3),
      rawOverlapMeanDeltaE: roundOrNull(rawOverlapMeanDeltaE, 3),
    },
  };
}
