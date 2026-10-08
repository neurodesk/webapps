#!/usr/bin/env node --no-warnings
// The opt-in DeepISLES DWI/ADC seed route, as the app behaves.
//
// DeepISLES stays benchmark-only until a browser candidate passes the Dice
// gap analysis. These checks run the real app methods against the real
// manifest: the gate refuses to run, never falls back to another model, and
// a DWI-space seed never enters T1 mask review on its own.
//
// The worker half of the route (two-channel tensor, ADC resampled onto the
// DWI grid, gating, seed written on the DWI grid) is executed in
// scripts/test_inference_worker.mjs; the page controls in
// scripts/test_index_html.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as niftiReader from 'nifti-reader-js';
import { writeNifti1 } from '../web/js/modules/nifti-writer.js';
import { VOLUME_SPACES, getSpatialMetadata } from '../web/js/modules/spatial-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8'));

// ---- manifest: the asset is registered, pinned and still gated ----
const asset = manifest.modelAssets.find(entry => entry.id === 'lnm-deepisles-nvauto-browser-seed');
assert.ok(asset, 'the manifest registers the DeepISLES browser seed candidate');
assert.equal(
  asset.supportStatus,
  'benchmark-only',
  'DeepISLES stays benchmark-only until the Dice 0.5 gap is explained and a browser candidate passes'
);
assert.equal(asset.inputModality, 'DWI_ADC');
assert.deepEqual(asset.inputContrasts, ['ADC', 'TRACE']);
assert.deepEqual(asset.patchSize, [192, 192, 128]);
assert.equal(asset.overlap, 0.625);
assert.deepEqual(asset.preprocessing?.channelOrder, ['ADC', 'TRACE']);
assert.equal(asset.preprocessing?.normalize, 'nonzero-zscore-channel-wise');
assert.match(asset.checksum, /^sha256:[0-9a-f]{64}$/, 'the asset is pinned by checksum');

// ---- the app ----
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8'), { url: 'http://localhost:8080/' });
for (const name of ['window', 'document', 'HTMLElement', 'customElements', 'Event', 'Node', 'MutationObserver']) {
  globalThis[name] = dom.window[name];
}
globalThis.niivue = {
  SHOW_RENDER: { NEVER: 0, AUTO: 2 },
  Niivue: class {}
};
globalThis.Worker = class {
  postMessage() {}
  terminate() {}
};
// The page loads nifti-reader-js with a script tag that installs this global.
globalThis.nifti = niftiReader;
const { LesionNetworkMappingApp } = await import(path.join(ROOT, 'web/js/lnm-app.js'));

function makeApp(manifestForApp) {
  const app = new LesionNetworkMappingApp();
  app.messages = [];
  app.updateOutput = message => app.messages.push(message);
  app.ensureManifest = async () => manifestForApp;
  app.executorCalls = [];
  for (const method of ['runDeepIslesInference', 'runInference', 'runSynthStrip', 'runRegistration']) {
    app.executor[method] = async settings => {
      app.executorCalls.push([method, settings]);
      return true;
    };
  }
  return app;
}

function niftiFile(name, dims, affine) {
  const voxels = dims[0] * dims[1] * dims[2];
  const buffer = writeNifti1(new Float32Array(voxels).fill(1), { dims, affine: Float64Array.from(affine.flat()) });
  return new File([buffer], name);
}

const dwiAffine = [[2, 0, 0, -8], [0, 2, 0, -8], [0, 0, 2, -8], [0, 0, 0, 1]];
const dwi = niftiFile('sub-1_trace.nii', [8, 8, 8], dwiAffine);
const adc = niftiFile('sub-1_adc.nii', [8, 8, 8], dwiAffine);
const structural = niftiFile('sub-1_T1w.nii', [8, 8, 8], [[1, 0, 0, -4], [0, 1, 0, -4], [0, 0, 1, -4], [0, 0, 0, 1]]);

// ---- inputs are tagged as native DWI space ----
{
  const app = makeApp(manifest);
  assert.equal(VOLUME_SPACES.NATIVE_DWI, 'native-dwi');
  assert.equal(await app.setDeepIslesInput('dwi', dwi), dwi);
  assert.equal(await app.setDeepIslesInput('adc', adc), adc);
  assert.equal(app.deepIslesDwiFile, dwi);
  assert.equal(app.deepIslesAdcFile, adc);
  const meta = getSpatialMetadata(dwi);
  assert.equal(meta.space, 'native-dwi', 'DWI/TRACE is not mistaken for a T1-space volume');
  assert.deepEqual(Array.from(meta.dims), [8, 8, 8]);
  assert.deepEqual(app.messages, [
    'DeepISLES DWI/TRACE input ready: sub-1_trace.nii',
    'DeepISLES ADC input ready: sub-1_adc.nii'
  ]);
  await assert.rejects(app.setDeepIslesInput('flair', dwi), /Unknown DeepISLES input kind 'flair'/);
  assert.equal(await app.setDeepIslesInput('dwi', null), null);
}

// ---- preconditions ----
{
  const app = makeApp(manifest);
  await app.runDeepIslesSegmentation();
  assert.deepEqual(app.messages, ['Drop a structural T1 before running a DeepISLES seed.']);

  app.structuralFile = structural;
  app.deepIslesDwiFile = dwi;
  await assert.rejects(app.runDeepIslesSegmentation(), /^Error: DeepISLES requires DWI\/TRACE and ADC inputs\.$/);
  assert.deepEqual(app.executorCalls, [], 'nothing is sent to the worker');
}

// ---- the shipped manifest refuses to run DeepISLES, loudly ----
{
  const app = makeApp(manifest);
  app.structuralFile = structural;
  app.deepIslesDwiFile = dwi;
  app.deepIslesAdcFile = adc;
  await assert.rejects(
    app.runDeepIslesSegmentation(),
    /'lnm-deepisles-nvauto-browser-seed' is benchmark-only; benchmark-only DeepISLES assets must pass the Dice gap analysis/
  );
  assert.deepEqual(app.executorCalls, [], 'no inference runs, and no other model is substituted');
  assert.equal(app.autoLesionSeedFile, null, 'no seed appears');

  const withoutAsset = makeApp({ ...manifest, modelAssets: manifest.modelAssets.filter(entry => entry !== asset) });
  withoutAsset.structuralFile = structural;
  withoutAsset.deepIslesDwiFile = dwi;
  withoutAsset.deepIslesAdcFile = adc;
  await assert.rejects(withoutAsset.runDeepIslesSegmentation(), /Manifest is missing the 'lnm-deepisles-nvauto-browser-seed' model asset/);
}

// ---- once validated: the manifest geometry reaches the worker, and a
//      DWI-space seed does not start T1 mask review ----
{
  const validated = {
    ...manifest,
    modelAssets: manifest.modelAssets.map(entry => (entry === asset ? { ...asset, supportStatus: 'supported' } : entry))
  };
  const app = makeApp(validated);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('adc', adc);
  app.structuralFile = structural;
  app.nativeStructuralFile = structural;
  app.prepareViewerForLesionSegmentation = async () => {};
  app._waitForStageData = async () => {};
  app._waitForStepComplete = async () => {};

  await app.runDeepIslesSegmentation();
  assert.equal(app.executorCalls.length, 1);
  const [method, settings] = app.executorCalls[0];
  assert.equal(method, 'runDeepIslesInference');
  assert.equal(settings.modelAssetId, 'lnm-deepisles-nvauto-browser-seed');
  assert.equal(`${settings.modelBaseUrl}/${settings.modelName}`, asset.sourceUrl, 'the pinned asset URL is used');
  assert.equal(settings.cacheKey, asset.cacheKey);
  assert.equal(settings.supportStatus, 'supported');
  assert.deepEqual(settings.patchSize, [192, 192, 128]);
  assert.equal(settings.overlap, 0.625);
  assert.equal(settings.threshold, asset.probabilityThreshold);
  assert.equal(settings.minComponentSize, asset.minComponentSize);
  assert.deepEqual(settings.channelOrder, ['ADC', 'TRACE']);
  assert.equal(settings.dwiBuffer.byteLength, dwi.size);
  assert.equal(settings.adcBuffer.byteLength, adc.size);

  // The DWI grid (2 mm) is not the native T1 grid (1 mm).
  assert.equal(app.deepIslesSeedCompatibleWithNativeT1, false);
  assert.equal(
    app.messages.at(-1),
    'DeepISLES seed is in DWI space and does not match the native T1 grid; ' +
    'not starting T1 mask review or downstream CALMaR mapping automatically.'
  );

  // A DWI acquired on the T1 grid may be reviewed on the T1.
  const aligned = niftiFile('aligned_trace.nii', [8, 8, 8], [[1, 0, 0, -4], [0, 1, 0, -4], [0, 0, 1, -4], [0, 0, 0, 1]]);
  await app.setDeepIslesInput('dwi', aligned);
  await app.runDeepIslesSegmentation();
  assert.equal(app.deepIslesSeedCompatibleWithNativeT1, true);
}

// ---- static contract of the opt-in Python gap harness ----
// Labelled source check: `npm run benchmark:deepisles-gap` needs Python
// packages the Node-only CI does not install, so its one documented
// requirement (a mandatory --reference-prediction argument) is pinned as
// text. scripts/test_lesion_model_benchmark.mjs holds the benchmark's pins.
const gapHarness = fs.readFileSync(path.join(ROOT, 'scripts/deepisles_gap_analysis.py'), 'utf8');
assert.match(
  gapHarness,
  /parser\.add_argument\("--reference-prediction", type=Path, required=True,/,
  'the gap harness requires --reference-prediction'
);

console.log('DeepISLES browser seed OK: manifest gate, app preconditions, loud refusal and DWI-space handling executed.');
process.exit(0);
