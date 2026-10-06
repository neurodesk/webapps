// The web app's results on the shipped example, recorded in a real browser (browser-reference.json),
// and the checks that compare another run with them. e2e/app.spec.js records and asserts them;
// packages/white-matter-lesions/validation/cli-check.mjs holds the command line to them.
import { readFile } from 'node:fs/promises';
import { voxelVolumeMl } from '@neurodesk/white-matter-lesions';

export const browserReference = JSON.parse(await readFile(new URL('./browser-reference.json', import.meta.url), 'utf8'));

// mask and probability are readVolume results; lesions and totalMl are what the run reported.
export function measure({ mask, probability, lesions, totalMl }) {
  let maskVoxels = 0;
  let nonBinary = 0;
  let outOfRange = 0;
  let unthresholded = 0;
  let probabilitySum = 0;
  for (let i = 0; i < mask.data.length; i++) {
    const label = mask.data[i];
    const p = probability.data[i];
    if (label !== 0 && label !== 1) nonBinary++;
    if (!(p >= 0 && p <= 1)) outOfRange++;
    if (label !== (p > 0.5 ? 1 : 0)) unthresholded++;
    if (label === 1) maskVoxels++;
    probabilitySum += p;
  }
  const probabilityMl = Number((probabilitySum * voxelVolumeMl(probability.affine)).toFixed(2));
  return { lesions, totalMl: Number(totalMl.toFixed(2)), maskVoxels, probabilityMl, nonBinary, outOfRange, unthresholded };
}

const within = (value, expected, relative) => Math.abs(value - expected) <= relative * expected;

// [passed, line] pairs, so each caller reports them its own way.
export function compareWithBrowser(measured, folds) {
  const expected = browserReference.folds[folds];
  const { tolerance } = browserReference;
  const percent = (relative) => `${relative * 100} %`;
  return [
    [measured.nonBinary === 0, `lesion mask is binary (${measured.nonBinary} voxels outside {0, 1})`],
    [measured.outOfRange === 0, `lesion probability is finite and within [0, 1] (${measured.outOfRange} voxels outside)`],
    [measured.unthresholded === 0, `lesion mask is the probability above 0.5 (${measured.unthresholded} voxels disagree)`],
    [Math.abs(measured.lesions - expected.lesions) <= tolerance.lesions, `${measured.lesions} lesions, browser ${expected.lesions} ± ${tolerance.lesions}`],
    [within(measured.maskVoxels, expected.maskVoxels, tolerance.relative), `${measured.maskVoxels} mask voxels, browser ${expected.maskVoxels} ± ${percent(tolerance.relative)}`],
    [within(measured.totalMl, expected.totalMl, tolerance.relative), `${measured.totalMl} ml of lesions, browser ${expected.totalMl} ± ${percent(tolerance.relative)}`],
    [within(measured.probabilityMl, expected.probabilityMl, tolerance.relative), `${measured.probabilityMl} ml of lesion probability, browser ${expected.probabilityMl} ± ${percent(tolerance.relative)}`],
  ];
}
