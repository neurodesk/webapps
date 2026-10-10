export function outputNames(modelCount) {
  const stages = [...Array.from({ length: modelCount }, (_, i) => `model${i + 1}`), 'avgProb', 'consensus'];
  return Object.fromEntries(stages.map(stage => [stage, `${stage}.nii`]));
}
