// End-to-end deterministic Dermoscope ABCD pipeline (DOM-free).
import { APP, DEFAULTS, readSettings } from "../config.js";
import { preprocessDermoscopyImage } from "./preprocess.js";
import { segmentLesion } from "./segment.js";
import { computeAbcdMetrics, emptyAbcdMetrics } from "./abcd.js";

/**
 * Run preprocessing, lesion border segmentation, and experimental automated ABCD morphometry
 * on an RGBA pixel buffer.
 */
export function runDermoscopyPipeline(rgba, width, height, rawSettings = {}, { onProgress } = {}) {
  const settings = readSettings(rawSettings);
  onProgress?.(0.1, "Masking vignette and removing hairs…");

  const preprocessed = preprocessDermoscopyImage(rgba, width, height, {
    maxWorkingDimension: APP.maxWorkingDimension,
    removeHair: settings.removeHair,
    colorConstancy: settings.colorConstancy,
    vignetteThreshold: DEFAULTS.vignetteThreshold,
    hairThreshold: DEFAULTS.hairThreshold,
    minkowskiP: DEFAULTS.minkowskiP,
  });

  onProgress?.(0.45, "Segmenting lesion border…");

  const segmented = segmentLesion(
    preprocessed.preprocessedRgba,
    preprocessed.width,
    preprocessed.height,
    preprocessed.validMask,
    { thresholdBias: settings.thresholdBias },
  );

  onProgress?.(0.75, segmented.segmented ? "Computing ABCD morphometry…" : "No lesion detected");

  const abcd = segmented.segmented
    ? computeAbcdMetrics({
        mask: segmented.mask,
        contour: segmented.contour,
        lab: segmented.lab,
        validMask: preprocessed.validMask,
        width: preprocessed.width,
        height: preprocessed.height,
        pixelsPerMm: settings.pixelsPerMm,
        scaleFactor: preprocessed.scaleFactor,
        scaleX: preprocessed.scaleX,
        scaleY: preprocessed.scaleY,
        differentialStructures: settings.differentialStructures,
      })
    : emptyAbcdMetrics({
        width: preprocessed.width,
        height: preprocessed.height,
        pixelsPerMm: settings.pixelsPerMm,
        scaleFactor: preprocessed.scaleFactor,
        scaleX: preprocessed.scaleX,
        scaleY: preprocessed.scaleY,
        differentialStructures: settings.differentialStructures,
        failureReason: segmented.failureReason,
      });

  onProgress?.(1, segmented.segmented ? "Analysis complete" : segmented.failureReason);

  return {
    settings,
    segmented: segmented.segmented,
    failureReason: segmented.failureReason,
    contourComplete: segmented.contourComplete,
    foregroundBackgroundDeltaE: segmented.foregroundBackgroundDeltaE,
    originalWidth: preprocessed.originalWidth,
    originalHeight: preprocessed.originalHeight,
    width: preprocessed.width,
    height: preprocessed.height,
    scaleX: preprocessed.scaleX,
    scaleY: preprocessed.scaleY,
    scaleFactor: preprocessed.scaleFactor,
    workingOriginalRgba: preprocessed.workingOriginalRgba,
    preprocessedRgba: preprocessed.preprocessedRgba,
    vignetteMask: preprocessed.vignetteMask,
    transparentMask: preprocessed.transparentMask,
    validMask: preprocessed.validMask,
    vignetteCoveragePct: preprocessed.vignetteCoveragePct,
    transparentCoveragePct: preprocessed.transparentCoveragePct,
    hairMask: preprocessed.hairMask,
    hairCoveragePct: preprocessed.hairCoveragePct,
    repairedPixels: preprocessed.repairedPixels,
    hairPixelCount: preprocessed.hairPixelCount,
    illuminant: preprocessed.illuminant,
    gains: preprocessed.gains,
    mask: segmented.mask,
    boundaryMask: segmented.boundaryMask,
    contour: segmented.contour,
    perilesionalSkin: segmented.perilesionalSkin,
    otsuThreshold: segmented.otsuThreshold,
    appliedThreshold: segmented.appliedThreshold,
    abcd,
  };
}
