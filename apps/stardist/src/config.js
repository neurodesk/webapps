// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import manifest from "../../../models/stardist.manifest.json" with { type: "json" };

export const APP = Object.freeze({
  id: "stardist",
  title: automation.title,
  version: packageJson.version,
});

const asset = manifest.assets[0];

/** The pinned StarDist 2D_versatile_fluo model and the constants its Python model carries. */
export const MODEL = Object.freeze({
  name: manifest.model.name,
  url: manifest.base_url + asset.filename,
  bytes: asset.bytes,
  sha256: asset.sha256,
  input: manifest.model.input,
  nRays: manifest.model.n_rays,
  grid: manifest.model.grid,
  divBy: manifest.model.div_by,
  tileOverlap: manifest.model.tile_overlap,
  thresholds: manifest.model.thresholds,
  normalization: manifest.model.normalization,
});
