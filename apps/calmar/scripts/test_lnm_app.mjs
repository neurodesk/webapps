#!/usr/bin/env node --no-warnings
// Executed checks for LesionNetworkMappingApp behaviour that the larger
// stubbed suite (scripts/test_lnm_app_behavior.mjs) does not reach: stage
// dispatch, the CSV export, "Start over", perf formatting and the pipeline
// log. The app runs against a jsdom copy of the real web/index.html, so
// every DOM id it reads or writes is the page's own.
//
// This file used to regex the app source for method names and call
// expressions. Importing the module already proves the import surface
// resolves; everything else is asserted by running it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8'), { url: 'http://localhost:8080/' });
for (const name of ['window', 'document', 'HTMLElement', 'customElements', 'Event', 'Node', 'MutationObserver']) {
  globalThis[name] = dom.window[name];
}
const { document } = dom.window;
globalThis.niivue = {
  SHOW_RENDER: { NEVER: 0, AUTO: 2 },
  Niivue: class {}
};
globalThis.Worker = class {
  postMessage() {}
  terminate() {}
};

const { LesionNetworkMappingApp } = await import(path.join(ROOT, 'web/js/lnm-app.js'));
const { ATLAS_OPTIONS, getAtlasOptionById } = await import(path.join(ROOT, 'web/js/app/atlas-options.js'));

function makeApp() {
  const app = new LesionNetworkMappingApp();
  app.messages = [];
  app.updateOutput = message => app.messages.push(message);
  return app;
}

// Replace methods with recorders that resolve immediately.
function record(app, methods) {
  const calls = [];
  for (const method of methods) {
    assert.equal(typeof app[method], 'function', `app.${method} exists`);
    app[method] = async (...args) => {
      calls.push(args.length ? [method, ...args] : [method]);
    };
  }
  return calls;
}

const STAGE_METHODS = [
  'runBrainExtraction', 'prealignToMni160', 'runLesionSegmentation', 'startLesionMaskReview',
  'runRegistration', 'applyRegistrationToLesion', 'runAtlasOverlap', 'runFcNetworkMap'
];

// ---- _runStage: each pipeline module runs the right stage ----
{
  const app = makeApp();
  const calls = record(app, STAGE_METHODS);
  const run = async stage => {
    calls.length = 0;
    const result = await app._runStage(stage);
    return { result, calls: [...calls] };
  };

  assert.deepEqual((await run({ module: 'brain-extraction' })).calls, [['runBrainExtraction']]);
  assert.deepEqual((await run({ module: 'prealign' })).calls, [['prealignToMni160', { skipIfAligned: true }]]);

  // Auto segmentation always hands over to mask review and pauses there.
  const segmentation = await run({ module: 'inference-pipeline' });
  assert.deepEqual(segmentation.calls, [['runLesionSegmentation'], ['startLesionMaskReview', { seedFile: null }]]);
  assert.deepEqual(segmentation.result, { pausedForMaskReview: true });

  // Registration is followed by the warp + atlas-grid bridge.
  assert.deepEqual((await run({ module: 'registration' })).calls, [['runRegistration'], ['applyRegistrationToLesion']]);
  assert.deepEqual((await run({ module: 'parcel-overlap' })).calls, [['runAtlasOverlap']]);
  assert.deepEqual((await run({ module: 'fc-weighted-sum' })).calls, [['runFcNetworkMap']]);

  // Threshold stage: pipeline defaults are written into the controls, then
  // the threshold is applied from those controls.
  let thresholdApplied = 0;
  app.applyNetworkThreshold = () => {
    thresholdApplied++;
  };
  await app._runStage({ module: 'threshold', defaults: { value: 2.5, symmetric: false, minClusterVoxels: 12 } });
  assert.equal(thresholdApplied, 1);
  assert.equal(document.getElementById('networkThresholdValue').value, '2.5');
  assert.equal(document.getElementById('networkThresholdSymmetric').checked, false);
  assert.equal(document.getElementById('networkThresholdMinCluster').value, '12');
  assert.equal(document.getElementById('networkThresholdValueLabel').textContent, '2.5%');

  // Work that already exists is not redone.
  app.brainmaskFile = { name: 'mask.nii' };
  assert.deepEqual((await run({ module: 'brain-extraction' })).calls, [], 'an existing brain mask is reused');
  app.lesionMaskFile = { name: 'lesion.nii' };
  app.lesionMaskConfirmed = true;
  const confirmed = await run({ module: 'inference-pipeline' });
  assert.deepEqual(confirmed.calls, [], 'a confirmed lesion mask is not re-segmented');
  assert.equal(confirmed.result, undefined, 'and the pipeline does not pause again');
  app.lesionMaskConfirmed = false;
  app.autoLesionSeedFile = { name: 'seed.nii' };
  const seeded = await run({ module: 'inference-pipeline' });
  assert.deepEqual(seeded.calls, [['startLesionMaskReview', { seedFile: app.autoLesionSeedFile }]], 'an existing seed goes straight to review');
  assert.deepEqual(seeded.result, { pausedForMaskReview: true });

  await assert.rejects(app._runStage({ module: 'nope' }), /unknown module 'nope'/);
  await assert.rejects(app._runStage({}), /stage must declare a module/);
}

// ---- runFullPipeline: stages run in order, are timed, and stop at review ----
{
  const app = makeApp();
  const calls = record(app, STAGE_METHODS);
  app.structuralFile = { name: 'T1.nii' };
  app.selectedPipeline = {
    id: 'test-chain',
    stages: [
      { id: 'brain', module: 'brain-extraction' },
      { id: 'prealign', module: 'prealign' },
      { id: 'lesion', module: 'inference-pipeline' },
      { id: 'register', module: 'registration' }
    ]
  };
  await app.runFullPipeline();
  assert.deepEqual(
    calls.map(([method]) => method),
    ['runBrainExtraction', 'prealignToMni160', 'runLesionSegmentation', 'startLesionMaskReview'],
    'nothing after the lesion seed runs before the mask is confirmed'
  );
  // Completed stages are timed; the paused stage is not.
  const perfLines = app.messages.filter(message => message.startsWith('[perf] '));
  assert.equal(perfLines.length, 2, 'one timing line per completed stage');
  assert.match(perfLines[0], /^\[perf\] brain \(brain-extraction\): \d+ ms$/);
  assert.match(perfLines[1], /^\[perf\] prealign \(prealign\): \d+ ms$/);
  assert.deepEqual(app._perfStats.map(entry => entry.id), ['brain', 'prealign']);
  assert.equal(app.messages.at(-1), 'Pipeline paused for manual lesion-mask review.');
  assert.equal(app._pendingMaskResume.nextStageIndex, 3, 'confirming the mask resumes at registration');
  assert.equal(document.getElementById('statusText').textContent, 'Review and confirm the lesion mask');
}

// ---- duration formatting (hand-worked) ----
{
  const app = makeApp();
  assert.equal(app._formatMs(0), '0 ms');
  assert.equal(app._formatMs(999.4), '999 ms');
  assert.equal(app._formatMs(1000), '1.00 s');
  assert.equal(app._formatMs(12345), '12.35 s');
  assert.equal(app._formatMs(59999), '60.00 s');
  assert.equal(app._formatMs(60000), '1.00 min');
  assert.equal(app._formatMs(150000), '2.50 min');
  assert.ok(app._now() > 0);
}

// ---- exportCsv: a real .csv download of the displayed overlap ----
{
  const app = makeApp();
  const downloads = [];
  const blobs = new Map();
  globalThis.URL.createObjectURL = blob => {
    const url = `blob:test-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  const revoked = [];
  globalThis.URL.revokeObjectURL = url => revoked.push(url);
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
  };

  app.exportCsv();
  assert.deepEqual(downloads, [], 'nothing to export before an overlap exists');

  document.getElementById('networkThresholdMinCluster').value = '10';
  app.overlapResult = {
    summary: {
      totalLesionVoxels: 100,
      networks: [
        { network: 'Visual', voxelsInLesion: 60, fractionOfLesion: 0.6, parcels: [1] },
        { network: 'Default', voxelsInLesion: 35, fractionOfLesion: 0.35, parcels: [7] },
        { network: 'Limbic', voxelsInLesion: 5, fractionOfLesion: 0.05, parcels: [5] }
      ]
    },
    networkSizes: { Visual: 1200, Default: 700, Limbic: 500 }
  };
  app.exportCsv();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].download, 'lnm-overlap.csv');
  assert.equal(downloads[0].attached, true, 'the link is in the document when clicked');
  assert.equal(document.querySelector('a[download]'), null, 'and removed afterwards');
  assert.deepEqual(revoked, [downloads[0].href]);
  const blob = blobs.get(downloads[0].href);
  assert.equal(blob.type, 'text/csv;charset=utf-8');
  // Fractions of network: 60 / 1200 = 0.05 and 35 / 700 = 0.05. Limbic has
  // 5 voxels, below the 10-voxel minimum set above, so it is not exported.
  assert.equal(
    await blob.text(),
    'network,voxelsInLesion,fractionOfLesion,voxelsInNetwork,fractionOfNetwork,parcels\n' +
    'Visual,60,0.6000,1200,0.0500,1\n' +
    'Default,35,0.3500,700,0.0500,7\n'
  );
  document.getElementById('networkThresholdMinCluster').value = '30';
}

// ---- Start over: results are dropped, the structural image is kept ----
{
  const app = makeApp();
  const viewer = [];
  app.viewerController = {
    clearAll: () => viewer.push('clearAll'),
    removeVolumeForStage: stage => viewer.push(`remove ${stage}`),
    getVolumeIndexForStage: () => null
  };
  app.loadViewerBaseVolume = async file => {
    viewer.push(`base ${file.name}`);
  };
  let executorCleared = 0;
  app.executor.clearResults = () => {
    executorCleared++;
  };

  const structural = { name: 'T1.nii' };
  app.structuralFile = structural;
  app.overlapResult = { summary: {} };
  app.networkMapData = new Float32Array(8);
  app.lesionMaskFile = { name: 'lesion.nii' };
  app.lesionMaskConfirmed = true;
  app.hasRegistrationDisplacement = true;
  const results = document.getElementById('resultsSection');
  results.classList.remove('collapsed');
  const outputIds = [
    'downloadOverlapCsv', 'downloadBrainMaskButton', 'downloadLesionMaskButton', 'downloadNetworkMapButton',
    'downloadThresholdedNetworkMapButton', 'downloadEditedLesionMaskButton', 'checkAtlasAlignmentButton',
    'showSubjectAtlasButton', 'downloadSubjectAtlasButton'
  ];
  for (const id of outputIds) document.getElementById(id).disabled = false;
  document.querySelector('#networkOverlapTable tbody').innerHTML = '<tr><td>Visual</td><td>60</td><td>60%</td></tr>';
  app.showAtlasCoverageNote(4, 10);
  assert.match(
    document.getElementById('outsideAtlasWarning').textContent,
    /^6 of 10 lesion voxels are assigned to .+ labels; 4 are unlabeled by this atlas\.$/,
    'the coverage note is about atlas labels, not a brain mask'
  );
  assert.equal(document.getElementById('outsideAtlasWarning').classList.contains('hidden'), false);

  app.clearResults({ full: false });
  assert.equal(app.structuralFile, structural, 'the structural image survives');
  assert.deepEqual(
    [app.overlapResult, app.networkMapData, app.lesionMaskFile, app.lesionMaskConfirmed, app.hasRegistrationDisplacement],
    [null, null, null, false, false]
  );
  for (const id of outputIds) {
    assert.equal(document.getElementById(id).disabled, true, `${id} is disabled again`);
  }
  assert.ok(results.classList.contains('collapsed'), 'the results section collapses');
  assert.equal(document.querySelector('#networkOverlapTable tbody').children.length, 0, 'the overlap table is emptied');
  assert.ok(document.getElementById('outsideAtlasWarning').classList.contains('hidden'));
  assert.equal(document.getElementById('networkThresholdSummary').textContent, 'Compute a network map first to enable thresholding.');
  assert.equal(executorCleared, 1, 'worker results are dropped too');
  assert.deepEqual(viewer, ['remove threshold-preview', 'base T1.nii'], 'the viewer goes back to the structural image');
  assert.equal(app.messages.at(-1), 'Results cleared (structural retained).');

  viewer.length = 0;
  app.clearResults({ full: true });
  assert.equal(app.structuralFile, null, 'a full reset also drops the input');
  assert.deepEqual(viewer, ['remove threshold-preview', 'clearAll']);
  assert.equal(app.messages.at(-1), 'All state cleared.');
}

// ---- atlas registry: both atlases are selectable, Schaefer first ----
{
  assert.deepEqual(ATLAS_OPTIONS.map(option => [option.id, option.displayName]), [
    ['schaefer400', 'Schaefer 400 parcels'],
    ['yeo7', 'Yeo 7 networks']
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/models/manifest.json'), 'utf8'));
  const assetIds = new Set(
    Object.values(manifest)
      .filter(Array.isArray)
      .flat()
      .map(asset => asset?.id)
  );
  for (const option of ATLAS_OPTIONS) {
    assert.equal(getAtlasOptionById(option.id), option);
    for (const key of ['overlapAtlasAssetId', 'connectomeAssetId', 'functionProfileAssetId']) {
      assert.ok(assetIds.has(option[key]), `${option.id}.${key} (${option[key]}) is a manifest asset`);
    }
  }
  assert.equal(getAtlasOptionById('yeo7').functionProfileAssetId, 'yeo7-neurosynth-v7-function-profiles');
  assert.equal(getAtlasOptionById('schaefer400').functionProfileAssetId, 'schaefer400-neurosynth-v7-function-profiles');
}

console.log('LNM app OK: stage dispatch, pipeline timing, CSV export, reset and atlas registry executed.');
process.exit(0);
