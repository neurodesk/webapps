// The web app's downloads, keyed by automation artifact role: the registration output each
// holds and its suffix after the moving image's name. The command line writes the same files.
export const ARTIFACTS = Object.freeze({
  registered: { source: 'warped', suffix: '_registered.nii.gz' },
  affine: { source: '0GenericAffine.mat', suffix: '_0GenericAffine.mat' },
  warp: { source: '1Warp.nii.gz', suffix: '_1Warp.nii.gz' },
  'inverse-warp': { source: '1InverseWarp.nii.gz', suffix: '_1InverseWarp.nii.gz' },
});

export function artifactName(movingName, role) {
  return movingName.replace(/\.nii(\.gz)?$/i, '') + ARTIFACTS[role].suffix;
}

// The second argument is register()'s result: the warped image and the transforms by ANTs' names.
export function artifactFiles(movingName, { warped, transforms }) {
  const outputs = { warped, ...transforms };
  return Object.entries(ARTIFACTS).map(([role, { source }]) => ({ role, name: artifactName(movingName, role), bytes: outputs[source] }));
}
