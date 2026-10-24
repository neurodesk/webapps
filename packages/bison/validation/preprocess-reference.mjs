// Runs the JavaScript preprocessing on one subject in Node and compares it with the native MINC
// reference (validation/native). Writes every checkpoint, timings.json and report.json to --out.
//
//   node validation/preprocess-reference.mjs --t1 T1w.nii.gz [--flair FLAIR.nii.gz] --out DIR \
//     [--native DIR] [--native-export DIR] [--asset-dir DIR] [--modes t1,t1-flair]
//
// With --native the linear T1 mask must reach Dice >= 0.97 with the native T1_Mask, or the script
// exits with status 1 (report.json gates).
//
// --native is the output of validation/native/preproc_nifti.py (T1_Mask, T1_N3, Mask_nl,
// FLAIR_Mask, FLAIR_N3); --native-export a ref-masked tree's t1-flair/export/nifti/checkpoints
// (T1_VP, FLAIR_CR, sp_k, av_t1, av_flair). --asset-dir defaults to BISON_ASSET_DIR.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { loadNodeAssets } from '../src/node-assets.js';
import { nodeDrivers } from '../src/node.js';
import { preprocess, readVolume } from '../src/preprocess.js';

const { values } = parseArgs({
  options: {
    t1: { type: 'string' },
    flair: { type: 'string' },
    out: { type: 'string' },
    native: { type: 'string' },
    'native-export': { type: 'string' },
    'asset-dir': { type: 'string' },
    modes: { type: 'string', default: 't1,t1-flair' },
  },
});
if (!values.t1 || !values.out) throw new Error('Give --t1 and --out.');
const modes = values.modes.split(',');
const report = { modes, steps: {} };
const LINEAR_MASK_DICE = 0.97;

async function nativeVolume(dir, name) {
  if (!dir) return null;
  try {
    return (await readNifti(await readFile(join(dir, name)))).data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function dice(a, b) {
  let both = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > 0.5;
    const y = b[i] > 0.5;
    if (x && y) both++;
    sum += x + y;
  }
  return (2 * both) / sum;
}

// Pearson correlation and mean absolute difference inside a mask.
function agreement(a, b, mask) {
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!mask[i]) continue;
    n++;
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  let mad = 0;
  for (let i = 0; i < a.length; i++) {
    if (!mask[i]) continue;
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
    mad += Math.abs(a[i] - b[i]);
  }
  return { r: cov / Math.sqrt(va * vb), meanAbsDiff: mad / n, meanJs: ma, meanNative: mb };
}

const NATIVE = {
  'T1_Mask.nii': ['native', 'T1_Mask.nii.gz', 'dice'],
  'Mask_nl.nii': ['native', 'Mask_nl.nii.gz', 'dice'],
  'FLAIR_Mask.nii': ['native', 'FLAIR_Mask.nii.gz', 'dice'],
  'T1_N4.nii.gz': ['native', 'T1_N3.nii.gz', 'T1_Mask.nii.gz'],
  'FLAIR_N4.nii.gz': ['native', 'FLAIR_N3.nii.gz', 'FLAIR_Mask.nii.gz'],
  'T1_VP.nii': ['native-export', 'T1_VP.nii.gz', 'mask'],
  'FLAIR_CR.nii': ['native-export', 'FLAIR_CR.nii.gz', 'mask'],
  'av_t1.nii': ['native-export', 'av_t1.nii.gz', 'mask'],
  'av_flair.nii': ['native-export', 'av_flair.nii.gz', 'mask'],
};
for (let k = 1; k <= 9; k++) NATIVE[`t1-flair/sp_${k}.nii`] = ['native-export', `sp_${k}.nii.gz`, 'mask'];

let classificationMask = await nativeVolume(values.native, 'Mask_nl.nii.gz');

async function compare(name, bytes) {
  const spec = NATIVE[name];
  if (!spec) return;
  const reference = await nativeVolume(values[spec[0]], spec[1]);
  if (!reference) return;
  const { data } = await readVolume(bytes, name);
  if (data.length !== reference.length) {
    report.steps[name] = { error: 'grid differs' };
    return;
  }
  if (spec[2] === 'dice') {
    report.steps[name] = { dice: dice(data, reference) };
  } else {
    const mask = spec[2] === 'mask' ? classificationMask : await nativeVolume(values.native, spec[2]);
    if (mask) report.steps[name] = agreement(data, reference, mask.map((v) => v > 0.5));
  }
  console.log(name, JSON.stringify(report.steps[name]));
}

const started = performance.now();
const marks = [];
const assets = await loadNodeAssets({ modes, assetDir: values['asset-dir'], onProgress: () => {} });
const result = await preprocess({
  t1: await readFile(values.t1),
  flair: values.flair ? await readFile(values.flair) : null,
  modes,
  assets,
  drivers: nodeDrivers(),
  onProgress: (message) => {
    marks.push([message, (performance.now() - started) / 1000]);
    console.log(`[${((performance.now() - started) / 1000).toFixed(1)} s] ${message}`);
  },
  checkpoint: async (name, bytes) => {
    const path = join(values.out, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await compare(name, bytes);
  },
});
report.volumePol = result.volumePol;
report.timings = result.timings;
report.totalSeconds = (performance.now() - started) / 1000;
classificationMask = result.mask;
await writeFile(join(values.out, 'timings.json'), `${JSON.stringify({ steps: result.timings, progress: marks, total: report.totalSeconds }, null, 2)}\n`);
if (report.steps['T1_Mask.nii']) {
  report.gates = { linearMask: { dice: report.steps['T1_Mask.nii'].dice, minimum: LINEAR_MASK_DICE, pass: report.steps['T1_Mask.nii'].dice >= LINEAR_MASK_DICE } };
}
await writeFile(join(values.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.gates && !report.gates.linearMask.pass) {
  console.error(`Linear mask Dice ${report.gates.linearMask.dice} is below ${LINEAR_MASK_DICE}.`);
  process.exitCode = 1;
}
