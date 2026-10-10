import manifest from '../model.manifest.json' with { type: 'json' };

export const MODEL_ASSETS = manifest.assets.map(asset => ({
  ...asset,
  seed: Number(asset.id.slice(4)),
  url: `${manifest.base_url}${asset.filename}`,
}));
export const MODEL_SEEDS = MODEL_ASSETS.map(asset => asset.seed);

export function resolveModels(selected = MODEL_SEEDS) {
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 4) {
    throw new Error('Select one to four distinct SeedSeg models.');
  }
  const ids = selected.map(value => {
    const asset = MODEL_ASSETS.find(asset => [asset.id, asset.filename, String(asset.seed)].includes(String(value)));
    if (!asset) throw new Error(`Unknown SeedSeg model "${value}". Choose ${MODEL_SEEDS.join(', ')}.`);
    return asset.id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Select distinct SeedSeg models.');
  // The browser's checkboxes always run in published model order.
  return MODEL_ASSETS.filter(asset => ids.includes(asset.id));
}

export function validateSelection({ threshold = 0.1, nMarkers = 3 } = {}) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('Threshold must be a finite number in [0, 1].');
  }
  if (!Number.isInteger(nMarkers) || nMarkers < 1 || nMarkers > 10) {
    throw new Error('Top-N markers must be an integer from 1 to 10.');
  }
}
