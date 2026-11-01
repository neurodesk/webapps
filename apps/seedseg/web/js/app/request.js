import {
  INFERENCE_DEFAULTS,
  MODEL_SEEDS,
  resolveModelChoice,
} from "../../vendor/seedseg/src/assets.js";

// Maps a `segment` automation request onto a model and its selection. A request that names v1
// checkpoints (`models`) without a `model`, as every request did before v2, still runs v1.
export function segmentRequest(request = {}) {
  const legacy = resolveModelChoice(request) === "v1";
  return {
    pipeline: legacy ? "legacy-v1" : "nnunet-v2",
    model: ["web", "fp32"].includes(request.model) ? request.model : "web",
    models: legacy ? (request.models ?? MODEL_SEEDS) : [],
    folds: legacy
      ? []
      : (request.folds ?? INFERENCE_DEFAULTS.folds.map(Number)),
    mirror: legacy ? false : (request.mirror ?? false),
  };
}
