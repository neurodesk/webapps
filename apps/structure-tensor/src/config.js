// DOM-independent app config: settings, refusals and output names, unit-tested under Node.
import automation from "../automation.json" with { type: "json" };
import { axisScales } from "./tensor.js";

export const APP = Object.freeze({
  id: "structure-tensor",
  title: automation.title,
  version: "0.0.0",
});

// Every voxel holds up to nine float64 working arrays (three gradients, six tensor components).
export const MAX_VOXELS = 2 ** 23;

export const DEFAULT_SETTINGS = Object.freeze({ sigma: 1, rho: 3, minCoherency: 0.2, minEnergy: 0.01 });

const LIMITS = {
  sigma: [0.5, 20, "Gradient scale σ"],
  rho: [0.5, 50, "Window scale ρ"],
  minCoherency: [0, 1, "Minimum coherency"],
  minEnergy: [0, 1, "Minimum energy"],
};

/** Validated analysis settings; throws with the field's label when a value is out of range. */
export function analysisSettings(values = {}) {
  const settings = {};
  for (const [key, [low, high, label]] of Object.entries(LIMITS)) {
    const value = values[key] ?? DEFAULT_SETTINGS[key];
    if (!Number.isFinite(value) || value < low || value > high) throw new Error(`${label} must be between ${low} and ${high}.`);
    settings[key] = value;
  }
  return settings;
}

/** Why an image of these dimensions is too large to hold, or null. */
export function voxelRefusal(dims) {
  const voxels = dims.reduce((product, n) => product * n, 1);
  if (voxels > MAX_VOXELS) return `The image has ${voxels.toLocaleString("en")} voxels; crop or bin it to at most ${MAX_VOXELS.toLocaleString("en")}.`;
  return null;
}

/** Why an image cannot be analysed with these settings, or null. */
export function imageRefusal({ dims, spacing }, settings) {
  if (dims[0] < 8 || dims[1] < 8) return "The image must be at least 8 × 8 pixels.";
  const tooLarge = voxelRefusal(dims);
  if (tooLarge) return tooLarge;
  const is3d = dims[2] > 1;
  const scales = axisScales(settings.sigma, spacing, is3d);
  const names = ["x", "y", "z"];
  for (let axis = 0; axis < (is3d ? 3 : 2); axis++) {
    // Below one voxel the sampled derivative kernel loses gain on that axis and biases angles.
    if (scales[axis] < 1 - 1e-9) {
      const minimum = Math.ceil((spacing[axis] / spacing[0]) * 100) / 100;
      return `σ is ${scales[axis].toFixed(2)} voxels along ${names[axis]} at this voxel size; set σ to at least ${minimum}.`;
    }
  }
  return null;
}

const EXTENSIONS = /\.(ome\.tiff?|tiff?|nii\.gz|nii|png|jpe?g)$/i;

/** The input's name without its image extension. */
export function baseName(name) {
  return name.replace(EXTENSIONS, "") || "image";
}

/** The kind of image a file name holds. */
export function inputKind(name) {
  if (/\.tiff?$/i.test(name)) return "tiff";
  if (/\.nii(\.gz)?$/i.test(name)) return "nifti";
  if (/\.(png|jpe?g)$/i.test(name)) return "raster";
  return null;
}

/** The output files of one analysis, keyed by result id, with their names and descriptions. */
export function outputPlan(name, dimensions, mapFormat) {
  const base = baseName(name);
  const ext = mapFormat === "nifti" ? ".nii.gz" : ".tif";
  const plan = dimensions === 2
    ? {
      orientation: [`${base}_orientation${ext}`, "Orientation (degrees)"],
      coherency: [`${base}_coherency${ext}`, "Coherency"],
      energy: [`${base}_energy${ext}`, "Energy"],
      colour: [`${base}_hsb.png`, "Colour survey (HSB)"],
    }
    : {
      azimuth: [`${base}_azimuth${ext}`, "Azimuth (degrees)"],
      elevation: [`${base}_elevation${ext}`, "Elevation (degrees)"],
      coherency: [`${base}_coherency${ext}`, "Fibre coherency"],
      energy: [`${base}_energy${ext}`, "Energy"],
      colour: [`${base}_direction_rgb${ext}`, "Direction colour map"],
      vectors: [`${base}_fibre_vectors.nii.gz`, "Fibre direction vectors"],
    };
  return {
    ...plan,
    distribution: [`${base}_distribution.csv`, "Orientation distribution"],
    summary: [`${base}_summary.json`, "Summary"],
  };
}

/** The run summary written beside the maps. */
export function summary({ input, dims, spacing, unit, settings, dominant, distributions }) {
  const counted = Object.values(distributions)[0].total;
  return {
    app: APP.id,
    method: "structure tensor (OrientationJ method), Gaussian derivative gradients",
    input,
    dimensions: dims[2] > 1 ? 3 : 2,
    dims,
    spacing,
    unit,
    settings,
    angles: dims[2] > 1
      ? "azimuth: degrees counterclockwise from +x in the xy plane with rows pointing down; elevation: degrees from the xy plane towards +z"
      : "degrees counterclockwise from +x with rows pointing down, in (-90, 90]",
    dominant,
    countedVoxels: counted,
  };
}
