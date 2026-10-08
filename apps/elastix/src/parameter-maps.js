// Elastix parameter objects: the preset stage chains, user parameter files, and
// the TransformParameters files written for download. Pure apart from the
// injected ITK-Wasm calls, so Node tests drive it with fakes.

export const PRESETS = Object.freeze({
  rigid: Object.freeze(["translation", "rigid"]),
  affine: Object.freeze(["translation", "rigid", "affine"]),
  bspline: Object.freeze(["translation", "rigid", "affine", "bspline"]),
});

export const METHOD_LABELS = Object.freeze({
  rigid: "Rigid",
  affine: "Affine",
  bspline: "Affine + B-spline",
});

/** Validated preset settings: 1–6 resolutions and a positive B-spline grid spacing. */
export function presetSettings({ method = "affine", resolutions = 3, gridSpacing = 10 } = {}) {
  if (!PRESETS[method]) throw new Error(`Unknown registration method: ${method}`);
  const numberOfResolutions = Number(resolutions);
  if (!Number.isInteger(numberOfResolutions) || numberOfResolutions < 1 || numberOfResolutions > 6) {
    throw new Error("Resolutions must be a whole number from 1 to 6.");
  }
  const finalGridSpacing = Number(gridSpacing);
  if (!Number.isFinite(finalGridSpacing) || finalGridSpacing <= 0) {
    throw new Error("B-spline grid spacing must be a positive number.");
  }
  return { method, stages: PRESETS[method], numberOfResolutions, finalGridSpacing };
}

/**
 * One elastix default parameter map per preset stage, in order. All calls
 * share `webWorker`; the worker that ran them is returned for reuse.
 */
export async function buildParameterObject(settings, { defaultParameterMap, webWorker }) {
  const { stages, numberOfResolutions, finalGridSpacing } = presetSettings(settings);
  const parameterObject = [];
  let worker = webWorker;
  for (const stage of stages) {
    const result = await defaultParameterMap(stage, { numberOfResolutions, finalGridSpacing, webWorker: worker });
    worker = result.webWorker;
    parameterObject.push(result.parameterMap);
  }
  return { parameterObject, webWorker: worker };
}

/** The transform each map of a parameter object estimates, for logs and provenance. */
export function stageNames(parameterObject) {
  return parameterObject.map((map) => map.Transform?.[0] ?? "unknown");
}

/** Parameter files are read in the order chosen; sort by name so TransformParameters.0 precedes .1. */
export function sortParameterFiles(files) {
  return Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Download names for a run's TransformParameters files. */
export function parameterFileNames(stem, count) {
  return Array.from({ length: count }, (_, index) => `${stem}_TransformParameters.${index}.txt`);
}

/**
 * Copies of the optimized maps with each one naming its predecessor as
 * InitialTransformParameterFileName, so transformix given the last file
 * applies every stage, as elastix's own output folder does.
 */
export function chainParameterFiles(transformParameterObject, stem) {
  const names = parameterFileNames(stem, transformParameterObject.length);
  const maps = transformParameterObject.map((map, index) => ({
    ...map,
    InitialTransformParameterFileName: [index === 0 ? "NoInitialTransform" : names[index - 1]],
  }));
  return { maps, names };
}
