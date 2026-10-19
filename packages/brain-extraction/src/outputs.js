import { writeVolume } from '@neurodesk/synthsr';

// The names the web app downloads a run's brain image and mask under. A no-CSF SynthStrip run
// is named apart, so its mask can sit beside the one that includes CSF.
export function outputNames(inputName, method, { noCsf = false } = {}) {
  const stem = inputName.replace(/\.nii(\.gz)?$/i, '');
  const label = noCsf ? `${method}-nocsf` : method;
  return { brain: `${stem}_${label}_brain.nii`, mask: `${stem}_${label}_mask.nii` };
}

// The NIfTI bytes of a run's brain image and mask, as the web app downloads them.
export function writeOutputs(result) {
  return { brain: writeVolume(result.brain, 'Brain extraction'), mask: writeVolume(result.mask, 'Brain mask') };
}
