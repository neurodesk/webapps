import { writeVolume } from '@neurodesk/synthsr';
import { labelLesions, lesionTable, threshold } from './pipeline.js';

export function outputNames(inputName) {
  const stem = inputName.replace(/\.nii(\.gz)?$/i, '');
  return {
    mask: `${stem}_lesions.nii`,
    probability: `${stem}_lesion_probability.nii`,
    table: `${stem}_lesions.tsv`,
  };
}

// The three downloads of one segmentation, on the input grid and affine.
export function lesionResults(volume, probability) {
  const lesionMask = threshold(probability);
  const { lesions } = labelLesions(lesionMask, volume.dims);
  const table = lesionTable(lesions, volume.affine);
  const geometry = { dims: volume.dims, affine: volume.affine };
  return {
    mask: writeVolume({ ...geometry, data: lesionMask }, 'FLAMeS lesion mask'),
    probability: writeVolume({ ...geometry, data: probability }, 'FLAMeS lesion probability'),
    tsv: table.tsv,
    summary: { count: table.rows.length, totalMl: table.totalMl },
  };
}
