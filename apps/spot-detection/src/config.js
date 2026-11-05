// DOM-independent settings, names and provenance, unit-tested under Node.
import automation from "../automation.json" with { type: "json" };

export const APP = Object.freeze({
  id: "spot-detection",
  title: automation.title,
});

// Big-FISH tutorial values for its example (experiment_1, 100x objective).
export const DEFAULTS = Object.freeze({ voxelZ: 300, voxelYx: 103, radiusZ: 350, radiusYx: 150 });

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number of nanometres.`);
  return number;
}

// Form or automation parameters → the settings analyse() takes. Lengths are (z, y, x) in nm.
export function detectionSettings(parameters = {}) {
  const voxelZ = positive(parameters.voxelZ ?? DEFAULTS.voxelZ, "Voxel size z");
  const voxelYx = positive(parameters.voxelYx ?? DEFAULTS.voxelYx, "Voxel size yx");
  const radiusZ = positive(parameters.radiusZ ?? DEFAULTS.radiusZ, "Spot radius z");
  const radiusYx = positive(parameters.radiusYx ?? DEFAULTS.radiusYx, "Spot radius yx");
  const raw = parameters.threshold;
  let threshold = null;
  if (raw !== undefined && raw !== null && raw !== "" && !Number.isNaN(raw)) {
    threshold = Number(raw);
    if (!Number.isFinite(threshold) || threshold < 0) throw new Error("The threshold must be a nonnegative LoG response, or empty for automatic.");
  }
  return {
    voxelSize: [voxelZ, voxelYx, voxelYx],
    spotRadius: [radiusZ, radiusYx, radiusYx],
    threshold,
    projection: parameters.projection === true || parameters.projection === "projection",
    subpixel: parameters.subpixel !== false,
  };
}

const stem = (name) => name.replace(/\.(ome\.)?tiff?$/i, "").replace(/\.nii(\.gz)?$/i, "");

export function outputNames(inputName, projection) {
  const base = `${stem(inputName)}${projection ? "_mip" : ""}`;
  return { spots: `${base}_spots.csv`, cells: `${base}_cell_counts.csv`, overlay: `${base}_spots.nii.gz` };
}

export function describeImage(name, shape, dtype) {
  return `${name} · ${shape.join(" × ")} · ${dtype}`;
}

export function provenance({ input, labels, settings, result }) {
  return {
    method: "Big-FISH 0.6.2 detect_spots + fit_subpixel (JavaScript port)",
    input,
    labels: labels ?? null,
    voxelSizeNm: settings.voxelSize.slice(-result.image.shape.length),
    spotRadiusNm: settings.spotRadius.slice(-result.image.shape.length),
    detectedIn: result.image.shape.length === 3 ? "3D stack" : settings.projection ? "2D maximum projection" : "2D image",
    logSigmaPx: result.sigma.map((s) => Number(s.toFixed(6))),
    threshold: result.threshold,
    automaticThreshold: settings.threshold === null,
    spots: result.spots.length,
    subpixel: settings.subpixel,
    cells: result.cells?.cells.length ?? null,
  };
}
