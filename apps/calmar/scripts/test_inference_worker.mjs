#!/usr/bin/env node --no-warnings
// Source-grep contract for the LNM module worker (Phase 2a.1.4a).
//
// We can't easily exercise the worker end-to-end in Node (it imports the ORT
// WebGPU/WASM bundle that has no Node entry point); instead we pin the
// migration's invariants at the source level:
//
//   - module-worker idiom: no importScripts, top-level ES imports
//   - dead SCT code stripped (vertebrae, legacy 'run' shim, SCT branding)
//   - localforage dropped, Cache Storage used instead
//   - 'run-synthstrip' op is dispatched, calls stepSynthStrip -> runSynthStrip
//   - inference-pipeline.js is a real ES module
//   - InferenceExecutor spawns the worker with { type: 'module' }
//
// End-to-end validation happens in the 2a.1.4c onnxruntime-node parity test
// and the 2a.1.5 browser smoke test.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = path.join(ROOT, 'web/js/inference-worker.js');
const PIPELINE_PATH = path.join(ROOT, 'web/js/inference-pipeline.js');
const EXECUTOR_PATH = path.join(ROOT, 'web/js/controllers/InferenceExecutor.js');

for (const p of [WORKER_PATH, PIPELINE_PATH, EXECUTOR_PATH]) {
  assert.ok(fs.existsSync(p), `${path.relative(ROOT, p)} must exist`);
}

const worker = fs.readFileSync(WORKER_PATH, 'utf8');
const pipeline = fs.readFileSync(PIPELINE_PATH, 'utf8');
const executor = fs.readFileSync(EXECUTOR_PATH, 'utf8');

// Acorn parse — catches syntax errors that would only surface when the
// browser tries to load the module worker.
parse(worker, { ecmaVersion: 'latest', sourceType: 'module' });
parse(pipeline, { ecmaVersion: 'latest', sourceType: 'module' });
parse(executor, { ecmaVersion: 'latest', sourceType: 'module' });

// ---- (1) module-worker idiom ----
assert.doesNotMatch(
  worker,
  /\bimportScripts\s*\(/,
  'module worker must not use importScripts'
);
assert.match(
  worker,
  /^\s*import\s/m,
  'module worker must have at least one top-level import statement'
);
// ORT must come from the local ESM bundle setup.sh fetches.
assert.match(
  worker,
  /from\s+['"][^'"]*\.mjs['"]/,
  'module worker must import ORT from a .mjs (ESM) file'
);
assert.match(
  worker,
  /from\s+['"]\.\/inference-pipeline\.js['"]/,
  "must import './inference-pipeline.js' as a module"
);
assert.match(
  worker,
  /from\s+['"]\.\/modules\/brain-extraction\.js['"]/,
  'must import brain-extraction.js'
);

// ---- (2) dead SCT code stripped ----
assert.doesNotMatch(
  worker,
  /\bvertebrae\b|\bvertebral\b/i,
  'no vertebrae / vertebral references in worker'
);
assert.doesNotMatch(
  worker,
  /SpinalCordToolbox/i,
  'no SCT product branding in worker (banner included)'
);
assert.doesNotMatch(
  worker,
  /SCTModelCache/,
  "no SCTModelCache string (rename to lnm-models cache)"
);
assert.doesNotMatch(
  worker,
  /['"]spinalcord['"]/,
  "no 'spinalcord' taskId default fallback"
);
assert.doesNotMatch(
  worker,
  /\blocalforage\b/i,
  'localforage must be removed entirely (Cache Storage replaces it)'
);
assert.doesNotMatch(
  worker,
  /case\s+['"]run-vertebral-labeling['"]/,
  "dead 'run-vertebral-labeling' case must be gone"
);
// The legacy single-shot 'run' message handler must also be gone (it baked
// in SCT settings shapes).
assert.doesNotMatch(
  worker,
  /case\s+['"]run['"]\s*:/,
  "legacy 'run' shim must be gone"
);

// ---- (3) Cache Storage replacement ----
assert.match(
  worker,
  /\bcaches\.open\s*\(/,
  "fetchModel must use Cache Storage (caches.open)"
);
assert.match(
  worker,
  /['"]lnm-models[-_a-z0-9]*['"]/i,
  "cache name must include 'lnm-models'"
);

// ---- (4) run-synthstrip op + stepSynthStrip adapter ----
assert.match(
  worker,
  /case\s+['"]run-synthstrip['"]/,
  "worker dispatch must handle 'run-synthstrip'"
);
assert.match(
  worker,
  /case\s+['"]run-deepisles-inference['"]/,
  "worker dispatch must handle the opt-in DeepISLES DWI/ADC seed route"
);
assert.match(
  worker,
  /\bstepSynthStrip\s*\(/,
  "worker must define / call stepSynthStrip(...)"
);
assert.match(
  worker,
  /\brunSynthStrip\s*\(/,
  'stepSynthStrip must invoke runSynthStrip from brain-extraction.js'
);
assert.match(
  worker,
  /['"]brainmask['"]/,
  "stepSynthStrip must emit a 'brainmask' stage"
);
assert.match(
  worker,
  /['"]lnm-synthstrip['"]/,
  "stepSynthStrip must reference the 'lnm-synthstrip' modelAssetId"
);

// ---- (5) inference-pipeline is a real ES module ----
assert.match(
  pipeline,
  /^export\s/m,
  'inference-pipeline.js must use top-level ES exports'
);
assert.doesNotMatch(
  pipeline,
  /SCTInferencePipeline/,
  'no SCTInferencePipeline global (replaced by named ESM exports)'
);
assert.doesNotMatch(
  pipeline,
  /^\s*\(function\b/m,
  'no UMD IIFE wrapper (use ESM)'
);

// ---- (6) InferenceExecutor spawns module worker ----
assert.match(
  executor,
  /new\s+Worker\s*\([^)]*type:\s*['"]module['"]/,
  "InferenceExecutor must spawn the worker with { type: 'module' }"
);

// Phase 2a.1.4b: InferenceExecutor must expose runSynthStrip() that posts
// the 'run-synthstrip' worker op, and must NOT carry the dead
// runVertebralLabeling method (the worker no longer handles that op).
assert.match(
  executor,
  /\brunSynthStrip\s*\(/,
  "InferenceExecutor must define runSynthStrip(...)"
);
assert.match(
  executor,
  /['"]run-synthstrip['"]/,
  'runSynthStrip must post the run-synthstrip message type'
);
assert.doesNotMatch(
  executor,
  /\brunVertebralLabeling\s*\(/,
  'runVertebralLabeling must be removed (worker no longer handles it)'
);

// ---- (7) sanity: known-good banner / cache name ----
assert.match(
  worker,
  /(LNM|Lesion Network Mapping)/,
  'worker file should mention LNM in the banner / comments'
);

// ---- (8) Phase 28/31: SynthMorph EP routing ----
// The current browser SynthMorph graph contains 3D MaxPool nodes, which
// ORT WebGPU cannot run in NHWC layout. The worker must respect the
// manifest-declared provider order, keep WASM as the fallback provider,
// and log 'SynthMorph EP=<name>' so the smoke test can read the chosen EP.
assert.match(
  worker,
  /executionProviders\s*=\s*\[\s*['"]wasm['"]\s*\]/,
  "stepRegister must default SynthMorph executionProviders to ['wasm']"
);
assert.match(
  worker,
  /normaliseSynthMorphExecutionProviders/,
  'stepRegister must normalize manifest-declared SynthMorph execution providers'
);
assert.match(
  worker,
  /providerOrder\s*=\s*normaliseSynthMorphExecutionProviders\(executionProviders\)/,
  'stepRegister must build its provider order from the manifest-provided settings'
);
assert.match(
  worker,
  /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*providerOrder\.length\s*&&\s*!svfFlat;/,
  'stepRegister must retry providers across the whole create + run path'
);
assert.match(
  worker,
  /executionProviders:\s*\[\s*ep\s*\]/,
  'stepRegister must create each session from the selected provider candidate'
);
assert.match(
  worker,
  /SynthMorph EP=/,
  'stepRegister must log the chosen EP as "SynthMorph EP=<name>"'
);
assert.match(
  worker,
  /referenceHeaderBytes\s*=\s*copyNiftiHeaderBytes\(refBuf\)/,
  'stepRegister must preserve the lnm-mni160 reference header for target-space outputs'
);
assert.match(
  worker,
  /referenceDims\s*=\s*\[/,
  'stepRegister must preserve the lnm-mni160 reference dims for target-space outputs'
);
assert.match(
  worker,
  /postStageData\(\s*['"]registered-t1-mni160['"]/,
  'stepRegister must emit the moving T1 warped onto the fixed MNI160 grid for QC'
);
assert.match(
  worker,
  /postStageData\(\s*['"]registration-displacement-mag['"]/,
  'stepRegister must emit a displacement-magnitude map for registration QC'
);
assert.match(
  worker,
  /displacementMagnitudeField/,
  'stepRegister must compute displacement magnitude through the registration helper'
);
assert.match(
  worker,
  /brainMaskBuffer/,
  'stepRegister must accept a prealigned brain mask for masked SynthMorph normalization'
);
assert.match(
  worker,
  /robustNormalizeMasked/,
  'stepRegister must robustly normalize registration inputs inside foreground masks'
);
assert.match(
  worker,
  /foregroundMaskFromScalar\(targetData,\s*0\.05\)/,
  'stepRegister must derive the MNI-template foreground mask before masked normalization'
);

// ---- (9) Patient-space threshold projection ----
assert.match(
  worker,
  /inverseWarpVolume/,
  'worker must import/use inverseWarpVolume for patient-space threshold projection'
);
assert.match(
  worker,
  /case\s+['"]inverse-warp-mask['"]/,
  "worker dispatch must handle 'inverse-warp-mask'"
);
assert.match(
  worker,
  /stage\s*=\s*['"]threshold-patient['"]/,
  "inverse-warp-mask must default its output stage to 'threshold-patient'"
);
assert.match(
  worker,
  /labelMap\s*=\s*false/,
  "inverse-warp-mask must default to binary masks unless labelMap is requested"
);
assert.match(
  worker,
  /createOutputNifti\(\s*warpedBin,\s*workerState\.referenceHeaderBytes/s,
  'warp-mask must wrap mni-lesion output with the fixed lnm-mni160 reference header'
);
assert.match(
  worker,
  /Math\.round\(projected\[i\]\)/,
  'label-map inverse warp must preserve integer atlas labels instead of binarising them'
);
assert.match(
  worker,
  /createOutputNifti\(\s*projectedOut,\s*workerState\.origHeaderBytes,\s*workerState\.origDims\s*\)/,
  'inverse-warp-mask must keep patient-space outputs on the source structural header'
);
assert.match(
  executor,
  /\brunInverseWarpMask\s*\(/,
  'InferenceExecutor must expose runInverseWarpMask(...)'
);
assert.match(
  executor,
  /['"]inverse-warp-mask['"]/,
  'runInverseWarpMask must post the inverse-warp-mask message type'
);

console.log(
  'inference-worker module-worker migration OK: 9 invariants, ' +
  '28+ source-grep assertions.'
);
