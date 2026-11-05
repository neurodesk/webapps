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

// The form's voxel sizes from a TIFF's metadata (ImageJ or OME, in nm), rounded as the form
// shows them; an axis the file does not record is left out.
export function voxelFromFile(voxelSize) {
  const round = (value) => (value ? Number(value.toFixed(3)) : undefined);
  const out = {};
  const z = round(voxelSize?.z);
  const yx = round(voxelSize?.x ?? voxelSize?.y);
  if (z !== undefined) out.voxelZ = z;
  if (yx !== undefined) out.voxelYx = yx;
  return out;
}

// Estimated bytes the analysis holds per input voxel, by input type: the page's input and its
// display copy, the worker's clone, the float image and the two LoG buffers (float32 for uint8
// and float32 input, float64 otherwise), the filtered image cast back to an integer type, two
// local-maximum buffers of the filtered image's type, three byte masks and, for float images,
// the float64 copy sorted for the threshold percentile.
export const WORKING_BYTES = Object.freeze({ uint8: 21, uint16: 39, float32: 39, float64: 67 });
// The working memory a run may need: 4 GiB, what 64-bit Chromium gives one tab's arrays.
export const MEMORY_BUDGET = 4 * 1024 ** 3;

// Refuses a run that cannot finish, before the worker starts: an image too large for the
// memory budget, or 3D cell labels with detection in the 2D maximum projection.
export function checkRun(image, settings, labels = null) {
  if (labels?.shape.length === 3 && image.shape.length === 3 && settings.projection) {
    throw new Error("3D cell labels cannot count spots found in the 2D maximum projection; detect in the 3D stack, or load one y × x label plane.");
  }
  const voxels = image.shape.reduce((a, b) => a * b, 1);
  const bytes = voxels * WORKING_BYTES[image.dtype];
  if (bytes > MEMORY_BUDGET) {
    const gb = (n) => (n / 1024 ** 3).toFixed(1);
    throw new Error(`This ${image.shape.join(" × ")} ${image.dtype} image needs about ${gb(bytes)} GB of working memory, above the ${gb(MEMORY_BUDGET)} GB limit; crop it or keep fewer planes.`);
  }
}

// A threshold as the results and the log show it: integers whole, others to 4 significant digits.
export function formatThreshold(threshold) {
  return Number.isInteger(threshold) ? String(threshold) : String(Number(threshold.toPrecision(4)));
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
