#!/usr/bin/env node --no-warnings

// Executes SCT task routing end to end instead of reading the source.
//
// The browser once fell back to the default model when a user picked
// "Vertebral labeling" from the segmentation dropdown: runInference() spent
// ~22 minutes producing a sparse cord mask and reported success without ever
// running the vertebrae module. This test boots the real application against
// the real index.html in jsdom, clicks the real controls and asserts the
// message that reaches the worker. The second half loads the real worker and
// asserts the URL it fetches.
//
// Expected values are literals from the SCT task definitions as recorded in
// web/models/manifest.json (the runtime reads web/js/app/sct-tasks.js, a
// separate file) and from SCT's own defaults; nothing is recomputed with the
// application's expressions.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import {
  APP_ROOT,
  bootApp,
  click,
  emitStage,
  loadInput,
  parseIndexHtml,
  report,
  setChecked,
  setValue,
  settle,
  tinyNiftiBytes,
  waitFor
} from './lib/app-harness.mjs';

const require = createRequire(import.meta.url);
const manifest = require('../web/models/manifest.json');

const HF = 'https://huggingface.co/datasets/sbollmann/sct-webapp-data/resolve/55c9462a14bc9c84cf093c348cffda9148099df9/web/models';
const LOCAL_MODELS = 'http://localhost:4320/models';

// One row per task offered in the SCT Task dropdown. `overlap`,
// `keepLargestComponent`, `minComponentSize` and `testTimeAugmentation` for the
// spinal cord follow SCT's wrapper (tile_step_size=0.5, largest component kept,
// no extra size filter, no TTA). Tasks without an SCT overlap default use the
// app default of 0 and keep every component.
const EXPECTED_SEGMENTATION_REQUESTS = [
  {
    taskId: 'spinalcord',
    label: 'Spinal cord',
    modelAssetId: 'sct-spinalcord',
    modelName: 'sct-spinalcord.onnx',
    modelUrl: `${HF}/sct-spinalcord.onnx`,
    patchSize: [160, 224, 64],
    overlap: 0.5,
    threshold: 0.5,
    minComponentSize: 0,
    keepLargestComponent: true,
    sourceVersion: 'stable'
  },
  {
    taskId: 'graymatter',
    label: 'Gray matter',
    modelAssetId: 'sct-graymatter',
    modelName: 'sct-graymatter.onnx',
    modelUrl: `${HF}/sct-graymatter.onnx`,
    patchSize: [64, 64, 64],
    overlap: 0,
    threshold: 0.5,
    minComponentSize: 1000,
    keepLargestComponent: false,
    sourceVersion: 'stable'
  },
  {
    taskId: 'lesion_sci_t2',
    label: 'SCI lesion T2',
    modelAssetId: 'sct-lesion-sci-t2',
    modelName: 'sct-lesion-sci-t2.onnx',
    modelUrl: `${HF}/sct-lesion-sci-t2.onnx`,
    patchSize: [128, 192, 96],
    overlap: 0,
    threshold: 0.5,
    minComponentSize: 1,
    keepLargestComponent: false,
    sourceVersion: 'r20240729'
  },
  {
    taskId: 'spine',
    label: 'TotalSpineSeg',
    modelAssetId: 'totalspineseg-step1',
    modelName: 'totalspineseg-step1.onnx',
    modelUrl: `${HF}/totalspineseg-step1.onnx`,
    patchSize: [256, 256, 48],
    overlap: 0,
    threshold: 0.5,
    minComponentSize: 1,
    keepLargestComponent: false,
    sourceVersion: 'r20251124'
  }
];

function manifestAsset(taskId) {
  return manifest.tasks.find(task => task.id === taskId).modelAssets[0];
}

async function runSegmentationFor(harness, taskId) {
  const before = harness.postedOfType('run-inference').length;
  setValue(harness.document.getElementById('modelSelect'), taskId);
  click(harness.document.getElementById('runSegmentation'));
  await waitFor(() => harness.postedOfType('run-inference').length > before, `run-inference for ${taskId}`);
  return harness.postedOfType('run-inference').at(-1).message.data;
}

async function finishInference(harness) {
  harness.worker().emit({ type: 'step-complete', step: 'inference' });
  harness.worker().emit({ type: 'complete' });
  await settle(harness);
}

let checks = 0;
function check(fn) {
  checks++;
  return fn();
}

// ---------------------------------------------------------------------------
// Static page: what the two selectors offer before any script runs.
// ---------------------------------------------------------------------------
{
  const { document } = parseIndexHtml().window;
  check(() => assert.equal(document.getElementById('overlapSelect'), null, 'sliding-window overlap is an SCT model default, not a user control'));
  const operations = [...document.querySelectorAll('#processingOperationSelect option')].map(option => option.value);
  check(() => assert.deepEqual(operations, ['vertebrae'], 'SCT Processing offers only operations wired to a real pipeline step'));
}

// ---------------------------------------------------------------------------
// SCT Task dropdown -> run-inference message, one task at a time.
// ---------------------------------------------------------------------------
{
  const harness = await bootApp();
  await loadInput(harness);

  const options = [...harness.document.querySelectorAll('#modelSelect option')];
  check(() => assert.deepEqual(
    options.map(option => option.value),
    ['spinalcord', 'graymatter', 'lesion_sci_t2', 'spine'],
    'the SCT Task dropdown lists the supported model tasks and not the processing-only vertebrae task'
  ));
  check(() => assert.deepEqual(
    options.map(option => option.textContent),
    ['Spinal cord', 'Gray matter', 'SCI lesion T2', 'TotalSpineSeg']
  ));

  for (const expected of EXPECTED_SEGMENTATION_REQUESTS) {
    const sent = await runSegmentationFor(harness, expected.taskId);
    const asset = manifestAsset(expected.taskId);
    check(() => assert.equal(sent.taskId, expected.taskId));
    check(() => assert.equal(sent.modelAssetId, expected.modelAssetId, `${expected.taskId}: model asset id`));
    check(() => assert.equal(sent.modelName, expected.modelName, `${expected.taskId}: model file`));
    check(() => assert.equal(sent.modelUrl, expected.modelUrl, `${expected.taskId}: pinned Hugging Face model URL`));
    check(() => assert.equal(sent.modelUrl, asset.downloadUrl, `${expected.taskId}: URL matches manifest.json`));
    check(() => assert.deepEqual(sent.patchSize, expected.patchSize, `${expected.taskId}: patch size`));
    check(() => assert.equal(sent.overlap, expected.overlap, `${expected.taskId}: overlap`));
    check(() => assert.equal(sent.threshold, expected.threshold, `${expected.taskId}: threshold`));
    check(() => assert.equal(sent.minComponentSize, expected.minComponentSize, `${expected.taskId}: min component size`));
    check(() => assert.equal(sent.keepLargestComponent, expected.keepLargestComponent, `${expected.taskId}: largest-component cleanup`));
    check(() => assert.equal(sent.testTimeAugmentation, false, `${expected.taskId}: TTA off by default`));
    check(() => assert.equal(sent.supportStatus, 'supported'));
    check(() => assert.equal(sent.modelBaseUrl, LOCAL_MODELS));
    check(() => assert.deepEqual(sent.preprocessing, asset.preprocessing || {}, `${expected.taskId}: preprocessing matches manifest.json`));
    check(() => assert.deepEqual(sent.output, asset.output || {}, `${expected.taskId}: output metadata matches manifest.json`));
    check(() => assert.equal(sent.provenance.sourceVersion, expected.sourceVersion));
    check(() => assert.equal(sent.provenance.modelAssetId, expected.modelAssetId));
    await finishInference(harness);
  }

  // SCT reference values the spinal cord request must carry, stated once more
  // as plain literals so a manifest edit cannot move them silently.
  const cord = await runSegmentationFor(harness, 'spinalcord');
  check(() => assert.deepEqual(cord.preprocessing, {
    modelOrientation: 'RPI',
    modelAxisOrder: 'zyx',
    targetSpacing: [0.8958333, 0.7, 1.0]
  }));
  await finishInference(harness);

  const lesion = await runSegmentationFor(harness, 'lesion_sci_t2');
  check(() => assert.equal(lesion.output.activation, 'sigmoid-regions', 'SCIsegV2 is a region-channel sigmoid model'));
  await finishInference(harness);

  const spine = await runSegmentationFor(harness, 'spine');
  check(() => assert.equal(spine.output.activation, 'sigmoid-labels'));
  check(() => assert.deepEqual(spine.output.labelPriority, [1, 2, 3, 4, 5, 6, 7, 8, 9]));
  check(() => assert.equal(spine.output.paddingMode, 'center-min-patch'));
  check(() => assert.equal(spine.output.discPointRadius, 2));
  check(() => assert.equal(spine.preprocessing.modelOrientation, 'RAS'));
  await finishInference(harness);

  // The advanced controls reach the worker.
  setValue(harness.document.getElementById('modelSelect'), 'spinalcord');
  setValue(harness.document.getElementById('thresholdInput'), '0.3');
  setValue(harness.document.getElementById('minSizeInput'), '25');
  setChecked(harness.document.getElementById('ttaToggle'), true);
  const before = harness.postedOfType('run-inference').length;
  click(harness.document.getElementById('runSegmentation'));
  await waitFor(() => harness.postedOfType('run-inference').length > before, 'run-inference with edited settings');
  const edited = harness.postedOfType('run-inference').at(-1).message.data;
  check(() => assert.equal(edited.threshold, 0.3));
  check(() => assert.equal(edited.minComponentSize, 25));
  check(() => assert.equal(edited.testTimeAugmentation, true));
  await finishInference(harness);

  // Choosing a task restores that task's defaults in the controls.
  setValue(harness.document.getElementById('modelSelect'), 'graymatter');
  check(() => assert.equal(harness.document.getElementById('minSizeInput').value, '1000'));
  check(() => assert.equal(harness.document.getElementById('thresholdInput').value, '0.5'));
  check(() => assert.equal(harness.document.getElementById('ttaToggle').checked, false));
  check(() => assert.equal(harness.document.getElementById('taskDetails').textContent, 'Input: T2star'));
}

// ---------------------------------------------------------------------------
// A processing-only task must never be sent to run-inference.
// ---------------------------------------------------------------------------
{
  const harness = await bootApp();
  await loadInput(harness);
  const select = harness.document.getElementById('modelSelect');
  const forced = harness.document.createElement('option');
  forced.value = 'vertebrae';
  forced.textContent = 'Vertebral labeling';
  select.appendChild(forced);
  select.value = 'vertebrae';
  click(harness.document.getElementById('runSegmentation'));
  await settle(harness);
  check(() => assert.equal(harness.postedOfType('run-inference').length, 0, 'vertebrae is not routed to model inference'));
  check(() => assert.match(harness.logText(), /"Vertebral labeling" is a post-processing step/));

  // An unsupported task is refused as well.
  const unsupported = harness.document.createElement('option');
  unsupported.value = 'lesion_ms';
  select.appendChild(unsupported);
  select.value = 'lesion_ms';
  click(harness.document.getElementById('runSegmentation'));
  await settle(harness);
  check(() => assert.equal(harness.postedOfType('run-inference').length, 0, 'an unsupported task is not routed to model inference'));
  check(() => assert.match(harness.logText(), /is unavailable\./));
}

// ---------------------------------------------------------------------------
// SCT Processing -> run-vertebral-labeling, gated on a segmentation result.
// ---------------------------------------------------------------------------
{
  const harness = await bootApp();
  await loadInput(harness);

  click(harness.document.getElementById('runProcessingBtn'));
  await settle(harness);
  check(() => assert.equal(harness.postedOfType('run-vertebral-labeling').length, 0, 'no vertebral labeling without a segmentation'));
  check(() => assert.match(harness.logText(), /Run spinal cord segmentation before vertebral labeling/));

  await runSegmentationFor(harness, 'spinalcord');
  await emitStage(harness, 'segmentation');
  await finishInference(harness);

  click(harness.document.getElementById('runProcessingBtn'));
  await waitFor(() => harness.postedOfType('run-vertebral-labeling').length === 1, 'run-vertebral-labeling');
  check(() => assert.deepEqual(harness.postedOfType('run-vertebral-labeling')[0].message.data, {
    modelBaseUrl: LOCAL_MODELS,
    pam50LevelsUrl: `${HF}/templates/PAM50/PAM50_levels.nii.gz`,
    scaleDist: 0.55,
    detectorMinScore: 0.1
  }));
  check(() => assert.equal(harness.postedOfType('run-inference').length, 1, 'vertebral labeling does not start a second model inference'));
}

// ---------------------------------------------------------------------------
// Result stages: what the viewer shows as stages arrive and are toggled.
// ---------------------------------------------------------------------------
{
  const harness = await bootApp();
  await loadInput(harness);
  await runSegmentationFor(harness, 'lesion_sci_t2');
  await emitStage(harness, 'segmentation', { taskId: 'lesion_sci_t2' });
  await emitStage(harness, 'lesion', { taskId: 'lesion_sci_t2' });
  harness.worker().emit({
    type: 'stageData',
    stage: 'lesion_metrics',
    kind: 'metrics',
    taskId: 'lesion_sci_t2',
    csv: 'lesion_id,volume_mm3\n1,12.5\n',
    rows: [{ lesion_id: 1, volume_mm3: 12.5 }],
    summary: { lesion_count: 1 }
  });
  await finishInference(harness);

  // Input as base, then each label mask as its own overlay with its colormap.
  check(() => assert.deepEqual(harness.viewerStack(), [
    { name: 'input.nii', colormap: 'gray' },
    { name: 'lesion_sci_t2_segmentation.nii', colormap: 'sct-spinalcord' },
    { name: 'lesion_sci_t2_lesion.nii', colormap: 'sct-lesion' }
  ]));

  // Metrics are a table with its own CSV download, not an image layer.
  const rows = [...harness.document.querySelectorAll('#stageButtons .stage-label')].map(label => label.textContent);
  check(() => assert.deepEqual(rows, ['Input', 'SCT Segmentation', 'SCI Lesion']));
  const metricsDownload = harness.document.querySelector('#metricsResults .metrics-download-btn');
  check(() => assert.ok(metricsDownload, 'the statistics panel has its own download button'));
  click(metricsDownload);
  check(() => assert.match(harness.logText(), /Downloaded statistics: lesion_sci_t2_lesion_metrics\.csv/));
  check(() => assert.deepEqual(harness.downloads.map(download => download.name), ['lesion_sci_t2_lesion_metrics.csv']));

  // An unchanged stack is not reloaded.
  const loadsBefore = harness.niivueCalls.filter(call => call[0] === 'loadVolumes').length;
  await harness.app.renderViewerVolumes();
  check(() => assert.equal(harness.niivueCalls.filter(call => call[0] === 'loadVolumes').length, loadsBefore, 'a repeated render does not reload the input volume'));

  // Each eye button toggles only its own stage.
  const eye = stage => harness.document.querySelector(`#stageButtons .view-btn[data-stage="${stage}"]`);
  click(eye('segmentation'));
  await settle(harness);
  check(() => assert.deepEqual(harness.viewerStack().map(volume => volume.name), ['input.nii', 'lesion_sci_t2_lesion.nii']));
  check(() => assert.equal(eye('segmentation').classList.contains('active'), false));
  check(() => assert.equal(eye('lesion').classList.contains('active'), true));

  // Hiding the input promotes the first visible label mask to the base volume.
  setChecked(harness.document.getElementById('inputVisibilityToggle'), false);
  await settle(harness);
  check(() => assert.deepEqual(harness.viewerStack(), [{ name: 'lesion_sci_t2_lesion.nii', colormap: 'sct-lesion' }]));
  click(eye('segmentation'));
  await settle(harness);
  check(() => assert.deepEqual(harness.viewerStack(), [
    { name: 'lesion_sci_t2_segmentation.nii', colormap: 'sct-spinalcord' },
    { name: 'lesion_sci_t2_lesion.nii', colormap: 'sct-lesion' }
  ]));

  // A new run must not show the previous run's overlays, and must show the new
  // segmentation even though its eye was switched off during the old run.
  click(eye('segmentation'));
  await settle(harness);
  await runSegmentationFor(harness, 'spinalcord');
  await settle(harness);
  check(() => assert.deepEqual(harness.viewerStack().map(volume => volume.name), ['input.nii'], 'stale overlays are gone when a new run starts'));
  await emitStage(harness, 'segmentation', { taskId: 'spinalcord' });
  check(() => assert.deepEqual(harness.viewerStack(), [
    { name: 'input.nii', colormap: 'gray' },
    { name: 'spinalcord_segmentation.nii', colormap: 'sct-spinalcord' }
  ]));
  await finishInference(harness);

  // Vertebral labels join as a third independent overlay.
  click(harness.document.getElementById('runProcessingBtn'));
  await waitFor(() => harness.postedOfType('run-vertebral-labeling').length === 1, 'run-vertebral-labeling');
  await emitStage(harness, 'vertebrae');
  harness.worker().emit({ type: 'step-complete', step: 'processing' });
  await settle(harness);
  check(() => assert.deepEqual(harness.viewerStack().map(volume => volume.colormap), ['gray', 'sct-spinalcord', 'sct-vertebrae']));
}

{
  // TotalSpineSeg shows both of its label stages by default.
  const harness = await bootApp();
  await loadInput(harness);
  await runSegmentationFor(harness, 'spine');
  await emitStage(harness, 'spine_step1', { taskId: 'spine' });
  await emitStage(harness, 'spine_discs', { taskId: 'spine' });
  await finishInference(harness);
  check(() => assert.deepEqual(harness.viewerStack(), [
    { name: 'input.nii', colormap: 'gray' },
    { name: 'spine_spine_step1.nii', colormap: 'sct-totalspineseg' },
    { name: 'spine_spine_discs.nii', colormap: 'sct-spine-discs' }
  ]));
}

// ---------------------------------------------------------------------------
// Worker: which URL is fetched for a model and for the PAM50 template.
// ---------------------------------------------------------------------------
async function startWorker(fetched) {
  const {
    prepareModuleWorkerSource,
    loadSharedWorkerBindings,
    installModuleLoader
  } = require('./worker-vm.cjs');
  const workerPath = path.join(APP_ROOT, 'web/js/inference-worker.js');
  const messages = [];
  const selfObj = {
    onmessage: null,
    postMessage: message => messages.push(message)
  };
  // The network boundary: the committed C2-C3 detector YAML is served from
  // disk, every other request is recorded and refused.
  const detectorUrl = `${LOCAL_MODELS}/c2c3_disc_models/t2_model.yml`;
  const refuse = async (url) => {
    fetched.push(String(url));
    if (String(url) === detectorUrl) {
      return new Response(fs.readFileSync(path.join(APP_ROOT, 'web/models/c2c3_disc_models/t2_model.yml')));
    }
    throw new Error('offline');
  };
  const localforage = {
    config() {},
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {}
  };
  const sandbox = {
    self: selfObj,
    ort: {
      env: { wasm: {} },
      InferenceSession: {
        create: async () => {
          throw new Error('no session in the routing test');
        }
      }
    },
    localforage,
    // The vendored NIfTI reader only gunzips for the worker; inputs here are
    // uncompressed, so it must never be called.
    nifti: {
      decompress() {
        throw new Error('unexpected gzip input in the routing test');
      }
    },
    fetch: refuse,
    performance,
    console: { log() {}, warn() {}, error() {} },
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    navigator: { hardwareConcurrency: 1 },
    location: { href: 'http://localhost:4320/js/inference-worker.js' }
  };
  Object.assign(sandbox, await loadSharedWorkerBindings());
  vm.createContext(sandbox);
  sandbox.globalThis = sandbox;
  installModuleLoader(sandbox, selfObj, localforage);
  // The shared model fetcher runs in this realm and reads globalThis.fetch.
  globalThis.fetch = refuse;
  vm.runInContext(prepareModuleWorkerSource(fs.readFileSync(workerPath, 'utf8')), sandbox, { filename: workerPath });
  const send = async (type, data) => {
    const before = messages.length;
    await selfObj.onmessage({ data: { type, data, version: 'test' } });
    return messages.slice(before);
  };
  await send('init');
  return { send, messages };
}

{
  const input = tinyNiftiBytes();
  const settings = {
    supportStatus: 'supported',
    taskId: 'graymatter',
    modelAssetId: 'sct-graymatter',
    modelName: 'sct-graymatter.onnx',
    modelBaseUrl: LOCAL_MODELS
  };

  const fetched = [];
  const worker = await startWorker(fetched);
  await worker.send('load', { inputData: input.buffer.slice(0) });

  const hosted = await worker.send('run-inference', { ...settings, modelUrl: `${HF}/sct-graymatter.onnx` });
  check(() => assert.deepEqual([...new Set(fetched)], [`${HF}/sct-graymatter.onnx`], 'the worker downloads the per-asset model URL it was given'));
  check(() => assert.equal(hosted.filter(message => message.type === 'error').length, 1, 'a failed download ends in one error message'));

  fetched.length = 0;
  await worker.send('run-inference', settings);
  check(() => assert.deepEqual([...new Set(fetched)], [`${LOCAL_MODELS}/sct-graymatter.onnx`], 'without a per-asset URL the worker falls back to the local models directory'));

  fetched.length = 0;
  const refused = await worker.send('run-inference', { ...settings, supportStatus: 'unsupported' });
  check(() => assert.deepEqual(fetched, [], 'an unsupported task downloads nothing'));
  check(() => assert.match(refused.find(message => message.type === 'error').message, /SCT task "graymatter" is unsupported/));

  // Vertebral labeling needs a segmentation; restore one, then watch the fetches.
  await worker.send('restore-state', {
    inputData: input.buffer.slice(0),
    hiddenArtifacts: { segmentationState: { segLabelsRAS: new Uint8Array(64).fill(1), segMinComponentSize: 0 } }
  });
  fetched.length = 0;
  await worker.send('run-vertebral-labeling', {
    modelBaseUrl: LOCAL_MODELS,
    pam50LevelsUrl: `${HF}/templates/PAM50/PAM50_levels.nii.gz`
  });
  check(() => assert.deepEqual(fetched, [
    `${LOCAL_MODELS}/c2c3_disc_models/t2_model.yml`,
    `${HF}/templates/PAM50/PAM50_levels.nii.gz`
  ], 'vertebral labeling loads the local detector and the hosted PAM50 levels it was given'));

  fetched.length = 0;
  await worker.send('run-vertebral-labeling', { modelBaseUrl: LOCAL_MODELS });
  check(() => assert.deepEqual(fetched, [
    `${LOCAL_MODELS}/c2c3_disc_models/t2_model.yml`,
    `${LOCAL_MODELS}/templates/PAM50/PAM50_levels.nii.gz`
  ], 'without a hosted URL the PAM50 levels fall back to the local models directory'));
}

// ---------------------------------------------------------------------------
// Repository lint: model binaries stay on Hugging Face, not in Git LFS.
// ---------------------------------------------------------------------------
{
  const gitAttributesPath = path.join(APP_ROOT, '.gitattributes');
  const gitAttributes = fs.existsSync(gitAttributesPath) ? fs.readFileSync(gitAttributesPath, 'utf8') : '';
  check(() => assert.doesNotMatch(gitAttributes, /filter=lfs/, 'model assets must not be tracked with Git LFS'));
}

// ---------------------------------------------------------------------------
// Task definitions the browser reads (web/js/app/sct-tasks.js).
// ---------------------------------------------------------------------------
{
  const tasks = await import(pathToFileURL(path.join(APP_ROOT, 'web/js/app/sct-tasks.js')));
  const vertebrae = tasks.getTaskById('vertebrae');
  check(() => assert.equal(vertebrae.processingOnly, true));
  check(() => assert.equal(tasks.getPrimaryModelAsset(vertebrae), null, 'vertebrae has no model asset to fall back to'));
  check(() => assert.equal(tasks.getTaskTemplateAssetUrl(vertebrae, 'pam50-t2'), `${HF}/templates/PAM50/PAM50_t2.nii.gz`));
  check(() => assert.equal(tasks.getTaskTemplateAssetUrl(vertebrae, 'pam50-levels'), `${HF}/templates/PAM50/PAM50_levels.nii.gz`));

  const lesion = tasks.getTaskById('lesion_sci_t2');
  check(() => assert.deepEqual(lesion.outputStages.map(stage => stage.id), ['segmentation', 'lesion', 'lesion_metrics']));

  const spine = tasks.getTaskById('spine');
  check(() => assert.equal(spine.validationStatus, 'manual-only', 'spine stays manual-only until an SCT reference fixture exists'));
  check(() => assert.deepEqual(spine.outputStages.map(stage => [stage.id, stage.visibleByDefault]), [['spine_step1', true], ['spine_discs', true]]));
}

report(`Task routing OK: ${checks} executed checks across ${EXPECTED_SEGMENTATION_REQUESTS.length} segmentation tasks, vertebral labeling, result stages and the worker.`);
process.exit(0);
