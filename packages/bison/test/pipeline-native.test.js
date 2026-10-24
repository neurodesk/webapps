// The whole pipeline in Node on one validation subject's raw images, against the native MINC
// reference. BISON_NATIVE_REFERENCE is run_native.sh's ref-final directory for that subject,
// BISON_NATIVE_INPUTS the directory with its raw *_T1w.nii.gz and *_FLAIR.nii.gz, BISON_ASSET_DIR the
// asset directory, and BISON_FULL_PIPELINE=1 opts in: each mode takes about 20 minutes on one core.
// Both modes are in this one file so that they run one after the other.
//
// Each threshold is the lowest value on the five ds007522 validation subjects
// (validation/pipeline-reference.mjs, validation/compare-outputs.mjs) less 0.02, so it holds for
// any of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { gunzipSync } from 'fflate';
import { loadNodeAssets } from '../src/node-assets.js';
import { nodeDrivers } from '../src/node.js';
import { runBison } from '../src/pipeline.js';
import { labelAgreement, nativeOutput } from '../validation/agreement.mjs';

const reference = process.env.BISON_NATIVE_REFERENCE;
const inputs = process.env.BISON_NATIVE_INPUTS;
const assetDir = process.env.BISON_ASSET_DIR;
const skip = !reference || !inputs || !assetDir || process.env.BISON_FULL_PIPELINE !== '1'
  ? 'set BISON_NATIVE_REFERENCE, BISON_NATIVE_INPUTS, BISON_ASSET_DIR and BISON_FULL_PIPELINE=1'
  : false;

// Lowest on the five subjects (t1 / t1-flair): mask Dice 0.970 / 0.970, voxel agreement 0.935 /
// 0.933, Dice ventricles 0.961 / 0.965, CSF 0.788 / 0.791, cerebellar GM 0.943 / 0.944, cerebellar
// WM 0.905 / 0.905, brainstem 0.960 / 0.956, deep GM 0.934 / 0.935, cortical GM 0.907 / 0.908, WM
// 0.931 / 0.926, WMH 0.772 (sub-HML0774; the other four 0.882-0.927). The WMH volume differs by at
// most 3.1 ml (sub-HML0774, 8.0 against 11.1 ml). CSF is low because the classification masks
// differ at the brain edge, and WMH because N4 is not N3 on the FLAIR (docs/preprocessing.md).
const MINIMUM = {
  t1: {
    maskDice: 0.95,
    agreementInMasks: 0.914,
    dice: { ventricles: 0.941, csf: 0.768, 'cerebellar-gm': 0.923, 'cerebellar-wm': 0.885, brainstem: 0.939, 'deep-gm': 0.914, 'cortical-gm': 0.887, wm: 0.91 },
  },
  't1-flair': {
    maskDice: 0.95,
    agreementInMasks: 0.913,
    dice: { ventricles: 0.945, csf: 0.771, 'cerebellar-gm': 0.923, 'cerebellar-wm': 0.884, brainstem: 0.935, 'deep-gm': 0.914, 'cortical-gm': 0.887, wm: 0.906, wmh: 0.751 },
    wmhMlDifference: 3.5,
  },
};

async function input(suffix) {
  const name = (await readdir(inputs)).find((file) => file.endsWith(suffix));
  assert.ok(name, `raw ${suffix} in ${inputs}`);
  return { name, bytes: await readFile(join(inputs, name)) };
}

for (const mode of ['t1', 't1-flair']) {
  test(`${mode}: the whole pipeline agrees with the native reference`, { skip, timeout: 7_200_000 }, async () => {
    const t1 = await input('_T1w.nii.gz');
    const flair = mode === 't1-flair' ? (await input('_FLAIR.nii.gz')).bytes : null;
    const assets = await loadNodeAssets({ modes: [mode], assetDir });
    const result = await runBison({ t1: t1.bytes, flair, t1Name: t1.name }, nodeDrivers({ threads: 1 }), assets);
    const file = (suffix) => readNifti(gunzipSync(result.files.find((f) => f.name.endsWith(suffix)).bytes), Uint8Array);
    const labels = await file('_bison-labels.nii.gz');
    const nativeLabels = await nativeOutput(reference, mode, '_bison-labels.nii.gz');
    const agreement = labelAgreement({
      labels: labels.data,
      mask: (await file('_bison-mask.nii.gz')).data,
      nativeLabels: nativeLabels.data,
      nativeMask: (await nativeOutput(reference, mode, '_bison-mask.nii.gz')).data,
      affine: labels.header.affine,
      mode,
    });
    const minimum = MINIMUM[mode];
    assert.ok(agreement.maskDice >= minimum.maskDice, `mask Dice ${agreement.maskDice}`);
    assert.ok(agreement.agreementInMasks >= minimum.agreementInMasks, `agreement ${agreement.agreementInMasks}`);
    for (const [slug, value] of Object.entries(minimum.dice)) {
      assert.ok(agreement.perClass[slug].dice >= value, `${slug} Dice ${agreement.perClass[slug].dice} < ${value}`);
    }
    if (minimum.wmhMlDifference !== undefined) {
      assert.ok(Math.abs(agreement.perClass.wmh.differenceMl) <= minimum.wmhMlDifference, `WMH differs by ${agreement.perClass.wmh.differenceMl} ml`);
    }
  });
}
