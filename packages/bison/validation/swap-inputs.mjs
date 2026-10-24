// Finds which preprocessing output costs agreement with the native reference: classifies with each
// classifier input taken from our checkpoints or from the native export, one input group at a time.
//
//   node validation/swap-inputs.mjs --mode t1|t1-flair --checkpoints DIR --native REF_MASKED_DIR \
//     [--asset-dir DIR] [--t1-scale F] [--flair-scale F] [--out report.json]
//
// --t1-scale multiplies our T1_VP by F first (for example native / our volume_pol coefficient), to
// tell an intensity scale difference from a difference in texture. --flair-scale does the same for
// our FLAIR_CR.
// --checkpoints is pipeline-reference.mjs's <out>/checkpoints. Groups: t1 (T1_VP), avT1, priors,
// flair (FLAIR_CR), avFlair, mask (Mask_nl). Each row is all ours except the named groups.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as ort from 'onnxruntime-node';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { MODE_ASSETS } from '../src/assets.js';
import { classifyVoxels, createClassifier } from '../src/classify.js';
import { histogramTable, maskVoxels, modeSpec } from '../src/features.js';
import { labelAgreement, nativeOutput } from './agreement.mjs';

const { values } = parseArgs({
  options: {
    mode: { type: 'string' },
    checkpoints: { type: 'string' },
    native: { type: 'string' },
    'asset-dir': { type: 'string' },
    out: { type: 'string' },
    't1-scale': { type: 'string' },
    'flair-scale': { type: 'string' },
  },
});
const mode = values.mode;
const spec = modeSpec(mode);
const assetDir = values['asset-dir'] ?? process.env.BISON_ASSET_DIR;
const nativeDir = join(values.native, mode, 'export', 'nifti', 'checkpoints');
const volume = async (path) => (await readNifti(await readFile(path))).data;

async function inputs(source) {
  const native = source === 'native';
  const at = (ours, theirs) => volume(native ? join(nativeDir, theirs) : join(values.checkpoints, ours));
  const group = {
    t1: await at('T1_VP.nii', 'T1_VP.nii.gz'),
    avT1: await at('av_t1.nii', 'av_t1.nii.gz'),
    priors: [],
    mask: native ? (await nativeOutput(values.native, mode, '_bison-mask.nii.gz')).data : await volume(join(values.checkpoints, 'Mask_nl.nii')),
  };
  for (let k = 1; k <= spec.classes; k++) group.priors.push(await at(`${mode}/sp_${k}.nii`, `sp_${k}.nii.gz`));
  if (spec.flair) {
    group.flair = await at('FLAIR_CR.nii', 'FLAIR_CR.nii.gz');
    group.avFlair = await at('av_flair.nii', 'av_flair.nii.gz');
  }
  return group;
}

const ours = await inputs('ours');
const t1Scale = Number(values['t1-scale'] ?? 1);
if (t1Scale !== 1) ours.t1 = ours.t1.map((value) => value * t1Scale);
const flairScale = Number(values['flair-scale'] ?? 1);
if (flairScale !== 1) ours.flair = ours.flair.map((value) => value * flairScale);
const theirs = await inputs('native');
const histogram = async (name) => histogramTable(JSON.parse(await readFile(join(assetDir, name), 'utf8')), spec.classes);
const t1Histogram = await histogram(MODE_ASSETS[mode].t1Histogram);
const flairHistogram = spec.flair ? await histogram(MODE_ASSETS[mode].flairHistogram) : undefined;
const classifier = await createClassifier(ort, await readFile(join(assetDir, MODE_ASSETS[mode].classifier)));
const nativeLabels = await nativeOutput(values.native, mode, '_bison-labels.nii.gz');
const nativeMask = await nativeOutput(values.native, mode, '_bison-mask.nii.gz');

const groups = spec.flair ? ['t1', 'avT1', 'priors', 'flair', 'avFlair', 'mask'] : ['t1', 'avT1', 'priors', 'mask'];
const rows = [[], ...groups.map((g) => [g]), groups.filter((g) => g !== 'mask'), groups];
const report = [];
for (const swapped of rows) {
  const pick = (g) => (swapped.includes(g) ? theirs[g] : ours[g]);
  const mask = pick('mask');
  const voxels = maskVoxels(mask);
  const images = { mode, t1: pick('t1'), avT1: pick('avT1'), priors: pick('priors'), t1Histogram };
  if (spec.flair) Object.assign(images, { flair: pick('flair'), avFlair: pick('avFlair'), flairHistogram });
  const { labels } = await classifyVoxels(classifier, images, voxels);
  const full = new Uint8Array(mask.length);
  voxels.forEach((v, r) => { full[v] = labels[r]; });
  const agreement = labelAgreement({ labels: full, mask: Uint8Array.from(mask, (v) => (v > 0 ? 1 : 0)), nativeLabels: nativeLabels.data, nativeMask: nativeMask.data, affine: nativeLabels.header.affine, mode });
  const row = { native: swapped.length ? swapped : ['none'], maskDice: agreement.maskDice, agreementInMasks: agreement.agreementInMasks, dice: Object.fromEntries(Object.entries(agreement.perClass).map(([slug, c]) => [slug, Number(c.dice.toFixed(4))])) };
  if (spec.flair) row.wmhMl = { ours: agreement.perClass.wmh.ml, native: agreement.perClass.wmh.nativeMl };
  report.push(row);
  console.log(JSON.stringify(row));
}
if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
