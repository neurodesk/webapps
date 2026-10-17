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

// ---- manifest: SEALS fold 0 is registered, pinned and enabled ----
const asset = manifest.modelAssets.find(entry => entry.id === 'lnm-deepisles-seals-fold0');
assert.ok(asset, 'the manifest registers the SEALS DWI/ADC seed');
assert.equal(asset.supportStatus, 'supported');
assert.equal(asset.inputModality, 'DWI_ADC');
assert.deepEqual(asset.inputContrasts, ['TRACE', 'ADC']);
assert.deepEqual(asset.preprocessing?.channelOrder, ['TRACE', 'ADC'], 'nnU-Net channel 0 is DWI/TRACE, 1 is ADC');
assert.deepEqual(asset.patchSize, [128, 128, 128]);
assert.equal(asset.testTimeAugmentation, true, "SEALS' 8 mirrorings");
assert.match(asset.checksum, /^sha256:[0-9a-f]{64}$/, 'the asset is pinned by checksum');
assert.match(asset.sourceUrl, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\//, 'the asset is pinned to a dataset commit');
assert.equal(manifest.modelAssets.some(entry => /nvauto/.test(entry.id)), false, 'the NVAUTO candidate is gone');

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
  // The viewer as NiiVue sees it: the base, then overlays in load order.
  app.viewerStack = [];
  app.viewerController = {
    loadBaseVolume: async (file, options) => {
      await app.viewerDelay?.(file);
      app.viewerStack = [[file.name, options.stage]];
      return true;
    },
    loadOverlay: async (file, colormap, opacity, options) => {
      app.viewerStack.push([file.name, options.stage]);
      return true;
    },
    replaceOverlayForStage: async (stage, file) => {
      app.viewerStack = app.viewerStack.filter(([, s]) => s !== stage);
      app.viewerStack.push([file.name, stage]);
      return true;
    }
  };
  app.refreshViewerLayerControls = () => {};
  app.refreshMaskDrawingControls = () => {};
  app._autoPromotePipeline = () => {};
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
  assert.deepEqual(app.viewerStack, [['sub-1_trace.nii', 'deepisles-dwi']], 'with nothing else loaded, DWI/TRACE is shown as the base');
  assert.equal(await app.setDeepIslesInput('adc', adc), adc);
  assert.deepEqual(app.viewerStack, [['sub-1_adc.nii', 'deepisles-adc']]);
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

// ---- with a T1 loaded, DWI/ADC is an overlay and the T1 stays the base ----
{
  const app = makeApp(manifest);
  await app.setStructural(structural);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('adc', adc);
  assert.deepEqual(app.viewerStack, [['sub-1_T1w.nii', 'structural'], ['sub-1_adc.nii', 'deepisles-input']],
    'the T1 stays the base and the latest diffusion input replaces the previous overlay');
  assert.equal(app.getActiveViewerBaseFile(), structural, 'T1-space overlays are still checked against the T1');

  app.maskReviewActive = true;
  await app.setDeepIslesInput('dwi', dwi);
  assert.deepEqual(app.viewerStack.at(-1), ['sub-1_adc.nii', 'deepisles-input'], 'mask review leaves the viewer alone');
  assert.equal(app.deepIslesDwiFile, dwi, 'the input is still stored during mask review');
}

// ---- a slow DWI base load cannot finish after, and replace, a later T1 ----
{
  const app = makeApp(manifest);
  let release;
  app.viewerDelay = file => file === dwi ? new Promise(resolve => { release = resolve; }) : null;
  const dwiLoad = app.setDeepIslesInput('dwi', dwi);
  await new Promise(resolve => setImmediate(resolve));
  const t1Load = app.setStructural(structural);
  release();
  await Promise.all([dwiLoad, t1Load]);
  assert.deepEqual(app.viewerStack, [['sub-1_T1w.nii', 'structural']]);
  assert.equal(app.getActiveViewerBaseFile(), structural);

  // An overlay chosen while the T1 is still loading lands on the T1, not under it.
  app.viewerDelay = file => file === structural ? new Promise(resolve => { release = resolve; }) : null;
  const reload = app.setStructural(structural);
  const adcLoad = app.setDeepIslesInput('adc', adc);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([reload, adcLoad]);
  assert.deepEqual(app.viewerStack, [['sub-1_T1w.nii', 'structural'], ['sub-1_adc.nii', 'deepisles-input']]);
}

// ---- brain extraction waits for a pending T1 base, and a render error never strands it ----
{
  const app = makeApp(manifest);
  const synthstrip = manifest.modelAssets.find(entry => entry.id === 'lnm-synthstrip');
  app.executor.loadVolume = async () => true;
  app.executor.runSynthStrip = async () => {
    app.executorCalls.push(['runSynthStrip', app.viewerStack.map(([name]) => name)]);
    app.handleStageData({ stage: 'brainmask', niftiData: await structural.arrayBuffer() });
    app.handleStepComplete('brainmask');
  };
  await app.setDeepIslesInput('dwi', dwi);
  let release;
  app.viewerDelay = file => file === structural ? new Promise(resolve => { release = resolve; }) : null;
  const t1Load = app.setStructural(structural);
  const extraction = app.runBrainExtraction();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.executorCalls, [], 'SynthStrip waits while the T1 base is still loading');
  release();
  await Promise.all([t1Load, extraction]);
  assert.deepEqual(app.executorCalls, [['runSynthStrip', ['sub-1_T1w.nii']]], 'SynthStrip starts once the T1 is the base');
  assert.ok(synthstrip, 'the manifest has the SynthStrip asset this check exercises');

  // A brain mask that cannot be drawn on the current base is logged, and the waiter still resolves.
  app.viewerBaseFile = dwi;
  const waited = app._waitForStageData('brainmask');
  app.handleStageData({ stage: 'brainmask', niftiData: await structural.arrayBuffer() });
  await waited;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.messages.some(message => /^Brain mask render error: Brain mask overlay/.test(message)));
}

const t1Affine = [[1, 0, 0, -4], [0, 1, 0, -4], [0, 0, 1, -4], [0, 0, 0, 1]];
function stubRun(app) {
  app.prepareViewerForLesionSegmentation = async () => {};
  app._waitForStageData = async () => {};
  app._waitForStepComplete = async () => {};
}

// ---- preconditions ----
{
  const app = makeApp(manifest);
  stubRun(app);
  await assert.rejects(app.runDeepIslesSegmentation(), /^Error: DeepISLES requires a DWI\/TRACE input\.$/);

  // A T1 never stands in for b0, even on the DWI grid: geometry is not contrast.
  await app.setStructural(niftiFile('sub-1_T1w_on_dwi.nii', [8, 8, 8], dwiAffine));
  await app.setDeepIslesInput('dwi', dwi);
  assert.equal(app.diffusionSeedReady(), false);
  await assert.rejects(app.runDeepIslesSegmentation(), /DeepISLES requires ADC or b0 with the DWI\/TRACE/);
  assert.deepEqual(app.executorCalls, [], 'nothing is sent to the worker');
}

// ---- the asset gate: only a supported, registered asset runs ----
{
  for (const [assets, message] of [
    [manifest.modelAssets.map(entry => (entry === asset ? { ...asset, supportStatus: 'benchmark-only' } : entry)), /'lnm-deepisles-seals-fold0' is benchmark-only/],
    [manifest.modelAssets.filter(entry => entry !== asset), /Manifest is missing the 'lnm-deepisles-seals-fold0' model asset/]
  ]) {
    const app = makeApp({ ...manifest, modelAssets: assets });
    stubRun(app);
    await app.setStructural(structural);
    await app.setDeepIslesInput('dwi', dwi);
    await app.setDeepIslesInput('adc', adc);
    await assert.rejects(app.runDeepIslesSegmentation(), message);
    assert.deepEqual(app.executorCalls, [], 'no inference runs, and no other model is substituted');
  }
}

// ---- T1 + DWI/TRACE + ADC: SynthStrip on the DWI, seed projected by scanner coordinates ----
{
  const app = makeApp(manifest);
  stubRun(app);
  await app.setStructural(structural);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('adc', adc);
  await app.runDeepIslesSegmentation();
  const [method, settings] = app.executorCalls[0];
  assert.equal(method, 'runDeepIslesInference');
  assert.equal(settings.modelAssetId, 'lnm-deepisles-seals-fold0');
  assert.equal(`${settings.modelBaseUrl}/${settings.modelName}`, asset.sourceUrl, 'the pinned asset URL is used');
  assert.equal(settings.cacheKey, asset.cacheKey);
  assert.equal(settings.supportStatus, 'supported');
  assert.deepEqual(settings.channelOrder, ['TRACE', 'ADC']);
  assert.equal(settings.testTimeAugmentation, true);
  assert.equal(settings.dwiBuffer.byteLength, dwi.size);
  assert.equal(settings.adcBuffer.byteLength, adc.size);
  assert.equal(settings.b0Buffer, null);
  assert.equal(settings.brainMaskBuffer, null, 'no brain mask exists on the DWI grid');
  const synthstrip = manifest.modelAssets.find(entry => entry.id === 'lnm-synthstrip');
  assert.equal(`${settings.synthStrip.modelBaseUrl}/${settings.synthStrip.modelName}`, synthstrip.sourceUrl, 'the worker strips the DWI with SynthStrip');
  assert.equal(app.deepIslesSeedCompatibleWithNativeT1, false);
  assert.match(app.messages.at(-1), /shown on the structural image by scanner coordinates/);

  // The DWI-grid seed (2 mm, 8^3) lands on the T1 grid (1 mm, 8^3) by its affine.
  const seedBox = new Float32Array(512);
  for (let z = 3; z < 5; z++) for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) seedBox[x + 8 * (y + 8 * z)] = 1;
  const seed = new File([writeNifti1(seedBox, { dims: [8, 8, 8], affine: Float64Array.from(dwiAffine.flat()) })], 'seed.nii');
  app.tagFileSpace(seed, { space: VOLUME_SPACES.NATIVE_DWI, role: 'lesion-seed' });
  const native = await app.resampleSeedMaskToNative(seed);
  const projected = (await import('nifti-reader-js'));
  const bytes = await native.arrayBuffer();
  const data = new Uint8Array(projected.readImage(projected.readHeader(bytes), bytes));
  // DWI voxels 3 and 4 sit at world -2 and 0 mm; nearest neighbour takes
  // T1 voxels 1..4 (world -3..0 mm; -3 mm is half-way and rounds up into voxel 3).
  const lit = [];
  for (let i = 0; i < data.length; i++) if (data[i]) lit.push([i % 8, Math.floor(i / 8) % 8, Math.floor(i / 64)].join(','));
  assert.equal(lit.length, 4 ** 3, 'a 2x2x2 seed at 2 mm covers 4x4x4 voxels at 1 mm');
  assert.ok(lit.includes('1,1,1') && lit.includes('4,4,4') && !lit.includes('5,5,5') && !lit.includes('0,0,0'));
}

// ---- b0 + DWI/TRACE, no T1: the b0 stands in for ADC and for the structural image ----
{
  const app = makeApp(manifest);
  stubRun(app);
  const b0 = niftiFile('sub-1_b0.nii', [8, 8, 8], dwiAffine);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('b0', b0);
  assert.equal(app.diffusionSeedReady(), true, 'Run analysis takes the DeepISLES seed');
  await app.ensureStructuralForDiffusion();
  assert.equal(app.structuralFile.name, b0.name, 'the b0 is the structural image');
  assert.notEqual(app.structuralFile, b0, 'a copy, so the b0 keeps its own space tag');
  assert.equal(getSpatialMetadata(b0).space, 'native-dwi');
  const brainmask = niftiFile('brainmask.nii', [8, 8, 8], dwiAffine);
  app.nativeBrainmaskFile = brainmask;
  await app.runDeepIslesSegmentation();
  const settings = app.executorCalls[0][1];
  assert.equal(settings.adcBuffer, null);
  assert.equal(settings.b0Buffer.byteLength, b0.size, 'the b0 is sent to compute ADC');
  assert.equal(settings.brainMaskBuffer.byteLength, brainmask.size, 'the b0 brain mask is reused on the DWI grid');
  assert.equal(app.deepIslesSeedCompatibleWithNativeT1, true);
  assert.match(app.messages.at(-1), /ADC computed from b0/);
}

// ---- DWI/TRACE + ADC, no T1 or b0: the DWI/TRACE is the structural image ----
{
  const app = makeApp(manifest);
  stubRun(app);
  await app.setDeepIslesInput('dwi', dwi);
  assert.equal(app.diffusionSeedReady(), false, 'TRACE alone is not enough');
  await assert.rejects(app.ensureStructuralForDiffusion(), /DWI\/TRACE needs ADC or b0 for the lesion seed/);
  assert.equal(app.structuralFile, null, 'TRACE alone never reaches the T1 model');
  await app.runFullPipeline();
  assert.match(app.messages.at(-1), /DWI\/TRACE needs ADC or b0/);
  assert.equal(app.structuralFile, null);

  await app.setDeepIslesInput('adc', adc);
  await app.runDeepIslesSegmentation();
  assert.equal(app.structuralFile.name, dwi.name);
  assert.equal(app.deepIslesSeedCompatibleWithNativeT1, true, 'the seed is reviewed on the TRACE itself');
}

// ---- inputs from one subject never seed another ----
{
  // Replacing the T1 drops the previous subject's diffusion inputs.
  const app = makeApp(manifest);
  app.clearResults = () => {};
  await app.setStructural(structural);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('adc', adc);
  await app.setStructural(niftiFile('sub-2_T1w.nii', [8, 8, 8], t1Affine));
  assert.equal(app.deepIslesDwiFile, null);
  assert.equal(app.deepIslesAdcFile, null);
  assert.equal(app.diffusionSeedReady(), false, 'the new T1 gets the T1 model');

  // A T1 added after a diffusion stand-in belongs to the same subject.
  const second = makeApp(manifest);
  await second.setDeepIslesInput('dwi', dwi);
  await second.setDeepIslesInput('adc', adc);
  await second.ensureStructuralForDiffusion();
  await second.setStructural(structural);
  assert.equal(second.deepIslesDwiFile, dwi, 'the diffusion inputs stay');
  assert.equal(second.diffusionSeedReady(), true);
}
{
  // Replacing a diffusion input invalidates the lesion built from it, and a
  // structural stand-in copied from it.
  const app = makeApp(manifest);
  const cleared = [];
  app.clearResults = ({ full }) => {
    cleared.push(full);
    app.autoLesionSeedFile = null;
    if (full) app.structuralFile = null;
  };
  const b0 = niftiFile('sub-1_b0.nii', [8, 8, 8], dwiAffine);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('b0', b0);
  assert.deepEqual(cleared, [], 'first loads clear nothing');
  await app.ensureStructuralForDiffusion();
  await app.setDeepIslesInput('adc', adc);
  app.lesionSource = 'other';
  await app.setDeepIslesInput('adc', niftiFile('sub-1_adc_v2.nii', [8, 8, 8], dwiAffine));
  assert.deepEqual(cleared, [], 'a lesion not made from diffusion input stays');
  app.lesionSource = 'diffusion';
  await app.setDeepIslesInput('dwi', niftiFile('sub-1_trace_v2.nii', [8, 8, 8], dwiAffine));
  assert.deepEqual(cleared, [false], 'a new TRACE clears its DeepISLES lesion and results, not the b0 stand-in');
  assert.equal(app.autoLesionSeedFile, null);
  assert.equal(app.structuralFromDiffusion, b0);
  await app.setDeepIslesInput('b0', niftiFile('sub-1_b0_v2.nii', [8, 8, 8], dwiAffine));
  assert.deepEqual(cleared, [false, true], 'a new b0 also drops the structural copy made from the old one');
  assert.equal(app.structuralFromDiffusion, null);
}
{
  // Adding an input for the first time also changes the seed's inputs:
  // TRACE + b0 gave the lesion, ADC now arrives, the lesion must go.
  const app = makeApp(manifest);
  const cleared = [];
  app.clearResults = ({ full }) => cleared.push(full);
  await app.setStructural(structural);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('b0', niftiFile('sub-1_b0.nii', [8, 8, 8], dwiAffine));
  // The real seed handler records the source; prealign then replaces the
  // seed file and confirmation keeps only the mask.
  const seedBytes = writeNifti1(new Float32Array(512), { dims: [8, 8, 8], affine: Float64Array.from(dwiAffine.flat()) });
  app.refreshMaskDrawingControls = () => {};
  app.handleStageData({ stage: 'segmentation', niftiData: seedBytes, taskId: 'lnm-deepisles-seed' });
  assert.equal(app.lesionSource, 'diffusion');
  app.autoLesionSeedFile = null;
  app.lesionMaskConfirmed = true;
  app.lesionFile = { name: 'lesion-atlas-grid.nii' };
  await app.setDeepIslesInput('adc', adc);
  assert.deepEqual(cleared, [false], 'the first ADC clears the TRACE + b0 lesion and its results');
  assert.equal(app.lesionFile, null, 'and the atlas-grid lesion warped from it');
}
{
  // A blank or uploaded mask after a DeepISLES seed no longer depends on
  // the diffusion inputs.
  for (const start of ['blank', 'upload']) {
    const app = makeApp(manifest);
    const cleared = [];
    app.clearResults = ({ full }) => cleared.push(full);
    await app.setStructural(structural);
    await app.setDeepIslesInput('dwi', dwi);
    app.refreshMaskDrawingControls = () => {};
    app.handleStageData({
      stage: 'segmentation',
      niftiData: writeNifti1(new Float32Array(512), { dims: [8, 8, 8], affine: Float64Array.from(dwiAffine.flat()) }),
      taskId: 'lnm-deepisles-seed'
    });
    app.startLesionMaskReview = async ({ blank = false } = {}) => {
      if (blank) app.lesionSource = 'other';
    };
    if (start === 'blank') {
      // The real method's first lines decide the source; run them.
      delete app.startLesionMaskReview;
      app.maskDrawingController = { startBlank() {}, loadSeedFile: async () => {} };
      app.setMaskDrawingTool = () => {};
      app.applyMaskDrawingVisibility = () => {};
      app.setMaskReview3DRenderEnabled = () => {};
      await app.startLesionMaskReview({ blank: true });
    } else {
      await app.startUploadedLesionMaskReview(niftiFile('manual.nii', [8, 8, 8], t1Affine));
    }
    assert.equal(app.lesionSource, 'other', start);
    if (start === 'blank') assert.equal(app.autoLesionSeedFile, null, 'review re-entry cannot restore the DeepISLES seed');
    await app.setDeepIslesInput('adc', adc);
    assert.deepEqual(cleared, [], `a ${start} mask survives a new ADC`);
  }
}

// ---- changing an input mid-run cancels DeepISLES; the stand-in mark is synchronous ----
{
  const app = makeApp(manifest);
  app.prepareViewerForLesionSegmentation = async () => {};
  let cancelled = 0;
  app.executor.cancel = () => { cancelled++; };
  await app.setStructural(structural);
  await app.setDeepIslesInput('dwi', dwi);
  await app.setDeepIslesInput('adc', adc);
  const run = app.runDeepIslesSegmentation();
  const outcome = run.then(() => 'resolved', err => err.message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app._deepIslesRunning, true, 'the worker is running SEALS');
  await app.setDeepIslesInput('adc', niftiFile('sub-1_adc_v2.nii', [8, 8, 8], dwiAffine));
  assert.equal(cancelled, 1, 'the old run is cancelled');
  assert.equal(await outcome, 'DeepISLES cancelled: the ADC input changed.');
  assert.equal(app._deepIslesRunning, false);
  assert.equal(app.autoLesionSeedFile, null, 'no seed from the old inputs');

  const marked = makeApp(manifest);
  const source = niftiFile('sub-1_b0.nii', [8, 8, 8], dwiAffine);
  const loading = marked.setStructural(new File([source], source.name), { fromDiffusion: source });
  assert.equal(marked.structuralFromDiffusion, source, 'marked before the structural load awaits');
  await loading;
  const t1Loading = marked.setStructural(structural);
  assert.equal(marked.structuralFromDiffusion, null, 'a T1 is never marked as a stand-in');
  await t1Loading;
}

// ---- Run analysis picks the seed model from the inputs ----
for (const [label, setup, expected] of [
  ['T1 only', async app => app.setStructural(structural), 'runLesionSegmentation'],
  ['T1 + DWI/TRACE + ADC', async app => {
    await app.setStructural(structural);
    await app.setDeepIslesInput('dwi', dwi);
    await app.setDeepIslesInput('adc', adc);
  }, 'runDeepIslesSegmentation'],
  ['T1 + DWI/TRACE, no ADC or b0', async app => {
    await app.setStructural(structural);
    await app.setDeepIslesInput('dwi', dwi);
  }, 'runLesionSegmentation'],
  ['T1 + DWI/TRACE + b0', async app => {
    await app.setStructural(structural);
    await app.setDeepIslesInput('dwi', dwi);
    await app.setDeepIslesInput('b0', niftiFile('sub-1_b0.nii', [8, 8, 8], dwiAffine));
  }, 'runDeepIslesSegmentation']
]) {
  const app = makeApp(manifest);
  await setup(app);
  const ran = [];
  app.runLesionSegmentation = async () => ran.push('runLesionSegmentation');
  app.runDeepIslesSegmentation = async () => ran.push('runDeepIslesSegmentation');
  app.startLesionMaskReview = async () => null;
  assert.deepEqual(await app._runStage({ module: 'inference-pipeline' }), { pausedForMaskReview: true });
  assert.deepEqual(ran, [expected], label);
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
