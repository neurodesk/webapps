// DOM-independent app configuration and parameter validation.
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "dermoscope",
  title: "Dermoscope ABCD",
  version: packageJson.version,
  maxWorkingDimension: 512,
});

export const DEFAULTS = Object.freeze({
  removeHair: true,
  colorConstancy: true,
  thresholdBias: 0,
  pixelsPerMm: 0,
  differentialStructures: null,
  hairThreshold: 18,
  vignetteThreshold: 22,
  minkowskiP: 6,
});

export const TDS_WEIGHTS = Object.freeze({
  asymmetry: 1.3,
  border: 0.1,
  color: 0.5,
  differentialStructures: 0.5,
});

export const DISCLAIMER =
  "Experimental automated morphometry only — not a clinical diagnosis. Nachbar & Stolz (1994) ABCD/TDS weights and thresholds were evaluated on clinician-scored lesions.";

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "SettingsError";
    this.field = field;
  }
}

function parseFinite(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : NaN;
}

export function readSettings(raw = {}) {
  const removeHair = raw.removeHair === undefined ? DEFAULTS.removeHair : Boolean(raw.removeHair);
  const colorConstancy =
    raw.colorConstancy === undefined ? DEFAULTS.colorConstancy : Boolean(raw.colorConstancy);

  const thresholdBias = parseFinite(raw.thresholdBias, DEFAULTS.thresholdBias);
  if (!Number.isFinite(thresholdBias) || thresholdBias < -0.3 || thresholdBias > 0.3) {
    throw new SettingsError(
      "thresholdBias",
      "Threshold bias must be a number between -0.3 and 0.3.",
    );
  }

  const pixelsPerMm = parseFinite(raw.pixelsPerMm, DEFAULTS.pixelsPerMm);
  if (!Number.isFinite(pixelsPerMm) || pixelsPerMm < 0 || pixelsPerMm > 1000) {
    throw new SettingsError(
      "pixelsPerMm",
      "Calibration must be between 0 and 1000 pixels per mm.",
    );
  }

  let differentialStructures = DEFAULTS.differentialStructures;
  const rawD = raw.differentialStructures;
  if (rawD !== undefined && rawD !== null && rawD !== "" && rawD !== 0 && rawD !== "0") {
    const parsedD = Number(rawD);
    if (!Number.isInteger(parsedD) || parsedD < 1 || parsedD > 5) {
      throw new SettingsError(
        "differentialStructures",
        "Differential structures (D) must be 0 (not scored) or an integer from 1 to 5.",
      );
    }
    differentialStructures = parsedD;
  }

  return Object.freeze({
    removeHair,
    colorConstancy,
    thresholdBias,
    pixelsPerMm,
    differentialStructures,
  });
}
