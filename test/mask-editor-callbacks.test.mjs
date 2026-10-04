import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createMaskEditor } from '../packages/components/src/elements/mask-editor.js';
import { createFloat32Nifti, createNiftiHeaderFromVolume } from '../packages/components/src/file-io/NiftiUtils.js';
import { editedSegmentation } from '../apps/musclemap/web/js/app/segmentation-edit.js';
import { replaceWithEdit, stageLabel } from '../apps/seedseg/web/js/app/mask-edit.js';
import * as resultDisplay from '../apps/vesselboost/web/js/modules/ui/result-display.js';

const noop = () => {};
const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const hdr = { affine, sform_code: 1, dims: [3, 2, 2, 2, 1, 1, 1, 1] };
const original = new File([createFloat32Nifti(new Float32Array(8), createNiftiHeaderFromVolume({ hdr }))], 'mask.nii');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function settles(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function appPrototype(id, name, document) {
  const source = await readFile(new URL(`../apps/${id}/web/js/${id}-app.js`, import.meta.url), 'utf8');
  const start = source.indexOf(`class ${name} {`);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const declaration = source.slice(start, end).replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  return vm.runInNewContext(`${declaration}\n${name}.prototype`, {
    document, File, Config: { STAGE_NAMES: {} }, editedSegmentation, replaceWithEdit, stageLabel,
    getLabelsForLabelSpace: () => null, ...resultDisplay,
  });
}

const apps = [
  { id: 'musclemap', name: 'MuscleMapApp', callback: 'applySegmentationEdit', show: 'showSegmentationSource' },
  { id: 'seedseg', name: 'SeedSegApp', callback: 'onMaskApplied', show: 'showResult' },
  { id: 'vesselboost', name: 'VesselBoostApp', callback: 'onMaskApplied', show: 'renderVisibleResults' },
  { id: 'spinalcordtoolbox', name: 'SpinalCordToolboxApp', callback: 'applyMaskEdit', show: 'renderViewerVolumes' },
];

async function setup(spec, t) {
  const { window } = new JSDOM('<div id="viewer"></div>');
  t.after(() => window.close());
  const app = Object.create(await appPrototype(spec.id, spec.name, window.document));
  const stage = spec.id === 'seedseg' ? 'consensus' : 'segmentation';
  const rendered = deferred();
  const renderDone = deferred();
  const loads = [];
  const load = async file => { loads.push(file); rendered.resolve(); await renderDone.promise; return true; };
  const result = { id: stage, file: original, baseFile: original, label: 'Mask', type: 'pipeline' };
  const results = { [stage]: result };
  Object.assign(app, {
    inputFile: original, currentResultTab: 'input', segmentationResults: [result],
    resultStageVisibility: { [stage]: true }, viewerLayerVisibility: {},
    _inputVisible: true, _segmentationVisible: true, _overlaySliderValue: 0.6,
    _renderViewerPromise: Promise.resolve(),
    inferenceExecutor: {
      results,
      getResult: key => results[key], getResults: () => results, getStageOrder: () => [stage],
      replaceWithEdit: (key, file, old) => replaceWithEdit(app.inferenceExecutor, key, file, old),
    },
    viewerController: {
      showResultAsOverlay: (_base, file) => load(file),
      loadVolumeStack: stack => load(stack.at(-1).file),
      isCurrentVolumeStack: () => false,
    },
    isViewerAvailable: () => true, isCompareMode: () => false,
    getCurrentBaseFile: () => original, getVisibleOverlayStages: () => [stage],
    isStageVisible: () => true, getOverlayColormapId: () => 'red',
    updateOutput: noop, endSegmentationEdit: noop, onMaskEditClosed: noop, endMaskEdit: noop,
    progress: { setText: noop }, rebuildResultsList: noop, refreshViewerLayerControls: noop,
    applyVolumeVisibility: noop, syncWindowControls: noop, clearMetricsIfSourceChanged: noop,
    muscleLegend: { hide: noop }, updateViewerInfo: noop, updateOverlayControlState: noop,
    updateResultButtonStates: noop, applyDefaultBaseColormap: noop, applyAutoContrast: noop,
  });
  app.getSegmentationSourceById = id => app.segmentationResults.find(item => item.id === id);
  const nv = {
    volumes: [{ hdr, opacity: 1 }, { opacity: 0.6 }],
    async loadDrawing(file) { this.drawing = new Uint8Array(await file.arrayBuffer()); return true; },
    async saveDrawing() { return this.drawing.slice(); },
    closeDrawing: noop, async setVolume() {},
  };
  app.maskEditor = createMaskEditor({
    nv, doc: window.document,
    onApply: (key, file, { original: old }) => app[spec.callback](key, file, old),
  });
  window.document.getElementById('viewer').append(app.maskEditor);
  return { app, stage, loads, rendered, renderDone };
}

for (const spec of apps) {
  test(`${spec.id} Apply renders the edited mask and completes without cancelling itself`, async t => {
    const { app, stage, loads, rendered, renderDone } = await setup(spec, t);
    assert.equal(await app.maskEditor.start({ stage, file: original, overlayIndex: 1 }), true);
    const applying = app.maskEditor.apply();
    await settles(rendered.promise, `${spec.id} Apply waits on its own cancellation before rendering`);
    let cancelled = false;
    const cancelling = app.maskEditor.cancel().then(() => { cancelled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, false, 'external cancellation must wait for the callback viewer load');
    renderDone.resolve();
    const edited = await settles(applying, `${spec.id} Apply never completed`);
    await cancelling;
    assert.ok(edited instanceof File);
    assert.equal(app.maskEditor.session.state, 'idle');
    assert.equal(loads.length, 1);
    assert.deepEqual(new Uint8Array(await loads[0].arrayBuffer()), new Uint8Array(await edited.arrayBuffer()));
  });

  test(`${spec.id} a public viewer change waits for editor cancellation`, async t => {
    const { app, stage, loads, renderDone } = await setup(spec, t);
    const cancellation = deferred();
    app.maskEditor = { cancel: () => cancellation.promise };
    const showing = app[spec.show](stage);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loads.length, 0);
    cancellation.resolve();
    renderDone.resolve();
    await showing;
    assert.equal(loads.length, 1);
  });
}

for (const id of ['seedseg', 'vesselboost', 'musclemap']) {
  test(`${id} keeps Edit disabled until the shared editor completes cancellation`, async t => {
    const spec = apps.find(app => app.id === id);
    const { app, stage } = await setup(spec, t);
    const document = app.maskEditor.ownerDocument;
    const controls = document.createElement('div');
    controls.id = 'stageButtons';
    const button = document.createElement('button');
    button.className = 'nd-edit-btn';
    button.disabled = true;
    controls.append(button);
    document.body.append(controls);
    const callbackDone = deferred();
    const callbackEntered = deferred();
    const enable = id === 'musclemap' ? 'syncEditButtons' : 'setEditButtonsEnabled';
    const source = await readFile(new URL(`../apps/${id}/web/js/${id}-app.js`, import.meta.url), 'utf8');
    const listener = source.split('\n').find(line => line.includes("addEventListener('nd-mask-edit-end'"));
    assert.ok(listener, 'the app must refresh its buttons when the session ends');
    vm.runInNewContext(`(function () { ${listener} }).call(app)`, { app });
    app.maskEditor.configure({
      nv: {
        volumes: [{ hdr }],
        async loadDrawing(file) { this.drawing = new Uint8Array(await file.arrayBuffer()); return true; },
        async saveDrawing() { return this.drawing.slice(); },
        closeDrawing: noop,
      },
      onCancel: async () => {
        app[enable](true);
        callbackEntered.resolve();
        await callbackDone.promise;
      },
    });
    await app.maskEditor.start({ stage, file: original });
    const cancelling = app.maskEditor.cancel();
    await callbackEntered.promise;
    assert.equal(button.disabled, true, 'app button updates cannot release a pending edit');
    callbackDone.resolve();
    await cancelling;
    assert.equal(button.disabled, false, 'completion must restore the next Edit action');
  });
}
