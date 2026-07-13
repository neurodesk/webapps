#!/usr/bin/env node --no-warnings
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(ROOT, 'scripts/benchmark_lesion_models.py');
const src = fs.readFileSync(scriptPath, 'utf8');

for (const subject of [
  'sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5', 'sub-7',
  'sub-8', 'sub-9', 'sub-10', 'sub-11', 'sub-13', 'sub-14'
]) {
  assert.match(src, new RegExp(`"${subject}"`),
    `benchmark must include paired SOOP subject ${subject}`);
}

for (const subject of ['sub-6', 'sub-12']) {
  assert.match(src, new RegExp(`"${subject}"`),
    `benchmark must include prediction-only SOOP subject ${subject}`);
}

for (const contrast of ['T1w', 'FLAIR', 'ADC', 'TRACE']) {
  assert.match(src, new RegExp(`"${contrast}"`),
    `benchmark must cover ${contrast}`);
}

assert.match(src, /desc-lesion_mask/,
  'SOOP accuracy target must be the combined desc-lesion_mask, not acute/chronic fallback masks');
assert.doesNotMatch(src, /desc-lesionAcute_mask.*mask_path|desc-lesionChronic_mask.*mask_path/s,
  'benchmark must not silently score against acute/chronic masks');

assert.match(src, /"baseline-app"[\s\S]*?out_channels=2[\s\S]*?stroke_channel=1/,
  'baseline-app mode must validate two output channels and stroke channel 1');
assert.match(src, /"synthplus-app-like"[\s\S]*?out_channels=6[\s\S]*?stroke_channel=5/,
  'SynthPlus app-like mode must validate six output channels and stroke channel 5');
assert.match(src, /"baseline-upstream-like"[\s\S]*?patch_size=\(192,\s*192,\s*192\)[\s\S]*?overlap=0\.5[\s\S]*?tta=True/,
  'upstream-like baseline must use 192^3 patches, 0.5 overlap, and TTA');
assert.match(src, /"deepisles-nvauto-single-fold"[\s\S]*?input_contrasts=\("ADC",\s*"TRACE"\)[\s\S]*?channel_order=\("ADC",\s*"TRACE"\)/,
  'DeepISLES single-fold mode must be multi-input ADC + TRACE in the validated channel order');
assert.match(src, /"deepisles-nvauto-best3"[\s\S]*?probability_globs=\([\s\S]*model7[\s\S]*model9[\s\S]*model11/,
  'DeepISLES best-3 benchmark mode must combine the prior strongest NVAUTO folds');
assert.match(src, /"deepisles-nvauto-15fold"[\s\S]*?patch_size=\(192,\s*192,\s*128\)[\s\S]*?overlap=0\.625/,
  'DeepISLES 15-fold mode must pin upstream NVAUTO patch geometry');
assert.match(src, /resample_binary_to_mask_grid/,
  'benchmark must resample predictions onto the mask grid before metrics');
assert.match(src, /best-worst/,
  'benchmark must support optional best/worst prediction NIfTI export');
assert.match(src, /torch-device/,
  'benchmark must expose a torch-device option so upstream-like modes can use MPS/CUDA when available');
assert.match(src, /torch-batch-size/,
  'benchmark must batch PyTorch patch inference so TTA modes are practical on MPS/CUDA');
assert.match(src, /deepisles-pred-root/,
  'benchmark must expose a DeepISLES prediction root so candidate outputs can be scored on SOOP');

console.log('lesion model benchmark contract OK: SOOP subjects/contrasts, SynthStroke/SynthPlus channels, DeepISLES ADC+TRACE modes, mask target, and resampling are pinned.');
