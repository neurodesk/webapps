import manifest from "../model.manifest.json" with { type: "json" };

export const MODEL_ASSETS = manifest.assets;
export const LEGACY_MODEL_ASSETS = MODEL_ASSETS.filter(
  (asset) => asset.pipeline === "legacy-v1",
);
export const MODEL_SEEDS = LEGACY_MODEL_ASSETS.map((asset) => asset.seed);
export const FOLDS = ["0", "1", "2", "3", "4"];
export const NNUNET = manifest.nnunet;
export const INFERENCE_DEFAULTS = Object.freeze({
  pipeline: "nnunet-v2",
  folds: ["0"],
  model: "web",
  mirror: false,
  threshold: 0.1,
  nMarkers: 3,
});

export function resolveModels(
  selected,
  { pipeline = "nnunet-v2", model = "web" } = {},
) {
  if (!["nnunet-v2", "legacy-v1"].includes(pipeline))
    throw new Error(`Unknown SeedSeg pipeline "${pipeline}".`);
  if (!["web", "fp32"].includes(model))
    throw new Error(`Unknown SeedSeg model variant "${model}".`);
  const legacy = pipeline === "legacy-v1";
  const available = legacy
    ? LEGACY_MODEL_ASSETS
    : MODEL_ASSETS.filter(
        (asset) => asset.pipeline === pipeline && asset.model === model,
      );
  const values = selected ?? (legacy ? MODEL_SEEDS : INFERENCE_DEFAULTS.folds);
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > available.length
  ) {
    throw new Error(
      `Select one to ${available.length} distinct SeedSeg ${legacy ? "models" : "folds"}.`,
    );
  }
  const ids = values.map((value) => {
    const asset = available.find((asset) =>
      [
        asset.id,
        asset.filename,
        String(legacy ? asset.seed : asset.fold),
      ].includes(String(value)),
    );
    if (!asset)
      throw new Error(
        `Unknown SeedSeg ${legacy ? "model" : "fold"} "${value}".`,
      );
    return asset.id;
  });
  if (new Set(ids).size !== ids.length)
    throw new Error("Select distinct SeedSeg models or folds.");
  return available.filter((asset) => ids.includes(asset.id));
}

export function validateSelection({
  threshold = 0.1,
  nMarkers = 3,
  mirror = false,
} = {}) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Threshold must be a finite number in [0, 1].");
  }
  if (!Number.isInteger(nMarkers) || nMarkers < 1 || nMarkers > 10) {
    throw new Error("Top-N markers must be an integer from 1 to 10.");
  }
  if (typeof mirror !== "boolean")
    throw new Error("Mirroring must be a boolean.");
}

/**
 * Which model a request runs. v1 checkpoint selections (`models`, `ensemble`) without a `model`
 * keep their meaning from before v2 existed and run the legacy v1 consensus; without either, v2
 * runs. Mixing v1 selections with v2 (explicit `model: 'v2'`, `folds` or `mirror`) is an error.
 */
export function resolveModelChoice({
  pipeline,
  model,
  folds,
  mirror = false,
  models,
  ensemble,
} = {}) {
  if (pipeline !== undefined && !["nnunet-v2", "legacy-v1"].includes(pipeline))
    throw new Error(`Unknown SeedSeg pipeline "${pipeline}".`);
  if (model !== undefined && !["v2", "v1", "web", "fp32"].includes(model))
    throw new Error(`Unknown SeedSeg model "${model}".`);
  const alias = ["v1", "v2"].includes(model) ? model : undefined;
  const explicit =
    pipeline === undefined ? alias : pipeline === "legacy-v1" ? "v1" : "v2";
  if (alias !== undefined && explicit !== alias)
    throw new Error(
      "The model alias and pipeline must select the same method.",
    );
  const legacySelection = models !== undefined || ensemble !== undefined;
  const networkSelection =
    folds !== undefined || mirror === true || model === "fp32";
  if (legacySelection && networkSelection) {
    throw new Error(
      "models/ensemble select v1 checkpoints and folds/mirror select v2 networks; choose one model.",
    );
  }
  const chosen = explicit ?? (legacySelection ? "v1" : "v2");
  if (chosen === "v2" && legacySelection)
    throw new Error(
      "models/ensemble select v1 checkpoints; use folds with model v2.",
    );
  if (chosen === "v1" && networkSelection)
    throw new Error(
      "folds and mirror apply to v2; use models or ensemble with model v1.",
    );
  return chosen;
}
