#!/usr/bin/env node --no-warnings
// Contract test for web/js/app/lnm-tasks.js: the LNM_PIPELINES manifest must
// expose well-formed pipelines and the helpers used by the app to validate
// stage definitions. Written before lnm-tasks.js per the project's TDD policy.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tasksUrl = pathToFileURL(path.join(ROOT, 'web/js/app/lnm-tasks.js'));

const {
  LNM_PIPELINES,
  getPipelineById,
  getRequiredAssetIds,
  isStageRunnable,
  isPipelineRunnable
} = await import(tasksUrl);

assert.ok(Array.isArray(LNM_PIPELINES) && LNM_PIPELINES.length >= 1,
  'LNM_PIPELINES must export a non-empty array');

// Phase 1 ships the 'lnm-yeo-only' pipeline (manual mask -> Yeo7 overlap).
// The 'lnm-default' Schaefer/development-fMRI pipeline remains hidden because
// the visible Atlas selector is the supported Schaefer surface.
const yeo = getPipelineById('lnm-yeo-only');
assert.ok(yeo, "Pipeline 'lnm-yeo-only' must exist for Phase 1");
assert.ok(typeof yeo.displayName === 'string' && yeo.displayName.length > 0);
assert.ok(Array.isArray(yeo.stages) && yeo.stages.length >= 1,
  "lnm-yeo-only must declare at least one stage");

// The Yeo-only pipeline must include a parcel-overlap stage that references
// the Yeo7 atlas.
const overlapStage = yeo.stages.find(s => s.module === 'parcel-overlap');
assert.ok(overlapStage, "lnm-yeo-only must contain a parcel-overlap stage");
assert.ok(overlapStage.atlasAssetId, 'parcel-overlap stage must declare atlasAssetId');
assert.match(overlapStage.atlasAssetId, /yeo/i, 'Phase 1 atlas must be Yeo-based');

// Stage IDs must be unique within a pipeline.
for (const pipeline of LNM_PIPELINES) {
  const ids = pipeline.stages.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length,
    `pipeline ${pipeline.id} has duplicate stage IDs`);
  // Pipeline IDs must follow lnm-* convention so the routing layer can pick
  // them up consistently (see test_lnm_manifest).
  assert.match(pipeline.id, /^lnm-/,
    `pipeline ID must start with 'lnm-': got ${pipeline.id}`);
}

// getRequiredAssetIds returns the union of modelAssetId + atlasAssetId +
// connectomeAssetId across all stages in a pipeline. Used by the loader to
// fetch the right entries from manifest.json before running.
const yeoAssets = getRequiredAssetIds(yeo);
assert.ok(Array.isArray(yeoAssets) && yeoAssets.includes(overlapStage.atlasAssetId),
  'getRequiredAssetIds must surface the Yeo atlas asset ID');

// isStageRunnable returns true only for stages whose module is implemented and
// (if required) whose asset ID is provided. For the Phase 1 Yeo overlap stage
// this must be true.
assert.equal(isStageRunnable(overlapStage), true,
  'Phase 1 Yeo overlap stage must be runnable');

// A stage with required:true and no module/assets must NOT be runnable —
// guards against the SCT regression where missing assets fell back silently.
assert.equal(
  isStageRunnable({ id: 'broken', module: 'fc-weighted-sum', required: true }),
  false,
  'a stage missing its required assets must be flagged not-runnable'
);

// Phase 4: lnm-network-map pipeline (manual MNI lesion mask + Yeo7 atlas
// + Yeo7 group-FC pack -> per-voxel weighted-sum t-map).
const netMap = getPipelineById('lnm-network-map');
assert.ok(netMap, "Phase 4 must define an 'lnm-network-map' pipeline");
const fcStage = netMap.stages.find(s => s.id === 'fc');
assert.ok(fcStage, "lnm-network-map must declare an 'fc' stage");
assert.equal(fcStage.module, 'fc-weighted-sum');
assert.equal(fcStage.connectomeAssetId, 'yeo7-fc-pack');
assert.equal(isStageRunnable(fcStage), true,
  'fc stage must be runnable (Phase 4 wires fc-weighted-sum)');
const netMapThreshold = netMap.stages.find(s => s.module === 'threshold');
assert.equal(netMapThreshold?.defaults?.mode, undefined,
  'lnm-network-map threshold defaults must not expose a threshold mode; connectivity-map UI is top-percent only');
assert.ok(netMapThreshold.defaults.value > 0 && netMapThreshold.defaults.value <= 10,
  `lnm-network-map threshold default uses top-percent semantics; expected a small top %, got ${netMapThreshold.defaults.value}`);
assert.equal(netMapThreshold.defaults.minClusterVoxels, 30,
  'lnm-network-map threshold default must use a 30-voxel min cluster filter');

// Phase 3: lnm-yeo-auto pipeline (T1 -> SynthStrip -> seg -> register ->
// warp lesion to MNI -> Yeo 7-network overlap). Declaring the structure;
// individual stage runnability requires the matching modules to be in
// IMPLEMENTED_MODULES.
const yeoAuto = getPipelineById('lnm-yeo-auto');
assert.ok(yeoAuto, "Phase 3 must define an 'lnm-yeo-auto' pipeline");
const ynStages = yeoAuto.stages.map(s => s.id);
for (const required of ['brainmask', 'segment', 'register', 'overlap']) {
  assert.ok(ynStages.includes(required),
    `lnm-yeo-auto must declare stage ${required}; got ${ynStages.join(',')}`);
}
const regStage = yeoAuto.stages.find(s => s.id === 'register');
assert.equal(regStage.module, 'registration',
  'register stage must reference the registration module');
assert.equal(regStage.modelAssetId, 'lnm-synthmorph-mni',
  'register stage must reference the lnm-synthmorph-mni model');
assert.equal(isStageRunnable(regStage), true,
  'register stage must be runnable (Phase 3.4 module + asset are wired)');
const autoThreshold = yeoAuto.stages.find(s => s.module === 'threshold');
assert.equal(autoThreshold?.defaults?.mode, undefined,
  'lnm-yeo-auto threshold defaults must not expose a threshold mode; connectivity-map UI is top-percent only');
assert.ok(autoThreshold.defaults.value > 0 && autoThreshold.defaults.value <= 10,
  `lnm-yeo-auto threshold default uses top-percent semantics; expected a small top %, got ${autoThreshold.defaults.value}`);
assert.equal(autoThreshold.defaults.minClusterVoxels, 30,
  'lnm-yeo-auto threshold default must use a 30-voxel min cluster filter');

// Phase 2a.2: lnm-segment-only pipeline (T1 -> SynthStrip -> lesion seg ->
// display + download). No registration / no atlas overlap until Phase 3.
const segOnly = getPipelineById('lnm-segment-only');
assert.ok(segOnly, "Phase 2a.2 must define an 'lnm-segment-only' pipeline");
const brainmaskStage = segOnly.stages.find(s => s.id === 'brainmask');
const segStage = segOnly.stages.find(s => s.id === 'segment');
assert.ok(brainmaskStage, "lnm-segment-only must declare a 'brainmask' stage");
assert.ok(segStage, "lnm-segment-only must declare a 'segment' stage");
assert.equal(brainmaskStage.module, 'brain-extraction',
  'brainmask stage must reference the brain-extraction module');
assert.equal(brainmaskStage.modelAssetId, 'lnm-synthstrip',
  'brainmask stage must reference the lnm-synthstrip model');
assert.equal(segStage.module, 'inference-pipeline',
  'segment stage must reference the inference-pipeline module');
assert.equal(segStage.modelAssetId, 'lnm-stroke-lesion',
  'segment stage must reference the lnm-stroke-lesion model');
assert.equal(isStageRunnable(brainmaskStage), true,
  'brainmask stage must be runnable (Phase 2a.1 module is implemented)');
assert.equal(isStageRunnable(segStage), true,
  'segment stage must be runnable (Phase 2a.2 module + asset are wired)');

// Pipeline-level runnability remains an internal guard even though the
// selector is no longer visible. Manual-mask pipelines stay hidden:true
// and are reached only through setLesion() auto-promote when a researcher
// loads a Yeo-grid mask through the Advanced disclosure.
assert.equal(isPipelineRunnable(getPipelineById('lnm-yeo-only')), false,
  'lnm-yeo-only must be HIDDEN (manual-mask path moved to Advanced)');
assert.equal(isPipelineRunnable(getPipelineById('lnm-network-map')), false,
  'lnm-network-map must be HIDDEN (manual-mask path moved to Advanced)');
assert.equal(isPipelineRunnable(getPipelineById('lnm-yeo-auto')), true,
  'lnm-yeo-auto must be a runnable pipeline (the visible default)');
assert.equal(isPipelineRunnable(getPipelineById('lnm-default')), false,
  'lnm-default is legacy internal wiring; Schaefer is selected through Atlas');

// Phase 34: lnm-yeo-auto must include the prealign stage between
// brain-extraction and lesion segmentation so the auto chain swallows
// arbitrary clinical T1s.
const auto = getPipelineById('lnm-yeo-auto');
const stageModules = auto.stages.map(s => s.module);
assert.ok(stageModules.includes('prealign'),
  `lnm-yeo-auto must include a 'prealign' stage; got [${stageModules.join(', ')}]`);
const idxBrain = stageModules.indexOf('brain-extraction');
const idxPrealign = stageModules.indexOf('prealign');
const idxSegment = stageModules.indexOf('inference-pipeline');
assert.ok(idxBrain < idxPrealign && idxPrealign < idxSegment,
  `lnm-yeo-auto stage order must be brain-extraction -> prealign -> inference-pipeline; ` +
  `got brain=${idxBrain}, prealign=${idxPrealign}, segment=${idxSegment}`);

console.log(`LNM tasks OK: ${LNM_PIPELINES.length} pipeline(s); Yeo overlap + lnm-segment-only runnable.`);
