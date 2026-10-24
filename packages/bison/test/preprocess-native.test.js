// The volume_pol step against the native MINC reference: fitted on the native N3 images with the
// native linear masks, the port must print the expression files volume_pol wrote. Needs
// BISON_NATIVE_REFERENCE (a ref-masked tree), BISON_NATIVE_PREPROC (validation/native/preproc_nifti.py
// output for it) and BISON_ASSET_DIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AV_FLAIR, TEMPLATE_MASK, TEMPLATE_T1 } from '../src/assets.js';
import { binaryMask, readVolume } from '../src/preprocess.js';
import { fitVolumePol } from '../src/volume-pol.js';

const reference = process.env.BISON_NATIVE_REFERENCE;
const preproc = process.env.BISON_NATIVE_PREPROC;
const assets = process.env.BISON_ASSET_DIR;
const skip = !reference || !preproc || !assets ? 'set BISON_NATIVE_REFERENCE, BISON_NATIVE_PREPROC and BISON_ASSET_DIR' : false;

const volume = async (path) => (await readVolume(await readFile(path))).data;

async function expfile(suffix) {
  const dir = join(reference, 'preproc');
  const name = (await readdir(dir)).find((file) => file.endsWith(suffix));
  return (await readFile(join(dir, name), 'utf8')).trim();
}

test('volume_pol on the native N3 images prints the native expression files', { skip }, async () => {
  const templateMask = binaryMask(await volume(join(assets, TEMPLATE_MASK)));
  for (const [image, mask, target, suffix] of [
    ['T1_N3', 'T1_Mask', TEMPLATE_T1, '_T1_norm'],
    ['FLAIR_N3', 'FLAIR_Mask', AV_FLAIR, '_FLAIR_norm'],
  ]) {
    const fit = fitVolumePol({
      source: await volume(join(preproc, `${image}.nii.gz`)),
      sourceMask: binaryMask(await volume(join(preproc, `${mask}.nii.gz`))),
      target: await volume(join(assets, target)),
      targetMask: templateMask,
      order: 1,
    });
    assert.equal(fit.expression, await expfile(suffix), image);
  }
});
