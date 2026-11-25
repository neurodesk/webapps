// Pure DOM-free comparison pipeline: uniform pair scaling -> preprocess -> register -> warp -> CIEDE2000 & morphometry.
import { downsampleRgba, preprocessImage } from "./preprocess.js";
import { registerImages, warpMaskAny, warpRgba } from "./register.js";
import { analyzeChange } from "./change.js";

export const DEFAULT_MAX_WORKING_DIMENSION = 1024;
export const MIN_SMALLER_WORKING_DIMENSION = 256;
export const MAX_WORKING_PIXELS = 4_194_304;

/**
 * Compute one shared uniform downscale factor across both images so unequal crop dimensions
 * (e.g. 1024×672 vs 2048×1344) keep identical relative pixel pitch in rigid mode, while never
 * crushing a small crop (e.g. 63×63 vs 4096×512) below morphometric working resolution.
 */
export function computeSharedWorkingScale(
  baselineWidth, baselineHeight,
  followupWidth, followupHeight,
  maxWorkingDimension = DEFAULT_MAX_WORKING_DIMENSION,
) {
  const baselineMax = Math.max(baselineWidth, baselineHeight);
  const followupMax = Math.max(followupWidth, followupHeight);
  const largerMax = Math.max(baselineMax, followupMax);
  if (largerMax <= maxWorkingDimension) return 1;

  const smallerMax = Math.min(baselineMax, followupMax);
  const baseScale = maxWorkingDimension / largerMax;
  const floorTarget = Math.min(smallerMax, MIN_SMALLER_WORKING_DIMENSION);
  const floorScale = smallerMax > 0 ? Math.min(1, floorTarget / smallerMax) : baseScale;
  const maxPixels = Math.max(baselineWidth * baselineHeight, followupWidth * followupHeight);
  const pixelBudgetScale = maxPixels > MAX_WORKING_PIXELS ? Math.sqrt(MAX_WORKING_PIXELS / maxPixels) : 1;
  return Math.min(1, Math.min(pixelBudgetScale, Math.max(baseScale, floorScale)));
}

/**
 * Run full sequential dermoscopy comparison on raw RGBA baseline and follow-up buffers.
 * Applies one shared uniform working-resolution downscale factor to both images before
 * registration. Registration and lesion segmentation use preprocessed (color-normalized +
 * hair-suppressed) images when enabled; ΔE2000 color change is measured on non-inpainted
 * images with detected hair pixels excluded; clinical output (`warpedFollowupRgba`) warps
 * the original follow-up capture at full floating-point transform precision and is masked
 * by the unified baseline ∧ follow-up `validMask`.
 */
export function runComparison({
  baselineRgba, baselineWidth, baselineHeight,
  followupRgba, followupWidth, followupHeight,
  settings = {},
  maxWorkingDimension = DEFAULT_MAX_WORKING_DIMENSION,
  onProgress = null,
}) {
  const {
    normalizeColor = true,
    suppressHair = true,
    allowScale = false,
    maxAngle = 25,
  } = settings;

  const workingScale = computeSharedWorkingScale(
    baselineWidth, baselineHeight,
    followupWidth, followupHeight,
    maxWorkingDimension,
  );
  let workBaseRgba = baselineRgba;
  let workBaseW = baselineWidth;
  let workBaseH = baselineHeight;
  let workFollRgba = followupRgba;
  let workFollW = followupWidth;
  let workFollH = followupHeight;

  if (workingScale < 1) {
    onProgress?.(0.02, "Scaling image pair uniformly…");
    const bScaled = downsampleRgba(
      baselineRgba, baselineWidth, baselineHeight,
      Math.max(1, Math.round(baselineWidth * workingScale)),
      Math.max(1, Math.round(baselineHeight * workingScale)),
    );
    const fScaled = downsampleRgba(
      followupRgba, followupWidth, followupHeight,
      Math.max(1, Math.round(followupWidth * workingScale)),
      Math.max(1, Math.round(followupHeight * workingScale)),
    );
    workBaseRgba = bScaled.rgba;
    workBaseW = bScaled.width;
    workBaseH = bScaled.height;
    workFollRgba = fScaled.rgba;
    workFollW = fScaled.width;
    workFollH = fScaled.height;
  }

  onProgress?.(0.05, "Normalizing illumination and hairs…");
  const basePrep = preprocessImage(workBaseRgba, workBaseW, workBaseH, { normalizeColor, suppressHair });
  onProgress?.(0.15, "Normalizing follow-up image…");
  const follPrep = preprocessImage(workFollRgba, workFollW, workFollH, { normalizeColor, suppressHair });

  const preprocessing = {
    workingScale: Number(workingScale.toFixed(6)),
    baselineGains: basePrep.gains.map((g) => Number(g.toFixed(4))),
    followupGains: follPrep.gains.map((g) => Number(g.toFixed(4))),
    baselineHairPct: Number((basePrep.hairFraction * 100).toFixed(2)),
    followupHairPct: Number((follPrep.hairFraction * 100).toFixed(2)),
  };

  onProgress?.(0.22, "Aligning follow-up onto baseline…");
  const registration = registerImages(
    basePrep.rgba, workBaseW, workBaseH,
    follPrep.rgba, workFollW, workFollH,
    {
      maxAngle,
      allowScale,
      baselineValid: basePrep.valid,
      followupValid: follPrep.valid,
      onProgress: (fraction) => onProgress?.(0.22 + 0.53 * fraction, "Aligning follow-up onto baseline…"),
    },
  );

  if (!registration.registered) {
    onProgress?.(1.0, registration.reason);
    return {
      registered: false,
      reason: registration.reason,
      width: workBaseW,
      height: workBaseH,
      followupWidth: workFollW,
      followupHeight: workFollH,
      workingScale,
      baselineRgba: null,
      warpedFollowupRgba: null,
      warpedPreprocessedRgba: null,
      overlapMask: null,
      validMask: null,
      deltaEMask: null,
      deltaEMap: null,
      baselineMask: null,
      followupMask: null,
      preprocessing,
      registration: {
        registered: false,
        reason: registration.reason,
        initialNcc: null,
        alignedNcc: null,
        dx: null,
        dy: null,
        angleDeg: null,
        scale: null,
        overlapPct: 0,
        overlapCount: 0,
      },
      metrics: null,
    };
  }

  // Full-precision transform parameters (never rounded before warping).
  const transform = {
    dx: registration.dx,
    dy: registration.dy,
    angleDeg: registration.angleDeg,
    scale: registration.scale,
  };

  // Warp original follow-up RGBA + its FOV/alpha mask for crisp clinical inspection and PNG download.
  onProgress?.(0.78, "Warping follow-up image…");
  const warpedClinical = warpRgba(
    workFollRgba, workFollW, workFollH,
    workBaseW, workBaseH,
    transform,
    { followupValid: follPrep.valid },
  );

  // Warp non-inpainted color-normalized follow-up for honest ΔE2000 measurement.
  const warpedColorRgba = normalizeColor
    ? warpRgba(
      follPrep.colorRgba, workFollW, workFollH,
      workBaseW, workBaseH,
      transform,
      { followupValid: follPrep.valid },
    ).rgba
    : warpedClinical.rgba;

  // Combine baseline and warped follow-up hair masks so detected hair pixels are excluded from ΔE2000.
  let excludedHairMask = null;
  if (suppressHair) {
    const warpedFollHair = warpMaskAny(
      follPrep.hairMask, workFollW, workFollH,
      workBaseW, workBaseH,
      transform,
    );
    const n = workBaseW * workBaseH;
    excludedHairMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (basePrep.hairMask[i] || warpedFollHair[i]) excludedHairMask[i] = 1;
    }
  }

  onProgress?.(0.84, "Quantifying CIEDE2000 and lesion change…");
  const change = analyzeChange({
    baselineRgba: basePrep.rgba,
    warpedFollowupRgba: registration.warpedRgba,
    baselineColorRgba: basePrep.colorRgba,
    warpedColorRgba,
    baselineRawRgba: workBaseRgba,
    warpedRawRgba: warpedClinical.rgba,
    baselineValid: basePrep.valid,
    overlapMask: warpedClinical.overlapMask,
    excludedHairMask,
    allowScale,
    width: workBaseW,
    height: workBaseH,
  });

  // Apply unified baseline ∧ follow-up validMask to aligned follow-up RGBA so aligned PNG,
  // Curtain, Flicker, Checker, and ΔE2000 honor the exact same validity mask.
  for (let i = 0, p = 0; i < change.validMask.length; i++, p += 4) {
    if (!change.validMask[i]) {
      warpedClinical.rgba[p] = 0;
      warpedClinical.rgba[p + 1] = 0;
      warpedClinical.rgba[p + 2] = 0;
      warpedClinical.rgba[p + 3] = 0;
    }
  }

  onProgress?.(1.0, "Comparison complete");

  return {
    registered: true,
    reason: null,
    width: workBaseW,
    height: workBaseH,
    followupWidth: workFollW,
    followupHeight: workFollH,
    workingScale,
    baselineRgba: workBaseRgba,
    warpedFollowupRgba: warpedClinical.rgba,
    warpedPreprocessedRgba: registration.warpedRgba,
    overlapMask: warpedClinical.overlapMask,
    validMask: change.validMask,
    deltaEMask: change.deltaEMask,
    deltaEMap: change.deltaEMap,
    baselineMask: change.baselineMask,
    followupMask: change.followupMask,
    preprocessing,
    registration: {
      registered: true,
      reason: null,
      initialNcc: registration.initialNcc,
      alignedNcc: registration.alignedNcc,
      dx: registration.dx,
      dy: registration.dy,
      angleDeg: registration.angleDeg,
      scale: registration.scale,
      mutualCoveragePct: registration.mutualCoveragePct,
      overlapPct: registration.overlapPct,
      overlapCount: registration.overlapCount,
    },
    metrics: change.metrics,
  };
}
