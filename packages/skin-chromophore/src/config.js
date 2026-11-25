// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import packageJson from "../package.json" with { type: "json" };
import { CHROMOPHORE_MODEL_SPEC } from "./core/chromophores.js";

export const APP = Object.freeze({
  id: "skin-chromophore",
  title: "Skin Chromophore",
  version: packageJson.version,
});

export const DEFAULT_SETTINGS = Object.freeze({
  whiteBalance: false,
  maskVignette: true,
  roiMode: "auto",
});

export const ROI_MODES = Object.freeze(["auto", "central"]);

export const MAX_DECODED_BYTES = 128 * 1024 * 1024;
export const MAX_ANALYSIS_SIDE = 1024;

export function computeAnalysisDimensions(width, height, maxSide = MAX_ANALYSIS_SIDE) {
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width, height, scale: 1, downscaled: false };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
    downscaled: true,
  };
}

export function readSettings(raw = {}) {
  const whiteBalance = Boolean(raw.whiteBalance ?? DEFAULT_SETTINGS.whiteBalance);
  const maskVignette = raw.maskVignette === undefined ? DEFAULT_SETTINGS.maskVignette : Boolean(raw.maskVignette);
  const roiMode = raw.roiMode ?? DEFAULT_SETTINGS.roiMode;
  if (!ROI_MODES.includes(roiMode)) {
    throw new Error(`Unsupported ROI mode "${roiMode}". Expected one of: ${ROI_MODES.join(", ")}.`);
  }
  return { whiteBalance, maskVignette, roiMode };
}

export function collectAnalysisWarnings(analysis) {
  const warnings = [];
  const { target, reference, autoFallback, overlapPixels } = analysis.roi;
  if (target.pixelCount === 0 && reference.pixelCount === 0) {
    warnings.push("Both Target and Reference ROIs contain 0 valid pixels (excluded by transparency or vignette mask). Metrics are unavailable.");
  } else if (target.pixelCount === 0) {
    warnings.push("Target ROI contains 0 valid pixels (excluded by transparency or vignette mask). Target and comparison metrics are unavailable.");
  } else if (reference.pixelCount === 0) {
    warnings.push("Reference ROI contains 0 valid pixels (excluded by transparency or vignette mask). Reference and comparison metrics are unavailable.");
  }
  if (overlapPixels > 0) {
    warnings.push(`Target and Reference ROIs overlap by ${overlapPixels.toLocaleString()} px; contrast metrics include shared pixels.`);
  }
  if (autoFallback) {
    warnings.push("Automatic lesion segmentation found insufficient color contrast and fell back to a central 25% disk.");
  }
  if (analysis.vignetteGuardTriggered) {
    warnings.push("Vignette safety guard kept pixels valid because dark border masking would have excluded most of the image.");
  }
  if (target.pixelCount > 0 && target.itaValidPixels === 0) {
    warnings.push("All Target ROI pixels lie outside the valid ITA° skin domain (b* <= 1).");
  }
  if (reference.pixelCount > 0 && reference.itaValidPixels === 0) {
    warnings.push("All Reference ROI pixels lie outside the valid ITA° skin domain (b* <= 1).");
  }
  return warnings;
}

export function buildProvenance({
  file,
  width,
  height,
  originalWidth = width,
  originalHeight = height,
  downscaled = false,
  format,
  settings,
  analysis,
  manualRoi,
}) {
  return {
    app: APP.id,
    version: APP.version,
    timestamp: new Date().toISOString(),
    input: {
      name: file.name,
      bytes: file.size,
      format,
      originalWidth,
      originalHeight,
      width,
      height,
      downscaled,
      colorSpace: "srgb (color-managed decode)",
    },
    settings: {
      ...settings,
      customTargetRoi: manualRoi?.target ?? null,
      customReferenceRoi: manualRoi?.reference ?? null,
    },
    preprocessing: {
      alphaExcludedPixels: analysis.alphaExcludedCount ?? 0,
      vignetteExcludedPixels: analysis.vignetteCount,
      vignetteGuardTriggered: Boolean(analysis.vignetteGuardTriggered),
      validPixels: analysis.validCount,
      whiteBalanceGains: analysis.whiteBalanceGains,
    },
    methods: {
      colorimetry: "Color-managed sRGB -> IEC 61966-2-1 linear RGB -> CIE XYZ (D65) -> CIE L*a*b*",
      colorDifference: "CIEDE2000 (Sharma, Wu & Dalal 2005; kL=kC=kH=1)",
      typology: "Individual Typology Angle ITA° = atan((L* - 50) / b*) * 180/pi (Chardon et al. 1991; Del Bino & Bernerd 2013), restricted to valid skin domain b* > 1",
      opticalIndices: "Uncalibrated RGB reflectance proxies inspired by Diffey et al. (1984) and Takiwaki et al. (1994): RGB MI proxy = 100*log10(1/R), RGB EI proxy = 100*log10(R/G) on linear RGB clamped to [1e-3, 1] (not calibrated narrow-band spectrophotometry)",
      chromophores: "Uncalibrated fixed-basis RGB optical-density proxy inspired by Tsumura et al. (JOSA A 1999): d = [-ln R, -ln G, -ln B] projected via fixed 3x3 basis inverse with non-negative clipping max(0, c) (not per-image ICA or calibrated spectrophotometry)",
      chromophoreModel: {
        kind: CHROMOPHORE_MODEL_SPEC.kind,
        perImageIca: CHROMOPHORE_MODEL_SPEC.perImageIca,
        calibratedSpectrophotometry: CHROMOPHORE_MODEL_SPEC.calibratedSpectrophotometry,
        reflectanceClamp: [...CHROMOPHORE_MODEL_SPEC.reflectanceClamp],
        opticalDensityDefinition: CHROMOPHORE_MODEL_SPEC.opticalDensityDefinition,
        nonNegativeClipping: CHROMOPHORE_MODEL_SPEC.nonNegativeClipping,
        basisColumns: [...CHROMOPHORE_MODEL_SPEC.basisColumns],
        basisRows: [...CHROMOPHORE_MODEL_SPEC.basisRows],
        basisMatrix: CHROMOPHORE_MODEL_SPEC.basisMatrix.map((row) => [...row]),
        inverseMatrix: CHROMOPHORE_MODEL_SPEC.inverseMatrix.map((row) => [...row]),
      },
      whiteBalance: settings.whiteBalance ? "Shades of Gray (Minkowski p=6)" : "none",
    },
    display: {
      hemoglobin: {
        range: [...analysis.ranges.hemoglobin],
        units: "arbitrary OD proxy units (p2–p98 linear ramp)",
      },
      melanin: {
        range: [...analysis.ranges.melanin],
        units: "arbitrary OD proxy units (p2–p98 linear ramp)",
      },
      ita: {
        range: [...analysis.ranges.ita],
        units: "degrees (6 discrete Del Bino/Chardon bands for b* > 1; b* <= 1 marked outside skin domain)",
      },
    },
    roiStrategy: analysis.roi.strategy,
    autoFallback: Boolean(analysis.roi.autoFallback),
    overlapPixels: analysis.roi.overlapPixels ?? 0,
    warnings: collectAnalysisWarnings(analysis),
    summary: {
      target: analysis.roi.target,
      reference: analysis.roi.reference,
      comparison: analysis.roi.comparison,
    },
  };
}
