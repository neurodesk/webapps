// SEALS parity: the browser pipeline (src/seals.js, onnxruntime-node) against
// apps/calmar/scripts/run_seals_onnx.py, which matches nnU-Net's own inference.
//
//   node validation/seals-parity.mjs <model.onnx> <case-dir>...
//
// Each case directory holds dwi.nii.gz, adc.nii.gz, brainmask.nii.gz and
// reference.nii.gz (run_seals_onnx.py --brain-mask output). Fails below Dice 0.999.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { decodeVolume } from '../src/nifti.js';
import { segmentSeals } from '../src/seals.js';

const [modelPath, ...cases] = process.argv.slice(2);
if (!modelPath || !cases.length) throw new Error('usage: node validation/seals-parity.mjs <model.onnx> <case-dir>...');
const session = await ort.InferenceSession.create(modelPath);
const runPatch = async (patch, p) => {
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', patch, [1, 2, p, p, p]) });
  return out[session.outputNames[0]].data;
};
const load = async (dir, name) => decodeVolume(new Uint8Array(await readFile(path.join(dir, name))));

let failed = false;
for (const dir of cases) {
  const [dwi, adc, brain, reference] = await Promise.all(['dwi', 'adc', 'brainmask', 'reference'].map(n => load(dir, `${n}.nii.gz`)));
  const start = performance.now();
  const labels = await segmentSeals({
    dwi: Float32Array.from(dwi.data),
    adc: { data: Float32Array.from(adc.data), dims: adc.dims, affine: adc.affine },
    brainMask: Uint8Array.from(brain.data, v => (v > 0 ? 1 : 0)),
    dims: dwi.dims,
    affine: dwi.affine
  }, runPatch);
  const sameGrid = reference.dims.every((n, i) => n === dwi.dims[i]) &&
    reference.affine.every((row, r) => row.every((v, c) => Math.abs(v - dwi.affine[r][c]) < 1e-3));
  if (!sameGrid || reference.data.length !== labels.length) {
    throw new Error(`${path.basename(dir)}: reference.nii.gz is not on the DWI/TRACE grid.`);
  }
  let both = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < labels.length; i++) {
    const r = reference.data[i] > 0;
    if (labels[i]) a++;
    if (r) b++;
    if (labels[i] && r) both++;
  }
  const dice = a + b === 0 ? 1 : (2 * both) / (a + b);
  const ok = dice >= 0.999;
  failed ||= !ok;
  console.log(`${path.basename(dir)}: browser ${a} voxels, reference ${b}, Dice ${dice.toFixed(5)} ${ok ? 'ok' : 'FAIL'} (${((performance.now() - start) / 1000).toFixed(0)} s)`);
}
if (failed) process.exit(1);
