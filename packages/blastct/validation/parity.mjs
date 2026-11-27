// Parity check: runs @neurodesk/blastct (pure-JS SimpleITK geometry + DeepMedic ONNX
// via onnxruntime-node) against upstream BLAST-CT v2.1.0 (v2 multi-centre model, checkpoint 1)
// PyTorch + SimpleITK oracles.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { decodeNiftiBuffer, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { CPU_OUTPUT_PATCH, segmentHeadCt } from '../src/pipeline.js';
import { compareMultiClassLabels, measureLesions } from '../src/results.js';

async function loadNifti(path) {
  return parseNiftiVolume(await decodeNiftiBuffer(await readFile(path)));
}

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const [imagePath, onnxPath, oraclePath] = positional;
if (!imagePath || !onnxPath || !oraclePath) {
  console.error('Usage: node parity.mjs [--allow-int16-truncation] <scan.nii.gz> <model.onnx> <oracle.nii.gz>');
  process.exit(2);
}

const inputVol = await loadNifti(imagePath);
const oracleVol = await loadNifti(oraclePath);
const session = await ort.InferenceSession.create(onnxPath);

const started = performance.now();
const result = await segmentHeadCt({
  data: inputVol.imageData,
  dimsXYZ: inputVol.dims.slice(0, 3),
  rasAffine: inputVol.affine,
  maxOutputPatch: CPU_OUTPUT_PATCH,
  runModel: async (patch, dims) => {
    const tensor = new ort.Tensor('float32', patch, dims);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    return out[session.outputNames[0]].data;
  },
});
const seconds = (performance.now() - started) / 1000;

const refLabels = Uint8Array.from(oracleVol.imageData, (v) => Math.round(v));
const cmp = compareMultiClassLabels(result.labels, refLabels);
const lesions = measureLesions(result.labels, result.nativeGeom.spacing);

console.log(JSON.stringify({
  image: imagePath,
  dims: result.nativeGeom.size,
  spacing: result.nativeGeom.spacing.map((v) => Number(v.toFixed(3))),
  isoDims: result.isoGeom.size,
  patches: result.patches,
  seconds: Number(seconds.toFixed(2)),
  totalVolumeMl: lesions.totalVolumeMl,
  ...cmp,
}, null, 2));

const allowInt16 = flags.has('--allow-int16-truncation');
for (const [cls, stats] of Object.entries(cmp.perClass)) {
  if (allowInt16) {
    if (stats.refVoxels >= 500) {
      assert.ok(stats.dice >= 0.94, `${cls} Dice too low (int16 comparison): ${stats.dice}`);
    } else if (stats.refVoxels >= 20) {
      assert.ok(stats.dice >= 0.80, `${cls} Dice too low (int16 comparison): ${stats.dice}`);
    }
  } else if (stats.refVoxels >= 500) {
    assert.ok(stats.dice >= 0.99, `${cls} Dice too low: ${stats.dice}`);
  } else if (stats.refVoxels >= 20) {
    assert.ok(stats.dice >= 0.97, `${cls} Dice too low: ${stats.dice}`);
  }
}
