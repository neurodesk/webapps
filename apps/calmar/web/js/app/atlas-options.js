export const ATLAS_OPTION_IDS = {
  SCHAEFER400: 'schaefer400',
  YEO7: 'yeo7'
};

// Schaefer400 is the recommended atlas now that direct overlap and the
// development-fMRI lazy FC shards are available; Yeo7 remains selectable.
export const DEFAULT_ATLAS_OPTION_ID = ATLAS_OPTION_IDS.SCHAEFER400;

export const ATLAS_OPTIONS = [
  {
    id: ATLAS_OPTION_IDS.SCHAEFER400,
    displayName: 'Schaefer 400 parcels',
    overlapAtlasAssetId: 'schaefer400-7n-2mm',
    connectomeAssetId: 'schaefer400-fc-pack-development-n155-4mm',
    weightSource: 'parcel',
    affectedAtlasAssetId: 'schaefer400-7n-4mm',
    colormap: 'lnm-schaefer400',
    functionProfileAssetId: 'schaefer400-neurosynth-v7-function-profiles'
  },
  {
    id: ATLAS_OPTION_IDS.YEO7,
    displayName: 'Yeo 7 networks',
    overlapAtlasAssetId: 'yeo7-2mm',
    connectomeAssetId: 'yeo7-fc-pack',
    weightSource: 'network',
    colormap: 'lnm-yeo7',
    functionProfileAssetId: 'yeo7-neurosynth-v7-function-profiles'
  }
];

export function getAtlasOptionById(id, options = ATLAS_OPTIONS) {
  return options.find(option => option.id === id) || null;
}

export function getDefaultAtlasOption(options = ATLAS_OPTIONS) {
  return getAtlasOptionById(DEFAULT_ATLAS_OPTION_ID, options) || options[0] || null;
}
