// DOM-independent settings: validation of the form, per-example settings and output names.
import automation from "../automation.json" with { type: "json" };
import { parseOrientation } from "./space.js";
import { DEFAULT_SETTINGS, deriveSettings } from "./detect.js";

export const APP = Object.freeze({
  id: "lightsheet-atlas",
  title: automation.title,
});

/** What each example needs that its file does not say: orientation and which steps make sense. */
export const EXAMPLE_SETTINGS = Object.freeze({
  "brainreg-test-brain": { orientation: "psl", register: true, detect: false },
  "cellfinder-crop": { orientation: "asr", register: false, detect: true },
});

export const DETECTION_FIELDS = Object.freeze({
  somaDiameterUm: DEFAULT_SETTINGS.somaDiameterUm,
  ballXyUm: DEFAULT_SETTINGS.ballXyUm,
  ballZUm: DEFAULT_SETTINGS.ballZUm,
  ballOverlapFraction: DEFAULT_SETTINGS.ballOverlapFraction,
  nSdsAboveMeanThresh: DEFAULT_SETTINGS.nSdsAboveMeanThresh,
});

const positive = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be a positive number.`);
  return number;
};

/**
 * The run settings from form values; throws a RangeError naming the field that is wrong.
 * `field` on the error is the form field to reveal.
 */
export function runSettings({ voxelSizeUm, orientation, register, detect, detection = {} }) {
  const fail = (message, field) => Object.assign(new RangeError(message), { field });
  if (!register && !detect) throw fail("Choose atlas registration, cell detection or both.", "register");
  let voxel;
  try {
    voxel = ["Plane spacing (z)", "Row spacing (y)", "Column spacing (x)"].map((name, i) => positive(voxelSizeUm[i], name));
  } catch (error) {
    throw fail(error.message, "voxelZ");
  }
  try {
    parseOrientation(orientation);
  } catch (error) {
    throw fail(error.message, "orientation");
  }
  const options = {};
  for (const [key, fallback] of Object.entries(DETECTION_FIELDS)) {
    const value = detection[key] ?? fallback;
    try {
      options[key] = positive(value, key);
    } catch (error) {
      throw fail(error.message, key);
    }
  }
  if (options.ballOverlapFraction > 1) throw fail("The ball overlap fraction must be at most 1.", "ballOverlapFraction");
  if (detect) {
    try {
      deriveSettings(voxel, options);
    } catch (error) {
      throw fail(error.message, "detect");
    }
  }
  return { voxelSizeUm: voxel, orientation: orientation.trim().toLowerCase(), register: Boolean(register), detect: Boolean(detect), detection: options };
}

/** Output file names from the input name. */
export function outputNames(inputName) {
  const stem = String(inputName || "sample").replace(/\.ome\.(tiff?|zarr)$/i, "").replace(/\.(tiff?|zarr)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_");
  return {
    sample: `${stem}_atlas-grid.nii.gz`,
    registeredAtlas: `${stem}_registered-atlas.nii.gz`,
    marks: `${stem}_cells.nii.gz`,
    cells: `${stem}_cells.csv`,
    regions: `${stem}_regions.csv`,
  };
}
