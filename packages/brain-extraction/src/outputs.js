import { writeVolume } from '@neurodesk/synthsr';

// The names the web app downloads a run's brain image and mask under.
export function outputNames(inputName, method) {
  const stem = inputName.replace(/\.nii(\.gz)?$/i, '');
  return { brain: `${stem}_${method}_brain.nii`, mask: `${stem}_${method}_mask.nii` };
}

// The NIfTI bytes of a run's brain image and mask, as the web app downloads them.
export function writeOutputs(result) {
  return { brain: writeVolume(result.brain, 'Brain extraction'), mask: writeVolume(result.mask, 'Brain mask') };
}
