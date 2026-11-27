import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };

export const MODELS = Object.freeze(
  manifest.assets.map((asset) => Object.freeze({ ...asset, url: manifest.base_url + asset.filename })),
);

export const DEFAULT_MODEL_ID = 'deepmedic-m1';

export function modelById(id = DEFAULT_MODEL_ID) {
  const model = MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`BLAST-CT has no model for ${id}.`);
  return model;
}
