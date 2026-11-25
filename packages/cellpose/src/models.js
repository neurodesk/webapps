// Pretrained Cellpose 3 model definitions built from model.manifest.json.
import manifest from "../model.manifest.json" with { type: "json" };

export { manifest };

const assetsByName = new Map(manifest.assets.map((asset) => [asset.filename, asset]));

function buildModel(spec) {
  const asset = assetsByName.get(spec.filename);
  return Object.freeze({
    name: spec.name,
    label: spec.label,
    diamMean: spec.diam_mean,
    channels: spec.channels,
    supportsNuclearChannel: Boolean(spec.supports_nuclear_channel),
    filename: spec.filename,
    url: asset.url ?? manifest.base_url + asset.filename,
    bytes: asset.bytes,
    sha256: asset.sha256,
    input: spec.input,
    outputs: Object.freeze([...spec.outputs]),
    bsize: spec.bsize,
    tileOverlap: spec.tile_overlap,
    divBy: spec.div_by,
    extraPad: spec.extra_pad,
    defaults: Object.freeze({
      diameter: spec.defaults.diameter,
      flowThresh: spec.defaults.flow_threshold,
      cellprobThresh: spec.defaults.cellprob_threshold,
      minSize: spec.defaults.min_size,
      maxSizeFraction: spec.defaults.max_size_fraction,
    }),
    normalization: Object.freeze({ ...spec.normalization }),
  });
}

export const MODEL_IDS = Object.freeze(Object.keys(manifest.models));

export const MODELS = Object.freeze(
  Object.fromEntries(MODEL_IDS.map((id) => [id, buildModel(manifest.models[id])])),
);

export const DEFAULT_MODEL_ID = manifest.default_model;

/** The default pinned Cellpose model (`cyto3`). */
export const MODEL = MODELS[DEFAULT_MODEL_ID];

/** All pinned ONNX model assets declared in model.manifest.json. */
export const MODEL_ASSETS = Object.freeze(
  manifest.assets.map((asset) => Object.freeze({
    filename: asset.filename,
    url: asset.url ?? manifest.base_url + asset.filename,
    bytes: asset.bytes,
    sha256: asset.sha256,
  })),
);

/** Resolve a model id (or undefined for the default), throwing on an unknown id. */
export function resolveModel(id = DEFAULT_MODEL_ID) {
  const key = id || DEFAULT_MODEL_ID;
  const model = MODELS[key];
  if (!model) throw new Error(`Unknown Cellpose model "${id}". Choose one of: ${MODEL_IDS.join(", ")}.`);
  return model;
}
