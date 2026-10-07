// Output naming, CT detection and the label artifact, shared by the web app and the synthseg command line
// so both write the same downloads from the same decisions.
export const outputStem = (name) => name.replace(/\.nii(\.gz)?$/i, '');

/** The web app's two downloads for one input: the label map and its run report. */
export function outputNames(inputName) {
  const stem = outputStem(inputName);
  return { labels: `${stem}_synthseg.nii.gz`, report: `${stem}_synthseg.json` };
}

// SynthSeg's CT path expects Hounsfield units; only CT scans store negatives.
export const looksLikeCt = (voxels) => voxels.some((value) => value < 0);

export const LABELS_ARTIFACT = Object.freeze({
  type: 'neuro:label-map',
  mediaType: 'application/gzip',
  space: 'subject-1mm',
  labelSystem: 'FreeSurfer',
});
