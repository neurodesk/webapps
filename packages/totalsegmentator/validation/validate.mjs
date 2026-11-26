// Validates @neurodesk/totalsegmentator JS pipeline + exported ONNX models against
// TotalSegmentator's official reference segmentations on example_ct_sm and example_mr_sm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ort from 'onnxruntime-node';
import { readVolume } from '@neurodesk/synthsr';
import { segmentVolume } from '../src/pipeline.js';
import { compareLabels, structureStatistics } from '../src/results.js';
import { MODELS } from '../src/models.js';

const workDir = process.argv[2] || process.env.TOTALSEG_WORK_DIR;
if (!workDir) {
  console.error('Usage: node packages/totalsegmentator/validation/validate.mjs <workDir>');
  console.error('Set <workDir> (or TOTALSEG_WORK_DIR) containing:');
  console.error('  onnx/  - the 12 pinned ONNX files from packages/totalsegmentator/model.manifest.json');
  console.error('  refs/  - upstream wasserth/TotalSegmentator tests/reference_files/*.nii.gz');
  process.exit(1);
}
const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));

async function runModel(model, fn) {
  const onnxPath = join(workDir, 'onnx', model.filename);
  const session = await ort.InferenceSession.create(onnxPath, { executionProviders: ['cpu'] });
  try {
    return await fn(async (tile) => {
      const input = new ort.Tensor('float32', tile, [1, 1, ...model.patch]);
      const outputs = await session.run({ [session.inputNames[0]]: input });
      return outputs[session.outputNames[0]].data;
    });
  } finally {
    await session.release();
  }
}

function readBuf(path) {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function assertGeometryMatches(actual, expected, label) {
  assert.deepEqual(actual.dims, expected.dims, `${label}: output dimensions must match input`);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      assert.ok(
        Math.abs(actual.affine[r][c] - expected.affine[r][c]) < 1e-4,
        `${label}: affine[${r}][${c}] mismatch (${actual.affine[r][c]} vs ${expected.affine[r][c]})`,
      );
    }
  }
}

async function checkCase(name, scanFile, refFile, task, modelIds, { cropModelId = null, minDice = null, minStructures = 1 } = {}) {
  const started = performance.now();
  const vol = readVolume(readBuf(join(workDir, 'refs', scanFile)));
  const ref = refFile ? readVolume(readBuf(join(workDir, 'refs', refFile))) : null;
  const out = await segmentVolume({
    volume: vol,
    task,
    models: modelIds.map((id) => byId[id]),
    cropModel: cropModelId ? byId[cropModelId] : null,
    runModel,
  });
  assertGeometryMatches(out, vol, name);
  const sec = ((performance.now() - started) / 1000).toFixed(1);
  const stats = structureStatistics({
    labels: out.labels,
    imageData: vol.data,
    dims: out.dims,
    affine: out.affine,
    task,
  });
  assert.ok(stats.length >= minStructures, `${name}: expected >= ${minStructures} detected structures, got ${stats.length}`);
  if (ref) {
    assertGeometryMatches(out, ref, `${name} vs ref`);
    const refLabels = Uint8Array.from(ref.data, (v) => Math.round(v));
    const cmp = compareLabels(out.labels, refLabels, task);
    const worst = Object.entries(cmp.perClass).sort((a, b) => a[1] - b[1]).slice(0, 5);
    console.log(`[${name}] ${sec}s | windows=${out.windows} | detected=${stats.length} | meanDice=${cmp.meanDice} | diff=${cmp.differingVoxels}/${cmp.totalVoxels} (${(100 * cmp.differingVoxels / cmp.totalVoxels).toFixed(3)}%)`);
    console.log('  worst 5 classes:', worst);
    if (minDice !== null) {
      assert.ok(cmp.meanDice >= minDice, `${name}: meanDice ${cmp.meanDice} < required ${minDice}`);
    }
  } else {
    console.log(`[${name}] ${sec}s | windows=${out.windows} | detected=${stats.length} | top 5:`, stats.slice(0, 5).map((r) => `${r.slug}:${r.ml.toFixed(1)}ml`));
  }
}

await checkCase('CT total fast (3mm)', 'example_ct_sm.nii.gz', 'example_seg_fast.nii.gz', 'total', ['total-ct-3mm'], { minDice: 0.99, minStructures: 35 });
await checkCase('CT total full (1.5mm, 5 parts)', 'example_ct_sm.nii.gz', 'example_seg.nii.gz', 'total', [
  'total-ct-organs',
  'total-ct-vertebrae',
  'total-ct-cardiac',
  'total-ct-muscles',
  'total-ct-ribs',
], { minDice: 0.92, minStructures: 35 });
await checkCase('MRI total_mr fast (3mm)', 'example_mr_sm.nii.gz', null, 'total_mr', ['total-mr-3mm'], { minStructures: 18 });
await checkCase('MRI total_mr full (1.5mm, 2 parts)', 'example_mr_sm.nii.gz', 'example_seg_mr.nii.gz', 'total_mr', ['total-mr-organs', 'total-mr-muscles'], { minDice: 0.94, minStructures: 20 });
await checkCase('MRI vertebrae_mr (1.5mm)', 'example_mr_sm.nii.gz', null, 'vertebrae_mr', ['vertebrae-mr'], { minStructures: 2 });
await checkCase('CT abdominal_muscles (cropped)', 'example_ct_sm.nii.gz', null, 'abdominal_muscles', ['abdominal-muscles-ct'], { cropModelId: 'body-ct-6mm', minStructures: 6 });
