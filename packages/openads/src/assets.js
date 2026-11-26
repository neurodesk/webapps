import manifest from '../model.manifest.json' with { type: 'json' };

const ASSET_MAP = new Map(manifest.assets.map((asset) => [asset.filename, asset]));

export const MANIFEST = manifest;
export const ASSETS = manifest.assets;

export function assetByPath(filename) {
  const normalized = String(filename).replace(/^\/+/, '');
  const asset = ASSET_MAP.get(normalized);
  if (!asset) {
    throw new Error(`Unknown OpenADS asset: ${filename}`);
  }
  return asset;
}

export function assetIntegrity(filename) {
  const asset = assetByPath(filename);
  return {
    url: asset.url,
    integrity: {
      bytes: asset.bytes,
      sha256: asset.sha256,
    },
  };
}
