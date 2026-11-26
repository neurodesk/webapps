// Model manifest reader for @neurodesk/instanseg.
import manifest from '../model.manifest.json' with { type: 'json' };
import { BRIGHTFIELD_PIXEL_CLASSIFIER, DEFAULTS } from './pipeline.js';

export const DEFAULT_MODEL_ID = 'brightfield_nuclei';

export const MODELS = Object.freeze(
  manifest.assets.map((asset) => Object.freeze({
    ...asset,
    url: `${manifest.base_url}${asset.filename}`,
    defaults: Object.freeze({ ...DEFAULTS, ...(asset.defaults || {}) }),
    pixelClassifier: BRIGHTFIELD_PIXEL_CLASSIFIER,
  })),
);

export const MODEL_IDS = Object.freeze(MODELS.map(({ id }) => id));

export function modelById(id = DEFAULT_MODEL_ID) {
  const model = MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`Unknown InstanSeg model: ${id}`);
  return model;
}
