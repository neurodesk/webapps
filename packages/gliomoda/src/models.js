import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };

// One graph per sequence combination GlioMODA ships, each with the nnU-Net plan it was trained on.
export const MODELS = Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset, url: manifest.base_url + asset.filename })));

export function modelById(id) {
  const model = MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`GlioMODA has no model for ${id}.`);
  return model;
}
