// EPI-reference N4 settings from niworkflows 1.15.3 workflows/epi/refmap.py,
// as recorded in docs/architecture/dwi-sdc-plan.md sections 2.1 and 3.
// This is independent of the MRtrix dwibiascorrect profile in index.js.

/** N4 argv for an EPI reference; request the bias output for the shared runtime's result contract. */
export function epiReferenceArguments({ input, weight, corrected, bias }) {
  if (weight) throw new Error('EPI-reference N4 does not use a weight image.');
  return [
    '-d', '3',
    '-i', input,
    '-o', `[${corrected},${bias}]`,
    '--convergence', '[50x50x50x50x50,1e-07]',
    '--shrink-factor', '4',
  ];
}
