#!/usr/bin/env node --no-warnings
// Phase 33 audit follow-up: behavior tests for the orchestrator's
// pipeline-driven runFullPipeline + _runStage dispatch + auto-promote.
//
// scripts/test_lnm_app.mjs is 100% source-grep — it asserts that the
// for-loop and case statements EXIST but never that they actually run
// the right stages in the right order. A regression where _runStage
// returns early after the first case, or runFullPipeline `return`s
// inside the loop, passes the source-grep but breaks the chain.
//
// This test stubs the browser globals (niivue, document, fetch, etc.)
// just enough to import LesionNetworkMappingApp, then:
//   - Replaces _runStage with a recording spy.
//   - Calls runFullPipeline with a synthetic pipeline.
//   - Asserts every stage was dispatched in declared order.
//   - Verifies an exception in one stage halts the chain (the for-loop
//     `try/catch ... return` path).
//   - Verifies _autoPromotePipeline switches selectedPipeline only
//     when the user hasn't manually picked.
//   - Verifies loading a structural image does not start processing;
//     the user must click Run analysis or an explicit stage button.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as niftiModule from 'nifti-reader-js';
import { writeNifti1 } from '../web/js/modules/nifti-writer.js';
import { LESION_MASK_COLORMAP_ID } from '../web/js/app/lnm-labels.js';
import {
  VOLUME_SPACES,
  atlasVolumeSpace,
  getSpatialMetadata,
  tagSpatialFile
} from '../web/js/modules/spatial-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- Stub browser globals before importing the orchestrator ----
// Niivue constructor is called in LesionNetworkMappingApp's constructor.
// We never touch the resulting nv instance in these tests.
globalThis.niivue = {
  SHOW_RENDER: { NEVER: 0, AUTO: 2 },
  Niivue: class {
    constructor() {}
    async attachTo() {}
    setMultiplanarPadPixels() {}
    setSliceType() {}
    sliceTypeMultiplanar = 0;
  }
};

// Minimal document stub — bindEvents() walks the DOM looking for IDs
// during init(). We never call init() in these tests so most of
// document is unused; but the constructor instantiates ConsoleOutput,
// ProgressManager, ModalManager which read DOM IDs lazily on .log()
// etc. Provide a no-op querySelector chain.
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    appendChild: () => {},
    setAttribute: () => {},
    addEventListener: () => {},
    style: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false }
  }),
  addEventListener: () => {},
  body: { appendChild: () => {} }
};
globalThis.window = globalThis;
globalThis.location = { href: 'http://localhost:8080/' };
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class {
  constructor(parts) { this.parts = parts || []; }
  async arrayBuffer() {
    const first = this.parts[0];
    if (first instanceof ArrayBuffer) return first;
    if (ArrayBuffer.isView(first)) {
      return first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength);
    }
    if (first && typeof first.arrayBuffer === 'function') return first.arrayBuffer();
    return new ArrayBuffer(0);
  }
};
globalThis.File = class {
  constructor(parts, name) { this.parts = parts; this.name = name; }
  async arrayBuffer() {
    const first = this.parts?.[0];
    if (first instanceof ArrayBuffer) return first;
    if (ArrayBuffer.isView(first)) {
      return first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength);
    }
    if (first && typeof first.arrayBuffer === 'function') return first.arrayBuffer();
    return new ArrayBuffer(0);
  }
};

const { LesionNetworkMappingApp, formatVersionLabel } =
  await import(path.join(ROOT, 'web/js/lnm-app.js'));

function makeApp() {
  const app = new LesionNetworkMappingApp();
  // Capture updateOutput so we can inspect status messages without
  // dragging in ConsoleOutput's DOM dependency.
  app._messages = [];
  app.updateOutput = (m) => { app._messages.push(m); };
  return app;
}

function useMockElements(elementsById) {
  const originalGetElementById = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => elementsById[id] || null;
  return () => { globalThis.document.getElementById = originalGetElementById; };
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Split-log routing: analysis log is condensed, technical log keeps details ----
{
  const app = new LesionNetworkMappingApp();
  const clinical = [];
  const technical = [];
  app.console = { log: (message, options) => clinical.push({ message, options }) };
  app.technicalConsole = { log: (message, options) => technical.push({ message, options }) };

  app.updateOutput('Loaded: sub-M2001_ses-1076_acq-tfl3_run-4_T1w.nii.gz');
  app.updateOutput('Loading sub-M2001_ses-1076_acq-tfl3_run-4_T1w.nii.gz...');
  app.updateOutput('sub-M2001_ses-1076_acq-tfl3_run-4_T1w.nii.gz loaded');
  app.updateOutput(
    'Prealign (PCA): centroid src voxel (77.7, 124.7, 129.1) -> world ' +
    '(3.5, 15.4, -10.2) mm; eigenvalues=[1561.1, 911.7, 833.4].'
  );
  app.updateOutput('Structural image ready: sub-M2001_ses-1076_acq-tfl3_run-4_T1w.nii.gz');
  app.updateOutput('Starting MNI registration (SynthMorph deformable)...');
  app.updateOutput('Starting MNI registration (SynthMorph deformable)...');
  app.updateOutput("Stage 'register' (registration) failed: synthetic failure");

  assert.deepEqual(
    clinical.map(entry => entry.message),
    [
      'Structural image ready.',
      'MNI registration started.',
      "Stage 'register' (registration) failed: synthetic failure"
    ],
    'analysis log must suppress file/viewer/PCA details, condense stage messages, and de-dupe repeats'
  );
  assert.ok(
    technical.some(entry => entry.message.startsWith('Loaded: sub-M2001')) &&
    technical.some(entry => entry.message.startsWith('Loading sub-M2001')) &&
    technical.some(entry => entry.message.startsWith('sub-M2001')) &&
    technical.some(entry => entry.message.startsWith('Prealign (PCA): centroid')),
    'technical log must retain full file/viewer/PCA diagnostic details'
  );
}

function makeNiftiFile(name, buffer) {
  return {
    name,
    async arrayBuffer() { return buffer; }
  };
}

function decodeNiftiForTest(buffer) {
  const nifti = niftiModule.default || niftiModule;
  let buf = buffer;
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buf = nifti.decompress(buf);
  const header = nifti.readHeader(buf);
  const imageBuffer = nifti.readImage(header, buf);
  const byteOffset = imageBuffer.byteOffset || 0;
  let data;
  switch (header.datatypeCode) {
    case 2:
      data = new Uint8Array(imageBuffer, byteOffset);
      break;
    case 4:
      data = new Int16Array(imageBuffer, byteOffset);
      break;
    case 16:
      data = new Float32Array(imageBuffer, byteOffset);
      break;
    default:
      data = new Uint8Array(imageBuffer, byteOffset);
  }
  return {
    header,
    dims: [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])],
    data
  };
}

function assertAffineClose(actual, expected, message, tolerance = 1e-5) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      assert.ok(
        Math.abs(actual[r][c] - expected[r][c]) < tolerance,
        `${message}: affine[${r}][${c}] got ${actual[r][c]}, expected ${expected[r][c]}`
      );
    }
  }
}

function installMockDownloadCache() {
  const originalCaches = globalThis.caches;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const entries = new Map();
  const deletes = [];
  globalThis.caches = {
    open: async (name) => {
      assert.equal(name, 'lnm-mask-downloads-v1',
        'mask downloads must use the dedicated Cache Storage bucket');
      return {
        put: async (url, response) => { entries.set(url, response); },
        match: async (url) => entries.get(url),
        delete: async (url) => {
          deletes.push(url);
          entries.delete(url);
          return true;
        }
      };
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      ...(globalThis.navigator || {}),
      serviceWorker: { controller: {} }
    }
  });
  return {
    entries,
    deletes,
    restore() {
      globalThis.caches = originalCaches;
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      } else {
        delete globalThis.navigator;
      }
    }
  };
}

function makeClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle: (name, force) => {
      const shouldAdd = force === undefined ? !classes.has(name) : !!force;
      if (shouldAdd) classes.add(name);
      else classes.delete(name);
      return shouldAdd;
    }
  };
}

async function waitForMicrotaskCondition(predicate, message, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

// ---- Test 1: runFullPipeline dispatches every stage in declared order ----
{
  const app = makeApp();
  const calls = [];
  app._runStage = async (stage) => { calls.push(stage.id); };
  // Skip the precondition gate for parcel-overlap-first pipelines.
  app._lesionFileMatchesAtlasGrid = async () => true;
  app.lesionFile = {};   // satisfy precondition
  app.selectedPipeline = {
    id: 'test-pipeline',
    displayName: 'Test',
    stages: [
      { id: 'overlap', module: 'parcel-overlap', required: true },
      { id: 'fc',      module: 'fc-weighted-sum', required: true },
      { id: 'thresh',  module: 'threshold', required: false }
    ]
  };
  await app.runFullPipeline();
  assert.deepEqual(calls, ['overlap', 'fc', 'thresh'],
    `expected stages in declared order; got ${JSON.stringify(calls)}`);
  // _perfStats accumulated one entry per stage.
  assert.equal(app._perfStats.length, 3,
    `expected 3 perf entries; got ${app._perfStats.length}`);
  assert.deepEqual(
    app._perfStats.map(s => s.id),
    ['overlap', 'fc', 'thresh'],
    'perf entries must match stage order'
  );
}

// ---- Test 2: a stage exception halts the chain (no further stages run) ----
{
  const app = makeApp();
  const calls = [];
  app._runStage = async (stage) => {
    calls.push(stage.id);
    if (stage.id === 'fc') throw new Error('synthetic FC failure');
  };
  app._lesionFileMatchesAtlasGrid = async () => true;
  app.lesionFile = {};
  app.selectedPipeline = {
    id: 'test-pipeline',
    displayName: 'Test',
    stages: [
      { id: 'overlap', module: 'parcel-overlap', required: true },
      { id: 'fc',      module: 'fc-weighted-sum', required: true },
      { id: 'thresh',  module: 'threshold', required: false }
    ]
  };
  await app.runFullPipeline();
  assert.deepEqual(calls, ['overlap', 'fc'],
    `expected chain to halt after the failing stage; got ${JSON.stringify(calls)}`);
  // The failure message must surface to the user.
  assert.ok(
    app._messages.some(m => /Stage 'fc'.*failed.*synthetic FC failure/.test(m)),
    `expected a 'Stage fc failed' message; got ${JSON.stringify(app._messages)}`
  );
}

// ---- Test 3: precondition gate — parcel-overlap-first pipeline + missing
//      lesion file -> no stages run ----
{
  const app = makeApp();
  const calls = [];
  app._runStage = async (stage) => { calls.push(stage.id); };
  app.lesionFile = null;   // missing!
  app.selectedPipeline = {
    id: 'test-pipeline', displayName: 'Test',
    stages: [{ id: 'overlap', module: 'parcel-overlap', required: true }]
  };
  await app.runFullPipeline();
  assert.deepEqual(calls, [],
    `parcel-overlap-first pipeline must NOT run without a lesion file; got ${JSON.stringify(calls)}`);
}

// ---- Test 4: precondition gate — brain-extraction-first pipeline +
//      missing structural -> no stages run ----
{
  const app = makeApp();
  const calls = [];
  app._runStage = async (stage) => { calls.push(stage.id); };
  app.structuralFile = null;
  app.selectedPipeline = {
    id: 'test-pipeline', displayName: 'Test',
    stages: [
      { id: 'brain', module: 'brain-extraction', required: true },
      { id: 'overlap', module: 'parcel-overlap', required: true }
    ]
  };
  await app.runFullPipeline();
  assert.deepEqual(calls, [],
    `brain-extraction-first pipeline must NOT run without structural; got ${JSON.stringify(calls)}`);
}

// ---- Test 5: _autoPromotePipeline follows the currently loaded input ----
{
  const app = makeApp();
  assert.equal(app.selectedPipeline?.id, 'lnm-yeo-auto',
    'default Run analysis pipeline should be the structural-T1 auto chain');

  app._autoPromotePipeline('lnm-yeo-auto');
  assert.equal(app.selectedPipeline?.id, 'lnm-yeo-auto',
    'structural T1 input should select the full auto pipeline');

  app._autoPromotePipeline('lnm-network-map');
  assert.equal(app.selectedPipeline?.id, 'lnm-network-map',
    'researcher-mode Yeo mask input should select the manual network-map pipeline');
}

// ---- Test 6: _runStage rejects unknown modules (catches manifest typos) ----
{
  const app = makeApp();
  await assert.rejects(
    () => app._runStage({ id: 'x', module: 'made-up-module' }),
    /unknown module/i,
    '_runStage must throw on an unrecognised module name'
  );
  await assert.rejects(
    () => app._runStage(null),
    /must declare a module/i,
    '_runStage must throw on a null stage'
  );
}

// ---- Test 7: setStructural only loads/selects; it must not run SynthStrip ----
{
  const app = makeApp();
  const loaded = [];
  let synthStripCalls = 0;
  app.viewerController = {
    loadBaseVolume: async (file, opts) => { loaded.push({ file, opts }); }
  };
  app.runBrainExtraction = async () => { synthStripCalls += 1; };
  const file = { name: 'subject-t1.nii.gz' };

  await app.setStructural(file);

  assert.equal(app.structuralFile, file, 'setStructural must store the structural file');
  assert.equal(loaded.length, 1, 'setStructural must still load the structural into the viewer');
  assert.equal(app.selectedPipeline?.id, 'lnm-yeo-auto',
    'setStructural must still select the auto T1 pipeline for the later Run analysis click');
  assert.equal(synthStripCalls, 0,
    'setStructural must not call runBrainExtraction; users explicitly start processing');
}

// ---- Test 7a: lesion masks render with the dedicated blue colormap ----
{
  const app = makeApp();
  const overlayCalls = [];
  const renderedStacks = [];
  app.structuralFile = { name: 'subject-t1.nii' };
  app.networkMapFile = { name: 'network-map.nii' };
  app.networkMapSpacing = [1, 1, 1];
  app.viewerController = {
    loadOverlay: async (...args) => { overlayCalls.push(args); },
    loadVolumeStack: async (entries) => { renderedStacks.push(entries); }
  };
  const lesion = { name: 'manual-lesion.nii' };

  await app.setLesion(lesion);
  assert.equal(overlayCalls.at(-1)[1], LESION_MASK_COLORMAP_ID,
    'manual lesion overlays must render with the blue lesion colormap');

  await app.displayNetworkMapOnYeoTemplate({
    data: new Uint8Array([0, 1, 1, 0, 0, 1, 0, 0]),
    dims: [2, 2, 2]
  }, [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ]);
  const lesionEntry = renderedStacks.at(-1).find(entry => entry.stage === 'lesion');
  assert.equal(lesionEntry.colormap, LESION_MASK_COLORMAP_ID,
    'Yeo-grid lesion overlays must render with the blue lesion colormap');
}

// ---- Test 8: worker-backed stages resolve only after their output arrives ----
{
  const app = makeApp();
  app.manifest = {
    modelAssets: [{
      id: 'lnm-synthstrip',
      sourceUrl: 'https://example.test/models/synthstrip.onnx',
      cacheKey: 'synthstrip-v1',
      supportStatus: 'supported'
    }]
  };
  app.structuralFile = { name: 't1.nii.gz', arrayBuffer: async () => new ArrayBuffer(8) };
  app.viewerController = { loadOverlay: async () => {} };
  const calls = [];
  app.executor = {
    loadVolume: async () => { calls.push('load'); },
    runSynthStrip: async () => { calls.push('run-synthstrip'); }
  };

  let settled = false;
  const promise = app.runBrainExtraction().then(() => { settled = true; });
  await waitForMicrotaskCondition(
    () => calls.includes('run-synthstrip'),
    'runBrainExtraction must dispatch SynthStrip before waiting for stageData'
  );
  assert.equal(settled, false,
    'runBrainExtraction must not resolve before brainmask stageData arrives');
  assert.deepEqual(calls, ['load', 'run-synthstrip']);

  app.handleStageData({
    stage: 'brainmask',
    niftiData: new ArrayBuffer(8),
    description: 'synthetic brainmask'
  });
  await Promise.resolve();
  assert.equal(settled, false,
    'runBrainExtraction must also wait for brainmask step-complete after stageData');
  app.handleStepComplete('brainmask');
  await promise;
  assert.equal(settled, true,
    'runBrainExtraction must resolve after brainmask stageData and step-complete arrive');
  assert.ok(app.brainmaskFile, 'brainmaskFile must be populated before the stage resolves');
}

// ---- Test 9: registration resolves only after the worker register step completes ----
{
  const app = makeApp();
  app.manifest = {
    modelAssets: [{
      id: 'lnm-synthmorph-mni',
      sourceUrl: 'https://example.test/models/lnm-synthmorph-mni.onnx',
      filename: 'models/lnm-synthmorph-mni.onnx',
      cacheKey: 'synthmorph-v1',
      supportStatus: 'supported',
      inputShape: [1, 48, 48, 64, 1],
      svfShape: [1, 24, 24, 32, 3],
      browserRuntime: {
        inputDims: [48, 48, 64],
        svfDims: [24, 24, 32],
        executionProviders: ['wasm']
      }
    }],
    atlasAssets: [{
      id: 'lnm-mni160',
      sourceUrl: 'https://example.test/templates/lnm-mni160.nii.gz',
      cacheKey: 'mni160-v1',
      supportStatus: 'supported'
    }]
  };
  globalThis.nifti = niftiModule.default || niftiModule;
  app.structuralFile = { name: 'lnm-prealign-t1.nii', arrayBuffer: async () => new ArrayBuffer(8) };
  app.brainmaskFile = makeNiftiFile('lnm-prealign-brainmask.nii', writeNifti1(
    new Uint8Array([1, 0, 1, 0, 0, 1, 0, 1]),
    {
      dims: [2, 2, 2],
      spacing: [1, 1, 1],
      affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      description: 'registration brain mask'
    }
  ));
  let registrationSettings = null;
  app.executor = {
    loadVolume: async () => {},
    runRegistration: async (settings) => { registrationSettings = settings; }
  };

  let settled = false;
  const promise = app.runRegistration().then(() => { settled = true; });
  await waitForMicrotaskCondition(
    () => registrationSettings !== null,
    'runRegistration must dispatch worker registration before waiting for step-complete'
  );
  assert.equal(settled, false,
    'runRegistration must not resolve before register step-complete arrives');
  assert.deepEqual(registrationSettings.executionProviders, ['wasm']);
  assert.deepEqual(registrationSettings.brainMaskDims, [2, 2, 2],
    'runRegistration must pass the prealigned brain-mask dimensions to the worker');
  assert.equal(registrationSettings.brainMaskBuffer.byteLength, 8,
    'runRegistration must pass a compact binary brain mask to the worker');

  app.handleStepComplete('register');
  await promise;
  assert.equal(settled, true,
    'runRegistration must resolve after register step-complete arrives');
}

// ---- Test 10: lesion segmentation waits for output and inference completion ----
{
  const app = makeApp();
  app.manifest = {
    modelAssets: [{
      id: 'lnm-stroke-lesion',
      sourceUrl: 'https://example.test/models/lnm-stroke-lesion.onnx',
      cacheKey: 'stroke-v1',
      supportStatus: 'supported',
      patchSize: [128, 128, 128],
      probabilityThreshold: 0.4,
      minComponentSize: 30,
      overlap: 0.25,
      testTimeAugmentation: true,
      preprocessing: {}
    }]
  };
  const calls = [];
  const nativeStructural = { name: 'native-t1.nii' };
  const prealignedStructural = { name: 'lnm-prealign-t1.nii', arrayBuffer: async () => new ArrayBuffer(8) };
  app.structuralFile = prealignedStructural;
  app.nativeStructuralFile = nativeStructural;
  app.viewerBaseFile = prealignedStructural;
  app.viewerLayerVisibility.brainmask = true;
  app.nv.opts = {
    multiplanarShowRender: globalThis.niivue.SHOW_RENDER.AUTO,
    sliceType: app.nv.sliceTypeMultiplanar
  };
  app.nv.sliceTypeRender = 7;
  app.nv.drawScene = () => { calls.push('draw-scene'); };
  app.viewerController = {
    clearVolumes: () => { calls.push('clear-volumes'); },
    loadOverlay: async () => {},
    setStageVisible: (stage, visible) => { calls.push(`visible:${stage}:${visible}`); }
  };
  app.loadViewerBaseVolume = async (file, options) => {
    calls.push(`base:${file.name}`);
    app.viewerBaseFile = file;
    app._lastBaseOptions = options;
  };
  let inferenceSettings = null;
  app.executor = {
    loadVolume: async () => { calls.push('load'); },
    runInference: async (settings) => { calls.push('run-inference'); inferenceSettings = settings; }
  };

  let settled = false;
  const promise = app.runLesionSegmentation().then(() => { settled = true; });
  await waitForMicrotaskCondition(
    () => calls.includes('run-inference'),
    'runLesionSegmentation must dispatch inference before waiting for stageData'
  );
  assert.equal(settled, false,
    'runLesionSegmentation must not resolve before segmentation output arrives');
  assert.equal(app.viewerLayerVisibility.brainmask, false,
    'runLesionSegmentation must hide the prealign brain-mask overlay while inference runs');
  assert.equal(app.nv.opts.multiplanarShowRender, globalThis.niivue.SHOW_RENDER.NEVER,
    'runLesionSegmentation must hide the 3D render tile while inference runs');
  assert.equal(app.viewerBaseFile, nativeStructural,
    'runLesionSegmentation must switch the display back to the native T1 while inference runs');
  assert.ok(calls.indexOf('base:native-t1.nii') > -1 && calls.indexOf('base:native-t1.nii') < calls.indexOf('load'),
    'native T1 display must be prepared before the worker loads the prealigned inference input');
  app.handleStageData({
    stage: 'segmentation',
    niftiData: new ArrayBuffer(8),
    description: 'synthetic segmentation'
  });
  await Promise.resolve();
  assert.equal(settled, false,
    'runLesionSegmentation must also wait for inference step-complete after stageData');
  app.handleStepComplete('inference');
  await promise;
  assert.equal(settled, true,
    'runLesionSegmentation must resolve after segmentation stageData and step-complete arrive');
  assert.ok(app.autoLesionSeedFile, 'autoLesionSeedFile must be populated before the stage resolves');
  assert.equal(app.lesionMaskFile, null,
    'automatic segmentation is only a seed; confirmed manual review populates lesionMaskFile');
  // Test-time augmentation must be enabled so reflection-unstable false
  // positives (notably in-brain cerebellum/posterior-fossa clusters) are
  // averaged out; overlap stays at the manifest-configured 0.25.
  assert.equal(inferenceSettings.testTimeAugmentation, true,
    'lesion segmentation must dispatch with test-time augmentation enabled to suppress cerebellum false positives');
  assert.equal(inferenceSettings.overlap, 0.25,
    'lesion segmentation sliding-window overlap must follow the manifest (0.25)');
}

// ---- Test 10b: auto structural pipeline pauses at manual mask review ----
{
  const app = makeApp();
  const calls = [];
  app.structuralFile = { name: 'subject-t1.nii' };
  app.runBrainExtraction = async () => { calls.push('brain'); };
  app.prealignToMni160 = async () => { calls.push('prealign'); };
  app.runLesionSegmentation = async () => {
    calls.push('segment');
    app.autoLesionSeedFile = { name: 'auto-seed.nii' };
  };
  app.startLesionMaskReview = async () => {
    calls.push('review');
    app.maskReviewActive = true;
  };
  app.runRegistration = async () => { calls.push('register'); };
  app.applyRegistrationToLesion = async () => { calls.push('warp'); };
  app.selectedPipeline = {
    id: 'auto-with-review',
    displayName: 'Auto With Review',
    stages: [
      { id: 'brain', module: 'brain-extraction', required: true },
      { id: 'prealign', module: 'prealign', required: true },
      { id: 'seed', module: 'inference-pipeline', required: true },
      { id: 'register', module: 'registration', required: true }
    ]
  };

  await app.runFullPipeline();

  assert.deepEqual(calls, ['brain', 'prealign', 'segment', 'review'],
    'auto pipeline must stop after loading the editable lesion seed');
  assert.equal(app._pendingMaskResume?.nextStageIndex, 3,
    'paused pipeline must remember the stage after editable-seed review');
  assert.equal(app.maskReviewActive, true,
    'mask review must be active after the auto seed is created');
  assert.ok(app._messages.includes('Pipeline paused for manual lesion-mask review.'),
    'pause must be visible to the user');
}

// ---- Test 10c: blank review path starts an editable native-space mask ----
{
  const app = makeApp();
  const loaded = [];
  let blankStarts = 0;
  let seedLoads = 0;
  const toolCalls = [];
  app.nativeStructuralFile = { name: 'native-t1.nii' };
  app.nativeStructuralInfo = {
    dims: [2, 2, 2],
    affine: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ]
  };
  app.viewerController = {
    loadBaseVolume: async (file, opts) => { loaded.push({ file, opts }); }
  };
  app.maskDrawingController = {
    hasDrawing: true,
    startBlank: () => { blankStarts += 1; },
    loadSeedFile: async () => { seedLoads += 1; },
    ensureDrawing: () => {},
    setTool: (tool) => { toolCalls.push(tool); }
  };

  const seed = await app.startLesionMaskReview({ blank: true });

  assert.equal(seed, null,
    'blank review should not create a projected seed file');
  assert.equal(blankStarts, 1,
    'blank review must create a new editable drawing');
  assert.equal(seedLoads, 0,
    'blank review must not load a seed drawing');
  assert.equal(loaded[0].file.name, 'native-t1.nii',
    'blank review must render the native T1 as the drawing base');
  assert.equal(app.maskReviewActive, true,
    'blank review must activate mask-review mode');
  assert.equal(app.lesionMaskConfirmed, false,
    'blank review must require explicit confirmation');
  assert.deepEqual(toolCalls, ['paint'],
    'blank review must leave the drawing controller in paint mode');
}

// ---- Test 10c.1: advanced Manual mask choice starts blank review ----
{
  const app = makeApp();
  const listeners = {};
  const restoreDocument = useMockElements({
    startManualMaskButton: {
      addEventListener: (eventName, handler) => { listeners[`startManualMaskButton:${eventName}`] = handler; }
    }
  });
  let requestedOptions = null;
  app.startLesionMaskReview = async (options) => { requestedOptions = options; };

  try {
    app.bindEvents();
    assert.equal(typeof listeners['startManualMaskButton:click'], 'function',
      'advanced Manual mask button must bind a click handler');
    listeners['startManualMaskButton:click']();
    await waitForMicrotaskCondition(
      () => requestedOptions !== null,
      'advanced Manual mask button must call startLesionMaskReview'
    );
    assert.deepEqual(requestedOptions, { blank: true },
      'advanced Manual mask button must start a blank editable lesion mask');
  } finally {
    restoreDocument();
  }
}

// ---- Test 10c.2: advanced Upload mask choice opens native-mask review ----
{
  const app = makeApp();
  const listeners = {};
  let clickCount = 0;
  const manualMaskInput = {
    files: [],
    value: 'stale',
    click: () => { clickCount += 1; },
    addEventListener: (eventName, handler) => { listeners[`manualMaskFileInput:${eventName}`] = handler; }
  };
  const restoreDocument = useMockElements({
    manualMaskFileInput: manualMaskInput,
    uploadManualMaskButton: {
      addEventListener: (eventName, handler) => { listeners[`uploadManualMaskButton:${eventName}`] = handler; }
    },
    uploadReviewMaskButton: {
      addEventListener: (eventName, handler) => { listeners[`uploadReviewMaskButton:${eventName}`] = handler; }
    }
  });
  const uploaded = { name: 'native-lesion-mask.nii' };
  let requestedFile = null;
  app.startUploadedLesionMaskReview = async (file) => { requestedFile = file; };

  try {
    app.bindEvents();
    assert.equal(typeof listeners['uploadManualMaskButton:click'], 'function',
      'advanced Upload mask button must bind a click handler');
    listeners['uploadManualMaskButton:click']();
    assert.equal(clickCount, 1,
      'advanced Upload mask button must open the hidden file input');
    assert.equal(typeof listeners['uploadReviewMaskButton:click'], 'function',
      'review-toolbar Upload button must bind a click handler');
    listeners['uploadReviewMaskButton:click']();
    assert.equal(clickCount, 2,
      'review-toolbar Upload button must open the same hidden file input');
    assert.equal(typeof listeners['manualMaskFileInput:change'], 'function',
      'manual mask file input must bind a change handler');
    manualMaskInput.files = [uploaded];
    listeners['manualMaskFileInput:change']({ target: manualMaskInput });
    await waitForMicrotaskCondition(
      () => requestedFile === uploaded,
      'manual mask upload must call startUploadedLesionMaskReview with the chosen file'
    );
    await waitForMicrotaskCondition(
      () => manualMaskInput.value === '',
      'manual mask upload must reset the input so the same file can be selected again'
    );
  } finally {
    restoreDocument();
  }
}

// ---- Test 10c.2b: invalid manual mask upload names the rejected file ----
{
  const app = makeApp();
  const listeners = {};
  const manualMaskInput = {
    files: [],
    value: 'bad',
    click: () => {},
    addEventListener: (eventName, handler) => { listeners[`manualMaskFileInput:${eventName}`] = handler; }
  };
  const restoreDocument = useMockElements({
    manualMaskFileInput: manualMaskInput
  });
  const uploaded = { name: 'notes.txt' };
  app.startUploadedLesionMaskReview = async () => {
    throw new Error('Input is not a NIfTI file');
  };

  try {
    app.bindEvents();
    manualMaskInput.files = [uploaded];
    listeners['manualMaskFileInput:change']({ target: manualMaskInput });
    await waitForMicrotaskCondition(
      () => /notes\.txt/.test(app._messages.at(-1) || ''),
      'manual mask upload error must name the rejected file'
    );
    assert.match(app._messages.at(-1), /\.nii or \.nii\.gz/,
      'manual mask upload error must tell users the expected NIfTI formats');
    assert.equal(manualMaskInput.value, '',
      'manual mask upload failure must still reset the input');
  } finally {
    restoreDocument();
  }
}

// ---- Test 10c.3: uploaded native masks are not shifted by prealign affine ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const nativeDims = [4, 4, 4];
  const nativeAffine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const prealignSamplingAffine = [
    [1, 0, 0, -1],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const flatten = (affine) => [
    affine[0][0], affine[0][1], affine[0][2], affine[0][3],
    affine[1][0], affine[1][1], affine[1][2], affine[1][3],
    affine[2][0], affine[2][1], affine[2][2], affine[2][3]
  ];
  const mask = new Uint8Array(64);
  mask[2 + 1 * 4 + 1 * 16] = 1;
  const uploaded = tagSpatialFile(makeNiftiFile('native-lesion-mask.nii', writeNifti1(mask, {
    dims: nativeDims,
    spacing: [1, 1, 1],
    affine: flatten(nativeAffine),
    description: 'synthetic uploaded native lesion'
  })), {
    space: VOLUME_SPACES.NATIVE_T1,
    role: 'lesion-seed',
    sourceStage: 'mask-upload',
    dims: nativeDims,
    affine: nativeAffine
  });
  app.nativeStructuralInfo = {
    dims: nativeDims,
    affine: nativeAffine
  };
  app.prealignSamplingAffine = prealignSamplingAffine;
  app.fixedMni160Info = {
    dims: nativeDims,
    affine: [
      [1, 0, 0, -4],
      [0, 1, 0, -4],
      [0, 0, 1, -4],
      [0, 0, 0, 1]
    ],
    spacing: [1, 1, 1]
  };

  const projected = await app.resampleSeedMaskToNative(uploaded);
  const decoded = decodeNiftiForTest(await projected.arrayBuffer());

  assert.equal(decoded.data[2 + 1 * 4 + 1 * 16], 1,
    'native uploaded masks must keep their native voxel location during review');
  assert.equal(decoded.data[1 + 1 * 4 + 1 * 16], 0,
    'native uploaded masks must not be projected through the prealign sampling affine');
}

// ---- Test 10c.4: uploaded mask files are tagged as editable native seeds ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const mask = new Uint8Array(8);
  mask[3] = 1;
  const nativeAffine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const uploaded = makeNiftiFile('uploaded-native-mask.nii', writeNifti1(mask, {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine: [
      nativeAffine[0][0], nativeAffine[0][1], nativeAffine[0][2], nativeAffine[0][3],
      nativeAffine[1][0], nativeAffine[1][1], nativeAffine[1][2], nativeAffine[1][3],
      nativeAffine[2][0], nativeAffine[2][1], nativeAffine[2][2], nativeAffine[2][3]
    ],
    description: 'synthetic uploaded mask'
  }));
  app.structuralFile = { name: 'native-t1.nii' };
  let reviewOptions = null;
  app.startLesionMaskReview = async (options) => {
    reviewOptions = options;
    return { name: 'projected-seed.nii' };
  };

  const result = await app.startUploadedLesionMaskReview(uploaded);
  const meta = getSpatialMetadata(uploaded);

  assert.equal(result.name, 'projected-seed.nii',
    'uploaded mask review must return the projected editable seed');
  assert.equal(reviewOptions.seedFile, uploaded,
    'uploaded mask review must use the uploaded mask as the review seed');
  assert.equal(meta.space, VOLUME_SPACES.NATIVE_T1,
    'uploaded masks must be tagged as native T1 seeds');
  assert.deepEqual(meta.dims, [2, 2, 2],
    'uploaded mask metadata must carry decoded dimensions for viewer-space checks');
  assert.equal(meta.sourceStage, 'mask-upload',
    'uploaded mask metadata must record the mask-upload source stage');
}

// ---- Test 10c.5: mask-review starts with the brain mask off ----
{
  const affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const makeTagged = (name, space) => tagSpatialFile({ name }, {
    space,
    dims: [2, 2, 2],
    affine
  });
  const runReview = async () => {
    const app = makeApp();
    const calls = [];
    const nativeT1 = makeTagged('native-t1.nii', VOLUME_SPACES.NATIVE_T1);
    const nativeMask = makeTagged('native-brainmask.nii', VOLUME_SPACES.NATIVE_T1);
    const prealignT1 = makeTagged('lnm-prealign-t1.nii', VOLUME_SPACES.MNI160);
    const prealignMask = makeTagged('lnm-prealign-brainmask.nii', VOLUME_SPACES.MNI160);
    app.nativeStructuralFile = nativeT1;
    app.structuralFile = prealignT1;
    app.nativeBrainmaskFile = nativeMask;
    app.brainmaskFile = prealignMask;
    app.viewerLayerVisibility.brainmask = true;
    app.nv.opts = {
      multiplanarShowRender: globalThis.niivue.SHOW_RENDER.AUTO,
      sliceType: app.nv.sliceTypeMultiplanar
    };
    app.nv.sliceTypeRender = 7;
    app.nv.drawScene = () => calls.push({ type: 'drawScene' });
    app.ensureNativeStructuralInfo = async () => {};
    app.loadViewerBaseVolume = async (file, options) => {
      calls.push({ type: 'base', file, options });
      app.viewerBaseFile = file;
    };
    app.resampleSeedMaskToNative = async () => null;
    app.refreshViewerLayerControls = () => {};
    app.refreshMaskDrawingControls = () => {};
    app.viewerController = {
      clearVolumes: () => calls.push({ type: 'clearVolumes' }),
      getVolumeIndexForStage: () => null,
      loadOverlay: async (file, colormap, opacity, options) => {
        calls.push({ type: 'overlay', file, colormap, opacity, options });
      }
    };
    app.maskDrawingController = {
      hasDrawing: true,
      startBlank: () => calls.push({ type: 'blank' }),
      ensureDrawing: () => calls.push({ type: 'ensureDrawing' }),
      setTool: tool => calls.push({ type: 'tool', tool }),
      setVisible: visible => calls.push({ type: 'drawingVisible', visible })
    };

    await app.startLesionMaskReview({ blank: true });
    return { app, calls, nativeT1, nativeMask, prealignMask };
  };

  const reviewRun = await runReview();
  assert.equal(reviewRun.calls[0].type, 'clearVolumes',
    'mask review must clear the previous viewer stack before loading the native review base');
  const baseCall = reviewRun.calls.find(call => call.type === 'base');
  assert.equal(baseCall.file, reviewRun.nativeT1,
    'mask review must display the native T1 as the viewer base');
  assert.equal(reviewRun.app.viewerLayerVisibility.brainmask, false,
    'mask review must force the Brain mask layer off by default');
  assert.equal(reviewRun.app.nv.opts.multiplanarShowRender, globalThis.niivue.SHOW_RENDER.NEVER,
    'mask review must hide NiiVue 3D render tile even in multiplanar mode');
  assert.equal(reviewRun.app._preMaskReviewMultiplanarShowRender, globalThis.niivue.SHOW_RENDER.AUTO,
    'mask review must remember the prior 3D render-tile setting');
  assert.equal(reviewRun.calls.some(call => call.type === 'overlay'), false,
    'mask review must not display a brain-mask overlay by default');
  assert.equal(reviewRun.app.getBrainmaskFileForActiveViewer(), reviewRun.nativeMask,
    'manual re-enable in review mode must still use the native brain mask, not the prealigned mask');
  assert.notEqual(reviewRun.app.getBrainmaskFileForActiveViewer(), reviewRun.prealignMask,
    'manual re-enable in review mode must not select the prealigned MNI brain mask');
  reviewRun.app.setMaskReview3DRenderEnabled(true);
  assert.equal(reviewRun.app.nv.opts.multiplanarShowRender, globalThis.niivue.SHOW_RENDER.AUTO,
    'leaving mask review must restore the previous 3D render-tile setting');
  assert.equal(reviewRun.app._preMaskReviewMultiplanarShowRender, null,
    'leaving mask review must clear the saved render-tile setting');
}

// ---- Test 10c.6: mask-review banner is visible while toolbar owns actions ----
{
  const app = makeApp();
  const bannerClassList = makeClassList(['hidden']);
  const toolbarClassList = makeClassList(['hidden']);
  const banner = { classList: bannerClassList };
  const toolbar = { classList: toolbarClassList };
  const confirmButton = { disabled: true };
  const uploadReviewButton = { disabled: true };
  const downloadEditedButton = { disabled: true };
  const status = { textContent: '' };
  const restoreDocument = useMockElements({
    maskApprovalBanner: banner,
    maskDrawingToolbar: toolbar,
    confirmLesionMaskButton: confirmButton,
    uploadReviewMaskButton: uploadReviewButton,
    downloadEditedLesionMaskButton: downloadEditedButton,
    maskReviewStatus: status
  });
  app.nativeStructuralFile = { name: 'native-t1.nii' };
  app.maskReviewActive = true;
  app.maskDrawingController = { hasDrawing: true };

  try {
    app.refreshMaskDrawingControls();
    assert.equal(bannerClassList.contains('hidden'), false,
      'mask approval banner must be visible while mask review is active');
    assert.equal(toolbarClassList.contains('hidden'), false,
      'drawing toolbar must remain visible while mask review is active');
    assert.equal(confirmButton.disabled, false,
      'toolbar confirm button must be enabled during mask review');
    assert.equal(uploadReviewButton.disabled, false,
      'toolbar upload button must be enabled during mask review');
    assert.equal(downloadEditedButton.disabled, false,
      'toolbar download button must be enabled when a drawing exists');
    assert.equal(status.textContent, 'Review lesion mask',
      'mask-review status must describe the active review state');

    app.maskReviewActive = false;
    app.lesionMaskConfirmed = true;
    app.refreshMaskDrawingControls();
    assert.equal(bannerClassList.contains('hidden'), true,
      'mask approval banner must hide after approval');
    assert.equal(uploadReviewButton.disabled, true,
      'toolbar upload button must disable after review ends');
    assert.equal(status.textContent, 'Mask confirmed',
      'mask-review status must report confirmation after approval');
  } finally {
    restoreDocument();
  }
}

// ---- Test 10c.7: mask-review toolbar buttons own confirm/download actions ----
{
  const app = makeApp();
  const listeners = {};
  const restoreDocument = useMockElements({
    confirmLesionMaskButton: {
      addEventListener: (eventName, handler) => { listeners[`confirmLesionMaskButton:${eventName}`] = handler; }
    },
    downloadEditedLesionMaskButton: {
      addEventListener: (eventName, handler) => { listeners[`downloadEditedLesionMaskButton:${eventName}`] = handler; }
    }
  });
  let confirmCalls = 0;
  let downloadCalls = 0;
  app.confirmLesionDrawing = async (options) => {
    confirmCalls += 1;
    assert.deepEqual(options, { resumePipeline: true },
      'toolbar confirmation must resume the paused pipeline');
  };
  app.downloadEditedLesionMask = async () => { downloadCalls += 1; };

  try {
    app.bindMaskDrawingControls();
    assert.equal(typeof listeners['confirmLesionMaskButton:click'], 'function',
      'toolbar confirm button must bind a click handler');
    assert.equal(typeof listeners['downloadEditedLesionMaskButton:click'], 'function',
      'toolbar download button must bind a click handler');
    listeners['confirmLesionMaskButton:click']();
    listeners['downloadEditedLesionMaskButton:click']();
    await waitForMicrotaskCondition(() => confirmCalls === 1,
      'toolbar confirm button must call confirmLesionDrawing');
    await waitForMicrotaskCondition(() => downloadCalls === 1,
      'toolbar download button must call downloadEditedLesionMask');
  } finally {
    restoreDocument();
  }
}

// ---- Test 10d: confirming a native drawing writes fixed-header MNI160 mask ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const nativeDims = [4, 4, 4];
  const nativeAffine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const prealignSamplingAffine = [
    [1, 0, 0, -1],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const fixedMniAffine = [
    [1, 0, 0, -4],
    [0, 1, 0, -4],
    [0, 0, 1, -4],
    [0, 0, 0, 1]
  ];
  const nativeMask = new Uint8Array(64);
  nativeMask[2 + 1 * 4 + 1 * 16] = 1;
  let closeOptions = null;
  let asyncExportCalls = 0;
  let resumed = false;
  const toolbarClassList = makeClassList();
  const toolbar = { classList: toolbarClassList };
  const confirmButton = { disabled: false };
  const downloadEditedButton = { disabled: false };
  const status = { textContent: '' };
  const downloadButton = { disabled: true };
  const restoreDocument = useMockElements({
    maskDrawingToolbar: toolbar,
    confirmLesionMaskButton: confirmButton,
    downloadEditedLesionMaskButton: downloadEditedButton,
    maskReviewStatus: status,
    downloadLesionMaskButton: downloadButton
  });
  app.maskDrawingController = {
    hasDrawing: true,
    copyDrawingBitmap: () => new Uint8Array(nativeMask),
    exportDrawingFile: async () => { asyncExportCalls += 1; },
    close: (options) => { closeOptions = options; }
  };
  app.nativeStructuralInfo = {
    dims: nativeDims,
    affine: nativeAffine,
    spacing: [1, 1, 1]
  };
  app.prealignSamplingAffine = prealignSamplingAffine;
  app.fixedMni160Info = {
    dims: nativeDims,
    affine: fixedMniAffine,
    spacing: [1, 1, 1]
  };
  app.resumePipelineAfterMaskConfirmation = async () => { resumed = true; };

  let confirmed;
  let decoded;
  try {
    confirmed = await app.confirmLesionDrawing({ resumePipeline: true });
    decoded = decodeNiftiForTest(await confirmed.arrayBuffer());
  } finally {
    restoreDocument();
  }

  assert.equal(asyncExportCalls, 0,
    'confirming must use the active drawing bitmap, not NiiVue saveImage export');
  assert.equal(app.confirmedNativeLesionFile.name, 'lnm-lesion-edited-native.nii',
    'confirmed native drawing must be kept for download/edit provenance');
  const confirmedNative = decodeNiftiForTest(await app.confirmedNativeLesionFile.arrayBuffer());
  assert.deepEqual(confirmedNative.dims, nativeDims,
    'confirmed native drawing must be a non-empty native-space NIfTI');
  assert.equal(confirmedNative.data[2 + 1 * 4 + 1 * 16], 1,
    'confirmed native drawing file must contain the accepted drawing voxels');
  assert.equal(app.lesionMaskFile, confirmed,
    'confirmed MNI160 mask must become the downstream lesionMaskFile');
  assert.equal(app.lesionMaskConfirmed, true,
    'confirming must mark the lesion mask as user-approved');
  assert.equal(app.maskReviewActive, false,
    'confirming must leave mask-review mode');
  assert.deepEqual(closeOptions, { clearDrawing: true },
    'confirming must clear the accepted NiiVue drawing overlay');
  assert.equal(toolbarClassList.contains('hidden'), true,
    'confirming must hide the mask-review toolbar');
  assert.equal(resumed, true,
    'confirming from the paused pipeline must resume analysis');
  assert.deepEqual(decoded.dims, nativeDims,
    'confirmed mask must use the fixed MNI160 dimensions');
  assertAffineClose(decoded.header.affine, fixedMniAffine,
    'confirmed mask header must use the fixed MNI160 affine');
  assert.equal(decoded.data[3 + 1 * 4 + 1 * 16], 1,
    'native drawing must be resampled through the saved prealign sampling affine');
  assert.equal(decoded.data[2 + 1 * 4 + 1 * 16], 0,
    'native drawing must not be copied directly onto the MNI160 grid');
}

// ---- Test 10d.1: confirming swaps drawing mode for native mask overlay ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const nativeDims = [4, 4, 4];
  const nativeAffine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const fixedMniAffine = [
    [1, 0, 0, -4],
    [0, 1, 0, -4],
    [0, 0, 1, -4],
    [0, 0, 0, 1]
  ];
  const nativeMask = new Uint8Array(64);
  nativeMask[2 + 1 * 4 + 1 * 16] = 1;
  const nativeT1 = tagSpatialFile({ name: 'native-t1.nii' }, {
    space: VOLUME_SPACES.NATIVE_T1,
    role: 'structural',
    dims: nativeDims,
    affine: nativeAffine
  });
  const baseLoads = [];
  const overlayLoads = [];
  let closeOptions = null;
  app.nativeStructuralFile = nativeT1;
  app.structuralFile = tagSpatialFile({ name: 'lnm-prealign-t1.nii' }, {
    space: VOLUME_SPACES.MNI160,
    role: 'structural',
    dims: nativeDims,
    affine: fixedMniAffine
  });
  app.viewerBaseFile = app.structuralFile;
  app.viewerController = {
    loadBaseVolume: async (file, options) => { baseLoads.push({ file, options }); },
    loadOverlay: async (file, colormap, opacity, options) => {
      overlayLoads.push({ file, colormap, opacity, options });
    }
  };
  app.maskDrawingController = {
    hasDrawing: true,
    copyDrawingBitmap: () => new Uint8Array(nativeMask),
    close: (options) => { closeOptions = options; }
  };
  app.nativeStructuralInfo = {
    dims: nativeDims,
    affine: nativeAffine,
    spacing: [1, 1, 1]
  };
  app.prealignSamplingAffine = nativeAffine;
  app.fixedMni160Info = {
    dims: nativeDims,
    affine: fixedMniAffine,
    spacing: [1, 1, 1]
  };

  await app.confirmLesionDrawing({ resumePipeline: false });

  assert.deepEqual(closeOptions, { clearDrawing: true },
    'confirming must clear the accepted editable drawing');
  assert.equal(baseLoads.at(-1).file, nativeT1,
    'confirming must restore the native anatomical scan as the viewer base');
  assert.equal(overlayLoads.at(-1).file, app.confirmedNativeLesionFile,
    'confirming must load the confirmed native lesion mask as the visible overlay');
  assert.equal(overlayLoads.at(-1).colormap, LESION_MASK_COLORMAP_ID,
    'confirmed native lesion overlay must use the lesion mask colormap');
  assert.deepEqual(overlayLoads.at(-1).options, { stage: 'segmentation', visible: true },
    'confirmed native lesion overlay must be tracked by the lesion layer toggle');
  assert.equal(app.getLesionFileForActiveViewer(), app.confirmedNativeLesionFile,
    'native viewer lesion layer must prefer the confirmed native mask over the MNI160 computation mask');
}

// ---- Test 10d.2: active mask-review download exports drawing bytes ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const nativeDims = [2, 2, 2];
  const nativeAffine = [
    [1.5, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 2.5, 0],
    [0, 0, 0, 1]
  ];
  const drawing = new Uint8Array(8);
  drawing[3] = 1;
  const anchor = {
    href: '',
    download: '',
    clicked: 0,
    removed: 0,
    click() { this.clicked += 1; },
    remove() { this.removed += 1; }
  };
  let copyDrawingCalls = 0;
  let asyncExportCalls = 0;
  let downloadDrawingCalls = 0;
  const appended = [];
  const originalCreateElement = globalThis.document.createElement;
  const originalBody = globalThis.document.body;
  const originalFetch = globalThis.fetch;
  const originalShowSaveFilePicker = globalThis.showSaveFilePicker;
  let postedUrl = '';
  let postedOptions = null;
  let anchorCreations = 0;
  let pickerCalls = 0;
  globalThis.document.createElement = (tagName) => {
    anchorCreations += 1;
    assert.equal(tagName, 'a',
      'edited mask download must create an anchor element');
    return anchor;
  };
  globalThis.document.body = {
    appendChild: (child) => { appended.push(child); }
  };
  globalThis.fetch = async (url, options) => {
    postedUrl = String(url);
    postedOptions = options;
    return {
      ok: true,
      status: 201,
      async json() {
        return {
          url: '/__lnm_downloads/test-token/lnm-lesion-edited-native.nii',
          byteLength: 360
        };
      }
    };
  };
  globalThis.showSaveFilePicker = async () => {
    pickerCalls += 1;
    throw new Error('showSaveFilePicker must not be used for mask downloads');
  };
  app.nativeStructuralInfo = {
    dims: nativeDims,
    affine: nativeAffine,
    spacing: [1.5, 2, 2.5]
  };
  app.maskDrawingController = {
    hasDrawing: true,
    copyDrawingBitmap: () => {
      copyDrawingCalls += 1;
      return new Uint8Array(drawing);
    },
    exportDrawingFile: async () => { asyncExportCalls += 1; },
    downloadDrawing: async () => { downloadDrawingCalls += 1; }
  };

  try {
    await app.downloadEditedLesionMask();
  } finally {
    globalThis.document.createElement = originalCreateElement;
    globalThis.document.body = originalBody;
    globalThis.fetch = originalFetch;
    if (originalShowSaveFilePicker === undefined) delete globalThis.showSaveFilePicker;
    else globalThis.showSaveFilePicker = originalShowSaveFilePicker;
  }

  assert.equal(copyDrawingCalls, 1,
    'active review download must synchronously copy the current drawing bitmap');
  assert.equal(asyncExportCalls, 0,
    'active review download must not await NiiVue saveImage before creating the download');
  assert.equal(postedOptions.method, 'POST',
    'active review download must stage native mask bytes on the local dev server');
  assert.equal(postedOptions.headers['Content-Type'], 'application/octet-stream',
    'active review download must post raw mask bytes');
  assert.equal(postedOptions.headers['X-LNM-Filename'], 'lnm-lesion-edited-native.nii',
    'active review download must preserve the edited mask filename on the local route');
  assert.equal(postedOptions.headers['X-LNM-Stage-Only'], '1',
    'active review download must stage bytes for a normal browser download instead of writing to ~/Downloads');
  assert.match(postedUrl, /^http:\/\/localhost:8080\/__lnm_downloads\/.+\/lnm-lesion-edited-native\.nii$/,
    'active review download must use the localhost download route');
  const postedBytes = postedOptions.body;
  assert.equal(postedBytes.byteLength, 360,
    'active review download must post the full native NIfTI byte length');
  const postedBuffer = postedBytes.buffer.slice(
    postedBytes.byteOffset,
    postedBytes.byteOffset + postedBytes.byteLength
  );
  const downloaded = decodeNiftiForTest(postedBuffer);
  assert.deepEqual(downloaded.dims, nativeDims,
    'active review download must write the native T1 dimensions');
  assertAffineClose(downloaded.header.affine, nativeAffine,
    'active review download must write the native T1 affine');
  assert.equal(downloaded.data[3], 1,
    'active review download must contain the edited drawing voxels');
  assert.equal(pickerCalls, 0,
    'active review download must not use File System Access save picker APIs');
  assert.equal(anchorCreations, 1,
    'active review download must create one normal HTTP download anchor');
  assert.deepEqual(appended, [anchor],
    'active review download must attach the staged HTTP download anchor');
  assert.equal(anchor.href, 'http://localhost:8080/__lnm_downloads/test-token/lnm-lesion-edited-native.nii',
    'active review download must point the anchor at the staged HTTP response');
  assert.equal(anchor.download, 'lnm-lesion-edited-native.nii',
    'active review download must keep the edited mask filename');
  assert.equal(anchor.clicked, 1,
    'active review download must click the staged HTTP download anchor');
  assert.equal(downloadDrawingCalls, 0,
    'active review download must not rely on NiiVue filename-based saveImage download');
}

// ---- Test 10d.2a: localhost route without direct save still returns a download URL ----
{
  const app = makeApp();
  const originalFetch = globalThis.fetch;
  let posted = null;
  globalThis.fetch = async (url, options) => {
    posted = { url: String(url), options };
    return {
      ok: true,
      status: 201,
      async json() { return { url: '/__lnm_downloads/test/mask.nii' }; }
    };
  };

  let result;
  try {
    result = await app.createServerDownload(new Uint8Array([1, 2, 3]), 'mask.nii');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(posted.options.method, 'POST',
    'localhost fallback must post bytes to the dev server');
  assert.equal(posted.options.headers['X-LNM-Stage-Only'], '1',
    'localhost fallback must request staged download mode instead of direct-writing to ~/Downloads');
  assert.deepEqual(Array.from(posted.options.body), [1, 2, 3],
    'localhost fallback must post mask bytes unchanged');
  assert.equal(result.url, 'http://localhost:8080/__lnm_downloads/test/mask.nii',
    'localhost fallback must return an absolute download URL when the server does not direct-save');
}

// ---- Test 10d.2b: static-host fallback can stage mask bytes in Cache Storage ----
{
  const app = makeApp();
  const cache = installMockDownloadCache();
  const originalSetTimeout = globalThis.setTimeout;
  const cacheDeleteDelays = [];
  globalThis.setTimeout = (fn, delay) => {
    cacheDeleteDelays.push(delay);
    return 1;
  };

  let downloadUrl = '';
  try {
    downloadUrl = await app.createCachedDownloadUrl(new Uint8Array([1, 2, 3]), 'mask name.nii');
  } finally {
    cache.restore();
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.match(downloadUrl, /^http:\/\/localhost:8080\/__lnm_downloads\/.+\/mask_name\.nii$/,
    'static fallback must use a same-origin service-worker download URL');
  assert.equal(cache.entries.size, 1,
    'static fallback must stage one Cache Storage response');
  const [[storedUrl, response]] = cache.entries;
  assert.equal(storedUrl, downloadUrl,
    'static fallback must return the staged response URL');
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [1, 2, 3],
    'static fallback must preserve mask bytes exactly');
  assert.equal(response.headers.get('Content-Length'), '3',
    'static fallback must store a non-zero content length');
  assert.deepEqual(cacheDeleteDelays, [600000],
    'static fallback must keep the staged response available long enough for browsers to start saving');
  assert.deepEqual(cache.deletes, [],
    'static fallback must not remove the staged response synchronously');
}

// ---- Test 10d.3: File System Access picker is ignored even when exposed ----
{
  const app = makeApp();
  app.confirmedNativeLesionFile = new File([new Uint8Array([1, 2, 3])], 'confirmed-native-mask.nii');
  const anchor = {
    href: '',
    download: '',
    clicked: 0,
    removed: 0,
    click() { this.clicked += 1; },
    remove() { this.removed += 1; }
  };
  let pickerCalls = 0;
  let fetchCalls = 0;
  const originalShowSaveFilePicker = globalThis.showSaveFilePicker;
  const originalCreateElement = globalThis.document.createElement;
  const originalBody = globalThis.document.body;
  const originalFetch = globalThis.fetch;
  globalThis.showSaveFilePicker = async () => {
    pickerCalls += 1;
    throw new Error('createWritable is blocked in this browser context');
  };
  globalThis.document.createElement = () => anchor;
  globalThis.document.body = { appendChild: () => {} };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 201,
      async json() {
        return { url: '/__lnm_downloads/token/lnm-lesion-edited-native.nii', byteLength: 3 };
      }
    };
  };

  try {
    await app.downloadEditedLesionMask();
  } finally {
    if (originalShowSaveFilePicker === undefined) delete globalThis.showSaveFilePicker;
    else globalThis.showSaveFilePicker = originalShowSaveFilePicker;
    globalThis.document.createElement = originalCreateElement;
    globalThis.document.body = originalBody;
    globalThis.fetch = originalFetch;
  }

  assert.equal(pickerCalls, 0,
    'mask download must not call showSaveFilePicker because createWritable is blocked in the in-app browser');
  assert.equal(fetchCalls, 1,
    'mask download must stage bytes on the localhost HTTP route');
  assert.equal(anchor.href, 'http://localhost:8080/__lnm_downloads/token/lnm-lesion-edited-native.nii',
    'mask download must use the normal HTTP download URL');
  assert.equal(anchor.clicked, 1,
    'mask download must start the normal HTTP download');
}

// ---- Test 10e: confirming the mask resumes the remaining pipeline stages ----
{
  const app = makeApp();
  const calls = [];
  app._perfRunStart = app._now();
  app._runStage = async (stage) => { calls.push(stage.id); };
  app._pendingMaskResume = {
    pipeline: {
      id: 'resume-test',
      displayName: 'Resume Test',
      stages: [
        { id: 'brain', module: 'brain-extraction' },
        { id: 'seed', module: 'inference-pipeline' },
        { id: 'register', module: 'registration' },
        { id: 'overlap', module: 'parcel-overlap' }
      ]
    },
    nextStageIndex: 2
  };

  await app.resumePipelineAfterMaskConfirmation();

  assert.deepEqual(calls, ['register', 'overlap'],
    'mask confirmation must resume at the stage after editable-seed review');
  assert.equal(app._pendingMaskResume, null,
    'pending resume state must be cleared after resuming');
  assert.ok(app._messages.some(message => /Pipeline complete/.test(message)),
    'resumed pipeline must report completion when remaining stages finish');
}

// ---- Test 11: thresholding schedules a live viewer preview overlay ----
{
  const app = makeApp();
  const summaryEl = { textContent: '' };
  const restoreDocument = useMockElements({
    networkThresholdValue: { value: '10' },
    networkThresholdSymmetric: { checked: true },
    networkThresholdMinCluster: { value: '4' },
    networkThresholdSummary: summaryEl,
    downloadThresholdedNetworkMapButton: { disabled: true }
  });
  const previewCalls = [];
  app.viewerController = {
    replaceOverlayForStage: async (...args) => { previewCalls.push(args); },
    removeVolumeForStage: () => {}
  };
  app.networkMapData = new Float32Array([-1.0, 0.25, 0.75, 2.0]);
  app.networkMapDims = [2, 2, 1];
  app.networkMapSpacing = [1, 1, 1];
  app.networkMapAffine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];

  try {
    const mask = app.applyNetworkThreshold();
    assert.equal(mask.reduce((sum, value) => sum + value, 0), 0,
      'top-percent threshold should apply min-cluster cleanup to the binary mask');
    assert.match(summaryEl.textContent, /^0 voxels survive top 10%/,
      'threshold summary should update immediately');
    assert.match(summaryEl.textContent, /cluster≥4 removed 1 voxels/,
      'threshold summary should report how many voxels cluster cleanup removed');

    await waitMs(90);
    await app._thresholdPreviewRenderPromise;

    assert.equal(previewCalls.length, 1,
      'thresholding must schedule exactly one live preview replacement');
    assert.equal(previewCalls[0][0], 'threshold-preview');
    assert.equal(previewCalls[0][1], app.thresholdedMaskFile,
      'preview must render the freshly generated thresholded mask file');
    assert.equal(previewCalls[0][2], 'red');
    assert.equal(previewCalls[0][3], 0.65);
  } finally {
    restoreDocument();
    app.cancelThresholdPreviewOverlay();
  }
}

// ---- Test 12: thresholding labels the final affected map by Yeo network ----
{
  const app = makeApp();
  const summaryEl = { textContent: '' };
  const affectedResultsEl = { classList: makeClassList(['hidden']) };
  const affectedTableEl = { innerHTML: '', appendChild: () => {} };
  const mapFunctionResultsEl = { classList: makeClassList(['hidden']) };
  const mapFunctionTableEl = { innerHTML: '', appendChild: () => {} };
  const elements = {
    networkThresholdValue: { value: '10' },
    networkThresholdSymmetric: { checked: false },
    networkThresholdMinCluster: { value: '0' },
    networkThresholdSummary: summaryEl,
    affectedNetworkResults: affectedResultsEl,
    affectedNetworkTable: affectedTableEl,
    mapFunctionProfileResults: mapFunctionResultsEl,
    mapFunctionProfileTable: mapFunctionTableEl,
    downloadThresholdedNetworkMapButton: { disabled: true }
  };
  const restoreDocument = useMockElements(elements);
  const originalCreateElement = globalThis.document.createElement;
  const renderedText = [];
  globalThis.document.createElement = (tagName) => {
    let text = '';
    return {
      tagName,
      children: [],
      style: {},
      classList: makeClassList(),
      appendChild(child) { this.children.push(child); },
      setAttribute: () => {},
      set textContent(value) {
        text = value;
        renderedText.push(value);
      },
      get textContent() { return text; }
    };
  };
  app.viewerController = {
    replaceOverlayForStage: async () => {},
    removeVolumeForStage: () => {}
  };
  app.networkMapData = new Float32Array([0.1, 2.0, 3.0, 4.0]);
  app.networkMapDims = [2, 2, 1];
  app.networkMapSpacing = [1, 1, 1];
  app.networkMapAffine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];
  app.selectedAtlasOptionId = 'yeo7';
  app.overlapResult = {
    atlasOption: app.atlasOptions.find(option => option.id === 'yeo7'),
    atlas: {
      data: new Int16Array([1, 2, 7, 2]),
      dims: [2, 2, 1],
      networkLabels: {
        1: 'Visual',
        2: 'Somatomotor',
        7: 'Default'
      }
    }
  };
  app.functionProfiles = {
    sourceLabel: 'Neurosynth v7 via NiMARE',
    networkProfiles: {
      Somatomotor: [{ term: 'motor', score: 0.9 }],
      Default: [{ term: 'memory', score: 0.8 }]
    }
  };

  try {
    const mask = app.applyNetworkThreshold();
    await app._functionalProfileRenderPromise;
    assert.equal(mask.reduce((sum, value) => sum + value, 0), 1,
      'top-percent threshold should keep only the strongest high-valued voxel in this toy map');
    assert.ok(app.affectedNetworkResult,
      'thresholding must store a final affected-network summary');
    assert.deepEqual(
      app.affectedNetworkResult.summary.networks.map(row => [row.network, row.voxelsInLesion]),
      [['Somatomotor', 1]],
      'affected-network summary must aggregate thresholded map voxels by Yeo label'
    );
    assert.equal(affectedResultsEl.classList.contains('hidden'), false,
      'affected-network table must become visible after thresholding');
    assert.ok(renderedText.includes('Somatomotor'),
      'affected-network table must render the dominant Yeo network name');
    assert.ok(renderedText.includes('% of map'),
      'affected-network table must use map-specific percent copy');
    assert.equal(mapFunctionResultsEl.classList.contains('hidden'), false,
      'connectivity-map functional profile table must become visible after thresholding');
    assert.ok(renderedText.includes('motor'),
      'connectivity-map functional profile must rank terms from affected Yeo networks');
    assert.ok(renderedText.includes('Neurosynth v7 via NiMARE'),
      'connectivity-map functional profile must show its source label');
  } finally {
    globalThis.document.createElement = originalCreateElement;
    restoreDocument();
    app.cancelThresholdPreviewOverlay();
  }
}

// ---- Test 12: min-cluster input recomputes as the user types ----
{
  const app = makeApp();
  const listeners = {};
  const noOpAddEventListener = () => {};
  const minClusterEl = {
    addEventListener: (eventName, handler) => { listeners[eventName] = handler; }
  };
  const restoreDocument = useMockElements({
    networkThresholdMinCluster: minClusterEl,
    networkThresholdValueLabel: { textContent: '' },
    networkThresholdValue: { value: '0.5', addEventListener: noOpAddEventListener },
    networkThresholdSymmetric: { checked: true, addEventListener: noOpAddEventListener }
  });
  let thresholdCalls = 0;
  app.networkMapData = new Float32Array([0, 1]);
  app.applyNetworkThreshold = () => { thresholdCalls += 1; };

  try {
    app.bindEvents();
    assert.equal(typeof listeners.input, 'function',
      'min-cluster input must recompute on input, not only after blur/change');
    listeners.input();
    assert.equal(thresholdCalls, 1,
      'min-cluster input handler should trigger threshold recompute immediately');
  } finally {
    restoreDocument();
  }
}

// ---- Test 12b: min-cluster filters following result tables ----
{
  const app = makeApp();
  const directResultsEl = { classList: makeClassList(['hidden']) };
  const directTableEl = { innerHTML: '', children: [], appendChild(child) { this.children.push(child); } };
  const affectedResultsEl = { classList: makeClassList(['hidden']) };
  const affectedTableEl = { innerHTML: '', children: [], appendChild(child) { this.children.push(child); } };
  const restoreDocument = useMockElements({
    networkThresholdMinCluster: { value: '30' },
    networkOverlapTable: directTableEl,
    directFunctionProfileResults: directResultsEl,
    directFunctionProfileTable: { innerHTML: '', children: [], appendChild(child) { this.children.push(child); } },
    affectedNetworkResults: affectedResultsEl,
    affectedNetworkTable: affectedTableEl
  });
  const originalCreateElement = globalThis.document.createElement;
  const renderedText = [];
  globalThis.document.createElement = (tagName) => {
    let text = '';
    return {
      tagName,
      children: [],
      style: {},
      classList: makeClassList(),
      colSpan: 1,
      appendChild(child) { this.children.push(child); },
      setAttribute: () => {},
      set textContent(value) {
        text = value;
        renderedText.push(value);
      },
      get textContent() { return text; }
    };
  };
  const atlasOption = app.atlasOptions.find(option => option.id === 'yeo7');
  app.selectedAtlasOptionId = 'yeo7';
  app.overlapResult = {
    atlasOption,
    summary: {
      totalLesionVoxels: 40,
      networks: [
        { network: 'Somatomotor', voxelsInLesion: 31, fractionOfLesion: 31 / 40, parcels: [2] },
        { network: 'Default', voxelsInLesion: 9, fractionOfLesion: 9 / 40, parcels: [7] }
      ]
    },
    networkSizes: {}
  };
  app.affectedNetworkResult = {
    atlasOption,
    summary: {
      totalLesionVoxels: 35,
      networks: [
        { network: 'Visual', voxelsInLesion: 32, fractionOfLesion: 32 / 35, parcels: [1] },
        { network: 'Default', voxelsInLesion: 3, fractionOfLesion: 3 / 35, parcels: [7] }
      ]
    }
  };
  app.functionProfiles = {
    sourceLabel: 'Neurosynth v7 via NiMARE',
    networkProfiles: {
      Somatomotor: [{ term: 'motor', score: 0.9 }],
      Default: [{ term: 'memory', score: 0.9 }]
    }
  };

  try {
    app.renderDirectOverlapTable();
    assert.ok(renderedText.includes('Somatomotor'),
      'direct overlap table must keep rows meeting the min-cluster filter');
    assert.equal(renderedText.includes('Default'), false,
      'direct overlap table must hide rows below the min-cluster filter');

    await app.updateDirectFunctionProfile();
    assert.ok(renderedText.includes('motor'),
      'direct functional profile must use the filtered direct-overlap summary');
    assert.equal(renderedText.includes('memory'), false,
      'direct functional profile must not include terms from hidden rows');

    app.renderAffectedNetworkTable();
    assert.ok(renderedText.includes('Visual'),
      'affected-network table must keep rows meeting the min-cluster filter');
    assert.equal(renderedText.includes('Default'), false,
      'affected-network table must hide rows below the min-cluster filter');
  } finally {
    globalThis.document.createElement = originalCreateElement;
    restoreDocument();
  }
}

// ---- Test 13: percentile UI uses top-percent semantics ----
{
  const app = makeApp();
  const valueEl = { value: '0' };
  const elements = {
    networkThresholdValue: valueEl,
    networkThresholdSymmetric: { checked: true },
    networkThresholdMinCluster: { value: '0' },
    networkThresholdSummary: { textContent: '' },
    downloadThresholdedNetworkMapButton: { disabled: true }
  };
  const restoreDocument = useMockElements(elements);
  app.viewerController = {
    replaceOverlayForStage: async () => {},
    removeVolumeForStage: () => {}
  };
  app.networkMapData = new Float32Array([1, 2, 3, 4]);
  app.networkMapDims = [2, 2, 1];
  app.networkMapSpacing = [1, 1, 1];
  app.networkMapAffine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];

  try {
    app.configureTopPercentThresholdSlider({ resetValue: true });
    assert.equal(valueEl.min, '0', 'top-percent slider min must be 0');
    assert.equal(valueEl.max, '10', 'top-percent slider max must be 10 for easier adjustment');
    assert.equal(valueEl.step, '0.1', 'top-percent slider step must allow fine 0.1% adjustment');
    assert.equal(valueEl.value, '5', 'top-percent slider reset should land on the 5% default');

    valueEl.value = '0';
    const mask0 = app.applyNetworkThreshold();
    assert.equal(mask0.reduce((sum, value) => sum + value, 0), 0,
      'top 0% must keep no voxels, not the whole map');
    assert.match(elements.networkThresholdSummary.textContent, /top 0%/,
      'summary must report user-facing top-percent semantics');

    valueEl.value = '10';
    const mask10 = app.applyNetworkThreshold();
    assert.equal(mask10.reduce((sum, value) => sum + value, 0), 1,
      'top 10% of four ranked voxels should keep only the strongest voxel');
    assert.match(elements.networkThresholdSummary.textContent, /top 10%/,
      'summary must track the top-percent slider value');
  } finally {
    restoreDocument();
    app.cancelThresholdPreviewOverlay();
  }
}

// ---- Test 14: version label de-duplicates the staging short SHA ----
{
  assert.equal(
    formatVersionLabel('0.17.1-staging+31ff9d1', {
      sha: '31ff9d1',
      branch: 'main',
      dirty: false
    }),
    'v0.17.1-staging+31ff9d1',
    'staging version must not append the same git SHA twice'
  );
  assert.equal(
    formatVersionLabel('0.17.1', {
      sha: '31ff9d1',
      branch: 'main',
      dirty: false
    }),
    'v0.17.1 (31ff9d1)',
    'plain versions should still surface build-info SHA'
  );
}

// ---- Test 15: atlas label coverage note is neutral, not a brain-mask warning ----
{
  const app = makeApp();
  const classOps = [];
  const coverageEl = {
    textContent: '',
    classList: {
      add: (cls) => { classOps.push(['add', cls]); },
      remove: (cls) => { classOps.push(['remove', cls]); }
    }
  };
  const restoreDocument = useMockElements({ outsideAtlasWarning: coverageEl });

  try {
    app.showAtlasCoverageNote(2, 7);
    assert.equal(
      coverageEl.textContent,
      '5 of 7 lesion voxels are assigned to Schaefer 400 parcels labels; 2 are unlabeled by this atlas.',
      'coverage note must report assigned and unlabeled atlas-label voxels'
    );
    assert.deepEqual(classOps.at(-1), ['remove', 'hidden'],
      'coverage note should be visible when any lesion voxels are unlabeled');

    app.showAtlasCoverageNote(0, 7);
    assert.equal(coverageEl.textContent, '',
      'coverage note should clear when all lesion voxels are labelled');
    assert.deepEqual(classOps.at(-1), ['add', 'hidden'],
      'coverage note should hide when there are no unlabeled voxels');
  } finally {
    restoreDocument();
  }
}

// ---- Test 16: unavailable viewer layers are disabled and unchecked ----
{
  const app = makeApp();
  app.structuralFile = { name: 't1.nii' };
  app.viewerController = {
    getVolumeIndexForStage: stage => stage === 'structural' ? 0 : null
  };

  const makeToggle = () => ({
    checked: true,
    disabled: false,
    addEventListener: () => {}
  });
  const toggles = {
    layerToggleT1: makeToggle(),
    layerToggleBrainMask: makeToggle(),
    layerToggleLesionMask: makeToggle(),
    layerToggleThresholdMap: makeToggle(),
    layerToggleAtlasQc: makeToggle()
  };
  const restoreDocument = useMockElements(toggles);

  try {
    app.refreshViewerLayerControls();
    assert.equal(toggles.layerToggleT1.disabled, false,
      'available structural layer must remain enabled');
    assert.equal(toggles.layerToggleT1.checked, true,
      'available structural layer must mirror the visible preference');
    assert.equal(toggles.layerToggleAtlasQc.disabled, true,
      'Yeo atlas toggle must be disabled before an atlas-QC volume is available');
    assert.equal(toggles.layerToggleAtlasQc.checked, false,
      'unavailable Yeo atlas toggle must not appear checked');
  } finally {
    restoreDocument();
  }
}

// ---- Test 16: direct lesion overlap renders exploratory functional terms ----
{
  const app = makeApp();
  const directResultsEl = { classList: makeClassList(['hidden']) };
  const directTableEl = { innerHTML: '', appendChild: () => {} };
  const restoreDocument = useMockElements({
    directFunctionProfileResults: directResultsEl,
    directFunctionProfileTable: directTableEl
  });
  const originalCreateElement = globalThis.document.createElement;
  const renderedText = [];
  globalThis.document.createElement = (tagName) => {
    let text = '';
    return {
      tagName,
      children: [],
      style: {},
      classList: makeClassList(),
      appendChild(child) { this.children.push(child); },
      setAttribute: () => {},
      set textContent(value) {
        text = value;
        renderedText.push(value);
      },
      get textContent() { return text; }
    };
  };
  app.selectedAtlasOptionId = 'yeo7';
  app.overlapResult = {
    atlasOption: app.atlasOptions.find(option => option.id === 'yeo7'),
    summary: {
      networks: [
        { network: 'Visual', fractionOfLesion: 0.6 },
        { network: 'Default', fractionOfLesion: 0.4 }
      ]
    }
  };
  app.functionProfiles = {
    sourceLabel: 'Neurosynth v7 via NiMARE',
    networkProfiles: {
      Visual: [{ term: 'visual', score: 0.8 }],
      Default: [{ term: 'memory', score: 0.7 }]
    }
  };

  try {
    const ranked = await app.updateDirectFunctionProfile();
    assert.equal(directResultsEl.classList.contains('hidden'), false,
      'direct functional profile table must become visible after overlap');
    assert.equal(ranked[0].term, 'visual',
      'direct functional profile must weight terms by direct lesion-overlap fractions');
    assert.ok(renderedText.includes('Neurosynth v7 via NiMARE'),
      'direct functional profile must show its source label');
  } finally {
    globalThis.document.createElement = originalCreateElement;
    restoreDocument();
  }
}

// ---- Test 16: viewer layer toggles bind to stage visibility ----
{
  const app = makeApp();
  app.structuralFile = { name: 't1.nii' };
  app.brainmaskFile = { name: 'brainmask.nii' };
  app.lesionMaskFile = { name: 'lesion.nii' };
  app.thresholdedMaskFile = { name: 'threshold.nii' };
  app.patientAtlasFile = { name: 'atlas-patient.nii' };
  app.maskReviewActive = true;

  const listeners = {};
  const makeToggle = id => ({
    checked: true,
    disabled: true,
    addEventListener: (eventName, handler) => { listeners[`${id}:${eventName}`] = handler; }
  });
  const toggles = {
    layerToggleT1: makeToggle('layerToggleT1'),
    layerToggleBrainMask: makeToggle('layerToggleBrainMask'),
    layerToggleLesionMask: makeToggle('layerToggleLesionMask'),
    layerToggleThresholdMap: makeToggle('layerToggleThresholdMap'),
    layerToggleAtlasQc: makeToggle('layerToggleAtlasQc')
  };
  const restoreDocument = useMockElements(toggles);
  const stageVisibilityCalls = [];
  const drawingVisibilityCalls = [];
  const activeStages = new Set(['structural', 'brainmask', 'segmentation', 'lesion', 'threshold-preview', 'atlas-qc']);
  app.viewerController = {
    getVolumeIndexForStage: stage => activeStages.has(stage) ? 1 : null,
    setStageVisible: (stage, visible) => {
      stageVisibilityCalls.push([stage, visible]);
      return true;
    }
  };
  app.maskDrawingController = {
    hasDrawing: true,
    setVisible: (visible) => { drawingVisibilityCalls.push(visible); }
  };

  try {
    app.bindEvents();
    for (const el of Object.values(toggles)) {
      assert.equal(el.disabled, false, 'available layer toggles must be enabled');
      assert.equal(el.checked, true, 'available layer toggles default visible');
    }

    listeners['layerToggleBrainMask:change']({ target: { checked: false } });
    assert.equal(app.viewerLayerVisibility.brainmask, false,
      'brain-mask toggle must persist app-level visibility state');
    assert.deepEqual(stageVisibilityCalls.at(-1), ['brainmask', false],
      'brain-mask toggle must target the brainmask viewer stage');

    listeners['layerToggleLesionMask:change']({ target: { checked: false } });
    assert.ok(stageVisibilityCalls.some(call => call[0] === 'segmentation' && call[1] === false),
      'lesion toggle must hide the native segmentation stage');
    assert.ok(stageVisibilityCalls.some(call => call[0] === 'lesion' && call[1] === false),
      'lesion toggle must hide the Yeo/manual lesion stage');
    assert.equal(drawingVisibilityCalls.at(-1), false,
      'lesion toggle must hide the active editable drawing overlay');

    listeners['layerToggleLesionMask:change']({ target: { checked: true } });
    await waitForMicrotaskCondition(() => drawingVisibilityCalls.at(-1) === true,
      'lesion toggle must restore the active editable drawing overlay');
    assert.equal(drawingVisibilityCalls.at(-1), true,
      'lesion toggle must restore the active editable drawing overlay');

    listeners['layerToggleAtlasQc:change']({ target: { checked: false } });
    assert.deepEqual(stageVisibilityCalls.at(-1), ['atlas-qc', false],
      'atlas QC toggle must target the subject-space atlas viewer stage');
  } finally {
    restoreDocument();
  }
}

// ---- Test 16a: layer controls reflect the active viewer stack, not stale files ----
{
  const app = makeApp();
  app.structuralFile = { name: 't1.nii' };
  app.brainmaskFile = { name: 'brainmask.nii' };
  app.lesionMaskFile = { name: 'lesion-mask.nii' };
  app.lesionFile = { name: 'lesion.nii' };
  app.patientAtlasFile = { name: 'atlas-patient.nii' };
  app.patientThresholdedMaskFile = { name: 'threshold-patient.nii' };
  const activeStages = new Set(['structural', 'threshold-preview']);
  app.viewerController = {
    getVolumeIndexForStage: stage => activeStages.has(stage) ? 1 : null
  };
  const makeToggle = () => ({ checked: true, disabled: false });
  const toggles = {
    layerToggleT1: makeToggle(),
    layerToggleBrainMask: makeToggle(),
    layerToggleLesionMask: makeToggle(),
    layerToggleThresholdMap: makeToggle(),
    layerToggleAtlasQc: makeToggle()
  };
  const restoreDocument = useMockElements(toggles);

  try {
    app.refreshViewerLayerControls();
    assert.deepEqual(
      Object.fromEntries(Object.entries(toggles).map(([id, el]) => [id, { checked: el.checked, disabled: el.disabled }])),
      {
        layerToggleT1: { checked: true, disabled: false },
        layerToggleBrainMask: { checked: false, disabled: false },
        layerToggleLesionMask: { checked: false, disabled: false },
        layerToggleThresholdMap: { checked: true, disabled: false },
        layerToggleAtlasQc: { checked: false, disabled: false }
      },
      'final threshold view controls must be unchecked for inactive layers but enabled when data exists'
    );
  } finally {
    restoreDocument();
  }
}

// ---- Test 16b: checking an available inactive layer adds it to the viewer stack ----
{
  const app = makeApp();
  app.structuralFile = { name: 't1.nii' };
  app.brainmaskFile = { name: 'brainmask.nii' };
  app.lesionMaskFile = { name: 'lesion-mask.nii' };
  app.patientAtlasFile = { name: 'atlas-patient.nii' };
  app.patientThresholdedMaskFile = { name: 'threshold-patient.nii' };
  const activeStages = new Set(['structural', 'threshold-preview']);
  const listeners = {};
  const overlayCalls = [];
  const visibilityCalls = [];
  const makeToggle = id => ({
    checked: true,
    disabled: false,
    addEventListener: (eventName, handler) => { listeners[`${id}:${eventName}`] = handler; }
  });
  const toggles = {
    layerToggleT1: makeToggle('layerToggleT1'),
    layerToggleBrainMask: makeToggle('layerToggleBrainMask'),
    layerToggleLesionMask: makeToggle('layerToggleLesionMask'),
    layerToggleThresholdMap: makeToggle('layerToggleThresholdMap'),
    layerToggleAtlasQc: makeToggle('layerToggleAtlasQc')
  };
  const restoreDocument = useMockElements(toggles);
  app.viewerController = {
    getVolumeIndexForStage: stage => activeStages.has(stage) ? 1 : null,
    loadOverlay: async (file, colormap, opacity, options = {}) => {
      overlayCalls.push([file, colormap, opacity, options]);
      if (options.stage) activeStages.add(options.stage);
    },
    setStageVisible: (stage, visible) => {
      visibilityCalls.push([stage, visible]);
      return activeStages.has(stage);
    }
  };

  try {
    app.bindViewerLayerToggles();
    assert.equal(toggles.layerToggleBrainMask.checked, false,
      'inactive-but-available brain mask starts unchecked');
    assert.equal(toggles.layerToggleBrainMask.disabled, false,
      'inactive-but-available brain mask can be activated');

    listeners['layerToggleBrainMask:change']({ target: { checked: true } });
    await waitForMicrotaskCondition(() => activeStages.has('brainmask') && toggles.layerToggleBrainMask.checked,
      'checking brain mask must load the brainmask overlay and refresh the checkbox');
    assert.equal(overlayCalls.at(-1)[0], app.brainmaskFile,
      'brain-mask activation must load the stored brain mask file');
    assert.equal(overlayCalls.at(-1)[3].stage, 'brainmask');
    assert.equal(toggles.layerToggleBrainMask.checked, true,
      'brain-mask checkbox must become checked after the overlay is loaded');

    listeners['layerToggleLesionMask:change']({ target: { checked: true } });
    await waitForMicrotaskCondition(() => activeStages.has('segmentation') && toggles.layerToggleLesionMask.checked,
      'checking lesion mask must load the lesion overlay and refresh the checkbox');
    assert.equal(overlayCalls.at(-1)[0], app.lesionMaskFile,
      'lesion activation must prefer the confirmed MNI160 lesion mask');
    assert.equal(overlayCalls.at(-1)[3].stage, 'segmentation');

    listeners['layerToggleAtlasQc:change']({ target: { checked: true } });
    await waitForMicrotaskCondition(() => activeStages.has('atlas-qc') && toggles.layerToggleAtlasQc.checked,
      'checking Yeo atlas must load the atlas-QC overlay and refresh the checkbox');
    assert.equal(overlayCalls.at(-1)[0], app.patientAtlasFile,
      'Yeo atlas activation must load the projected patient-space atlas');
    assert.equal(overlayCalls.at(-1)[3].stage, 'atlas-qc');
  } finally {
    restoreDocument();
  }
}

// ---- Test 16c: mask-review brain-mask toggle uses the native-space mask ----
{
  const app = makeApp();
  const affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  app.structuralFile = tagSpatialFile({ name: 'lnm-prealign-t1.nii' }, {
    space: VOLUME_SPACES.MNI160,
    dims: [160, 160, 192],
    affine
  });
  app.nativeStructuralFile = tagSpatialFile({ name: 'native-t1.nii' }, {
    space: VOLUME_SPACES.NATIVE_T1,
    dims: [128, 128, 128],
    affine
  });
  app.viewerBaseFile = app.nativeStructuralFile;
  app.brainmaskFile = tagSpatialFile({ name: 'lnm-prealign-brainmask.nii' }, {
    space: VOLUME_SPACES.MNI160,
    dims: [160, 160, 192],
    affine
  });
  app.nativeBrainmaskFile = tagSpatialFile({ name: 'native-brainmask.nii' }, {
    space: VOLUME_SPACES.NATIVE_T1,
    dims: [128, 128, 128],
    affine
  });
  app.maskReviewActive = true;
  const activeStages = new Set(['structural']);
  const listeners = {};
  const overlayCalls = [];
  const makeToggle = id => ({
    checked: true,
    disabled: false,
    addEventListener: (eventName, handler) => { listeners[`${id}:${eventName}`] = handler; }
  });
  const toggles = {
    layerToggleT1: makeToggle('layerToggleT1'),
    layerToggleBrainMask: makeToggle('layerToggleBrainMask'),
    layerToggleLesionMask: makeToggle('layerToggleLesionMask'),
    layerToggleThresholdMap: makeToggle('layerToggleThresholdMap'),
    layerToggleAtlasQc: makeToggle('layerToggleAtlasQc')
  };
  const restoreDocument = useMockElements(toggles);
  app.viewerController = {
    getVolumeIndexForStage: stage => {
      if (stage === 'structural') return 0;
      return activeStages.has(stage) ? 1 : null;
    },
    loadOverlay: async (file, colormap, opacity, options = {}) => {
      overlayCalls.push([file, colormap, opacity, options]);
      if (options.stage) activeStages.add(options.stage);
    },
    setStageVisible: () => true
  };

  try {
    app.bindViewerLayerToggles();
    assert.equal(toggles.layerToggleBrainMask.disabled, false,
      'native-space brain mask must be available during lesion-mask review');
    assert.equal(toggles.layerToggleBrainMask.checked, false,
      'inactive review brain mask starts unchecked until the user activates it');

    listeners['layerToggleBrainMask:change']({ target: { checked: true } });
    await waitForMicrotaskCondition(() => activeStages.has('brainmask') && toggles.layerToggleBrainMask.checked,
      'checking brain mask in review mode must load a brainmask overlay');
    assert.equal(overlayCalls.at(-1)[0], app.nativeBrainmaskFile,
      'review-mode brain-mask activation must load the native-space mask, not the prealigned mask');
    assert.equal(overlayCalls.at(-1)[3].stage, 'brainmask');
  } finally {
    restoreDocument();
  }

  app.viewerController = null;
  app.nativeBrainmaskFile = null;
  assert.equal(app.getViewerLayerAvailable('brainmask'), false,
    'review-mode brain-mask layer must be unavailable rather than showing a wrong-space prealigned mask');
}

// ---- Test 16d: viewer overlays reject tagged space mismatches before render ----
{
  const app = makeApp();
  const affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  app.structuralFile = tagSpatialFile({ name: 'native-t1.nii' }, {
    space: VOLUME_SPACES.NATIVE_T1,
    dims: [2, 2, 2],
    affine
  });
  app.viewerBaseFile = app.structuralFile;
  app.lesionMaskFile = tagSpatialFile({ name: 'mni-lesion.nii' }, {
    space: VOLUME_SPACES.MNI160,
    dims: [2, 2, 2],
    affine
  });
  let overlayCalls = 0;
  app.viewerController = {
    getVolumeIndexForStage: stage => stage === 'structural' ? 0 : null,
    loadOverlay: async () => { overlayCalls += 1; }
  };
  await assert.rejects(
    () => app.ensureViewerLayerLoaded('lesion'),
    /Lesion mask overlay: base is in native-t1, overlay is in mni160/,
    'lesion-mask toggle must reject a wrong-space mask before loading the overlay'
  );
  assert.equal(overlayCalls, 0,
    'wrong-space overlays must not be passed to NiiVue');
}

// ---- Test 17: threshold preview chooses patient-space projection when available ----
{
  const app = makeApp();
  app.structuralFile = { name: 't1.nii' };
  app.thresholdedMaskFile = { name: 'threshold.nii' };
  app.networkMapAffine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  app.hasRegistrationDisplacement = true;
  app.viewerController = {};
  const projected = [];
  let patientStackRenders = 0;
  let atlasRenders = 0;
  app.projectThresholdToPatientSpace = async (version) => {
    projected.push(version);
    app.patientThresholdedMaskFile = { name: 'patient-threshold.nii' };
  };
  app.renderPatientLayerStack = async () => { patientStackRenders += 1; };
  app.renderAtlasThresholdPreviewOverlay = async () => { atlasRenders += 1; };

  await app.renderThresholdPreviewOverlay(app._thresholdPreviewVersion);

  assert.equal(projected.length, 1,
    'registered structural runs must project threshold masks to patient space');
  assert.equal(patientStackRenders, 1,
    'patient-space projection must render the patient layer stack');
  assert.equal(atlasRenders, 0,
    'patient-space projection must not fall back to the atlas preview');
}

// ---- Test 17a: final patient-space threshold view only shows T1 + threshold ----
{
  const app = makeApp();
  app.structuralFile = { name: 't1.nii' };
  app.brainmaskFile = { name: 'brainmask.nii' };
  app.lesionMaskFile = { name: 'lesion-mask.nii' };
  app.lesionFile = { name: 'lesion.nii' };
  app.patientAtlasFile = { name: 'atlas-patient.nii' };
  app.patientThresholdedMaskFile = { name: 'threshold-patient.nii' };
  const renderedStacks = [];
  app.viewerController = {
    loadVolumeStack: async (entries) => { renderedStacks.push(entries); },
    setStageVisible: () => true
  };

  await app.renderPatientLayerStack();

  const stages = renderedStacks.at(-1).map(entry => entry.stage);
  assert.deepEqual(stages, ['structural', 'threshold-preview'],
    'final patient-space threshold view must load only the structural T1 and threshold map');
}

// ---- Test 17b: advanced atlas-alignment QC button mirrors subject-atlas
//      enablement and invokes the existing visual QC overlay path ----
{
  const app = makeApp();
  const listeners = {};
  const makeButton = id => ({
    disabled: false,
    addEventListener: (eventName, handler) => { listeners[`${id}:${eventName}`] = handler; }
  });
  const controls = {
    checkAtlasAlignmentButton: makeButton('checkAtlasAlignmentButton'),
    registrationQcMode: {
      value: 'mni',
      addEventListener: (eventName, handler) => { listeners[`registrationQcMode:${eventName}`] = handler; }
    },
    showSubjectAtlasButton: makeButton('showSubjectAtlasButton'),
    downloadSubjectAtlasButton: makeButton('downloadSubjectAtlasButton')
  };
  const restoreDocument = useMockElements(controls);
  let qcCalls = 0;
  app.showRegistrationQc = async () => { qcCalls += 1; };

  try {
    app.bindEvents();
    assert.equal(controls.checkAtlasAlignmentButton.disabled, true,
      'advanced atlas QC button starts disabled before registration');
    assert.equal(controls.showSubjectAtlasButton.disabled, true,
      'results atlas QC button starts disabled before registration');

    app.structuralFile = { name: 't1.nii' };
    app.hasRegistrationDisplacement = false;
    app.refreshSubjectAtlasControls();
    assert.equal(controls.checkAtlasAlignmentButton.disabled, true,
      'advanced atlas QC button stays disabled until registration displacement exists');
    assert.equal(controls.showSubjectAtlasButton.disabled, true,
      'results atlas QC button stays disabled until registration displacement exists');

    app.hasRegistrationDisplacement = true;
    app.refreshSubjectAtlasControls();
    assert.equal(controls.checkAtlasAlignmentButton.disabled, false,
      'advanced atlas QC button enables after structural T1 + registration');
    assert.equal(controls.showSubjectAtlasButton.disabled, false,
      'results atlas QC button enables after structural T1 + registration');

    listeners['checkAtlasAlignmentButton:click']();
    await waitForMicrotaskCondition(() => qcCalls === 1,
      'advanced atlas QC button must invoke showRegistrationQc');
  } finally {
    restoreDocument();
  }
}

// ---- Test 17c: Patient/MNI registration blend slider drives the
//      registered-patient overlay opacity in QC views ----
{
  const app = makeApp();
  const listeners = {};
  const controls = {
    registrationBlendValue: {
      value: '0.75',
      addEventListener: (eventName, handler) => { listeners[`registrationBlendValue:${eventName}`] = handler; }
    },
    registrationBlendLabel: { textContent: '' }
  };
  const restoreDocument = useMockElements(controls);
  const stageOpacityCalls = [];
  const appliedStages = [];
  let glUpdates = 0;

  app.viewerController = {
    setStageOpacity: (stage, opacity, options = {}) => {
      stageOpacityCalls.push([stage, opacity, options]);
      if (options.apply) appliedStages.push(stage);
      if (options.redraw) glUpdates += 1;
      return true;
    },
    nv: {
      updateGLVolume: () => { glUpdates += 1; },
      drawScene: () => {}
    }
  };

  try {
    app.bindEvents();
    assert.equal(app.registrationBlendValue, 0.75,
      'registration blend slider value must initialize app state');
    assert.equal(controls.registrationBlendLabel.textContent, '75% patient',
      'registration blend label must describe the registered-patient opacity');

    controls.registrationBlendValue.value = '0';
    listeners['registrationBlendValue:input']();
    assert.deepEqual(stageOpacityCalls.at(-1).slice(0, 2), ['registered-t1-mni160', 0],
      'MNI-only blend must set registered-patient overlay opacity to zero');
    assert.equal(controls.registrationBlendLabel.textContent, 'MNI template',
      'zero blend label must identify the fixed MNI template');

    controls.registrationBlendValue.value = '1';
    listeners['registrationBlendValue:change']();
    assert.deepEqual(stageOpacityCalls.at(-1).slice(0, 2), ['registered-t1-mni160', 1],
      'patient-only blend must set registered-patient overlay opacity to one');
    assert.equal(controls.registrationBlendLabel.textContent, 'Registered patient',
      'full blend label must identify the registered patient scan');
    assert.ok(appliedStages.includes('registered-t1-mni160'),
      'blend changes must be applied to the active registered-patient stage');
    assert.ok(glUpdates >= 2,
      'viewer must redraw after active registration blend changes');
  } finally {
    restoreDocument();
  }
}

// ---- Test 17d: moving the Patient/MNI blend slider opens MNI QC if
//      registration artifacts exist but the active viewer is still patient-space ----
{
  const app = makeApp();
  const listeners = {};
  const controls = {
    registrationQcMode: {
      value: 'patient',
      addEventListener: (eventName, handler) => { listeners[`registrationQcMode:${eventName}`] = handler; }
    },
    registrationBlendValue: {
      value: '0.6',
      addEventListener: (eventName, handler) => { listeners[`registrationBlendValue:${eventName}`] = handler; }
    },
    registrationBlendLabel: { textContent: '' }
  };
  const restoreDocument = useMockElements(controls);
  let mniRenders = 0;
  app.hasRegistrationDisplacement = true;
  app.registeredT1MniFile = { name: 'registered.nii' };
  app.viewerController = {
    setStageOpacity: () => false
  };
  app.renderMniRegistrationQc = async () => { mniRenders += 1; };

  try {
    app.bindEvents();
    listeners['registrationBlendValue:input']();
    await waitForMicrotaskCondition(() => mniRenders === 1,
      'blend slider must render MNI QC when the blend target is not active');
    assert.equal(controls.registrationQcMode.value, 'mni',
      'blend slider must switch the QC selector to MNI space before rendering');
    assert.equal(app.registrationQcMode, 'mni',
      'blend slider must update app QC mode to MNI space');
  } finally {
    restoreDocument();
  }
}

// ---- Test 17e: registration QC render modes use MNI-space artifacts ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const affine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];
  const templateBuffer = writeNifti1(new Float32Array([0, 1]), {
    dims: [2, 1, 1],
    spacing: [1, 1, 1],
    affine,
    description: 'qc template'
  });
  const registeredBuffer = writeNifti1(new Float32Array([1, 0]), {
    dims: [2, 1, 1],
    spacing: [1, 1, 1],
    affine,
    description: 'qc registered'
  });
  const displacementBuffer = writeNifti1(new Float32Array([0, 3]), {
    dims: [2, 1, 1],
    spacing: [1, 1, 1],
    affine,
    description: 'qc displacement'
  });
  const atlasBuffer = writeNifti1(new Uint8Array([1, 2]), {
    dims: [2, 1, 1],
    spacing: [1, 1, 1],
    affine,
    description: 'qc yeo atlas'
  });

  app.registrationTemplateFile = makeNiftiFile('template.nii', templateBuffer);
  app.yeoAtlasMni160File = makeNiftiFile('yeo-mni.nii', atlasBuffer);
  app.handleStageData({ stage: 'registered-t1-mni160', niftiData: registeredBuffer });
  app.handleStageData({ stage: 'registration-displacement-mag', niftiData: displacementBuffer });
  assert.equal(app.registeredT1MniFile.name, 'lnm-registered-t1-mni160.nii',
    'registered T1 QC stage must be cached as a File');
  assert.equal(app.displacementMagnitudeFile.name, 'lnm-registration-displacement-mag.nii',
    'displacement magnitude QC stage must be cached as a File');
  app.registrationBlendValue = 0.8;

  const renderedStacks = [];
  app.viewerController = {
    loadVolumeStack: async (entries) => { renderedStacks.push(entries); },
    setStageVisible: () => true,
    setStageOpacity: () => false
  };

  await app.renderMniRegistrationQc();
  assert.deepEqual(renderedStacks.at(-1).map(entry => entry.stage), [
    'registration-template',
    'registered-t1-mni160'
  ], 'MNI QC view must show only the fixed template and registered T1');
  assert.equal(renderedStacks.at(-1).find(entry => entry.stage === 'registered-t1-mni160').opacity, 0.8,
    'MNI QC view must use the Patient/MNI blend slider for registered T1 opacity');

  await app.renderCheckerboardRegistrationQc();
  assert.deepEqual(renderedStacks.at(-1).map(entry => entry.stage), [
    'registration-checkerboard'
  ], 'checkerboard QC view must show only the fixed-template/registered-T1 checkerboard');
  assert.ok(app.registrationCheckerboardFile,
    'checkerboard QC view must cache the generated checkerboard NIfTI');

  await app.renderDisplacementRegistrationQc();
  assert.ok(renderedStacks.at(-1).some(entry => entry.stage === 'registration-displacement' && entry.scalar),
    'displacement QC view must render the displacement magnitude map as a scalar overlay');
  assert.equal(renderedStacks.at(-1).find(entry => entry.stage === 'registered-t1-mni160').opacity, 0.8,
    'displacement QC view must retain the same registered T1 blend for patient/template comparison');
}

// ---- Test 18: patient projection resamples Yeo threshold onto lnm-mni160,
//      not the structural/prealign affine ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const thresholdData = new Uint8Array(5 * 5 * 5);
  thresholdData[0] = 1;
  const thresholdAffine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];
  const mni160Data = new Uint8Array(2 * 2 * 2);
  const mni160Affine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];
  const structuralData = new Uint8Array(2 * 2 * 2);
  const structuralAffine = [
    1, 0, 0, 2,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];
  app.thresholdedMaskFile = makeNiftiFile('threshold.nii', writeNifti1(thresholdData, {
    dims: [5, 5, 5],
    spacing: [1, 1, 1],
    affine: thresholdAffine,
    description: 'synthetic threshold'
  }));
  app.structuralFile = makeNiftiFile('structural-prealign.nii', writeNifti1(structuralData, {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine: structuralAffine,
    description: 'synthetic structural with shifted affine'
  }));
  const mni160Buffer = writeNifti1(mni160Data, {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine: mni160Affine,
    description: 'synthetic lnm-mni160'
  });

  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = undefined;
  const fetched = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    fetched.push(href);
    if (href.includes('manifest.json')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            atlasAssets: [{
              id: 'lnm-mni160',
              sourceUrl: 'https://example.test/lnm-mni160.nii',
              cacheKey: 'lnm-mni160-test',
              dims: [2, 2, 2],
              supportStatus: 'supported'
            }]
          };
        }
      };
    }
    if (href === 'https://example.test/lnm-mni160.nii') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return mni160Buffer; }
      };
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };

  try {
    const { mask, dims } = await app.resampleThresholdMaskToStructuralGrid();
    assert.deepEqual(dims, [2, 2, 2],
      'projection input to inverse-warp must use lnm-mni160 dims');
    assert.equal(mask[0], 1,
      'Yeo threshold must be sampled through the lnm-mni160 affine');
    assert.equal(mask[1], 0,
      'synthetic threshold should not be shifted through the structural affine');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

// ---- Test 19: prealign writes fixed lnm-mni160 headers, not the sampling affine ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  app.viewerController = {
    loadBaseVolume: async () => {},
    loadOverlay: async () => {},
    removeVolumeForStage: () => {}
  };
  const dims = [4, 4, 4];
  const t1Data = new Float32Array(64);
  for (let i = 0; i < t1Data.length; i++) t1Data[i] = i + 1;
  const maskData = new Uint8Array(64);
  maskData.fill(1);
  const sourceAffine = [
    1, 0.15, 0, 4,
    0, 1, 0.2, -3,
    0, 0, 1, 2
  ];
  const fixedMniAffine = [
    1, 0, 0, -2,
    0, 1, 0, -2,
    0, 0, 1, -2
  ];
  app.structuralFile = makeNiftiFile('source-oblique.nii', writeNifti1(t1Data, {
    dims,
    spacing: [1, 1, 1],
    affine: sourceAffine,
    description: 'synthetic oblique source'
  }));
  app.brainmaskFile = makeNiftiFile('source-mask.nii', writeNifti1(maskData, {
    dims,
    spacing: [1, 1, 1],
    affine: sourceAffine,
    description: 'synthetic source mask'
  }));
  const sourceBrainmaskFile = app.brainmaskFile;
  const mni160Buffer = writeNifti1(new Uint8Array(64), {
    dims,
    spacing: [1, 1, 1],
    affine: fixedMniAffine,
    description: 'synthetic fixed lnm-mni160'
  });

  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = undefined;
  const fetched = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    fetched.push(href);
    if (href.includes('manifest.json')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            atlasAssets: [{
              id: 'lnm-mni160',
              sourceUrl: 'https://example.test/prealign-mni160.nii',
              cacheKey: 'lnm-mni160-prealign-test',
              dims,
              supportStatus: 'supported'
            }]
          };
        }
      };
    }
    if (href === 'https://example.test/prealign-mni160.nii') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return mni160Buffer; }
      };
    }
    throw new Error(`unexpected fetch in prealign test: ${href}`);
  };

  try {
    await app.prealignToMni160();
    const structural = decodeNiftiForTest(await app.structuralFile.arrayBuffer());
    const brainmask = decodeNiftiForTest(await app.brainmaskFile.arrayBuffer());
    assert.equal(app.nativeBrainmaskFile, sourceBrainmaskFile,
      'prealign must preserve the native-space brain mask for lesion-mask review overlays');
    assert.deepEqual(structural.dims, dims,
      'prealigned structural must use the fixed lnm-mni160 dims');
    assert.deepEqual(brainmask.dims, dims,
      'prealigned brainmask must use the fixed lnm-mni160 dims');
    assertAffineClose(structural.header.affine, [
      [1, 0, 0, -2],
      [0, 1, 0, -2],
      [0, 0, 1, -2],
      [0, 0, 0, 1]
    ], 'prealigned structural header must be fixed lnm-mni160');
    assertAffineClose(brainmask.header.affine, [
      [1, 0, 0, -2],
      [0, 1, 0, -2],
      [0, 0, 1, -2],
      [0, 0, 0, 1]
    ], 'prealigned brainmask header must be fixed lnm-mni160');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

// ---- Test 20: subject-space Yeo atlas QC uses the fixed MNI160 grid and
//      requests a label-preserving inverse warp ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const mni160Data = new Uint8Array(2 * 2 * 2);
  const yeoData = new Uint8Array(5 * 5 * 5);
  yeoData[0] = 7;
  const affine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];
  const mni160Buffer = writeNifti1(mni160Data, {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine,
    description: 'synthetic lnm-mni160'
  });
  const yeoBuffer = writeNifti1(yeoData, {
    dims: [5, 5, 5],
    spacing: [1, 1, 1],
    affine,
    description: 'synthetic Yeo atlas'
  });
  const projectedAtlasBuffer = writeNifti1(new Uint8Array([7, 0, 0, 0, 0, 0, 0, 0]), {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine,
    description: 'synthetic subject-space atlas'
  });

  app.structuralFile = makeNiftiFile('lnm-prealign-t1.nii', mni160Buffer);
  app.selectedAtlasOptionId = 'yeo7';
  app.hasRegistrationDisplacement = true;
  let inverseSettings = null;
  app.executor = {
    runInverseWarpMask: async (settings) => {
      inverseSettings = settings;
      queueMicrotask(() => {
        app.handleStageData({ stage: 'atlas-patient', niftiData: projectedAtlasBuffer });
        app.handleStepComplete('inverse-warp-mask');
      });
    }
  };
  const renderedStacks = [];
  app.viewerController = {
    loadVolumeStack: async (entries) => { renderedStacks.push(entries); },
    setStageVisible: () => true
  };

  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = undefined;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('manifest.json')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            atlasAssets: [
              {
                id: 'lnm-mni160',
                sourceUrl: 'https://example.test/qc-mni160.nii',
                cacheKey: 'lnm-mni160-qc-test',
                dims: [2, 2, 2],
                supportStatus: 'supported'
              },
              {
                id: 'yeo7-2mm',
                sourceUrl: 'https://example.test/qc-yeo7.nii',
                cacheKey: 'yeo7-qc-test',
                dims: [5, 5, 5],
                supportStatus: 'supported'
              }
            ]
          };
        }
      };
    }
    if (href === 'https://example.test/qc-mni160.nii') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return mni160Buffer; }
      };
    }
    if (href === 'https://example.test/qc-yeo7.nii') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return yeoBuffer; }
      };
    }
    throw new Error(`unexpected fetch in atlas QC test: ${href}`);
  };

  try {
    await app.showSubjectSpaceAtlas();
    assert.ok(app.patientAtlasFile,
      'subject-space atlas QC must store the projected atlas file');
    assert.equal(inverseSettings.stage, 'atlas-patient',
      'subject-space atlas QC must use the atlas-patient stage');
    assert.equal(inverseSettings.labelMap, true,
      'subject-space atlas QC must request label-preserving inverse warp');
    assert.deepEqual(inverseSettings.maskDims, [2, 2, 2],
      'subject-space atlas QC must inverse-warp from the fixed lnm-mni160 grid');
    assert.equal(new Uint8Array(inverseSettings.maskBuffer)[0], 7,
      'Yeo labels must survive the Yeo-grid to MNI160 resample before inverse warp');
    const atlasEntry = renderedStacks.at(-1).find(entry => entry.stage === 'atlas-qc');
    assert.ok(atlasEntry, 'patient viewer stack must include the atlas QC layer');
    assert.equal(atlasEntry.colormap, 'lnm-yeo7',
      'atlas QC layer must use the Yeo label colormap');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

// ---- Test 21: Atlas selection drives overlap metadata, labels, and bridge grid ----
{
  globalThis.nifti = niftiModule.default || niftiModule;
  const app = makeApp();
  const schaeferData = new Uint8Array([1, 2, 0, 0, 0, 0, 0, 0]);
  const lesionData = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]);
  const smallAffine = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0
  ];
  const schaeferAtlasBuffer = writeNifti1(schaeferData, {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine: smallAffine,
    description: 'synthetic Schaefer atlas'
  });
  const lesionAtlasBuffer = writeNifti1(lesionData, {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine: smallAffine,
    description: 'synthetic atlas-grid lesion'
  });
  const lesion160 = new Uint8Array(160 * 160 * 192);
  lesion160[0] = 1;
  const lesion160Buffer = writeNifti1(lesion160, {
    dims: [160, 160, 192],
    spacing: [1, 1, 1],
    affine: smallAffine,
    description: 'synthetic confirmed lesion'
  });
  const warpedMniBuffer = writeNifti1(lesionData, {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    affine: smallAffine,
    description: 'synthetic warped lesion'
  });
  const fcShardData = new Float32Array(16);
  for (let v = 0; v < 8; v++) {
    fcShardData[v] = 10;
    fcShardData[8 + v] = 20;
  }
  const fcIndex = {
    shape: [2, 2, 2, 2],
    voxelsPerMap: 8,
    dtype: 'float32',
    voxelOrder: 'nifti',
    atlasAssetId: 'schaefer400-7n-4mm',
    atlasResolutionMm: 4,
    channelLabels: {
      1: 'LH_Vis_1',
      2: 'RH_Default_2'
    },
    shards: [{
      id: '001-002',
      sourceUrl: 'https://example.test/schaefer-fc-shard-001-002.bin',
      cacheKey: 'schaefer-fc-shard-test',
      channelLabels: ['1', '2']
    }]
  };
  const schaeferProfileJson = {
    id: 'schaefer400-neurosynth-v7-function-profiles',
    sourceLabel: 'Neurosynth v7 via NiMARE (parcel-wise Schaefer ROI decode)',
    method: 'NiMARE ROIAssociationDecoder',
    networkProfiles: {
      LH_Vis_1: [{ term: 'visual', score: 0.8, rank: 1 }],
      RH_Default_2: [{ term: 'language', score: 0.7, rank: 1 }]
    }
  };
  const tableEl = { innerHTML: '', children: [], appendChild(child) { this.children.push(child); } };
  const downloadEl = { disabled: true };
  const networkDownloadEl = { disabled: true };
  const coverageEl = { textContent: '', classList: makeClassList(['hidden']) };
  const emptyResultEl = { classList: makeClassList(['hidden']) };
  const emptyTableEl = { innerHTML: '' };
  const directProfileTableEl = { innerHTML: '', children: [], appendChild(child) { this.children.push(child); } };
  const restoreDocument = useMockElements({
    atlasSelect: { value: 'yeo7', options: [], addEventListener: () => {} },
    networkOverlapTable: tableEl,
    downloadOverlapCsv: downloadEl,
    downloadNetworkMapButton: networkDownloadEl,
    outsideAtlasWarning: coverageEl,
    affectedNetworkResults: emptyResultEl,
    affectedNetworkTable: emptyTableEl,
    mapFunctionProfileResults: emptyResultEl,
    mapFunctionProfileTable: emptyTableEl,
    directFunctionProfileResults: emptyResultEl,
    directFunctionProfileTable: directProfileTableEl
  });
  const originalCreateElement = globalThis.document.createElement;
  const renderedText = [];
  globalThis.document.createElement = (tagName) => {
    let text = '';
    return {
      tagName,
      children: [],
      style: {},
      classList: makeClassList(),
      appendChild(child) { this.children.push(child); },
      setAttribute: () => {},
      set textContent(value) {
        text = value;
        renderedText.push(value);
      },
      get textContent() { return text; }
    };
  };

  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = undefined;
  const selectableAtlasFetched = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    selectableAtlasFetched.push(href);
    if (href.includes('manifest.json')) {
      return {
        ok: true,
        status: 200,
        async json() {
          const schaeferAtlasEntry = {
            sourceUrl: 'https://example.test/schaefer400.nii',
            cacheKey: 'schaefer400-test',
            dims: [2, 2, 2],
            resolutionMm: 1,
            supportStatus: 'supported',
            parcelLabels: {
              1: 'LH_Vis_1',
              2: 'RH_Default_2'
            },
            networkLabels: {
              1: 'Visual',
              2: 'Default'
            }
          };
          return {
            atlasAssets: [{
              id: 'schaefer400-7n-2mm',
              ...schaeferAtlasEntry
            }, {
              id: 'schaefer400-7n-4mm',
              ...schaeferAtlasEntry,
              sourceUrl: 'https://example.test/schaefer400-4mm.nii',
              cacheKey: 'schaefer400-4mm-test',
              resolutionMm: 4
            }],
            connectomeAssets: [{
              id: 'schaefer400-fc-pack-development-n155-4mm',
              sourceUrl: 'https://example.test/schaefer-fc.index.json',
              indexSourceUrl: 'https://example.test/schaefer-fc.index.json',
              cacheKey: 'schaefer-fc-test',
              supportStatus: 'supported',
              atlasAssetId: 'schaefer400-7n-4mm',
              atlasResolutionMm: 4,
              dtype: 'float32',
              voxelOrder: 'nifti',
              weightSource: 'parcel',
              channelCount: 2
            }],
            annotationAssets: [{
              id: 'schaefer400-neurosynth-v7-function-profiles',
              sourceUrl: 'https://example.test/schaefer400-function-profiles.json',
              cacheKey: 'schaefer400-function-profiles-test',
              supportStatus: 'supported'
            }]
          };
        }
      };
    }
    if (href === 'https://example.test/schaefer400.nii') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return schaeferAtlasBuffer; }
      };
    }
    if (href === 'https://example.test/schaefer400-4mm.nii') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return schaeferAtlasBuffer; }
      };
    }
    if (href === 'https://example.test/schaefer-fc.index.json') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(fcIndex)).buffer; }
      };
    }
    if (href === 'https://example.test/schaefer-fc-shard-001-002.bin') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return fcShardData.buffer; }
      };
    }
    if (href === 'https://example.test/schaefer400-function-profiles.json') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(schaeferProfileJson)).buffer; }
      };
    }
    throw new Error(`unexpected fetch in selectable-atlas test: ${href}`);
  };

  try {
    app.handleAtlasSelectionChange('schaefer400');
    const option = app.getAtlasOption();
    assert.equal(option.overlapAtlasAssetId, 'schaefer400-7n-2mm',
      'Atlas selection must change the overlap atlas asset');
    assert.equal(option.connectomeAssetId, 'schaefer400-fc-pack-development-n155-4mm',
      'Atlas selection must change the connectome asset');
    assert.equal(option.weightSource, 'parcel',
      'Atlas selection must change the FC weighting mode to parcel for Schaefer');

    app.lesionFile = tagSpatialFile(makeNiftiFile('lesion-wrong-grid.nii', lesionAtlasBuffer), {
      space: atlasVolumeSpace('yeo7-mni2mm'),
      dims: [2, 2, 2],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
      ]
    });
    await assert.rejects(
      () => app.runAtlasOverlap(),
      /Direct lesion overlap: expected atlas:schaefer400-7n-2mm, got atlas:yeo7-mni2mm/,
      'direct overlap must reject a lesion tagged for a different atlas grid'
    );

    app.lesionFile = makeNiftiFile('lesion-schaefer-grid.nii', lesionAtlasBuffer);
    await app.runAtlasOverlap();
    assert.deepEqual(
      app.overlapResult.summary.networks.map(row => row.network),
      ['LH_Vis_1', 'RH_Default_2'],
      'Schaefer overlap table data must use parcel labels, not Yeo network names'
    );
    assert.equal(downloadEl.disabled, false,
      'atlas overlap must enable CSV export after the selected-atlas table is populated');
    await app._functionalProfileRenderPromise;
    assert.ok(renderedText.includes('Neurosynth v7 via NiMARE (parcel-wise Schaefer ROI decode)'),
      'Schaefer direct overlap must render its functional-profile source label');
    assert.ok(renderedText.includes('Atlas label drivers'),
      `Schaefer direct overlap must use atlas-label functional-profile driver copy; got ${renderedText.join(' | ')}`);
    assert.ok(renderedText.includes('language') || renderedText.includes('visual'),
      'Schaefer direct overlap must rank terms from parcel-label profiles');
    let fcStack = null;
    app.viewerController = {
      loadVolumeStack: async entries => { fcStack = entries; },
      getVolumeIndexForStage: () => null
    };
    await app.runFcNetworkMap();
    assert.deepEqual(app.networkMapDims, [2, 2, 2],
      'Schaefer FC map must use the affected-map atlas grid');
    assert.equal(app.networkMapData[0], 15,
      'Schaefer FC map must weight the selected parcel channels');
    assert.equal(networkDownloadEl.disabled, false,
      'supported Schaefer FC must enable network-map download');
    assert.ok(selectableAtlasFetched.includes('https://example.test/schaefer-fc.index.json'),
      'supported Schaefer FC must fetch the lazy index');
    assert.ok(selectableAtlasFetched.includes('https://example.test/schaefer-fc-shard-001-002.bin'),
      'supported Schaefer FC must fetch the shard containing lesion-hit parcels');
    assert.ok(!selectableAtlasFetched.includes('https://example.test/schaefer-fc.bin'),
      'supported Schaefer FC must not fetch a whole-pack binary');
    assert.equal(fcStack?.at(-1)?.stage, 'network-map',
      'supported Schaefer FC must render the network-map overlay on the atlas grid');
    assert.equal(fcStack?.some(entry => entry.stage === 'lesion'), false,
      'Schaefer FC display must skip the 2 mm overlap lesion on the 4 mm FC-map grid');
    assert.ok(
      app._messages.some(m => /Lesion overlay skipped on network map: Network-map lesion overlay: base is in atlas:schaefer400-7n-4mm, overlay is in atlas:schaefer400-7n-2mm/.test(m)),
      `Schaefer FC display must explain skipped cross-grid lesion overlay; got ${app._messages.join(' | ')}`
    );

    app.lesionMaskFile = makeNiftiFile('confirmed-lesion.nii', lesion160Buffer);
    app.lesionMaskConfirmed = true;
    app.structuralFile = makeNiftiFile('structural.nii', lesion160Buffer);
    let baseLoads = 0;
    let overlayLoads = 0;
    app.viewerController = {
      loadBaseVolume: async () => { baseLoads += 1; },
      loadOverlay: async () => { overlayLoads += 1; },
      getVolumeIndexForStage: () => null
    };
    app.executor = {
      runWarpMask: async () => {
        queueMicrotask(() => {
          app.handleStageData({ stage: 'mni-lesion', niftiData: warpedMniBuffer });
        });
      }
    };
    const bridgeFile = await app.applyRegistrationToLesion();
    assert.equal(bridgeFile.name, 'lnm-lesion-schaefer400.nii',
      'registration bridge output filename must reflect the selected atlas');
    const bridged = decodeNiftiForTest(await bridgeFile.arrayBuffer());
    assert.deepEqual(bridged.dims, [2, 2, 2],
      'registration bridge must resample the warped lesion onto the selected atlas grid');
    assert.equal(baseLoads + overlayLoads, 0,
      'atlas-grid lesion masks must not be rendered on the patient structural viewer stack');
  } finally {
    globalThis.document.createElement = originalCreateElement;
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    restoreDocument();
  }
}

console.log('lnm-app behavior OK: dispatch + precondition + explicit-start + split-log routing + worker-wait + manual mask review/upload/approval-banner/download/confirm/native-overlay/resume + threshold-preview/projection + selectable atlas + subject-atlas QC + advanced atlas-QC button + registration QC modes/blend + affected-network labels + functional profiles + layer-toggle + min-cluster input/table-filter + top-percent + auto-promote + coverage-note + version-label + MNI160 threshold-resample/header cases.');
