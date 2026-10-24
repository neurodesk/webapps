// Agreement of a BISON result with the native MINC reference (validation/native, export/nifti).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { CLASS_SLUGS } from '../src/outputs.js';
import { modeSpec } from '../src/features.js';

export async function nativeOutput(reference, mode, suffix) {
  const dir = join(reference, mode, 'export', 'nifti');
  const name = (await readdir(dir)).find((file) => file.endsWith(suffix));
  if (!name) throw new Error(`No native ${suffix} in ${dir}.`);
  return readNifti(await readFile(join(dir, name)), Uint8Array);
}

export function dice(a, b, label = null) {
  let both = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const x = label === null ? a[i] > 0 : a[i] === label;
    const y = label === null ? b[i] > 0 : b[i] === label;
    if (x && y) both++;
    sum += x + y;
  }
  return sum === 0 ? 1 : (2 * both) / sum;
}

function voxelMl(affine) {
  const [a, b, c] = affine;
  return Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 1000;
}

/** Per-class Dice and volumes, classification-mask Dice, and voxel agreement inside both masks. */
export function labelAgreement({ labels, mask, nativeLabels, nativeMask, affine, mode }) {
  const { classes } = modeSpec(mode);
  if (labels.length !== nativeLabels.length) throw new Error('The result and the native reference are on different grids.');
  const ml = voxelMl(affine);
  const perClass = {};
  for (let k = 1; k <= classes; k++) {
    let ours = 0;
    let theirs = 0;
    for (let i = 0; i < labels.length; i++) {
      ours += labels[i] === k;
      theirs += nativeLabels[i] === k;
    }
    perClass[CLASS_SLUGS[k - 1]] = { label: k, dice: dice(labels, nativeLabels, k), ml: ours * ml, nativeMl: theirs * ml, differenceMl: (ours - theirs) * ml };
  }
  let inBoth = 0;
  let same = 0;
  for (let i = 0; i < labels.length; i++) {
    if (!mask[i] || !nativeMask[i]) continue;
    inBoth++;
    same += labels[i] === nativeLabels[i];
  }
  return { mode, maskDice: dice(mask, nativeMask), agreementInMasks: same / inBoth, perClass };
}
