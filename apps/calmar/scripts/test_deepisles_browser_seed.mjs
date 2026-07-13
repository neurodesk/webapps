#!/usr/bin/env node --no-warnings
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'web/js/lnm-app.js'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'web/js/inference-worker.js'), 'utf8');
const executor = fs.readFileSync(path.join(ROOT, 'web/js/controllers/InferenceExecutor.js'), 'utf8');
const spatial = fs.readFileSync(path.join(ROOT, 'web/js/modules/spatial-file.js'), 'utf8');
const benchmark = fs.readFileSync(path.join(ROOT, 'scripts/benchmark_lesion_models.py'), 'utf8');
const gap = fs.readFileSync(path.join(ROOT, 'scripts/deepisles_gap_analysis.py'), 'utf8');

parse(app, { ecmaVersion: 'latest', sourceType: 'module' });
parse(worker, { ecmaVersion: 'latest', sourceType: 'module' });
parse(executor, { ecmaVersion: 'latest', sourceType: 'module' });

const asset = manifest.modelAssets.find(a => a.id === 'lnm-deepisles-nvauto-browser-seed');
assert.ok(asset, "manifest must register the DeepISLES browser seed candidate");
assert.equal(asset.supportStatus, 'benchmark-only',
  'DeepISLES must remain benchmark-only until the Dice 0.5 gap is explained and a browser candidate passes');
assert.equal(asset.inputModality, 'DWI_ADC');
assert.deepEqual(asset.inputContrasts, ['ADC', 'TRACE']);
assert.deepEqual(asset.patchSize, [192, 192, 128]);
assert.equal(asset.overlap, 0.625);
assert.deepEqual(asset.preprocessing?.channelOrder, ['ADC', 'TRACE']);
assert.equal(asset.preprocessing?.normalize, 'nonzero-zscore-channel-wise');

for (const id of [
  'deepIslesDwiFileInput',
  'deepIslesAdcFileInput',
  'runDeepIslesSegmentationButton'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `index.html must expose ${id}`);
}

assert.match(html, /DWI\/TRACE \(\.nii \/ \.nii\.gz\)/,
  'input section must expose a compact DWI/TRACE picker');
assert.match(html, /ADC \(\.nii \/ \.nii\.gz\)/,
  'input section must expose a compact ADC picker');
assert.match(html, /DeepISLES DWI\/ADC seed/,
  'advanced lesion source controls must expose the opt-in DeepISLES seed button');

assert.match(spatial, /NATIVE_DWI:\s*['"]native-dwi['"]/,
  'spatial-file must define a native DWI space for DeepISLES inputs and seed outputs');
assert.match(app, /deepIslesDwiFile\s*=\s*null/);
assert.match(app, /deepIslesAdcFile\s*=\s*null/);
assert.match(app, /\bsetDeepIslesInput\s*\(/);
assert.match(app, /\brunDeepIslesSegmentation\s*\(/);
assert.match(app, /lnm-deepisles-nvauto-browser-seed/);
assert.match(app, /DeepISLES requires DWI\/TRACE and ADC inputs/);
assert.match(app, /supportStatus !== 'supported'[\s\S]*benchmark-only/,
  'app must fail loudly rather than silently falling back when the DeepISLES asset is not validated');
assert.match(app, /DeepISLES seed is in DWI space[\s\S]*not starting T1 mask review/,
  'app must not silently feed an incompatible DWI-space mask into the T1 pipeline');

assert.match(executor, /\brunDeepIslesInference\s*\(/);
assert.match(executor, /type:\s*['"]run-deepisles-inference['"]/);
assert.match(worker, /case\s+['"]run-deepisles-inference['"]/);
assert.match(worker, /\bstepDeepIslesInference\s*\(/);
assert.match(worker, /resampleAffine/);
assert.match(worker, /\[1,\s*2,\s*p0,\s*p1,\s*p2\]/,
  'worker must create a two-channel NCDHW DeepISLES tensor');
assert.match(worker, /channelOrder/);

assert.match(benchmark, /deepisles-nvauto-single-fold/);
assert.match(benchmark, /deepisles-nvauto-best3/);
assert.match(benchmark, /deepisles-nvauto-15fold/);
assert.match(benchmark, /input_contrasts=\("ADC",\s*"TRACE"\)/,
  'benchmark must pin DeepISLES to ADC + TRACE inputs');
assert.match(benchmark, /patch_size=\(192,\s*192,\s*128\)[\s\S]*overlap=0\.625/,
  'benchmark must pin upstream NVAUTO patch geometry');
assert.match(gap, /--reference-prediction/);
assert.match(gap, /reference-deepisles-dice-0p5/);
assert.match(gap, /resample_binary_to_mask_grid/);
assert.match(gap, /input_inventory\.csv/);
assert.match(gap, /diff_maps/);

console.log('DeepISLES browser seed contract OK: benchmark modes, gap harness, app hooks, and worker route are pinned.');
