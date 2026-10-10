import manifest from '../model.manifest.json' with { type: 'json' };
export const MODEL_ASSETS = Object.freeze(
  manifest.assets.map((asset) =>
    Object.freeze({ ...asset, url: manifest.base_url + asset.filename })
  )
);
export const MODELS = Object.freeze({
  manual: 'vesselboost.onnx',
  omelette1: 'vesselboost-omelette1.onnx',
  omelette2: 'vesselboost-omelette2.onnx',
  t2s: 'vesselboost-t2s.onnx',
});
export function modelAsset(name) {
  const asset = MODEL_ASSETS.find((asset) => asset.filename === name);
  if (!asset) throw new Error(`Unknown VesselBoost model: ${name}`);
  return asset;
}
