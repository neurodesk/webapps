#!/usr/bin/env node --no-warnings
// Contract test for web/models/manifest.json under the LNM schema. Written
// before the manifest is rewritten per the project's TDD policy.
//
// The LNM manifest extends the SCT shape with:
//  - top-level 'pipelines' (renamed from 'tasks')
//  - 'atlasAssets', 'connectomeAssets', and 'annotationAssets' alongside 'modelAssets'
//  - every stage in every pipeline references an asset that exists in one of
//    the asset registries (no silent fallbacks).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(ROOT, 'web/models/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.equal(typeof manifest.schemaVersion, 'string');
assert.ok(Array.isArray(manifest.pipelines),
  "manifest must use 'pipelines' (renamed from 'tasks')");
assert.ok(!('tasks' in manifest),
  "manifest must not retain SCT 'tasks' key after LNM migration");
assert.ok(Array.isArray(manifest.atlasOptions) && manifest.atlasOptions.length >= 2,
  'manifest must declare selectable atlasOptions');

// Asset registries must exist (may be empty but must be arrays).
for (const key of ['modelAssets', 'atlasAssets', 'connectomeAssets', 'annotationAssets']) {
  assert.ok(Array.isArray(manifest[key]),
    `manifest.${key} must be an array (may be empty)`);
}

const atlasOptionsById = new Map(manifest.atlasOptions.map(option => [option.id, option]));
const schaeferOption = atlasOptionsById.get('schaefer400');
const yeoOption = atlasOptionsById.get('yeo7');
assert.ok(schaeferOption, "atlasOptions must include 'schaefer400'");
assert.ok(yeoOption, "atlasOptions must include 'yeo7'");
assert.equal(schaeferOption.displayName, 'Schaefer 400 parcels');
assert.equal(yeoOption.displayName, 'Yeo 7 networks');
assert.equal(schaeferOption.weightSource, 'parcel',
  'Schaefer option must weight FC maps by parcel');
assert.equal(yeoOption.weightSource, 'network',
  'Yeo option must weight FC maps by network');
assert.equal(schaeferOption.functionProfileAssetId, 'schaefer400-neurosynth-v7-function-profiles',
  'Schaefer option must expose its Schaefer functional-profile asset');

// Every asset entry must have id + filename + sizeBytes + checksum + cacheKey.
for (const key of ['modelAssets', 'atlasAssets', 'connectomeAssets', 'annotationAssets']) {
  for (const asset of manifest[key]) {
    for (const field of ['id', 'filename', 'sizeBytes', 'checksum', 'cacheKey']) {
      assert.ok(asset[field] !== undefined,
        `${key} asset '${asset.id || '?'}' missing field '${field}'`);
    }
  }
}

// Asset IDs must be unique across the union of all three registries (so a
// stage referencing assetId 'foo' has an unambiguous source).
const allIds = [
  ...manifest.modelAssets.map(a => a.id),
  ...manifest.atlasAssets.map(a => a.id),
  ...manifest.connectomeAssets.map(a => a.id),
  ...manifest.annotationAssets.map(a => a.id)
];
assert.equal(new Set(allIds).size, allIds.length,
  'asset IDs must be globally unique across modelAssets/atlasAssets/connectomeAssets/annotationAssets');

// Phase 2a.1: SynthStrip brain-extraction model must be registered as a
// supported modelAsset so the worker can fetch it. Pin the asset id literal
// here so a typo in either the manifest or the orchestrator surfaces fast.
const synthstrip = manifest.modelAssets.find(a => a.id === 'lnm-synthstrip');
assert.ok(synthstrip, "Phase 2a.1 manifest must register 'lnm-synthstrip' under modelAssets");
assert.equal(synthstrip.supportStatus, 'supported',
  'lnm-synthstrip must be marked supported once the model is uploaded');
assert.match(synthstrip.checksum, /^sha256:[0-9a-f]{64}$/i,
  'lnm-synthstrip must declare a real sha256 checksum');
assert.ok(typeof synthstrip.sizeBytes === 'number' && synthstrip.sizeBytes > 0,
  'lnm-synthstrip must declare a non-zero sizeBytes');
assert.match(synthstrip.sourceUrl, /huggingface\.co.+\.onnx$/,
  'lnm-synthstrip sourceUrl must point at an ONNX file on Hugging Face');
assert.equal(synthstrip.upstreamModelName, 'FreeSurfer SynthStrip main model v1 (synthstrip.1.pt)',
  'lnm-synthstrip must document the exact original FreeSurfer checkpoint variant');
assert.equal(synthstrip.upstreamSourceUrl,
  'https://surfer.nmr.mgh.harvard.edu/pub/dist/freesurfer/synthstrip/models/synthstrip.1.pt',
  'lnm-synthstrip must document the original FreeSurfer checkpoint URL');
assert.equal(synthstrip.upstreamChecksum,
  'sha256:37417f802196186441aae3e7f385d94f8a98c64a88acaeaa2723af995c653e33',
  'lnm-synthstrip must document the original FreeSurfer checkpoint checksum');
assert.match(synthstrip.conversionSource || '', /neurodesk\/vesselboost-webapp:scripts\/convert_synthstrip\.py/,
  'lnm-synthstrip must document the conversion source script');

// Phase 3: SynthMorph MNI registration model (SVF sub-model).
const synmorph = manifest.modelAssets.find(a => a.id === 'lnm-synthmorph-mni');
assert.ok(synmorph, "Phase 3 manifest must register 'lnm-synthmorph-mni' under modelAssets");
assert.equal(synmorph.supportStatus, 'supported',
  'lnm-synthmorph-mni must be supported once the SVF ONNX is uploaded');
assert.match(synmorph.checksum, /^sha256:[0-9a-f]{64}$/i,
  'lnm-synthmorph-mni must declare a real sha256 checksum');
assert.ok(typeof synmorph.sizeBytes === 'number' && synmorph.sizeBytes > 0,
  'lnm-synthmorph-mni must declare a non-zero sizeBytes');
assert.match(synmorph.sourceUrl, /huggingface\.co.+\.onnx$/,
  'lnm-synthmorph-mni sourceUrl must point at an ONNX file on Hugging Face');
assert.ok(Array.isArray(synmorph.inputShape) && synmorph.inputShape.length === 5,
  'lnm-synthmorph-mni must declare a 5D inputShape (1, X, Y, Z, 1)');
assert.ok(Array.isArray(synmorph.svfShape) && synmorph.svfShape.length === 5,
  'lnm-synthmorph-mni must declare a 5D svfShape (1, X/2, Y/2, Z/2, 3)');
assert.deepEqual(synmorph.browserRuntime?.executionProviders, ['wasm'],
  'lnm-synthmorph-mni must declare the WASM execution provider for its 3D MaxPool graph');

// Phase 4: Yeo7 group-FC pack (7 brain-wide t-maps stacked into one
// Float32 .bin). Lives under connectomeAssets so it gets the same
// streaming fetch + cache treatment as future Schaefer400 packs.
const yeoFc = manifest.connectomeAssets.find(a => a.id === 'yeo7-fc-pack');
assert.ok(yeoFc, "Phase 4 manifest must register 'yeo7-fc-pack' under connectomeAssets");
assert.equal(yeoFc.supportStatus, 'supported',
  'yeo7-fc-pack must be supported once the pack is uploaded');
assert.match(yeoFc.checksum, /^sha256:[0-9a-f]{64}$/i);
assert.ok(yeoFc.indexFilename && /\.json$/i.test(yeoFc.indexFilename),
  'yeo7-fc-pack must declare an indexFilename (byte-offsets JSON)');
assert.equal(yeoFc.parcelCount, 7, "Yeo7 FC pack must declare parcelCount=7");
assert.equal(yeoFc.dtype, 'float32');
assert.equal(yeoFc.voxelOrder, 'row-major',
  'Yeo7 FC pack must declare its NumPy row-major storage order');
assert.equal(yeoFc.statistic, 'tstat');

// Phase 2a.2: lesion-segmentation model (SynthStroke baseline) registered.
const stroke = manifest.modelAssets.find(a => a.id === 'lnm-stroke-lesion');
assert.ok(stroke, "Phase 2a.2 manifest must register 'lnm-stroke-lesion' under modelAssets");
assert.equal(stroke.supportStatus, 'supported',
  'lnm-stroke-lesion must be supported once the ONNX is exported and uploaded');
assert.match(stroke.checksum, /^sha256:[0-9a-f]{64}$/i,
  'lnm-stroke-lesion must declare a real sha256 checksum');
assert.ok(typeof stroke.sizeBytes === 'number' && stroke.sizeBytes > 0,
  'lnm-stroke-lesion must declare a non-zero sizeBytes');
assert.match(stroke.sourceUrl, /huggingface\.co.+\.onnx$/,
  'lnm-stroke-lesion sourceUrl must point at an ONNX file on Hugging Face');
assert.ok(Array.isArray(stroke.patchSize) && stroke.patchSize.length === 3,
  'lnm-stroke-lesion must declare a 3-tuple patchSize');
assert.ok(typeof stroke.probabilityThreshold === 'number',
  'lnm-stroke-lesion must declare a probabilityThreshold');
assert.ok(typeof stroke.minComponentSize === 'number',
  'lnm-stroke-lesion must declare a minComponentSize');
assert.equal(stroke.upstreamModelName, 'SynthStroke baseline',
  'lnm-stroke-lesion must document the exact upstream SynthStroke variant');
assert.equal(stroke.upstreamModelRepo, 'liamchalcroft/synthstroke-baseline',
  'lnm-stroke-lesion must document the upstream Hugging Face model repo');
assert.equal(stroke.upstreamRevision, 'b693a650026359705688fbce409219c4dbb5d6be',
  'lnm-stroke-lesion must document the observed upstream revision used for provenance');
assert.match(stroke.upstreamConfigUrl || '', /liamchalcroft\/synthstroke-baseline\/raw\/main\/config\.json/,
  'lnm-stroke-lesion must document the upstream config URL');
assert.equal(stroke.upstreamConfigChecksum,
  'sha256:2d9e7eb2ab4cb0a696ce6a845ad3123b77b31867f7ba74a271b81132cca38b1e',
  'lnm-stroke-lesion must document the upstream config checksum');
assert.match(stroke.upstreamWeightsUrl || '', /liamchalcroft\/synthstroke-baseline\/resolve\/main\/model\.safetensors/,
  'lnm-stroke-lesion must document the upstream safetensors weights URL');
assert.equal(stroke.upstreamWeightsSizeBytes, 74468100,
  'lnm-stroke-lesion must document the upstream safetensors size');
assert.equal(stroke.upstreamWeightsETag,
  'd56c089e8c4bcc0ad2281f1e80b7c0e265f3b7138dee17fb2d160487604eee66',
  'lnm-stroke-lesion must document the upstream safetensors ETag');
assert.equal(stroke.conversionSource, 'scripts/convert_lesion_seg_model.py',
  'lnm-stroke-lesion must document the conversion source script');
assert.deepEqual(stroke.conversionInputShape, [1, 1, 128, 128, 128],
  'lnm-stroke-lesion must document the ONNX trace shape');
assert.equal(stroke.conversionOpset, 17,
  'lnm-stroke-lesion must document the ONNX opset');

const deepIsles = manifest.modelAssets.find(a => a.id === 'lnm-deepisles-nvauto-browser-seed');
assert.ok(deepIsles,
  "manifest must register 'lnm-deepisles-nvauto-browser-seed' as the DeepISLES candidate asset");
assert.equal(deepIsles.supportStatus, 'benchmark-only',
  'DeepISLES candidate must not count as supported until gap analysis and browser budget gates pass');
assert.equal(deepIsles.inputModality, 'DWI_ADC',
  'DeepISLES candidate must declare that it uses DWI/ADC rather than T1');
assert.deepEqual(deepIsles.inputContrasts, ['ADC', 'TRACE'],
  'DeepISLES candidate must pin ADC + TRACE inputs');
assert.deepEqual(deepIsles.preprocessing?.channelOrder, ['ADC', 'TRACE'],
  'DeepISLES candidate must pin ADC,TRACE channel order');
assert.deepEqual(deepIsles.patchSize, [192, 192, 128],
  'DeepISLES candidate must document upstream NVAUTO patch geometry');
assert.equal(deepIsles.overlap, 0.625,
  'DeepISLES candidate must document upstream NVAUTO overlap');

// Phase 3: the SynthMorph registration target — an MNI152 brain at the
// 160x160x192 1mm grid the model was trained against. Lives under
// atlasAssets to share the same loader as Yeo / Schaefer.
const mniRef = manifest.atlasAssets.find(a => a.id === 'lnm-mni160');
assert.ok(mniRef, "Phase 3 manifest must register 'lnm-mni160' under atlasAssets");
assert.equal(mniRef.supportStatus, 'supported',
  'lnm-mni160 must be supported once the reference is uploaded');
assert.deepEqual(mniRef.dims, [160, 160, 192], "lnm-mni160 dims must be [160, 160, 192]");
assert.deepEqual(mniRef.spacingMm || mniRef.resolutionMm, 1,
  "lnm-mni160 must be 1mm isotropic (resolutionMm=1 or spacingMm=1)");

// Phase 1: the Yeo7 atlas must exist and have a sensible parcel count
// (network labels 1..7 plus 0 background -> at least 7 nonzero networks).
const yeoAtlas = manifest.atlasAssets.find(a => /yeo/i.test(a.id));
assert.ok(yeoAtlas, "Phase 1 manifest must register a Yeo atlas in atlasAssets");
assert.equal(typeof yeoAtlas.parcelCount, 'number');
assert.ok(yeoAtlas.parcelCount >= 7, 'Yeo atlas must declare >= 7 networks');
assert.ok(typeof yeoAtlas.networkLabels === 'object' && yeoAtlas.networkLabels !== null,
  'Yeo atlas must declare networkLabels (label -> network name) so the UI can render an overlap chart');
// Yeo7 network names must be present.
const yeoLabelValues = new Set(Object.values(yeoAtlas.networkLabels));
for (const expected of ['Visual', 'Default']) {
  assert.ok(yeoLabelValues.has(expected),
    `Yeo7 networkLabels must include '${expected}'`);
}

// Phase 40: Yeo7 functional profiles for exploratory Neurosynth/NiMARE terms.
const yeoProfiles = manifest.annotationAssets.find(a => a.id === 'yeo7-neurosynth-v7-function-profiles');
assert.ok(yeoProfiles,
  "Phase 40 manifest must register 'yeo7-neurosynth-v7-function-profiles' under annotationAssets");
assert.equal(yeoProfiles.supportStatus, 'supported',
  'Yeo7 function profiles must be supported once the compact JSON is committed');
assert.match(yeoProfiles.checksum, /^sha256:[0-9a-f]{64}$/i,
  'Yeo7 function profiles must declare a real sha256 checksum');
assert.ok(typeof yeoProfiles.sizeBytes === 'number' && yeoProfiles.sizeBytes > 0,
  'Yeo7 function profiles must declare a non-zero sizeBytes');
assert.match(yeoProfiles.sourceUrl, /yeo7_function_profiles\.json$/,
  'Yeo7 function profiles sourceUrl must point at the JSON payload');
assert.equal(yeoProfiles.atlasAssetId, 'yeo7-2mm',
  'Yeo7 function profiles must declare the atlas they decode');
assert.match(yeoProfiles.method, /NiMARE ROIAssociationDecoder/,
  'Yeo7 function profiles must declare the NiMARE decoder method');

const schaeferProfiles = manifest.annotationAssets.find(a => a.id === 'schaefer400-neurosynth-v7-function-profiles');
assert.ok(schaeferProfiles,
  "manifest must register 'schaefer400-neurosynth-v7-function-profiles' under annotationAssets");
assert.equal(schaeferProfiles.supportStatus, 'supported',
  'Schaefer400 function profiles must be supported once the compact JSON is committed');
assert.match(schaeferProfiles.checksum, /^sha256:[0-9a-f]{64}$/i,
  'Schaefer400 function profiles must declare a real sha256 checksum');
assert.ok(typeof schaeferProfiles.sizeBytes === 'number' && schaeferProfiles.sizeBytes > 0,
  'Schaefer400 function profiles must declare a non-zero sizeBytes');
assert.match(schaeferProfiles.sourceUrl, /schaefer400_function_profiles\.json$/,
  'Schaefer400 function profiles sourceUrl must point at the JSON payload');
assert.equal(schaeferProfiles.atlasAssetId, 'schaefer400-7n-2mm',
  'Schaefer400 function profiles must declare the atlas they decode');
assert.equal(schaeferProfiles.method, 'NiMARE ROIAssociationDecoder',
  'Schaefer400 function profiles must declare parcel-wise NiMARE ROI decoding');
assert.match(schaeferProfiles.sourceVersion, /schaefer400-parcel-roi/,
  'Schaefer400 function profiles must declare the parcel-wise ROI source build');
assert.equal(schaeferProfiles.parcelProfileCount, 400,
  'Schaefer400 function profiles must cover all 400 parcels');
assert.equal(schaeferProfiles.topTermsPerParcel, 24,
  'Schaefer400 function profiles must declare the retained term depth');
assert.equal(schaeferProfiles.minimumSourceScore, 0.01,
  'Schaefer400 function profiles must declare the source-score filter');

// Pipelines must reference atlas/model/connectome assets that exist.
const knownIds = new Set(allIds);
for (const pipeline of manifest.pipelines) {
  assert.match(pipeline.id, /^lnm-/);
  assert.ok(Array.isArray(pipeline.stages));
  for (const stage of pipeline.stages) {
    for (const refKey of ['modelAssetId', 'atlasAssetId', 'connectomeAssetId']) {
      if (stage[refKey] !== undefined) {
        assert.ok(knownIds.has(stage[refKey]),
          `pipeline ${pipeline.id} stage ${stage.id} references unknown ${refKey} '${stage[refKey]}'`);
      }
    }
  }
}

// Atlas options must reference registered assets. Schaefer's public-N155
// connectome is sharded, but it is now a supported runtime asset.
for (const option of manifest.atlasOptions) {
  assert.ok(knownIds.has(option.overlapAtlasAssetId),
    `atlas option ${option.id} overlapAtlasAssetId must reference a known asset`);
  assert.ok(knownIds.has(option.connectomeAssetId),
    `atlas option ${option.id} connectomeAssetId must reference a known asset`);
  if (option.affectedAtlasAssetId) {
    assert.ok(knownIds.has(option.affectedAtlasAssetId),
      `atlas option ${option.id} affectedAtlasAssetId must reference a known asset`);
  }
}

const schaeferAtlas = manifest.atlasAssets.find(a => a.id === 'schaefer400-7n-2mm');
assert.ok(schaeferAtlas, "manifest must register 'schaefer400-7n-2mm'");
assert.equal(schaeferAtlas.supportStatus, 'supported',
  'Schaefer 2mm overlap atlas must be supported once the official atlas metadata is wired');
assert.equal(schaeferAtlas.parcelCount, 400);
assert.deepEqual(schaeferAtlas.dims, [91, 109, 91]);
assert.match(schaeferAtlas.checksum, /^sha256:[0-9a-f]{64}$/i,
  'Schaefer atlas must declare a real sha256 checksum');
assert.equal(Object.keys(schaeferAtlas.parcelLabels || {}).length, 400,
  'Schaefer atlas must include parcelLabels for all 400 parcels');
assert.equal(schaeferAtlas.parcelLabels['1'], 'LH_Vis_1',
  'Schaefer parcelLabels must omit the 7Networks_ display prefix');
assert.ok(Object.values(schaeferAtlas.parcelLabels || {}).every(label => !String(label).startsWith('7Networks_')),
  'Schaefer 2mm parcelLabels must not expose the 7Networks_ display prefix');
assert.equal(Object.keys(schaeferAtlas.networkLabels || {}).length, 400,
  'Schaefer atlas must include 7-network membership for all 400 parcels');

const schaeferAtlas4mm = manifest.atlasAssets.find(a => a.id === 'schaefer400-7n-4mm');
assert.ok(schaeferAtlas4mm, "manifest must register 'schaefer400-7n-4mm'");
assert.equal(schaeferAtlas4mm.supportStatus, 'supported',
  'Schaefer 4mm affected-map companion atlas must be supported once the FC shards are uploaded');
assert.deepEqual(schaeferAtlas4mm.dims, [50, 59, 50]);
assert.equal(schaeferAtlas4mm.parcelCount, 400);
assert.match(schaeferAtlas4mm.checksum, /^sha256:[0-9a-f]{64}$/i,
  'Schaefer 4mm companion atlas must declare a real sha256 checksum');
assert.ok(typeof schaeferAtlas4mm.sizeBytes === 'number' && schaeferAtlas4mm.sizeBytes > 0,
  'Schaefer 4mm companion atlas must declare non-zero sizeBytes');
assert.equal(Object.keys(schaeferAtlas4mm.parcelLabels || {}).length, 400,
  'Schaefer 4mm companion atlas must include parcelLabels for all 400 parcels');
assert.equal(schaeferAtlas4mm.parcelLabels['1'], 'LH_Vis_1',
  'Schaefer 4mm parcelLabels must omit the 7Networks_ display prefix');
assert.ok(Object.values(schaeferAtlas4mm.parcelLabels || {}).every(label => !String(label).startsWith('7Networks_')),
  'Schaefer 4mm parcelLabels must not expose the 7Networks_ display prefix');
assert.equal(Object.keys(schaeferAtlas4mm.networkLabels || {}).length, 400,
  'Schaefer 4mm companion atlas must include 7-network membership for all 400 parcels');

const schaeferFc = manifest.connectomeAssets.find(a => a.id === 'schaefer400-fc-pack-development-n155-4mm');
assert.ok(schaeferFc, "manifest must register the Schaefer400 development-fMRI FC pack contract");
assert.equal(schaeferFc.supportStatus, 'supported',
  'Schaefer400 development-fMRI FC pack must be supported once lazy shards are uploaded');
assert.match(schaeferFc.checksum, /^sha256:[0-9a-f]{64}$/i,
  'Schaefer400 FC pack index must declare a real sha256 checksum');
assert.ok(typeof schaeferFc.sizeBytes === 'number' && schaeferFc.sizeBytes > 0,
  'Schaefer400 FC pack index must declare non-zero sizeBytes');
assert.equal(schaeferFc.parcelCount, 400);
assert.equal(schaeferFc.channelCount, 400);
assert.equal(schaeferFc.weightSource, 'parcel');
assert.equal(schaeferFc.dtype, 'float16');
assert.equal(schaeferFc.voxelOrder, 'row-major');
assert.equal(schaeferFc.atlasAssetId, 'schaefer400-7n-4mm');
assert.equal(schaeferFc.overlapAtlasAssetId, 'schaefer400-7n-2mm');
assert.equal(schaeferFc.sharded, true,
  'Schaefer400 FC pack must use lazy sharded loading');
assert.equal(schaeferFc.shardCount, 10);
assert.equal(schaeferFc.totalShardBytes, 118000000);
assert.match(schaeferFc.indexSourceUrl, /connectomes\/schaefer400\/schaefer400_fc_pack_dev155_4mm\.index\.json$/,
  'Schaefer400 FC pack indexSourceUrl must point at the uploaded sharded index');

// Cross-check with lnm-tasks.js: every pipeline declared in code must exist
// in the manifest so internal pipeline dispatch cannot select a pipeline whose
// assets aren't fetchable.
const tasks = await import(pathToFileURL(path.join(ROOT, 'web/js/app/lnm-tasks.js')));
const codePipelineIds = new Set(tasks.LNM_PIPELINES.map(p => p.id));
const manifestPipelineIds = new Set(manifest.pipelines.map(p => p.id));
for (const id of codePipelineIds) {
  assert.ok(manifestPipelineIds.has(id),
    `code pipeline '${id}' missing from manifest.pipelines`);
}

console.log(`LNM manifest OK: ${manifest.pipelines.length} pipeline(s); ${allIds.length} unique asset(s).`);
