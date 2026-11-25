// DOM-independent app config and settings validation. Kept pure so it can be
// unit-tested under Node without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "wound-planimetry",
  title: automation.title,
  version: packageJson.version,
});

// Cap decoded images at 16 megapixels (64 MB RGBA) so colour-space buffers and
// worker PNG encoding stay within comfortable browser memory limits.
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_BYTES = MAX_IMAGE_PIXELS * 4;

export const DEFAULTS = Object.freeze({
  pixelsPerMm: 0,
  referenceMm: 10,
  sensitivity: 0,
  escharL: 28,
  granulationA: 22,
  sloughB: 18,
});

export const PARAMETER_BOUNDS = Object.freeze({
  pixelsPerMm: Object.freeze({ min: 0, max: 1000 }),
  referenceMm: Object.freeze({ min: 0.1, max: 500 }),
  sensitivity: Object.freeze({ min: -0.3, max: 0.3 }),
  escharL: Object.freeze({ min: 0, max: 60 }),
  granulationA: Object.freeze({ min: 0, max: 80 }),
  sloughB: Object.freeze({ min: 0, max: 80 }),
});

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "SettingsError";
    this.field = field;
  }
}

function readBoundedNumber(raw, field, label) {
  const value = raw === "" || raw === undefined || raw === null ? DEFAULTS[field] : Number(raw);
  const { min, max } = PARAMETER_BOUNDS[field];
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new SettingsError(field, `${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function readSettings(values = {}) {
  return Object.freeze({
    pixelsPerMm: readBoundedNumber(values.pixelsPerMm, "pixelsPerMm", "Scale (px/mm)"),
    sensitivity: readBoundedNumber(values.sensitivity, "sensitivity", "Sensitivity"),
    escharL: readBoundedNumber(values.escharL, "escharL", "Eschar L* max"),
    granulationA: readBoundedNumber(values.granulationA, "granulationA", "Granulation a* min"),
    sloughB: readBoundedNumber(values.sloughB, "sloughB", "Slough b* min"),
  });
}

export function readReferenceMm(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    const { min, max } = PARAMETER_BOUNDS.referenceMm;
    throw new SettingsError("referenceMm", `Ruler reference (mm) must be between ${min} and ${max}.`);
  }
  return readBoundedNumber(raw, "referenceMm", "Ruler reference (mm)");
}
