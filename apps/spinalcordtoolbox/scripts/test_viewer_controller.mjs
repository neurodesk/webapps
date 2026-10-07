#!/usr/bin/env node

// SctViewer is the one owner of what the SCT viewer shows. These tests drive
// it against a fake NiiVue 1.0 instance and a fake FreeBrowse mount module, so
// they pin the calls the app makes (loadVolumes / addVolume / removeVolume /
// setVolume / setColormapLabel) without a browser.

import assert from 'node:assert/strict';
import { DEFAULT_OVERLAY_OPACITY, SctViewer } from '../web/js/modules/sct-viewer.js';

const SLICE_TYPE = { AXIAL: 0, CORONAL: 1, SAGITTAL: 2, MULTIPLANAR: 3, RENDER: 4 };
const SHOW_RENDER = { NEVER: 0, ALWAYS: 1, AUTO: 2 };
const DRAG_MODE = { contrast: 1, pan: 3 };

let nextVolumeId = 1;

class FakeNiiVue extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = options;
    this.volumes = [];
    this.backend = 'webgl2';
    this.sliceType = SLICE_TYPE.MULTIPLANAR;
    this.showRender = SHOW_RENDER.ALWAYS;
    this.secondaryDragMode = DRAG_MODE.contrast;
    this.calls = [];
    this.destroyed = false;
  }

  makeVolume(options) {
    return { id: `volume-${nextVolumeId++}`, name: options.name, url: options.url, opacity: options.opacity ?? 1, colormapLabel: null };
  }

  async attachToCanvas(canvas) {
    this.canvas = canvas;
    return this;
  }

  async loadVolumes(list) {
    this.calls.push(['loadVolumes', list.map(item => item.name)]);
    this.volumes = list.map(item => this.makeVolume(item));
    return this;
  }

  async addVolume(options) {
    this.calls.push(['addVolume', options.name]);
    this.volumes.push(this.makeVolume(options));
    return this;
  }

  async removeVolume(index) {
    this.calls.push(['removeVolume', index]);
    const [volume] = this.volumes.splice(index, 1);
    this.dispatchEvent(new CustomEvent('volumeRemoved', { detail: { volume } }));
  }

  async removeAllVolumes() {
    this.calls.push(['removeAllVolumes']);
    this.volumes = [];
  }

  async setVolume(index, changes) {
    this.calls.push(['setVolume', index, changes]);
    Object.assign(this.volumes[index], changes);
    this.dispatchEvent(new CustomEvent('volumeUpdated', { detail: { volume: this.volumes[index], changes } }));
  }

  async setColormapLabel(index, colormap) {
    this.calls.push(['setColormapLabel', index, colormap.labels]);
    this.volumes[index].colormapLabel = colormap;
  }

  async saveBitmap(filename) {
    this.calls.push(['saveBitmap', filename]);
    return true;
  }

  async saveVolume(options) {
    this.calls.push(['saveVolume', options]);
    return true;
  }

  drawScene() {
    this.draws = (this.draws || 0) + 1;
  }

  // NiiVue's own sync. `undefined` clears it.
  broadcastTo(targets, opts) {
    this.calls.push(['broadcastTo', targets ? targets.length : 0]);
    this.syncTargets = targets || [];
    this.syncOpts = targets ? opts : null;
  }

  destroy() {
    this.destroyed = true;
  }

  callsNamed(name) {
    return this.calls.filter(call => call[0] === name);
  }
}

function makeModule({ ready, created = [] } = {}) {
  const mounts = [];
  return {
    mounts,
    created,
    SLICE_TYPE,
    SHOW_RENDER,
    DRAG_MODE,
    NiiVue: class extends FakeNiiVue {
      constructor(options) {
        super(options);
        created.push(this);
      }
    },
    mountViewer(element, options, embed) {
      const nv = new FakeNiiVue(options);
      const handle = {
        nv,
        ready: ready ? ready(nv) : Promise.resolve(nv),
        destroyed: false,
        destroy() { this.destroyed = true; }
      };
      mounts.push({ element, options, embed, handle });
      return handle;
    }
  };
}

const makeFile = name => new File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
const cordColormap = () => ({ R: [0, 68], G: [0, 128], B: [0, 255], A: [0, 255], I: [0, 1], labels: ['Background', 'Spinal cord'] });
const lesionColormap = () => ({ R: [0, 255], G: [0, 0], B: [0, 0], A: [0, 255], I: [0, 1], labels: ['Background', 'Lesion'] });

async function mountViewer(overrides = {}) {
  const module = overrides.module || makeModule();
  const stageEvents = [];
  const locations = [];
  const viewer = await SctViewer.mount({
    element: { id: 'freebrowseViewer' },
    niivueOptions: { backend: 'webgl2', isDragDropEnabled: false },
    canvasLabel: 'Spinal cord image viewer',
    loadModule: async () => module,
    onLocationChange: data => locations.push(data),
    onStageVisibilityChange: (stage, visible) => stageEvents.push([stage, visible]),
    ...overrides
  });
  return { viewer, module, nv: viewer.nv, stageEvents, locations };
}

// ---------------------------------------------------------------------------
// Mounting: FreeBrowse is mounted through the shared helper and exposed.
// ---------------------------------------------------------------------------
{
  const { viewer, module, nv } = await mountViewer();
  assert.equal(module.mounts.length, 1, 'the shared mountViewer helper is called once');
  assert.deepEqual(module.mounts[0].options, { backend: 'webgl2', isDragDropEnabled: false }, 'NiiVue options reach the mount');
  assert.equal(module.mounts[0].embed.canvasLabel, 'Spinal cord image viewer', 'the canvas gets an accessible name');
  assert.equal(viewer.handle, module.mounts[0].handle, 'the mount handle is exposed for later integrations (Drawing)');
  assert.equal(viewer.nv, module.mounts[0].handle.nv, 'the NiiVue instance is exposed');
  assert.equal(nv.showRender, SHOW_RENDER.NEVER, 'SCT opens in the three-plane layout without the 3D tile');
  assert.equal(viewer.isAvailable(), true);
}

// A rejected canvas attachment (no WebGL2) rejects mount() and releases FreeBrowse.
{
  const module = makeModule({ ready: () => Promise.reject(new Error('WebGL2 is not supported')) });
  await assert.rejects(() => mountViewer({ module }), /WebGL2 is not supported/);
  assert.equal(module.mounts[0].handle.destroyed, true, 'a failed mount is destroyed so the 2D fallback owns the panel');
}

// A NiiVue that resolves without a rendering backend is treated as a failure.
{
  const module = makeModule({ ready: nv => { nv.backend = undefined; return Promise.resolve(nv); } });
  await assert.rejects(() => mountViewer({ module }), /WebGL2 context unavailable/);
  assert.equal(module.mounts[0].handle.destroyed, true);
}

// A bundle that cannot be loaded rejects too (the app then shows the fallback).
await assert.rejects(
  () => SctViewer.mount({ element: {}, loadModule: async () => { throw new Error('bundle missing'); } }),
  /bundle missing/
);

// ---------------------------------------------------------------------------
// showVolumes: base + label overlays, with label colormaps and stage tracking.
// ---------------------------------------------------------------------------
{
  const { viewer, nv, stageEvents } = await mountViewer();
  const input = makeFile('input.nii');
  const seg = makeFile('seg.nii');
  const lesion = makeFile('lesion.nii');
  const segColormap = cordColormap();
  const stack = () => [
    { file: input, stage: 'input', visible: true },
    { file: seg, stage: 'segmentation', visible: true, colormapKey: 'sct-spinalcord', labelColormap: segColormap },
    { file: lesion, stage: 'lesion', visible: true, colormapKey: 'sct-lesion', labelColormap: lesionColormap() }
  ];

  assert.equal(await viewer.showVolumes(stack()), true);
  assert.deepEqual(nv.callsNamed('loadVolumes'), [['loadVolumes', ['input.nii']]], 'the base loads alone');
  assert.deepEqual(nv.callsNamed('addVolume').map(call => call[1]), ['seg.nii', 'lesion.nii'], 'each overlay is added in order');
  assert.equal(nv.volumes[0].url, input, 'files are handed to NiiVue directly, without object URLs');
  assert.deepEqual(nv.volumes.map(volume => volume.opacity), [1, DEFAULT_OVERLAY_OPACITY, DEFAULT_OVERLAY_OPACITY], 'label masks start at the default overlay opacity');
  assert.equal(nv.volumes[0].colormapLabel, null, 'the input keeps its intensity colormap');
  assert.deepEqual(nv.volumes[1].colormapLabel.labels, ['Background', 'Spinal cord'], 'label masks get their label colormap');
  assert.deepEqual(nv.volumes[2].colormapLabel.labels, ['Background', 'Lesion']);
  assert.equal(viewer.getVolumeIndexForStage('input'), 0);
  assert.equal(viewer.getVolumeIndexForStage('segmentation'), 1);
  assert.equal(viewer.getVolumeIndexForStage('lesion'), 2);
  assert.equal(viewer.getVolumeIndexForStage('spine_discs'), null);

  // NiiVue clamps the colormap's index array in place; the app's copy must survive.
  assert.notEqual(nv.volumes[1].colormapLabel.I, segColormap.I);
  assert.deepEqual(nv.volumes[1].colormapLabel.I, segColormap.I);

  // An identical request touches nothing: zoom, pan and window are preserved.
  const before = nv.calls.length;
  await viewer.showVolumes(stack());
  assert.equal(nv.calls.length, before, 'an unchanged stack makes no NiiVue calls');

  // Eye toggle: visibility is opacity on the loaded volume, never a reload.
  const hidden = stack();
  hidden[1].visible = false;
  await viewer.showVolumes(hidden);
  assert.deepEqual(nv.calls.slice(before), [['setVolume', 1, { opacity: 0 }]], 'hiding a stage only changes its opacity');
  assert.equal(nv.volumes.length, 3);
  await viewer.showVolumes(stack());
  assert.equal(nv.volumes[1].opacity, DEFAULT_OVERLAY_OPACITY, 'showing a stage restores its opacity');
  assert.deepEqual(stageEvents, [], 'the viewer does not echo changes the app requested');

  // Hiding the input keeps it loaded as the base, so overlays stay aligned.
  const noInput = stack();
  noInput[0].visible = false;
  await viewer.showVolumes(noInput);
  assert.equal(nv.volumes[0].opacity, 0);
  assert.equal(nv.volumes[0].name, 'input.nii');
  assert.equal(nv.callsNamed('loadVolumes').length, 1, 'hiding the input never reloads it');
  await viewer.showVolumes(stack());

  // A changed overlay reloads only from the first difference upward.
  const lesion2 = makeFile('lesion2.nii');
  const changed = stack();
  changed[2] = { ...changed[2], file: lesion2 };
  const mark = nv.calls.length;
  await viewer.showVolumes(changed);
  assert.deepEqual(nv.calls.slice(mark).map(call => call[0]), ['removeVolume', 'addVolume', 'setColormapLabel']);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['input.nii', 'seg.nii', 'lesion2.nii']);
  assert.equal(nv.callsNamed('loadVolumes').length, 1, 'the base is not reloaded when only an overlay changes');

  // The same file under another label set is a different entry.
  const recolored = stack();
  recolored[2] = { ...changed[2] };
  recolored[1] = { ...recolored[1], colormapKey: 'sct-graymatter' };
  await viewer.showVolumes(recolored);
  assert.equal(nv.callsNamed('loadVolumes').length, 1);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['input.nii', 'seg.nii', 'lesion2.nii']);

  // A new run drops the overlays but keeps the loaded input.
  await viewer.showVolumes([{ file: input, stage: 'input', visible: true }]);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['input.nii']);
  assert.equal(nv.callsNamed('loadVolumes').length, 1);

  // A different input reloads the base.
  const other = makeFile('other.nii');
  await viewer.showVolumes([{ file: other, stage: 'input', visible: true }]);
  assert.equal(nv.callsNamed('loadVolumes').length, 2);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['other.nii']);

  // An empty stack clears the viewer.
  await viewer.showVolumes([]);
  assert.equal(nv.volumes.length, 0);
  assert.equal(viewer.getVolumeIndexForStage('input'), null);
}

// Requests are applied in order even when issued without awaiting.
{
  const { viewer, nv } = await mountViewer();
  const input = makeFile('input.nii');
  const seg = makeFile('seg.nii');
  const first = viewer.showVolumes([{ file: input, stage: 'input', visible: true }]);
  const second = viewer.showVolumes([
    { file: input, stage: 'input', visible: true },
    { file: seg, stage: 'segmentation', visible: true, colormapKey: 'sct-spinalcord', labelColormap: cordColormap() }
  ]);
  await Promise.all([first, second]);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['input.nii', 'seg.nii']);
  assert.equal(nv.callsNamed('loadVolumes').length, 1, 'a late base load cannot wipe an overlay');
}

// A NiiVue failure is reported, not thrown, and later requests still work.
{
  const outputs = [];
  const { viewer, nv } = await mountViewer({ updateOutput: message => outputs.push(message) });
  const loadVolumes = nv.loadVolumes.bind(nv);
  nv.loadVolumes = async () => { throw new Error('bad header'); };
  assert.equal(await viewer.showVolumes([{ file: makeFile('broken.nii'), stage: 'input', visible: true }]), false);
  assert.match(outputs[0], /bad header/);
  nv.loadVolumes = loadVolumes;
  assert.equal(await viewer.showVolumes([{ file: makeFile('ok.nii'), stage: 'input', visible: true }]), true);
}

// ---------------------------------------------------------------------------
// FreeBrowse's own controls (eye, opacity slider, delete) report back.
// ---------------------------------------------------------------------------
{
  const { viewer, nv, stageEvents, locations } = await mountViewer();
  const input = makeFile('input.nii');
  const seg = makeFile('seg.nii');
  const stack = [
    { file: input, stage: 'input', visible: true },
    { file: seg, stage: 'segmentation', visible: true, colormapKey: 'sct-spinalcord', labelColormap: cordColormap() }
  ];
  await viewer.showVolumes(stack);

  await nv.setVolume(1, { opacity: 0.3 });
  assert.deepEqual(stageEvents.at(-1), ['segmentation', true]);
  await nv.setVolume(1, { opacity: 0 });
  assert.deepEqual(stageEvents.at(-1), ['segmentation', false], 'FreeBrowse hiding a stage reaches the app');
  await viewer.showVolumes(stack);
  assert.equal(nv.volumes[1].opacity, 0.3, 'the opacity the user chose in FreeBrowse survives an eye toggle');

  const count = stageEvents.length;
  await nv.setVolume(0, { colormap: 'Hot' });
  assert.equal(stageEvents.length, count, 'non-opacity changes are not visibility changes');

  await nv.removeVolume(1);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(stageEvents.at(-1), ['segmentation', false], 'deleting a volume in FreeBrowse hides its stage');
  await viewer.showVolumes(stack);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['input.nii', 'seg.nii'], 'the stage is reloaded when shown again');

  // A volume FreeBrowse added is not ours: it is removed and the base image is kept.
  nv.volumes.splice(1, 0, nv.makeVolume({ name: 'user.nii' }));
  await viewer.showVolumes(stack);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['input.nii', 'seg.nii']);

  nv.dispatchEvent(new CustomEvent('locationChange', { detail: { string: '1 2 3', values: [] } }));
  assert.deepEqual(locations, [{ string: '1 2 3', values: [] }], 'crosshair readouts are forwarded');
}

// ---------------------------------------------------------------------------
// Export helpers go through NiiVue 1.0's own writers.
// ---------------------------------------------------------------------------
{
  const { viewer, nv } = await mountViewer();
  await viewer.saveScreenshot('scan_screenshot.png');
  await viewer.downloadVolume(0, 'scan.nii');
  assert.deepEqual(nv.callsNamed('saveBitmap'), [['saveBitmap', 'scan_screenshot.png']]);
  assert.deepEqual(nv.callsNamed('saveVolume'), [['saveVolume', { filename: 'scan.nii', volumeByIndex: 0 }]]);
}

// ---------------------------------------------------------------------------
// Comparison grid: one plain NiiVue canvas per loaded session, kept across
// updates, each with its own overlays, linked through NiiVue's broadcastTo.
// ---------------------------------------------------------------------------
{
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><body><div id="grid"></div></body>').window;
  const originalDocument = globalThis.document;
  globalThis.document = window.document;

  try {
    const created = [];
    const activations = [];
    const comparisonLocations = [];
    const { viewer, nv } = await mountViewer({
      module: makeModule({ created }),
      onComparisonActivate: id => activations.push(id),
      onComparisonLocation: (id, detail) => comparisonLocations.push([id, detail])
    });
    nv.sliceType = SLICE_TYPE.SAGITTAL;
    nv.secondaryDragMode = DRAG_MODE.pan;
    const container = window.document.getElementById('grid');
    const pre = makeFile('pre_op.nii.gz');
    const post = makeFile('post_op.nii.gz');
    const third = makeFile('follow_up.nii.gz');
    const preSeg = makeFile('pre_seg.nii');
    const panel = (id, file, overlays = []) => ({
      id,
      name: file.name,
      entries: [{ file, stage: 'input', visible: true }, ...overlays]
    });
    const cord = file => ({ file, stage: 'segmentation', visible: true, colormapKey: 'sct-spinalcord', labelColormap: cordColormap() });

    // Two sessions, the second active; only the first has a result.
    assert.equal(await viewer.showComparison([
      panel('session-1', pre, [cord(preSeg)]),
      panel('session-2', post)
    ], { container, activeSessionId: 'session-2' }), true);

    const panels = [...container.children];
    assert.equal(container.dataset.count, '2');
    assert.equal(panels.length, 2);
    assert.equal(panels[0].className, 'nd-compare-panel');
    const titles = panels.map(element => element.querySelector('button.nd-compare-title'));
    assert.deepEqual(titles.map(title => title.textContent), ['pre_op.nii.gz', 'post_op.nii.gz · active'], 'each panel is labelled; the active one says so');
    assert.deepEqual(titles.map(title => title.getAttribute('aria-pressed')), ['false', 'true']);
    assert.deepEqual(panels.map(element => element.getAttribute('aria-current')), ['false', 'true']);
    assert.equal(created.length, 2, 'each panel has its own NiiVue instance');
    assert.equal(created[0].canvas.id, 'comparisonCanvas-session-1');
    assert.match(created[0].canvas.getAttribute('aria-label'), /pre_op/);
    assert.deepEqual(created[0].options, { backend: 'webgl2', isDragDropEnabled: false });
    assert.deepEqual(created[0].callsNamed('loadVolumes'), [['loadVolumes', ['pre_op.nii.gz']]]);
    assert.deepEqual(created[0].callsNamed('addVolume'), [['addVolume', 'pre_seg.nii']], 'a panel shows its own session\'s overlays');
    assert.deepEqual(created[0].callsNamed('setColormapLabel'), [['setColormapLabel', 1, ['Background', 'Spinal cord']]], 'with the label colours of the single view');
    assert.deepEqual(created[1].callsNamed('addVolume'), [], 'a session without results shows only its image');
    assert.equal(created[1].sliceType, SLICE_TYPE.SAGITTAL, 'panels start in the main viewer layout');
    assert.equal(created[1].secondaryDragMode, DRAG_MODE.pan, 'panels follow the main viewer drag mode, so zoom works alike');
    assert.equal(created[1].isLegendVisible, false, 'panels leave the label legend to the info bar');
    assert.equal(nv.callsNamed('loadVolumes').length, 0, 'comparison never touches the main viewer stack');

    // Linked by default through NiiVue's own sync, crosshair and all.
    assert.equal(viewer.isComparisonLinked(), true);
    assert.deepEqual(created[0].syncTargets, [created[1]]);
    assert.deepEqual(created[1].syncTargets, [created[0]]);
    assert.deepEqual(created[0].syncOpts, { '2d': true, '3d': true, crosshair: true, sliceType: true });

    // Pointer and keyboard both activate a panel.
    panels[0].dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    titles[0].click();
    assert.deepEqual(activations, ['session-1', 'session-1']);
    created[0].dispatchEvent(new CustomEvent('locationChange', { detail: { string: '1 2 3' } }));
    assert.deepEqual(comparisonLocations, [['session-1', { string: '1 2 3' }]]);

    // A switch of active session, and a new result for the second, keep both
    // canvases: only the changed stack reloads, so zoom and pan survive.
    const postSeg = makeFile('post_seg.nii');
    await viewer.showComparison([
      panel('session-1', pre, [cord(preSeg)]),
      panel('session-2', post, [cord(postSeg)])
    ], { container, activeSessionId: 'session-1' });
    assert.equal(created.length, 2, 'no panel is recreated');
    assert.equal(created[0].callsNamed('loadVolumes').length, 1, 'the unchanged panel is not reloaded');
    assert.deepEqual(created[1].callsNamed('addVolume'), [['addVolume', 'post_seg.nii']], 'a new result is added to its own panel only');
    assert.deepEqual([...container.children].map(element => element.getAttribute('aria-current')), ['true', 'false'], 'the active marker follows the session');

    // Eye toggles change opacity in place.
    await viewer.showComparison([
      panel('session-1', pre, [{ ...cord(preSeg), visible: false }]),
      panel('session-2', post, [{ ...cord(postSeg), visible: false }])
    ], { container, activeSessionId: 'session-1' });
    assert.deepEqual(created[0].callsNamed('setVolume').at(-1), ['setVolume', 1, { opacity: 0 }]);
    assert.deepEqual(created[1].callsNamed('setVolume').at(-1), ['setVolume', 1, { opacity: 0 }]);

    // Unlinking clears NiiVue's sync on every panel; linking restores it and
    // lets the active panel lead.
    viewer.setComparisonLinked(false);
    assert.equal(viewer.isComparisonLinked(), false);
    assert.deepEqual(created.map(instance => instance.syncTargets), [[], []]);
    const drawsBefore = created[0].draws || 0;
    viewer.setComparisonLinked(true);
    assert.deepEqual(created[0].syncTargets, [created[1]]);
    assert.equal(created[0].draws, drawsBefore + 1, 'the active panel redraws so the others align to it');

    // Layout applies to every panel.
    viewer.setComparisonSliceType(SLICE_TYPE.AXIAL);
    assert.deepEqual(created.map(instance => instance.sliceType), [SLICE_TYPE.AXIAL, SLICE_TYPE.AXIAL]);
    assert.equal(viewer.getComparisonSliceType(), SLICE_TYPE.AXIAL);

    // Three sessions with a limit of two: the active session is always shown,
    // and a session that drops out releases its canvas.
    await viewer.showComparison([
      panel('session-1', pre),
      panel('session-2', post),
      panel('session-3', third)
    ], { container, activeSessionId: 'session-3', maxPanels: 2 });
    assert.equal(container.dataset.count, '2');
    assert.deepEqual([...container.children].map(element => element.dataset.sessionId), ['session-1', 'session-3']);
    assert.equal(created[1].destroyed, true, 'a dropped panel releases its WebGL context');
    assert.equal(created[2].sliceType, SLICE_TYPE.AXIAL, 'a new panel joins in the current comparison layout');
    assert.deepEqual(created[0].syncTargets, [created[2]], 'links are rebuilt over the panels now shown');
    assert.equal(viewer.getComparisonViewerCount(), 2);

    assert.deepEqual(await viewer.saveComparisonScreenshot('session-3', 'follow_up.png'), true);
    assert.deepEqual(created[2].callsNamed('saveBitmap'), [['saveBitmap', 'follow_up.png']]);

    viewer.clearComparison(container);
    assert.equal(viewer.getComparisonViewerCount(), 0);
    assert.equal(container.children.length, 0);
    assert.equal(container.dataset.count, '0');
    assert.equal(created.every(instance => instance.destroyed), true, 'panel viewers release their WebGL contexts');

    assert.equal(await viewer.showComparison([], { container }), false);
    assert.equal(await viewer.showComparison([{ id: 'x', file: pre }], {}), false, 'a missing container is a no-op');

    // A panel whose canvas cannot get a context is removed again and the error surfaces.
    const failing = await mountViewer({ module: makeModule({ created }) });
    const brokenClass = failing.module.NiiVue;
    failing.module.NiiVue = class extends brokenClass {
      async attachToCanvas(canvas) {
        this.canvas = canvas;
        this.backend = null;
        return this;
      }
    };
    await assert.rejects(failing.viewer.showComparison([panel('session-1', pre)], { container }), /WebGL2 context unavailable/);
    assert.equal(failing.viewer.getComparisonViewerCount(), 0);
    assert.equal(container.children.length, 0, 'the failed panel leaves no element behind');

    await viewer.showComparison([{ id: 'session-1', name: pre.name, file: pre }], { container });
    const handle = viewer.handle;
    viewer.destroy();
    assert.equal(handle.destroyed, true, 'destroy releases FreeBrowse');
    assert.equal(created.at(-1).destroyed, true, 'destroy releases comparison viewers');
    assert.equal(viewer.isAvailable(), false);
  } finally {
    globalThis.document = originalDocument;
  }
}

console.log('SctViewer tests passed');
