// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import manifest from "../../../models/stardist.manifest.json" with { type: "json" };
import rays3dDemo from "./rays-3d-demo.json" with { type: "json" };

export const APP = Object.freeze({
  id: "stardist",
  title: automation.title,
  version: packageJson.version,
});

const assetsByName = new Map(manifest.assets.map((asset) => [asset.filename, asset]));

function buildModel(spec) {
  const asset = assetsByName.get(spec.filename);
  const model = {
    name: spec.name,
    label: spec.label,
    ndim: spec.ndim,
    channels: spec.channels,
    axes: spec.axes,
    url: asset.url ?? manifest.base_url + asset.filename,
    bytes: asset.bytes,
    sha256: asset.sha256,
    input: spec.input,
    nRays: spec.n_rays,
    grid: Object.freeze([...spec.grid]),
    divBy: Object.freeze([...spec.div_by]),
    tileOverlap: Object.freeze([...spec.tile_overlap]),
    thresholds: Object.freeze({ ...spec.thresholds }),
    normalization: Object.freeze({ ...spec.normalization }),
  };
  if (spec.ndim === 3) {
    model.anisotropy = Object.freeze([...spec.anisotropy]);
    model.rays = Object.freeze({
      name: rays3dDemo.name,
      vertices: rays3dDemo.vertices,
      faces: rays3dDemo.faces,
    });
  }
  return Object.freeze(model);
}

export const MODEL_IDS = Object.freeze(Object.keys(manifest.models));

export const MODELS = Object.freeze(
  Object.fromEntries(MODEL_IDS.map((id) => [id, buildModel(manifest.models[id])])),
);

export const DEFAULT_MODEL_ID = manifest.default_model;

/** The default pinned StarDist model (`2D_versatile_fluo`). */
export const MODEL = MODELS[DEFAULT_MODEL_ID];

/** Resolve a model id (or undefined for the default), throwing on an unknown id. */
export function resolveModel(id = DEFAULT_MODEL_ID) {
  const key = id || DEFAULT_MODEL_ID;
  const model = MODELS[key];
  if (!model) throw new Error(`Unknown StarDist model "${id}". Choose one of: ${MODEL_IDS.join(", ")}.`);
  return model;
}
