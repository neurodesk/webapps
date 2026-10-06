#!/usr/bin/env node --no-warnings

// Manual mask editing: the drawing-bitmap mapping, the mask writer, the
// MaskEditor session against a fake NiiVue, the Edit masks controller, and the
// app's "stage data changed" seam that keeps lesion metrics and morphometry in
// step with an edited mask. e2e/manual-edits.spec.js draws on the real canvas.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createNiftiFromData, readNiftiImageData } from '@neurodesk/webapp-components/file-io';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = file => import(pathToFileURL(path.join(ROOT, file)));

const {
  MaskEditor, countChanged, drawingColormapName, drawingGeometry, drawingToNative, labelCounts, nativeToDrawing
} = await load('web/js/modules/mask-editor.js');

// ---------------------------------------------------------------------------
// The mapping between a mask file's voxels and NiiVue's drawing bitmap.
// ---------------------------------------------------------------------------

// What NiiVue 1.0.0-rc.13 reports for a 20x14x7 image with pixdims 0.5, 0.8,
// 3 mm and sform columns i -> -y, j -> -z, k -> +x (permuted and flipped):
// permRAS [3, -1, -2], dimsRAS [3, 7, 20, 14]. Recorded in Chromium by
// e2e/manual-edits.spec.js, which checks the same numbers on every run.
const PERMUTED = { dimsRAS: [3, 7, 20, 14], img2RASstart: [0, 19, 260], img2RASstep: [280, -1, -20] };

{
  const geometry = drawingGeometry(PERMUTED);
  assert.deepEqual(geometry.dims, [7, 20, 14]);
  assert.equal(geometry.count, 1960);
  const native = Uint8Array.from({ length: 1960 }, (_, index) => (index * 7) % 5);
  const bitmap = nativeToDrawing(native, geometry);
  assert.notDeepEqual(bitmap, native, 'a permuted image is reordered');
  assert.deepEqual(drawingToNative(bitmap, geometry), native, 'mask -> drawing -> mask is the identity');
  // Native voxel (i, j, k) is RAS voxel (x, y, z) = (k, 19 - i, 13 - j).
  const nativeIndex = (i, j, k) => i + 20 * (j + 14 * k);
  const rasIndex = (x, y, z) => x + 7 * (y + 20 * z);
  for (const [i, j, k] of [[0, 0, 0], [19, 13, 6], [3, 5, 2]]) {
    assert.equal(bitmap[rasIndex(k, 19 - i, 13 - j)], native[nativeIndex(i, j, k)], `voxel ${i},${j},${k} lands where the image puts it`);
  }
  assert.throws(() => nativeToDrawing(new Uint8Array(10), geometry), /10 voxels/);
  assert.throws(() => drawingGeometry({}), /RAS geometry/);
}

// Every axis order and flip, on an anisotropic grid, round-trips exactly.
for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  for (let flips = 0; flips < 8; flips += 1) {
    const nativeDims = [5, 3, 4];
    const rasDims = perm.map(axis => nativeDims[axis]);
    const strides = [1, nativeDims[0], nativeDims[0] * nativeDims[1]];
    const step = perm.map((axis, r) => ((flips >> r) & 1 ? -strides[axis] : strides[axis]));
    const start = perm.map((axis, r) => ((flips >> r) & 1 ? (rasDims[r] - 1) * strides[axis] : 0));
    const geometry = drawingGeometry({ dimsRAS: [3, ...rasDims], img2RASstart: start, img2RASstep: step });
    const native = Uint8Array.from({ length: 60 }, (_, index) => index + 1);
    const bitmap = nativeToDrawing(native, geometry);
    assert.deepEqual([...bitmap].sort((a, b) => a - b), [...native], 'the drawing is a permutation of the mask');
    assert.deepEqual(drawingToNative(bitmap, geometry), native, `perm ${perm} flips ${flips} round-trips`);
  }
}

assert.equal(countChanged(Uint8Array.of(0, 1, 2), Uint8Array.of(0, 2, 2)), 1);
assert.deepEqual([...labelCounts(Uint8Array.of(0, 1, 1, 3))], [[1, 2], [3, 1]]);
assert.equal(drawingColormapName('lesion'), '_sct_lesion', 'drawing colormaps are NiiVue _-prefixed lookup tables');

// ---------------------------------------------------------------------------
// The mask writer keeps the model output's header contract.
// ---------------------------------------------------------------------------

const { buildMaskNifti, editedFileName, readMaskVoxels, NEW_MASKS, SctManualEdits } = await load('web/js/app/manual-edits.js');

// An anisotropic, permuted input header, as the worker receives it.
function inputHeader(dims = [20, 14, 7]) {
  const header = new ArrayBuffer(352);
  const view = new DataView(header);
  view.setInt32(0, 348, true);
  [3, ...dims, 1, 1, 1, 1].forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  [1, 0.5, 0.8, 3, 1, 1, 1, 1].forEach((value, index) => view.setFloat32(76 + index * 4, value, true));
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 2, true);
  view.setInt16(254, 1, true);
  [[0, 0, 3, -10], [-0.5, 0, 0, 20], [0, -0.8, 0, 30]].forEach((row, r) => row.forEach((value, c) => view.setFloat32(280 + (r * 4 + c) * 4, value, true)));
  new Uint8Array(header).set([0x6e, 0x2b, 0x31, 0], 344);
  return header;
}

const modelVoxels = Uint8Array.from({ length: 1960 }, (_, index) => (index % 11 === 0 ? 2 : index % 3 === 0 ? 1 : 0));
// Exactly how the worker writes a stage (createOutputNifti).
const modelOutput = createNiftiFromData(modelVoxels, inputHeader(), { dims: [20, 14, 7] });
{
  const rebuilt = buildMaskNifti(modelVoxels, modelOutput);
  assert.deepEqual(new Uint8Array(rebuilt), new Uint8Array(modelOutput), 'unchanged voxels give back the model file byte for byte');
  const edited = modelVoxels.slice();
  edited[5] = 4;
  edited[11] = 0;
  const bytes = buildMaskNifti(edited, modelOutput);
  const view = new DataView(bytes);
  assert.equal(view.getInt16(70, true), 2, 'uint8');
  assert.equal(view.getFloat32(124, true), 4, 'cal_max is the largest label');
  assert.equal(view.getFloat32(112, true), 1, 'no scaling');
  assert.deepEqual(new Uint8Array(bytes, 0, 352).slice(280, 328), new Uint8Array(modelOutput, 0, 352).slice(280, 328), 'the sform is kept');
  assert.deepEqual(readNiftiImageData(bytes, Uint8Array).data, edited, 'the voxels are the edit, in file order');
  // A new mask starts from the input's header and writes the same contract.
  const fresh = buildMaskNifti(modelVoxels, inputHeader());
  assert.deepEqual(new Uint8Array(fresh), new Uint8Array(modelOutput), 'a mask drawn from nothing has the model output header');
  const { voxels } = await readMaskVoxels(new File([modelOutput], 'spinalcord_segmentation.nii'));
  assert.deepEqual(voxels, modelVoxels);
}
assert.equal(editedFileName('spinalcord_segmentation.nii'), 'spinalcord_segmentation_edited.nii');
assert.equal(editedFileName('spinalcord_segmentation_edited.nii'), 'spinalcord_segmentation_edited.nii', 'a second edit keeps one suffix');
assert.deepEqual(NEW_MASKS.map(mask => mask.stage), ['segmentation', 'lesion']);

// ---------------------------------------------------------------------------
// MaskEditor against a fake NiiVue 1.0 drawing API.
// ---------------------------------------------------------------------------

class FakeNiiVue extends EventTarget {
  constructor(volume = PERMUTED) {
    super();
    this.volumes = [volume];
    this.drawingVolume = null;
    this.colormaps = new Map();
    this.drawIsEnabled = false;
    this._penValue = 1;
    this._fill = true;
    this.calls = [];
  }
  get drawPenValue() { return this._penValue; }
  set drawPenValue(value) {
    this._penValue = value;
    this.dispatchEvent(new CustomEvent('penValueChanged', { detail: { penValue: value } }));
  }
  get drawIsFillOverwriting() { return this._fill; }
  set drawIsFillOverwriting(value) {
    this._fill = value;
    this.dispatchEvent(new CustomEvent('change', { detail: { property: 'drawIsFillOverwriting', value } }));
  }
  emitDrawing(action) { this.dispatchEvent(new CustomEvent('drawingChanged', { detail: { action } })); }
  createEmptyDrawing() {
    this.calls.push('createEmptyDrawing');
    this.drawingVolume = { img: new Uint8Array(1960) };
    this.drawIsEnabled = true;
    this.emitDrawing('create');
  }
  closeDrawing() {
    this.calls.push('closeDrawing');
    this.drawingVolume = null;
    this.emitDrawing('close');
  }
  addColormap(name, colormap) { this.colormaps.set(name, colormap); return name; }
  refreshDrawing() { this.calls.push('refreshDrawing'); }
}

const cordColormap = { R: [0, 68], G: [0, 128], B: [0, 255], A: [0, 255], I: [0, 1], labels: ['Background', 'Spinal cord'] };

{
  const nv = new FakeNiiVue();
  const penField = [];
  const editor = new MaskEditor({ nv, setPenField: value => { penField.push(value); return false; } });
  const session = await editor.begin({ stage: 'segmentation', native: modelVoxels, labelSetId: 'spinalcord', labelColormap: cordColormap, label: 1, opacity: 0.4 });
  assert.equal(editor.stage, 'segmentation');
  assert.deepEqual(nv.drawingVolume.img, nativeToDrawing(modelVoxels, drawingGeometry(PERMUTED)), 'the drawing holds the stage, in RAS order');
  assert.equal(nv.drawColormap, '_sct_spinalcord');
  assert.deepEqual(nv.colormaps.get('_sct_spinalcord').I, [0, 1], 'the stage label colours are the drawing colours');
  assert.equal(nv.drawOpacity, 0.4);
  assert.equal(nv.drawIsEnabled, false, 'no tool until the user picks one in FreeBrowse');
  assert.equal(editor.isDirty(), false);
  assert.deepEqual(editor.currentNative(), modelVoxels, 'no edits: the mask comes back unchanged');
  assert.deepEqual(penField, [1]);

  // A stroke and an undo in NiiVue (undo swaps in a new img array).
  nv.drawingVolume.img[3] = nv.drawingVolume.img[3] === 1 ? 0 : 1;
  assert.equal(editor.changedVoxels(), 1);
  assert.equal(editor.isDirty(), true);
  nv.drawingVolume.img = session.original.slice();
  assert.equal(editor.isDirty(), false, 'an undo back to the start is not an edit');

  // Unticking Pen Fill must not bring back erased voxels.
  nv.drawIsFillOverwriting = false;
  assert.equal(nv.drawIsFillOverwriting, true, 'fills keep overwriting during a session');

  // Label choice: FreeBrowse field absent, so the next pen value it applies is replaced.
  editor.setLabel(2);
  assert.equal(nv.drawPenValue, 2);
  nv.drawPenValue = 1;
  assert.equal(nv.drawPenValue, 2, "FreeBrowse's stale pen value is replaced by the chosen label");
  const shown = [];
  editor.onPenValue = value => shown.push(value);
  nv.drawPenValue = 3;
  assert.deepEqual(shown, [3], 'a pen value chosen in FreeBrowse is shown in the label select');
  nv.drawPenValue = 0;
  assert.deepEqual(shown, [3], 'erasing is not a label');

  nv.drawingVolume.img.fill(0);
  const applied = editor.apply();
  assert.equal(applied.length, 1960);
  assert.ok(applied.every(value => value === 0), 'apply returns the edited mask in file order');
  assert.equal(nv.drawingVolume, null, 'apply closes the drawing layer');
  assert.equal(editor.isActive(), false);
}

// FreeBrowse's Save Drawing closes the layer during a session: the edit is kept.
{
  const nv = new FakeNiiVue();
  const closed = [];
  const editor = new MaskEditor({ nv, onClosedByViewer: (native, stage) => closed.push([stage, native]) });
  await editor.begin({ stage: 'lesion', native: null, labelSetId: 'lesion', labelColormap: cordColormap });
  nv.drawingVolume.img[0] = 1;
  nv.closeDrawing();
  assert.equal(closed.length, 1);
  assert.equal(closed[0][0], 'lesion');
  assert.equal(closed[0][1].reduce((sum, value) => sum + value, 0), 1, 'the drawn voxel survives the close');
}

// FreeBrowse's Edit as drawing on an SCT overlay is adopted and refilled.
{
  const nv = new FakeNiiVue();
  const requests = [];
  const editor = new MaskEditor({
    nv,
    onAdopt: request => {
      requests.push(request);
      return request.stage ? { stage: request.stage, native: modelVoxels, labelSetId: 'spinalcord', labelColormap: cordColormap } : null;
    }
  });
  editor.noteStageRemoved('segmentation');
  nv.drawingVolume = { img: new Uint8Array(1960).fill(9) };
  nv.emitDrawing('load');
  await editor.adoption;
  assert.deepEqual(requests, [{ action: 'load', stage: 'segmentation' }]);
  assert.equal(editor.stage, 'segmentation');
  assert.deepEqual(editor.currentNative(), modelVoxels, "the stage's voxels replace NiiVue's loadDrawing result");
  assert.ok(!nv.calls.includes('createEmptyDrawing'), 'the open layer is reused');
}

// ---------------------------------------------------------------------------
// The app seam: stage data changes reach derived results.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!DOCTYPE html><body><select id="morphometryMask"></select></body>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'customElements', 'HTMLElement', 'HTMLInputElement', 'Node', 'Option', 'MutationObserver', 'requestAnimationFrame']) {
  if (dom.window[key] !== undefined) globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame ??= callback => setTimeout(callback, 0);
const { SpinalCordToolboxApp } = await load('web/js/spinalcordtoolbox-app.js');
const { PipelineExecutor } = await import('@neurodesk/webapp-components');

function fakeApp() {
  const app = Object.create(SpinalCordToolboxApp.prototype);
  const executor = new PipelineExecutor({ workerUrl: 'unused.js', steps: ['load', 'inference', 'morphometry', 'lesion_metrics'] });
  const workerRequests = [];
  executor.runLesionMetrics = async request => {
    workerRequests.push(['lesion_metrics', request]);
    queueMicrotask(() => app.onStepComplete('lesion_metrics'));
  };
  executor.runMorphometry = async request => {
    workerRequests.push(['morphometry', request]);
    queueMicrotask(() => app.onStepComplete('morphometry'));
  };
  Object.assign(app, {
    inferenceExecutor: executor,
    stageEvents: new EventTarget(),
    _stepWaiters: new Map(),
    _derivedResults: Promise.resolve(),
    morphometrySources: { masks: new Map(), discs: null },
    selectedTask: { id: 'lesion_sci_t2' },
    inputFile: new File([modelOutput], 'sub-01_T2w.nii'),
    lines: [],
    workerRequests,
    renders: 0
  });
  app.logAnalysis = (message, level = 'info') => app.lines.push([level, message]);
  app.renderViewerVolumes = async () => { app.renders += 1; };
  app.rebuildResultsList = () => {};
  app.syncMorphometryControls = () => {};
  app.clearMetricsResult = () => {};
  app.beginAbortableStep = step => { app.currentRunningStep = step; };
  app.onStepComplete = step => {
    app.currentRunningStep = null;
    app._stepWaiters.get(step)?.resolve();
    app._stepWaiters.delete(step);
  };
  app.runMorphometry = () => executor.runMorphometry({ mask: 'segmentation' });
  return app;
}

{
  const app = fakeApp();
  const seen = [];
  const unsubscribe = app.onStageDataChanged(change => seen.push([change.stage, change.source, change.file?.name ?? null, change.previousFile?.name ?? null]));
  app.onStageDataChanged(change => app.onStageMaskChanged(change));

  // Model output: announced, nothing recomputed (the worker sent its metrics).
  app.inferenceExecutor.handleStageData({ stage: 'segmentation', taskId: 'lesion_sci_t2', niftiData: modelOutput.slice(0) });
  app.notifyStageDataChanged('segmentation', 'model');
  app.inferenceExecutor.handleStageData({ stage: 'lesion', taskId: 'lesion_sci_t2', niftiData: modelOutput.slice(0) });
  app.notifyStageDataChanged('lesion', 'model');
  await app._derivedResults;
  assert.deepEqual(app.workerRequests, [], 'model output is not measured twice');

  // An edited lesion mask: one event, provenance kept, metrics recomputed through the worker route.
  const edited = new File([buildMaskNifti(new Uint8Array(1960), modelOutput)], 'lesion_sci_t2_lesion_edited.nii');
  await app.setStageData('lesion', edited, { source: 'edit', manualEdit: { kind: 'edited', downloaded: false } });
  await app._derivedResults;
  assert.deepEqual(seen.at(-1), ['lesion', 'edit', 'lesion_sci_t2_lesion_edited.nii', 'lesion_sci_t2_lesion.nii']);
  assert.equal(app.inferenceExecutor.getResult('lesion').file, edited, 'the edit is the stage data');
  assert.equal(app.inferenceExecutor.getResult('lesion').manualEdit.kind, 'edited');
  assert.equal(app.workerRequests.length, 1);
  const [step, request] = app.workerRequests[0];
  assert.equal(step, 'lesion_metrics');
  assert.equal(new Uint8Array(request.lesionData).length, edited.size, 'the edited lesion mask is measured');
  assert.ok(request.cordData, 'with the cord mask');
  assert.ok(request.imageData && request.imageName === 'sub-01_T2w', 'and the image');
  assert.equal(request.taskId, 'lesion_sci_t2');

  // An edited cord mask recomputes lesion metrics too, and remeasures morphometry made from it.
  app.inferenceExecutor.results.morphometry = { kind: 'metrics', file: new File([''], 'm.csv') };
  app.inferenceExecutor.lastMorphometrySettings = { mask: 'SCIseg spinal cord mask' };
  await app.setStageData('segmentation', new File([modelOutput], 'lesion_sci_t2_segmentation_edited.nii'), { source: 'edit', manualEdit: { kind: 'edited' } });
  await app._derivedResults;
  assert.deepEqual(app.workerRequests.slice(1).map(([name]) => name), ['lesion_metrics', 'morphometry']);
  assert.equal(app.morphometrySources.masks.get('segmentation').file.name, 'lesion_sci_t2_segmentation_edited.nii', 'morphometry measures the edited mask');

  // Removing a drawn lesion mask drops the metrics made from it.
  app.inferenceExecutor.results.lesion_metrics = { kind: 'metrics', file: new File([''], 'l.csv') };
  await app.removeStageData('lesion');
  await app._derivedResults;
  assert.equal(app.inferenceExecutor.getResult('lesion_metrics'), null);
  assert.deepEqual(seen.at(-1), ['lesion', 'restore', null, 'lesion_sci_t2_lesion_edited.nii']);

  unsubscribe();
  const count = seen.length;
  app.notifyStageDataChanged('segmentation', 'model');
  assert.equal(seen.length, count, 'unsubscribe stops the listener');
}

// ---------------------------------------------------------------------------
// The Edit masks controller: commit, revert and the unsaved-edits guard.
// ---------------------------------------------------------------------------

{
  document.body.innerHTML = `
    <section id="editSection" class="step-disabled"><select id="editStageSelect"></select><select id="editLabelSelect"></select>
    <button id="editStart"></button><button id="editApply"></button><button id="editDiscard"></button><button id="editRevert"></button></section>`;
  const app = fakeApp();
  app.viewerAvailable = true;
  app.viewer = { isAvailable: () => true, getStageOpacity: () => 0.7 };
  app.isCompareMode = () => false;
  app.currentResultTab = 'input';
  app.inferenceExecutor.handleStageData({ stage: 'segmentation', taskId: 'spinalcord', niftiData: modelOutput.slice(0) });
  app.selectedTask = { id: 'spinalcord' };
  const edits = new SctManualEdits(app);
  app.manualEdits = edits;
  const nv = new FakeNiiVue();
  edits.attachViewer({ nv, handle: {} });
  edits.sync();
  assert.ok(!document.getElementById('editSection').classList.contains('step-disabled'), 'the section opens once an image and the viewer are there');
  assert.deepEqual([...document.getElementById('editStageSelect').options].map(option => option.textContent), ['SCT Segmentation', 'New lesion mask']);

  assert.equal(await edits.start(), true);
  assert.equal(edits.editingStage, 'segmentation');
  assert.ok(edits.isHiding('segmentation'), 'its overlay is hidden while it is on the drawing layer');
  assert.equal(document.getElementById('editApply').hidden, false);
  assert.equal(document.getElementById('editStart').hidden, true);

  // Erase three cord voxels in the drawing.
  const cordRas = [...nv.drawingVolume.img.keys()].filter(index => nv.drawingVolume.img[index] === 1).slice(0, 3);
  for (const index of cordRas) nv.drawingVolume.img[index] = 0;
  assert.deepEqual(edits.unsavedStages(), ['segmentation'], 'a dirty drawing is unsaved');
  await edits.apply();
  const result = app.inferenceExecutor.getResult('segmentation');
  assert.equal(result.file.name, 'spinalcord_segmentation_edited.nii');
  assert.equal(result.manualEdit.kind, 'edited');
  assert.equal(result.manualEdit.changedVoxels, 3);
  assert.equal(result.manualEdit.original.file.name, 'spinalcord_segmentation.nii');
  const { voxels } = await readMaskVoxels(result.file);
  assert.equal(countChanged(voxels, modelVoxels), 3, 'the download holds exactly the edit');
  assert.ok(app.lines.some(([, line]) => /Manual edit applied to SCT Segmentation: 3 voxels changed/.test(line)), 'the analysis log records the edit');
  assert.equal(document.getElementById('editRevert').hidden, false);

  // Guard: not downloaded yet, so a destructive action asks.
  const asked = [];
  globalThis.confirm = message => { asked.push(message); return false; };
  assert.equal(edits.confirmDiscard('A new segmentation run'), false);
  assert.match(asked[0], /A new segmentation run discards your manual edits to SCT Segmentation/);
  result.manualEdit.downloaded = true;
  assert.equal(edits.confirmDiscard('A new segmentation run'), true, 'a downloaded edit is saved');
  result.manualEdit.downloaded = false;

  // Restore the model mask.
  assert.equal(await edits.revert('segmentation'), true);
  const restored = app.inferenceExecutor.getResult('segmentation');
  assert.equal(restored.file.name, 'spinalcord_segmentation.nii');
  assert.equal(restored.manualEdit, null);
  assert.equal(edits.hasUnsavedEdits(), false);

  // A new lesion mask drawn from nothing becomes the lesion stage, and can be removed.
  document.getElementById('editStageSelect').value = 'new:lesion';
  edits.sync();
  assert.deepEqual([...document.getElementById('editLabelSelect').options].map(option => option.textContent), ['Lesion']);
  await edits.start();
  assert.equal(edits.editingStage, 'lesion');
  nv.drawingVolume.img[100] = 1;
  await edits.apply();
  const lesion = app.inferenceExecutor.getResult('lesion');
  assert.equal(lesion.file.name, 'sub-01_T2w_lesion_manual.nii');
  assert.equal(lesion.manualEdit.kind, 'new');
  assert.equal(lesion.labelSetId, 'lesion');
  assert.equal(app.getOverlayLabelTaskId('lesion'), 'lesion', 'a drawn mask keeps its label set');
  assert.equal(document.getElementById('editRevert').textContent, 'Remove mask');
  await edits.revert('lesion');
  assert.equal(app.inferenceExecutor.hasResult('lesion'), false);
  delete globalThis.confirm;
}

console.log('Manual edit tests passed');
