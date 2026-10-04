#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createNiftiHeaderFromVolume, createUint8Nifti, parseNiftiHeader } from '@neurodesk/webapp-components/file-io';

const dom = new JSDOM(`<!DOCTYPE html>
<main class="app-main"><div class="viewer-toolbar"></div><div class="viewer-canvas-wrapper"></div></main>
<div id="stageButtons"></div>
<input type="checkbox" id="inputVisibilityToggle" checked>`, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;

const { SpinalCordToolboxApp } = await import('../web/js/spinalcordtoolbox-app.js');
const { SctPipeline } = await import('../web/js/controllers/SctPipeline.js');

const DIMS = [3, 4, 3, 2, 1, 1, 1, 1];

function maskBytes(values) {
  const labels = new Uint8Array(24);
  labels.set(values);
  return createUint8Nifti(labels, createNiftiHeaderFromVolume({ hdr: { dims: DIMS } }));
}

function fakeNv() {
  return {
    volumes: [],
    drawIsEnabled: false,
    drawing: null,
    async loadDrawing(file) {
      this.drawing = new Uint8Array(await file.arrayBuffer());
      return true;
    },
    createEmptyDrawing() {},
    drawUndo() {},
    closeDrawing() { this.drawing = null; },
    async setVolume(index, { opacity }) { this.volumes[index].opacity = opacity; },
    async saveDrawing() { return this.drawing.slice(); },
  };
}

function makeApp() {
  const app = Object.create(SpinalCordToolboxApp.prototype);
  const nv = fakeNv();
  const stacks = [];
  const status = [];
  app.nv = nv;
  app.viewerAvailable = true;
  app.viewerController = {
    isAvailable: () => true,
    isCurrentVolumeStack: (entries) => stacks.length > 0 && entries.length === stacks.at(-1).length && entries.every((entry, index) => {
      const previous = stacks.at(-1)[index];
      return entry.file === previous.file && entry.stage === previous.stage && entry.opacity === previous.opacity;
    }),
    async loadVolumeStack(entries) {
      stacks.push(entries);
      nv.volumes = entries.map(entry => ({ opacity: entry.opacity ?? 1, hdr: parseNiftiHeader(maskBytes([])) }));
    },
    clearVolumes() {
      stacks.length = 0;
      nv.volumes = [];
    },
    loadBaseVolume() {},
    registerSctColormap() {},
  };
  app.progress = {
    reset: (text) => status.push(['reset', text]),
    end: (text, options) => status.push(['end', text, options]),
    begin: (text) => status.push(['begin', text]),
    setCancellable() {},
  };
  app.console = { log() {}, clear() {} };
  app.inputFile = new File([maskBytes([])], 't2.nii');
  app.currentResultTab = 'input';
  app._viewerMode = 'single';
  app._editStage = null;
  app._overlaySliderValue = 0.7;
  app._renderViewerPromise = Promise.resolve();
  app.resetStageVisibility();
  app.applyDefaultBaseColormap = () => {};
  app.syncWindowControls = () => {};
  app.applyAutoContrast = () => {};
  app.updateViewerInfo = () => {};
  app.inferenceExecutor = new SctPipeline({ onStageData: (data) => app.handleStageData(data) });
  app.setupMaskEditor();
  return { app, nv, status };
}

async function deliverResults(app) {
  app.inferenceExecutor.handleStageData({ stage: 'segmentation', data: maskBytes([1, 1]), taskId: 'lesion_sci_t2' });
  app.inferenceExecutor.handleStageData({ stage: 'lesion', data: maskBytes([0, 1]), taskId: 'lesion_sci_t2' });
  app.inferenceExecutor.handleStageData({ stage: 'lesion_metrics', kind: 'metrics', csv: 'lesion_id\n1\n', rows: [], summary: {} });
  await until(() => document.querySelectorAll('#stageButtons .volume-toggle').length === 3);
  await app.renderViewerVolumes();
}

function rows() {
  return [...document.querySelectorAll('#stageButtons .volume-toggle')].map(row => ({
    label: row.querySelector('.stage-label').textContent,
    edit: row.querySelector('.nd-edit-btn'),
  }));
}

function editButton(label) {
  return rows().find(row => row.label.startsWith(label)).edit;
}

async function until(condition) {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition(), 'condition never held');
}

function editor() {
  return document.querySelector('nd-mask-editor');
}

function editorButton(text) {
  return [...editor().querySelectorAll('button')].find(button => button.textContent === text);
}

test.afterEach(() => {
  editor()?.remove();
  document.getElementById('stageButtons').replaceChildren();
});

test('label-mask results are editable and only their rows offer Edit', async () => {
  const { app } = makeApp();
  await deliverResults(app);
  assert.equal(app.inferenceExecutor.getResult('segmentation').editable, true);
  assert.equal(app.inferenceExecutor.getResult('lesion').editable, true);
  assert.equal(app.inferenceExecutor.getResult('lesion_metrics').editable, undefined, 'statistics are not editable');
  assert.deepEqual(rows().map(row => [row.label, Boolean(row.edit)]), [
    ['Input', false],
    ['SCT Segmentation', true],
    ['SCI Lesion', true],
  ]);
  const edit = editButton('SCI Lesion');
  assert.equal(edit.title, 'Edit in the viewer');
  assert.equal(edit.nextElementSibling.className, 'download-btn', 'Edit sits between the label and Download');
  assert.equal(document.querySelector('main.app-main > .viewer-toolbar').nextElementSibling, editor(), 'the editor sits under the viewer toolbar');
});

test('Apply replaces the result file, marks it edited and Download returns the edit', async () => {
  const { app, nv, status } = makeApp();
  await deliverResults(app);
  const original = app.inferenceExecutor.getResult('lesion').file;
  editButton('SCI Lesion').click();
  await until(() => editor().session.state === 'editing');
  assert.equal(nv.volumes[2].opacity, 0, 'the lesion overlay (volume 2) is hidden under the drawing');
  assert.ok(rows().slice(1).every(row => row.edit.disabled), 'every Edit is disabled during a session');
  assert.deepEqual(status.at(-1), ['reset', 'Editing SCI Lesion. Left-drag paints; Apply keeps the changes.']);

  nv.drawing[352] = 7;
  editorButton('Apply').click();
  await until(() => editor().session.state === 'idle');
  assert.ok(rows().some(row => row.label === 'SCI Lesion (edited)'));
  const result = app.inferenceExecutor.getResult('lesion');
  assert.equal(result.edited, true);
  assert.notEqual(result.file, original);
  assert.equal(result.file.name, original.name);
  assert.equal(result.original, original);
  assert.equal(new Uint8Array(await result.file.arrayBuffer())[352], 7, 'the result holds the edited voxels');
  assert.deepEqual(status.at(-1), ['reset', 'Ready']);
  assert.ok(rows().slice(1).every(row => row.edit.disabled === false), 'Edit is enabled again after Apply');
  assert.ok(rows().some(row => row.label === 'SCT Segmentation'), 'the other result is untouched');

  const downloaded = [];
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    downloaded.push(blob);
    return 'blob:download';
  };
  try {
    app.inferenceExecutor.downloadStage('lesion');
  } finally {
    URL.createObjectURL = createObjectURL;
  }
  assert.deepEqual(downloaded, [result.file]);
});

test('Edit stays disabled until Apply finishes reloading the edited viewer stack', async () => {
  const { app } = makeApp();
  await deliverResults(app);
  await app.editStage('lesion');
  let release;
  let reloading = false;
  const pendingLoad = new Promise(resolve => { release = resolve; });
  const loadVolumeStack = app.viewerController.loadVolumeStack;
  app.viewerController.loadVolumeStack = async (entries) => {
    reloading = true;
    await pendingLoad;
    await loadVolumeStack(entries);
  };
  const applying = editor().apply();
  try {
    await until(() => reloading);
    assert.equal(editor().session.state, 'applying');
    assert.ok(rows().slice(1).every(row => row.edit.disabled), 'Edit stays disabled while the edited stack loads');
  } finally {
    release();
    await applying;
  }
  assert.equal(editor().session.state, 'idle');
  assert.ok(rows().slice(1).every(row => !row.edit.disabled), 'Edit is enabled after Apply finishes');
});

test('Cancel leaves the result and its label unchanged', async () => {
  const { app } = makeApp();
  await deliverResults(app);
  const original = app.inferenceExecutor.getResult('segmentation').file;
  editButton('SCT Segmentation').click();
  await until(() => editor().session.state === 'editing');
  editorButton('Cancel').click();
  await until(() => editButton('SCT Segmentation').disabled === false);
  assert.equal(editor().session.state, 'idle');
  assert.equal(app.inferenceExecutor.getResult('segmentation').file, original);
  assert.equal(app.inferenceExecutor.getResult('segmentation').edited, undefined);
  assert.ok(rows().every(row => !row.label.includes('(edited)')));
});

for (const [name, reset] of [
  ['a new run', async (app) => {
    app.inferenceExecutor.runInference = async () => {};
    await app.runSegmentation();
  }],
  ['Clear results', (app) => app.clearResults()],
  ['a reset for a new input', (app) => app.resetAllSteps()],
  ['hiding the edited overlay', (app) => app.toggleStageVisibility('lesion', false)],
]) {
  test(`${name} closes an open edit session first`, async () => {
    const { app, nv } = makeApp();
    await deliverResults(app);
    editButton('SCI Lesion').click();
    await until(() => editor().session.state === 'editing');
    await reset(app);
    assert.equal(editor().session.state, 'idle');
    assert.equal(nv.drawing, null, 'the drawing is discarded');
    assert.equal(app._editStage, null);
  });
}
