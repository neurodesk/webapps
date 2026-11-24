import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };

export const TUMOUR_TYPES = Object.freeze([
  Object.freeze({ id: 'glioblastoma', label: 'Glioblastoma (T1c)', resectability: true }),
  Object.freeze({ id: 'meningioma', label: 'Meningioma (T1c)', resectability: false }),
  Object.freeze({ id: 'metastasis', label: 'Brain metastasis (T1c)', resectability: false }),
]);

export const ASSETS = Object.freeze(
  manifest.assets.map((asset) => Object.freeze({
    ...asset,
    url: asset.url ?? (manifest.base_url ? manifest.base_url + asset.filename : null),
  })),
);

export function assetById(id) {
  const entry = ASSETS.find((asset) => asset.id === id);
  if (!entry) throw new Error(`Tumour Report has no asset for ${id}.`);
  return entry;
}
