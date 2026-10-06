#!/usr/bin/env node --no-warnings

// Asserts the SCT Segmentation task selector routes work to the right model.
// A runnable task without a model asset would make runInference() silently
// fall back to the default model name and report DONE with the wrong output;
// this test enforces that every task in the dropdown has its own asset.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const {
  SCT_TASKS,
  isTaskRunnable,
  getPrimaryModelAsset,
  getTaskModelUrl
} = await import(pathToFileURL(path.join(ROOT, 'web/js/app/sct-tasks.js')));

const HOSTED_MODEL_URL_RE = /^https:\/\/huggingface\.co\/datasets\/sbollmann\/sct-webapp-data\/resolve\/[0-9a-f]{40}\/web\/models\/.+$/;

// Tasks offered in the segmentation dropdown must each have a primary model
// asset. Without one, runInference() falls back to Config.MODEL.name.
const segmentationDropdownTasks = SCT_TASKS.filter(task => isTaskRunnable(task));
for (const task of segmentationDropdownTasks) {
  const asset = getPrimaryModelAsset(task);
  assert.ok(asset, `Task "${task.id}" appears in the segmentation dropdown but has no primary model asset. Either add modelAssets or set supportStatus to unsupported.`);
  assert.match(asset.downloadUrl || '', HOSTED_MODEL_URL_RE, `Task "${task.id}" must use a pinned Hugging Face model asset URL`);
  assert.equal(getTaskModelUrl(task), asset.downloadUrl, `Task "${task.id}" runtime URL must resolve to the hosted model asset`);
}

const lesionSci = SCT_TASKS.find(task => task.id === 'lesion_sci_t2');
assert.ok(lesionSci, 'lesion_sci_t2 task is defined');
assert.equal(lesionSci.supportStatus, 'supported', 'lesion_sci_t2 must be runnable from SCT Segmentation');
assert.ok(segmentationDropdownTasks.includes(lesionSci), 'lesion_sci_t2 must appear in the segmentation dropdown');
assert.deepEqual(lesionSci.outputStages?.map(stage => stage.id), ['segmentation', 'lesion', 'lesion_metrics'], 'lesion_sci_t2 must declare spinal-cord, lesion, and metrics stages');
assert.equal(getPrimaryModelAsset(lesionSci)?.output?.activation, 'sigmoid-regions', 'lesion_sci_t2 must use SCIsegV2 region-channel output metadata');

const spinalcord = SCT_TASKS.find(task => task.id === 'spinalcord');
assert.ok(spinalcord, 'spinalcord task is defined');
const spinalcordAsset = getPrimaryModelAsset(spinalcord);
assert.ok(spinalcordAsset, 'spinalcord task has a primary model asset');
assert.equal(spinalcordAsset?.preprocessing?.modelOrientation, 'RPI', 'spinalcord must match SCT dataset.json image_orientation=RPI');
assert.equal(spinalcordAsset?.preprocessing?.modelAxisOrder, 'zyx', 'spinalcord must feed the nnU-Net plan in zyx tensor order');
assert.deepEqual(spinalcordAsset?.preprocessing?.targetSpacing, [0.8958333, 0.7, 1.0], 'spinalcord targetSpacing is stored in browser RAS/XYZ order');
assert.equal(spinalcordAsset?.inferenceDefaults?.overlap, 0.5, 'spinalcord overlap must match SCT tile_step_size=0.5');
assert.equal(spinalcordAsset?.inferenceDefaults?.testTimeAugmentation, false, 'spinalcord TTA must stay disabled by SCT default');
assert.equal(spinalcordAsset?.inferenceDefaults?.keepLargestComponent, true, 'spinalcord must keep the largest component like SCT');
assert.equal(spinalcordAsset?.inferenceDefaults?.minComponentSize, 0, 'spinalcord must not add a separate browser-only min-size cleanup');

const spine = SCT_TASKS.find(task => task.id === 'spine');
assert.ok(spine, 'spine task is defined');
assert.equal(spine.supportStatus, 'supported', 'spine must be runnable once the TotalSpineSeg ONNX asset is present');
assert.equal(spine.validationStatus, 'manual-only', 'spine must remain manual-only until SCT fixture parity is added');
assert.equal(spine.displayName, 'TotalSpineSeg', 'spine task must be labeled TotalSpineSeg in the UI');
assert.ok(segmentationDropdownTasks.includes(spine), 'spine must appear in the segmentation dropdown');
assert.equal(getPrimaryModelAsset(spine)?.output?.activation, 'sigmoid-labels', 'spine must use TotalSpineSeg region-sigmoid label aggregation');
assert.deepEqual(getPrimaryModelAsset(spine)?.patchSize, [256, 256, 48], 'spine must use the browser-safe TotalSpineSeg zyx patch size');
assert.equal(getPrimaryModelAsset(spine)?.preprocessing?.modelOrientation, 'RAS', 'spine must match upstream nib.as_closest_canonical RAS preprocessing');
assert.equal(getPrimaryModelAsset(spine)?.preprocessing?.modelAxisOrder, 'zyx', 'spine must feed TotalSpineSeg in nnU-Net zyx tensor order');
assert.deepEqual(getPrimaryModelAsset(spine)?.output?.labelPriority, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'spine must collapse TotalSpineSeg regions in nnU-Net regions_class_order');
assert.equal(getPrimaryModelAsset(spine)?.output?.paddingMode, 'center-min-patch', 'spine must use nnU-Net centered padding for short axes');
assert.equal(getPrimaryModelAsset(spine)?.output?.discPointRadius, 2, 'spine disc labels must use visible markers rather than one-voxel points');
assert.match(getPrimaryModelAsset(spine)?.downloadUrl || '', /^https:\/\/huggingface\.co\/datasets\/sbollmann\/sct-webapp-data\/resolve\/[0-9a-f]{40}\/web\/models\/totalspineseg-step1\.onnx$/, 'spine ONNX must be hosted on the Hugging Face dataset at a pinned revision');
assert.equal(getTaskModelUrl(spine), getPrimaryModelAsset(spine)?.downloadUrl, 'spine runtime URL must resolve to the Hugging Face-hosted ONNX asset');
assert.deepEqual(spine.outputStages?.map(stage => stage.id), ['spine_step1', 'spine_discs'], 'spine must declare TotalSpineSeg step-1 and disc-label stages');
assert.equal(spine.outputStages?.find(stage => stage.id === 'spine_step1')?.visibleByDefault, true, 'TotalSpineSeg step-1 labels must be visible by default');
assert.equal(spine.outputStages?.find(stage => stage.id === 'spine_discs')?.visibleByDefault, true, 'TotalSpineSeg disc labels must be visible by default');

const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
assert.doesNotMatch(indexHtml, /id="overlapSelect"/, 'sliding-window overlap is an SCT model default, not a user-facing control');
const appJs = fs.readFileSync(path.join(ROOT, 'web/js/spinalcordtoolbox-app.js'), 'utf8');
assert.match(appJs, /getTaskModelUrl\(selectedTask\)[\s\S]*?modelUrl:\s*modelUrl\s*\?/, 'runInference must pass the resolved per-asset model URL into the worker');
assert.match(appJs, /const overlap\s*=\s*assetDefaults\.overlap\s*\?\?\s*Config\.INFERENCE_DEFAULTS\.overlap/, 'runSegmentation must read overlap from task metadata instead of a public selector');
assert.match(appJs, /keepLargestComponent:\s*!!\(assetDefaults\.keepLargestComponent\s*\?\?\s*Config\.INFERENCE_DEFAULTS\.keepLargestComponent\)/, 'runSegmentation must pass SCT largest-component cleanup to the worker');

const workerJs = fs.readFileSync(path.join(ROOT, 'web/js/inference-worker.js'), 'utf8');
assert.match(workerJs, /resolvedModelUrl\s*=\s*modelUrl\s*\|\|\s*`\$\{modelBaseUrl\}\/\$\{modelName\}`/, 'worker must prefer per-asset modelUrl before falling back to MODEL_BASE_URL + filename');

const gitAttributesPath = path.join(ROOT, '.gitattributes');
const gitAttributes = fs.existsSync(gitAttributesPath) ? fs.readFileSync(gitAttributesPath, 'utf8') : '';
assert.doesNotMatch(gitAttributes, /filter=lfs/, 'model assets must not be tracked with Git LFS after migration to Hugging Face');

// runInference() must reject asset-less tasks rather than silently falling
// back to Config.MODEL.name.
assert.match(appJs, /if \(!selectedAsset\) \{/, 'runInference must guard against missing model assets');

// Label masks must be independently toggleable result stages. Every label
// mask of the current run is one tracked entry of the viewer stack above the
// base image; visibility (the input's included) is a property of the entry,
// so an eye toggle changes opacity instead of reloading or reordering volumes.
assert.match(appJs, /isOverlayStage\(stage\)\s*\{\s*return stage === 'segmentation' \|\| stage === 'lesion' \|\| stage === 'spine_step1' \|\| stage === 'spine_discs'/, 'isOverlayStage must include segmentation, lesion, and TotalSpineSeg label stages');
assert.match(appJs, /getOverlayColormapId[\s\S]*?'sct-lesion'/, 'getOverlayColormapId must map lesion to sct-lesion');
assert.match(appJs, /getOverlayColormapId[\s\S]*?'sct-totalspineseg'/, 'getOverlayColormapId must map TotalSpineSeg labels to sct-totalspineseg');
assert.match(appJs, /getOverlayColormapId[\s\S]*?'sct-spine-discs'/, 'getOverlayColormapId must map TotalSpineSeg disc points to sct-spine-discs');
assert.match(appJs, /_stageVisibility\s*=\s*\{[\s\S]*?segmentation:\s*true[\s\S]*?lesion:\s*true[\s\S]*?spine_step1:\s*true[\s\S]*?spine_discs:\s*true/, 'result visibility must show TotalSpineSeg label stages by default');
assert.match(appJs, /setStageVisible\(data\.stage,\s*this\.getDefaultStageVisibility\(\)\[data\.stage\]\s*!==\s*false\)/, 'new overlay stage data must honor default visibility instead of forcing raw localizers visible');
assert.match(appJs, /getVisibleOverlayStages\(\)[\s\S]*?\['segmentation', 'lesion', 'spine_step1', 'spine_discs'\][\s\S]*?isStageVisible\(stage\)[\s\S]*?hasResult\(stage\)/, 'visible overlay stages must be resolved from per-stage visibility and existing results');
assert.match(appJs, /getViewerStack\(\)\s*\{[\s\S]*?stackEntries\s*=\s*\[\{[\s\S]*?file:\s*baseFile[\s\S]*?visible:\s*this\.isStageVisible\('input'\)/, 'the base image stays in the stack when hidden; its visibility is an entry property');
assert.match(appJs, /for \(const overlayStage of this\.getOverlayStagesWithResults\(\)\)[\s\S]*?stackEntries\.push\(\{[\s\S]*?stage:\s*overlayStage[\s\S]*?visible:\s*this\.isStageVisible\(overlayStage\)[\s\S]*?colormapKey:\s*this\.getOverlayColormapId\(overlayStage, taskId\)[\s\S]*?labelColormap:\s*generateLabelColormap\(this\.getOverlayLabelTaskId\(overlayStage, taskId\)\)/, 'label masks must be loaded as independently tracked label-colormap entries, coloured by the task that produced them');
assert.match(appJs, /const taskId = result\?\.raw\?\.taskId;/, 'an overlay keeps the colours of the task that produced it');
assert.match(appJs, /getOverlayStagesWithResults\(\)\s*\{[\s\S]*?\['segmentation', 'lesion', 'spine_step1', 'spine_discs'\]\.filter\(stage => \(\s*this\.inferenceExecutor\.hasResult\(stage\)/, 'only stages with a current result enter the viewer stack, in stable order');
assert.match(appJs, /_renderViewerPromise\s*=\s*Promise\.resolve\(\)/, 'viewer renders must be serialized to prevent late base loads from wiping overlays');
assert.match(appJs, /renderViewerVolumes\(\)\s*\{[\s\S]*?_renderViewerPromise\s*=\s*this\._renderViewerPromise\.then/, 'renderViewerVolumes must enqueue render work in order');
assert.match(appJs, /_renderViewerVolumesNow\(\)\s*\{\s*await this\.viewer\.showVolumes\(this\.getViewerStack\(\)\);\s*\}/, 'renderViewerVolumes must hand the whole stack to SctViewer, which reloads only what changed');
assert.equal((appJs.match(/\.showVolumes\(/g) || []).length, 1, 'renderViewerVolumes is the only path that changes the main viewer stack');
assert.match(appJs, /getResultListStages\(\)\s*\{[\s\S]*?getStageOrder\(\)\.filter\(stage => !this\.isMetricsResultStage\(stage\)\)/, 'metrics stages must be excluded from the viewable/downloadable image-layer result list');
assert.match(appJs, /renderMetricsResult\(stage\)[\s\S]*?metrics-download-btn[\s\S]*?downloadMetricsResult\(stage\)/, 'metrics statistics panel must provide its own CSV download button');
assert.match(appJs, /downloadMetricsResult\(stage\)[\s\S]*?result\?\.kind !== 'metrics'[\s\S]*?Downloaded statistics/, 'metrics CSV download must be handled as statistics, not as a layer download');

// Visibility must not resurrect missing sibling results. Auto-rendering a
// stale label result onto a new input or new segmentation would silently
// render the wrong label mask.
assert.doesNotMatch(
  appJs,
  /getVisibleOverlayStages\(\)\s*\{[\s\S]*?return\s+\['segmentation', 'lesion', 'spine_step1', 'spine_discs'\]\.filter\(stage => \(\s*this\.isStageVisible\(stage\)\s*\)\)/,
  'getVisibleOverlayStages must also require an existing result for each visible stage'
);

// runSegmentation must reset visibility and re-render before kicking off
// inference, so a previous overlay is not visible during the new run.
assert.match(appJs, /clearResults\(\);[\s\S]*?disableAllResultTabs\(\);[\s\S]*?resetStageVisibility\(\);[\s\S]*?renderViewerVolumes\(\)/, 'runSegmentation must reset stage visibility and re-render before starting inference');

// Reproduce the visible-stage semantics directly: each result controls only
// its own visibility, and missing results are excluded even when their default
// visibility flag is on.
function getVisibleOverlayStages(visibility, available) {
  return ['segmentation', 'lesion', 'spine_step1', 'spine_discs'].filter(stage => visibility[stage] && available.has(stage));
}
assert.deepEqual(getVisibleOverlayStages({ segmentation: true, lesion: true, spine_discs: true }, new Set(['segmentation', 'lesion', 'spine_discs'])), ['segmentation', 'lesion', 'spine_discs']);
assert.deepEqual(getVisibleOverlayStages({ segmentation: true, lesion: false, spine_discs: true }, new Set(['segmentation', 'lesion', 'spine_discs'])), ['segmentation', 'spine_discs']);
assert.deepEqual(getVisibleOverlayStages({ segmentation: false, lesion: true, spine_discs: true }, new Set(['segmentation', 'lesion', 'spine_discs'])), ['lesion', 'spine_discs']);
assert.deepEqual(getVisibleOverlayStages({ segmentation: true, lesion: true, spine_discs: true }, new Set(['segmentation'])), ['segmentation'], 'must not render missing sibling results');
assert.deepEqual(getVisibleOverlayStages({ segmentation: false, lesion: false, spine_discs: false }, new Set(['segmentation', 'lesion', 'spine_discs'])), []);
assert.deepEqual(getVisibleOverlayStages({ segmentation: false, lesion: false, spine_step1: true, spine_discs: true }, new Set(['spine_step1', 'spine_discs'])), ['spine_step1', 'spine_discs'], 'default TotalSpineSeg view shows both label stages');

console.log(`Task routing OK: ${segmentationDropdownTasks.length} segmentation task(s) all have model assets.`);
