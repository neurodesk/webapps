import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };

// The five FLAMeS folds; fold 0 alone is the default, all five are the published ensemble.
export const FLAMES_FOLDS = Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset, url: manifest.base_url + asset.filename })));

export { SYNTHSTRIP_MODEL as SYNTHSTRIP } from '@neurodesk/synthstrip/model';

export const ENSEMBLE_SIZES = Object.freeze([1, FLAMES_FOLDS.length]);
