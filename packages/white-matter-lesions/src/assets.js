import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };

// The five FLAMeS folds; fold 0 alone is the default, all five are the published ensemble.
export const FLAMES_FOLDS = Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset, url: manifest.base_url + asset.filename })));

// SYNcro's published browser SynthStrip graph (models/syncro.manifest.json), shared by every app that strips the skull.
export const SYNTHSTRIP = Object.freeze({
  filename: 'synthstrip-browser.onnx',
  bytes: 10296357,
  sha256: 'dc9e11999b58d7949d77ddf1b2ed2910df66f8725c078a6b46ae08b8ebcc2800',
  license: 'Apache-2.0',
  url: 'https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/e0a056b3d6b2b075bab5b780281af17fc9d6421d/syncro/synthstrip-browser.onnx',
});

export const ENSEMBLE_SIZES = Object.freeze([1, FLAMES_FOLDS.length]);
