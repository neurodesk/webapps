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

// Written only when the input was finer than the FLAMeS grid, so not one of outputNames.
export function resampledFlairName(inputName) {
  return `${inputName.replace(/\.nii(\.gz)?$/i, '')}_flair_resampled.nii`;
}

// The downloads of one segmentation, on the grid it ran on. When the input was resampled to the
// FLAMeS grid, that FLAIR is one of them, so the mask can be checked and edited over it.
// `lesions` are the table's rows, largest first, for the viewer to step through.
export function lesionResults(volume, probability, { resampled = false } = {}) {
  const lesionMask = threshold(probability);
  const { lesions } = labelLesions(lesionMask, volume.dims);
  const table = lesionTable(lesions, volume.affine);
  const geometry = { dims: volume.dims, affine: volume.affine };
  return {
    mask: writeVolume({ ...geometry, data: lesionMask }, 'FLAMeS lesion mask'),
    probability: writeVolume({ ...geometry, data: probability }, 'FLAMeS lesion probability'),
    tsv: table.tsv,
    resampledFlair: resampled ? writeVolume(volume, 'FLAIR resampled to the FLAMeS grid') : null,
    summary: { count: table.rows.length, totalMl: table.totalMl },
    lesions: lesionList(table.rows),
  };
}

export function lesionList(rows) {
  return rows.map(({ ml, world }) => ({ ml, world }));
}
