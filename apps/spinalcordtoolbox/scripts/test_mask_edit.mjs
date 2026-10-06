#!/usr/bin/env node
// Manual mask editing: the shared nd-mask-editor wired to the SCT app on a
// fake NiiVue 1.0 behind a fake SctViewer. Covers the Edit buttons, Apply
// through the stage-data seam (edited name, provenance, SCT analysis mask
// choices, stale approximate metrics), Cancel, FreeBrowse's locked drawing
// controls, the unsaved-edits guard, settling before an image switch, and
// edits parking with their image. e2e/mask-edit.spec.js draws on the real
// FreeBrowse canvas.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createNiftiHeaderFromVolume, createUint8Nifti, parseNiftiHeader } from '@neurodesk/webapp-components/file-io';

const dom = new JSDOM(`<!DOCTYPE html>
<main class="app-main"><div class="viewer-toolbar"></div><div class="viewer-canvas-wrapper"></div></main>
<div id="stageButtons"></div><div id="metricsResults"></div><span id="statusText"></span>`, { url: 'http://localhost/' });
// Node's own Event and CustomEvent stay: the app's EventTargets are Node's.
for (const key of ['window', 'document', 'HTMLElement', 'customElements', 'Node', 'Option', 'MutationObserver']) {
  globalThis[key] = dom.window[key];
}

const { SpinalCordToolboxApp } = await import('../web/js/spinalcordtoolbox-app.js');
const { SctPipeline } = await import('../web/js/controllers/SctPipeline.js');
const { SctManualEdits, editedFileName, readMaskLabels } = await import('../web/js/app/manual-edits.js');
const { SessionResultStore, restoreSessionResults, snapshotSessionResults } = await import('../web/js/app/session-results.js');

const DIMS = [3, 4, 3, 2, 1, 1, 1, 1];
const AFFINE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const VOX = 352;

function maskBytes(values) {
  const labels = new Uint8Array(24);
  labels.set(values);
  return new Uint8Array(createUint8Nifti(labels, createNiftiHeaderFromVolume({ hdr: { dims: DIMS, affine: AFFINE } })));
}

// NiiVue 1.0's drawing API as the shared adapter uses it, plus the events
// FreeBrowse and NiiVue emit.
class FakeNiiVue extends EventTarget {
  constructor() {
    super();
    this.volumes = [];
    this.drawIsEnabled = false;
    this.drawing = null;
    this.colormaps = new Map();
  }
  async loadDrawing(file) {
    this.drawing = new Uint8Array(await file.arrayBuffer());
    this.emit('load');
    return true;
  }
  createEmptyDrawing() {
    this.drawing = maskBytes([]);
    this.emit('create');
  }
  closeDrawing() {
    this.drawing = null;
    this.emit('close');
  }
  drawUndo() { this.emit('undo'); }
  addColormap(name, colormap) { this.colormaps.set(name, colormap); }
  async setVolume(index, { opacity }) { this.volumes[index].opacity = opacity; }
  async saveDrawing() { return this.drawing.slice(); }
  emit(action) { this.dispatchEvent(new CustomEvent('drawingChanged', { detail: { action } })); }
  // A stroke: paint native voxel `index`, as the pen would.
  paint(index, value) {
    this.drawing[VOX + index] = value;
    this.emit('stroke');
  }
}

// SctViewer's surface the app and the editor use; it records every stack.
function fakeViewer(nv) {
  const locks = [];
  const viewer = {
    nv,
    stacks: [],
    locks,
    handle: { setDrawingLocked: locked => locks.push(locked) },
    isAvailable: () => true,
    async showVolumes(entries) {
      viewer.stacks.push(entries);
      nv.volumes = entries.map(entry => ({ opacity: entry.visible === false ? 0 : 1, hdr: parseNiftiHeader(maskBytes([])), stage: entry.stage, name: entry.file.name }));
    },
    getVolumeIndexForStage: stage => {
      const index = (viewer.stacks.at(-1) || []).findIndex(entry => entry.stage === stage);
      return index < 0 ? null : index;
    },
    clearComparison() {},
  };
  return viewer;
}

function makeApp() {
  document.getElementById('stageButtons').replaceChildren();
  const app = Object.create(SpinalCordToolboxApp.prototype);
  const nv = new FakeNiiVue();
  const viewer = fakeViewer(nv);
  const status = [];
  const lines = [];
  Object.assign(app, {
    nv,
    viewer,
    viewerAvailable: true,
    viewerReady: Promise.resolve(true),
    stageEvents: new EventTarget(),
    sessionResults: new SessionResultStore(),
    inputFile: new File([maskBytes([])], 't2.nii'),
    currentResultTab: 'input',
    _viewerMode: 'single',
    _renderViewerPromise: Promise.resolve(),
    selectedTask: { id: 'lesion_sci_t2' },
    lines,
    analysis: { generated: {}, setGenerated(results) { this.generated = results; } },
    progress: {
      reset: text => status.push(['reset', text]),
      end: (text, options) => status.push(['end', text, options]),
      begin: text => status.push(['begin', text]),
      setCancellable() {},
      setText() {},
    },
  });
  app.resetStageVisibility();
  app.logAnalysis = (message, level = 'info') => lines.push([level, message]);
  app.updateOutput = (message, level = 'info') => lines.push([level, message]);
  app.updateViewerInfo = () => {};
  app.inferenceExecutor = new SctPipeline({ onStageData: data => app.handleStageData(data) });
  app.manualEdits = new SctManualEdits(app);
  app.manualEdits.attachViewer(viewer);
  app.onStageDataChanged(change => app.onStageMaskChanged(change));
  return { app, nv, viewer, status, lines };
}

async function deliverResults(app) {
  app.inferenceExecutor.handleStageData({ stage: 'segmentation', data: maskBytes([1, 1, 1]), taskId: 'lesion_sci_t2' });
  app.inferenceExecutor.handleStageData({ stage: 'lesion', data: maskBytes([0, 1]), taskId: 'lesion_sci_t2' });
  app.inferenceExecutor.handleStageData({ stage: 'lesion_metrics', kind: 'metrics', csv: 'lesion_id\n1\n', rows: [{ lesion_id: 1 }], summary: { lesion_count: 1 } });
  await until(() => document.querySelectorAll('#stageButtons .volume-toggle').length === 3);
  await app.renderViewerVolumes();
}

function rows() {
  return [...document.querySelectorAll('#stageButtons .volume-toggle')].map(row => ({
    label: row.querySelector('.stage-label').textContent,
    edit: row.querySelector('.nd-edit-btn'),
  }));
}

const editButton = label => rows().find(row => row.label.startsWith(label)).edit;
const editor = () => document.querySelector('nd-mask-editor');
const editorButton = text => [...editor().querySelectorAll('button')].find(button => button.textContent === text);

async function until(condition) {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition(), 'condition never held');
}

async function openEditor(_app, label) {
  editButton(label).click();
  await until(() => editor().session.state === 'editing');
}

test.afterEach(() => {
  editor()?.remove();
});

test('mask results offer Edit; statistics and the input do not', async () => {
  const { app } = makeApp();
  await deliverResults(app);
  assert.deepEqual(rows().map(row => [row.label, Boolean(row.edit)]), [
    ['Input', false],
    ['SCT Segmentation', true],
    ['Lesion', true],
  ]);
  const edit = editButton('Lesion');
  assert.equal(edit.title, 'Edit in the viewer');
  assert.equal(edit.nextElementSibling.className, 'download-btn', 'Edit sits between the label and Download');
  assert.equal(document.querySelector('main.app-main > .viewer-toolbar').nextElementSibling, editor(), 'the editor row sits under the viewer toolbar');
  assert.equal(editor().hidden, true, 'the editor row is hidden until a session opens');
});

test('Apply makes the drawing the stage data: edited name, provenance, analysis masks, stale metrics', async () => {
  const { app, nv, viewer, status, lines } = makeApp();
  await deliverResults(app);
  const seen = [];
  app.onStageDataChanged(change => seen.push([change.stage, change.source, change.file?.name, change.previousFile?.name]));
  const original = app.inferenceExecutor.getResult('lesion').file;
  assert.equal(app.analysis.generated.lesion, original);

  await openEditor(app, 'Lesion');
  assert.deepEqual(viewer.locks, [true], "FreeBrowse's drawing controls are locked for the session");
  const shown = viewer.stacks.at(-1).find(entry => entry.stage === 'lesion');
  assert.equal(shown.visible, false, 'the lesion overlay is hidden while its mask is on the drawing layer');
  assert.ok(rows().slice(1).every(row => row.edit.disabled), 'every Edit is disabled during a session');
  assert.deepEqual(status.at(-1), ['reset', 'Editing Lesion. Left-drag paints; Apply keeps the changes.']);
  assert.equal(nv.drawIsEnabled, true);

  nv.paint(2, 1);
  nv.paint(1, 0);
  assert.equal(app.manualEdits.isDirty(), true);
  editorButton('Apply').click();
  await until(() => editor().session.state === 'idle' && viewer.locks.at(-1) === false);

  const result = app.inferenceExecutor.getResult('lesion');
  assert.equal(result.file.name, 'lesion_sci_t2_lesion_edited.nii', 'the edited file is named after the model output');
  assert.deepEqual([...await readMaskLabels(result.file)].slice(0, 4), [0, 0, 1, 0], 'the result holds the edited voxels');
  assert.equal(result.manualEdit.kind, 'edited');
  assert.equal(result.manualEdit.changedVoxels, 2);
  assert.equal(result.manualEdit.original.file, original, 'the model output is kept as provenance');
  assert.equal(result.manualEdit.downloaded, false);
  assert.deepEqual(seen, [['lesion', 'edit', 'lesion_sci_t2_lesion_edited.nii', 'lesion_sci_t2_lesion.nii']], 'one stage-data change, through setStageData');
  assert.ok(rows().some(row => row.label === 'Lesion (edited)'));
  assert.equal(app.analysis.generated.lesion, result.file, 'SCT analysis offers the edited lesion mask');
  assert.equal(app.analysis.generated.cord, app.inferenceExecutor.getResult('segmentation').file, 'and the untouched cord mask');
  assert.equal(app.inferenceExecutor.getResult('lesion_metrics'), null, 'the approximate metrics of the model mask are dropped');
  assert.ok(lines.some(([, line]) => /Manual edit applied to Lesion: 2 voxels changed/.test(line)));
  assert.equal(viewer.stacks.at(-1).find(entry => entry.stage === 'lesion').visible, true, 'the edited overlay is shown again');
  assert.ok(rows().slice(1).every(row => !row.edit.disabled), 'Edit is live again');
  assert.deepEqual(status.at(-1), ['reset', 'Ready']);

  // A second edit keeps the first model output as provenance and one suffix.
  await openEditor(app, 'Lesion');
  nv.paint(3, 1);
  await editor().apply();
  await until(() => viewer.locks.at(-1) === false);
  const again = app.inferenceExecutor.getResult('lesion');
  assert.equal(again.file.name, 'lesion_sci_t2_lesion_edited.nii');
  assert.equal(again.manualEdit.original.file, original);
  assert.equal(again.manualEdit.changedVoxels, 1, 'changes are counted against the mask the session opened');

  // Download marks the edit saved.
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:download';
  URL.revokeObjectURL ??= () => {};
  try {
    app.downloadStage('lesion');
  } finally {
    URL.createObjectURL = createObjectURL;
  }
  assert.equal(again.manualEdit.downloaded, true);
});

test('Apply without a changed voxel leaves the result unmarked', async () => {
  const { app, nv, viewer, lines } = makeApp();
  await deliverResults(app);
  const original = app.inferenceExecutor.getResult('segmentation').file;
  await openEditor(app, 'SCT Segmentation');
  nv.emit('stroke');
  await editor().apply();
  await until(() => viewer.locks.at(-1) === false);
  assert.equal(app.inferenceExecutor.getResult('segmentation').file, original);
  assert.equal(app.inferenceExecutor.getResult('segmentation').manualEdit, undefined);
  assert.ok(lines.some(([, line]) => /no voxels changed in SCT Segmentation/.test(line)));
  assert.equal(viewer.stacks.at(-1).find(entry => entry.stage === 'segmentation').visible, true);
});

test('Cancel leaves the result and its label unchanged', async () => {
  const { app, nv, viewer } = makeApp();
  await deliverResults(app);
  const original = app.inferenceExecutor.getResult('segmentation').file;
  await openEditor(app, 'SCT Segmentation');
  nv.paint(0, 0);
  editorButton('Cancel').click();
  await until(() => editButton('SCT Segmentation').disabled === false);
  assert.equal(editor().session.state, 'idle');
  assert.equal(nv.drawing, null, 'the drawing layer is closed');
  assert.deepEqual(viewer.locks, [true, false]);
  assert.equal(app.inferenceExecutor.getResult('segmentation').file, original);
  assert.ok(rows().every(row => !row.label.includes('(edited)')));
});

test('a drawing layer opened or closed by FreeBrowse during a session cancels it', async () => {
  const { app, nv, viewer, lines } = makeApp();
  await deliverResults(app);
  const original = app.inferenceExecutor.getResult('lesion').file;
  await openEditor(app, 'Lesion');
  nv.paint(0, 1);
  nv.createEmptyDrawing();
  await until(() => editor().session.state === 'idle' && viewer.locks.at(-1) === false);
  assert.equal(app.inferenceExecutor.getResult('lesion').file, original);
  assert.ok(lines.some(([level, line]) => level === 'warning' && /another tool changed the drawing layer/.test(line)));
});

for (const [name, action] of [
  ['a new run', async (app) => {
    app.inferenceExecutor.runInference = async () => {};
    await app.runSegmentation({ discardEdits: true });
  }],
  ['Clear results', app => app.clearResults()],
  ['a reset for a new input', app => app.resetAllSteps()],
]) {
  test(`${name} closes an open session first`, async () => {
    const { app, nv } = makeApp();
    app.inferenceExecutor.resetWorkerState = async () => {};
    await deliverResults(app);
    await openEditor(app, 'Lesion');
    await action(app);
    assert.equal(editor().session.state, 'idle');
    assert.equal(nv.drawing, null, 'the drawing is discarded');
    assert.equal(app.manualEdits.editingStage, null);
  });
}

test('settling before an image switch applies a drawing with strokes and closes an untouched one', async () => {
  const { app, nv } = makeApp();
  await deliverResults(app);
  await openEditor(app, 'SCT Segmentation');
  await app.manualEdits.settleBeforeSwitch();
  assert.equal(editor().session.state, 'idle');
  assert.equal(app.inferenceExecutor.getResult('segmentation').manualEdit, undefined, 'untouched: closed, not applied');

  await openEditor(app, 'SCT Segmentation');
  nv.paint(5, 1);
  await app.manualEdits.settleBeforeSwitch();
  assert.equal(editor().session.state, 'idle');
  assert.equal(app.inferenceExecutor.getResult('segmentation').manualEdit.changedVoxels, 1, 'the stroke belongs to the outgoing image');
});

test('the guard asks before unsaved edits are dropped', async () => {
  const { app, nv } = makeApp();
  await deliverResults(app);
  const asked = [];
  globalThis.confirm = message => { asked.push(message); return false; };
  try {
    await openEditor(app, 'SCT Segmentation');
    assert.equal(app.manualEdits.confirmDiscard('A new segmentation run'), true, 'an untouched drawing is not unsaved');
    nv.paint(4, 1);
    assert.deepEqual(app.manualEdits.unsavedStages(), ['segmentation'], 'a drawing with strokes is unsaved');
    assert.equal(app.manualEdits.confirmDiscard('A new segmentation run'), false);
    assert.match(asked[0], /A new segmentation run discards your manual edits to SCT Segmentation/);

    // Declined: the run does not start and the drawing stays open.
    app.inferenceExecutor.runInference = async () => assert.fail('the run must not start');
    await app.runSegmentation();
    assert.equal(editor().session.state, 'editing');

    await editor().apply();
    await until(() => app.manualEdits.editingStage === null);
    const result = app.inferenceExecutor.getResult('segmentation');
    assert.deepEqual(app.manualEdits.unsavedStages(), ['segmentation'], 'an applied edit not downloaded is unsaved');
    result.manualEdit.downloaded = true;
    assert.equal(app.manualEdits.confirmDiscard('A new segmentation run'), true, 'a downloaded edit is saved');
  } finally {
    delete globalThis.confirm;
  }
});

test('an edit parks and restores with its image and shows in Compare', async () => {
  const { app, nv } = makeApp();
  await deliverResults(app);
  await openEditor(app, 'SCT Segmentation');
  nv.paint(7, 1);
  await editor().apply();
  await until(() => app.manualEdits.editingStage === null);
  const edited = app.inferenceExecutor.getResult('segmentation');

  const store = new SessionResultStore();
  store.park('a', snapshotSessionResults(app.inferenceExecutor));
  app.inferenceExecutor.clearResults();
  assert.deepEqual(SctManualEdits.unsavedInSnapshot(store.peek('a'), 'a.nii'), ['SCT Segmentation of a.nii'], 'a parked image names its unsaved edits');
  assert.deepEqual(app.getOverlayEntries(store.peek('a').results).map(entry => [entry.stage, entry.file.name]), [
    ['segmentation', 'lesion_sci_t2_segmentation_edited.nii'],
    ['lesion', 'lesion_sci_t2_lesion.nii'],
  ], 'Compare panels draw the parked image\'s edited stage');
  restoreSessionResults(app.inferenceExecutor, store.unpark('a'));
  const back = app.inferenceExecutor.getResult('segmentation');
  assert.equal(back.file, edited.file, 'the edited mask comes back with its image');
  assert.equal(back.manualEdit.original.file.name, 'lesion_sci_t2_segmentation.nii', 'with its provenance');
});

test('edited file names keep the model output name and its compression', () => {
  assert.equal(editedFileName('spinalcord_segmentation.nii'), 'spinalcord_segmentation_edited.nii');
  assert.equal(editedFileName('spinalcord_segmentation_edited.nii'), 'spinalcord_segmentation_edited.nii', 'a second edit keeps one suffix');
  assert.equal(editedFileName('lesion.nii.gz'), 'lesion_edited.nii.gz');
});
