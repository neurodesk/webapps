// Parity check: runs @neurodesk/aurora's pure-JS pipeline with onnxruntime-node against
// upstream BrainLesion/AURORA (AuroraInferer, tta=False) oracle NIfTI outputs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { decodeNiftiBuffer, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { segmentMetastasis } from '../src/pipeline.js';
import { modelById } from '../src/models.js';
import { compareLabels, connectedLesions, volumeRows } from '../src/results.js';

const [t1cPath, onnxPath, oraclePath] = process.argv.slice(2);
if (!t1cPath || !onnxPath || !oraclePath) {
  console.error('Usage: node parity.mjs <t1c.nii.gz> <aurora-t1c-o_best.onnx> <oracle_seg.nii.gz>');
  process.exit(2);
}

const loadNifti = async (path) => {
  const parsed = parseNiftiVolume(await decodeNiftiBuffer(await readFile(path)));
  return { data: parsed.imageData, dims: parsed.dims, affine: parsed.affine, headerBytes: parsed.headerBytes };
};
const model = modelById('t1c-o_best');
const volume = await loadNifti(t1cPath);
const oracle = await loadNifti(oraclePath);
const session = await ort.InferenceSession.create(onnxPath);
const started = performance.now();
const result = await segmentMetastasis({
  volume,
  model,
  runPatch: async (tile) => {
    const tensor = new ort.Tensor('float32', tile, [1, 1, ...model.patch]);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    return out[session.outputNames[0]].data;
  },
});
const seconds = (performance.now() - started) / 1000;
const cmp = compareLabels(result.labels, oracle.data);
const rows = volumeRows(result.labels, volume.affine);
const lesions = connectedLesions(result.labels, volume.dims, volume.affine);

console.log(JSON.stringify({
  seconds: Number(seconds.toFixed(1)),
  windows: result.windows,
  ...cmp,
  rows,
  metastasisLesionCount: lesions.length,
  largestLesionMl: lesions[0] ? Number(lesions[0].ml.toFixed(3)) : 0,
}, null, 2));

assert.ok(cmp.dice.WL >= 0.999, `Whole lesion Dice too low: ${cmp.dice.WL}`);
assert.ok(cmp.dice.MET >= 0.999, `Metastasis Dice too low: ${cmp.dice.MET}`);
