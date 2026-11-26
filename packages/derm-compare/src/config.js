// DOM-independent app config and settings validation. Kept pure so Node tests import it.
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "derm-compare",
  title: "DermCompare",
  version: packageJson.version,
});

export const DEFAULTS = Object.freeze({
  normalizeColor: true,
  suppressHair: true,
  allowScale: false,
  maxAngle: 25,
  flickerIntervalMs: 600,
});

export const LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  minDimension: 16,
  maxDimension: 4096,
  maxWorkingDimension: 1024,
  maxDecodedPixels: 16 * 1024 * 1024,
  minAngle: 0,
  maxAngle: 90,
  minScale: 0.85,
  maxScale: 1.15,
  minFlickerMs: 150,
  maxFlickerMs: 3000,
});

export const TRANSFORM_CONVENTION = "Baseline pixel (x, y) maps to follow-up sampling coordinates u = cxF + scale*(cos(angleDeg)*(x - cxB) - sin(angleDeg)*(y - cyB)) + dx, v = cyF + scale*(sin(angleDeg)*(x - cxB) + cos(angleDeg)*(y - cyB)) + dy; angleDeg is clockwise in image coordinates (+x right, +y down) and dx/dy are sampling offsets in baseline pixels at unit scale.";

export const DESCRIPTIVE_THRESHOLDS = Object.freeze({
  areaChangePct: 15,
  lesionP95DeltaE: 10,
  note: "Descriptive review thresholds only, not standalone clinical diagnostic criteria.",
});

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "SettingsError";
    this.field = field;
  }
}

export function readSettings(raw = {}) {
  const normalizeColor = raw.normalizeColor === undefined ? DEFAULTS.normalizeColor : Boolean(raw.normalizeColor);
  const suppressHair = raw.suppressHair === undefined ? DEFAULTS.suppressHair : Boolean(raw.suppressHair);
  const allowScale = raw.allowScale === undefined ? DEFAULTS.allowScale : Boolean(raw.allowScale);
  const angleRaw = raw.maxAngle === undefined || raw.maxAngle === "" ? DEFAULTS.maxAngle : Number(raw.maxAngle);
  if (!Number.isFinite(angleRaw) || angleRaw < LIMITS.minAngle || angleRaw > LIMITS.maxAngle) {
    throw new SettingsError("maxAngle", `Max rotation must be between ${LIMITS.minAngle}° and ${LIMITS.maxAngle}°.`);
  }
  return {
    normalizeColor,
    suppressHair,
    allowScale,
    maxAngle: angleRaw,
  };
}

export function clampFlickerInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULTS.flickerIntervalMs;
  return Math.round(Math.min(LIMITS.maxFlickerMs, Math.max(LIMITS.minFlickerMs, parsed)));
}

export function buildProvenance({ baseline, followup, settings, preprocessing = null, registration, metrics, elapsedSeconds }) {
  const scaleFitted = Boolean(settings?.allowScale);
  return {
    app: APP.id,
    version: APP.version,
    method: "Sequential digital dermoscopy multi-scale NCC alignment and CIEDE2000 change quantification",
    references: [
      "Kittler et al. (2000) J Am Acad Dermatol 43(3):467-476",
      "Kittler et al. (2006) Arch Dermatol 142(9):1113-1119",
      "Korotkov & Garcia (2012) Artif Intell Med 56(2):69-90",
      "Sharma, Wu & Dalal (2005) Color Res Appl 30(1):21-30",
      "Lee et al. (1997) Comput Biol Med 27(6):533-543",
      "Finlayson & Trezzi (2004) Color Imaging Conf 12(1):37-41",
      "Otsu (1979) IEEE Trans Syst Man Cybern 9(1):62-66",
    ],
    inputs: {
      baseline: {
        name: baseline.name,
        width: baseline.width,
        height: baseline.height,
        ...(baseline.originalWidth ? { originalWidth: baseline.originalWidth, originalHeight: baseline.originalHeight } : {}),
      },
      followup: {
        name: followup.name,
        width: followup.width,
        height: followup.height,
        ...(followup.originalWidth ? { originalWidth: followup.originalWidth, originalHeight: followup.originalHeight } : {}),
      },
    },
    parameters: { ...settings },
    preprocessing: preprocessing ? { ...preprocessing } : null,
    transformConvention: TRANSFORM_CONVENTION,
    registration: {
      registered: registration.registered !== false,
      reason: registration.reason ?? null,
      initialNcc: registration.initialNcc,
      alignedNcc: registration.alignedNcc,
      dx: registration.dx,
      dy: registration.dy,
      angleDeg: registration.angleDeg,
      scale: registration.scale,
      overlapPct: registration.overlapPct,
    },
    metrics: metrics ? { ...metrics } : null,
    growthInterpretationNote: scaleFitted
      ? "Similarity scaling was enabled; fitted magnification can absorb true lesion growth, so physical growth is indeterminate and area/Dice metrics reflect post-alignment shape agreement only."
      : (metrics?.clippedByFov
        ? "One or both segmented lesion masks touch the common valid FOV boundary; area and centroid measurements may be truncated."
        : null),
    descriptiveThresholds: DESCRIPTIVE_THRESHOLDS,
    elapsedSeconds: Number.isFinite(elapsedSeconds) ? Number(elapsedSeconds.toFixed(3)) : null,
  };
}
