// Runs the port end to end with ONNX Runtime (Node) on a reference example and
// compares every slice's prediction and logits and every CSV with the original.
//   node validation/check-reference.mjs <reference.json> <input.nii.gz> <model.onnx>
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { INPUT_NAME, OUTPUT_NAME, localCsv, readVolume, runBrainQCNet, subjectId, tableCsv, totCsv } from '../src/pipeline.js';
import { cropToForeground, modelSlice } from '../src/slices.js';

const [referencePath, input, model] = process.argv.slice(2);
const reference = JSON.parse(await readFile(referencePath, 'utf8'));
const bytes = await readFile(input);
if (createHash('sha256').update(bytes).digest('hex') !== reference.input.sha256) throw new Error('Input differs from the reference input.');
const session = await ort.InferenceSession.create(model);
const volume = await readVolume(bytes);
const cropped = cropToForeground(volume);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const resizedMismatch = reference.slices.filter((s) => sha(modelSlice(cropped, s.axis, s.slice)) !== s.resized_sha256).length;
const started = performance.now();
const { predictions, summary } = await runBrainQCNet(volume, {
  batchSize: 8,
  classify: async (data, count) => (await session.run({ [INPUT_NAME]: new ort.Tensor('float32', data, [count, 3, 224, 224]) }))[OUTPUT_NAME].data,
});
const seconds = (performance.now() - started) / 1000;
const key = (s) => `${s.axis}${s.slice}`;
const ours = new Map(predictions.map((p) => [key(p), p]));
let flips = 0;
let maxDiff = 0;
let maxScale = 0;
for (const s of reference.slices) {
  const p = ours.get(key(s));
  if (!p || p.pred !== s.pred) flips++;
  for (let c = 0; c < 2; c++) {
    maxDiff = Math.max(maxDiff, Math.abs(p.logits[c] - s.logits[c]));
    maxScale = Math.max(maxScale, Math.abs(s.logits[c]));
  }
}
const tot = reference.files['tot_df.csv'];
const t = Number(tot.split('\n')[1].match(/^[^,]*,[^,]*,([^,]*),/)[1]);
const files = {
  'table.csv': tableCsv(summary),
  'tot_df.csv': totCsv(summary, subjectId(reference.input.name), t),
  'x_results_locally.csv': localCsv(summary, 'x'),
  'y_results_locally.csv': localCsv(summary, 'y'),
  'z_results_locally.csv': localCsv(summary, 'z'),
};
const differing = Object.keys(files).filter((name) => files[name] !== reference.files[name]);
const report = {
  id: reference.id,
  slices: reference.slices.length,
  classified: predictions.length,
  resized_mismatch: resizedMismatch,
  prediction_mismatch: flips,
  max_abs_logit_diff: maxDiff,
  max_abs_logit: maxScale,
  csv_mismatch: differing,
  flagged_fraction: summary.proba,
  seconds: Math.round(seconds),
};
console.log(JSON.stringify(report));
if (resizedMismatch || flips || differing.length || predictions.length !== reference.slices.length) process.exit(1);
