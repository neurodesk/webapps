#!/usr/bin/env node --no-warnings
// Phase 35: behavior tests for web/js/controllers/ViewerController.js.
//
// The Phase 4 silent-regression bug was: NiiVue 0.68.x's
// `loadVolumes([base, overlay1, ...])` adds the overlay volumes but
// doesn't initialise their cal_min / cal_max / colormap LUT — so binary
// label-mask overlays render invisible. Fix: load the base via
// `loadVolumes([single])`, add overlays via `addVolumeFromUrl()`. This
// test replicates that contract against a fake NiiVue and asserts the
// call shape so a future ViewerController refactor that "simplifies"
// back to the broken pattern fails immediately.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal browser stubs ViewerController doesn't reach into much, but
// loadBaseVolume calls URL.createObjectURL on the input file.
globalThis.URL = {
  createObjectURL: (file) => `blob:fake-${file?.name || 'noname'}`,
  revokeObjectURL: () => {}
};

if (!globalThis.File) {
  globalThis.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || '';
    }
    async arrayBuffer() {
      const first = this.parts?.[0];
      if (first instanceof ArrayBuffer) return first;
      if (ArrayBuffer.isView(first)) {
        return first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength);
      }
      return new ArrayBuffer(0);
    }
  };
}

const { ViewerController } = await import(path.join(ROOT, 'web/js/controllers/ViewerController.js'));
const { MaskDrawingController } = await import(path.join(ROOT, 'web/js/controllers/MaskDrawingController.js'));

// Fake NiiVue that records every call. Mirrors the surface ViewerController
// touches: addColormap, loadVolumes, addVolumeFromUrl, setOpacity,
// setColormap, setSliceType, updateGLVolume, drawScene, removeVolumeByIndex,
// volumes (mutable array), sliceType* constants.
function makeNv() {
  const calls = {
    addColormap: [],
    loadVolumes: [],
    addVolumeFromUrl: [],
    setOpacity: [],
    setColormap: [],
    setSliceType: [],
    updateGLVolume: 0,
    drawScene: 0,
    removeVolumeByIndex: []
  };
  const nv = {
    volumes: [],
    sliceTypeMultiplanar: 0,
    sliceTypeAxial: 1,
    sliceTypeCoronal: 2,
    sliceTypeSagittal: 3,
    sliceTypeRender: 4,
    addColormap(id, data) { calls.addColormap.push({ id, data }); },
    async loadVolumes(entries) {
      calls.loadVolumes.push(entries);
      // Mirror NiiVue: append a fake volume per entry.
      entries.forEach(e => nv.volumes.push({
        id: `vol-${nv.volumes.length}`,
        url: e.url, name: e.name,
        cal_min: 0, cal_max: 1, colormap: 'gray', interpolation: true,
        opacity: e.opacity ?? 1,
        img: new Float32Array([0.5])
      }));
    },
    async addVolumeFromUrl(opts) {
      calls.addVolumeFromUrl.push(opts);
      nv.volumes.push({
        id: `vol-${nv.volumes.length}`,
        url: opts.url, name: opts.name,
        cal_min: 0, cal_max: 1, colormap: opts.colormap || 'gray',
        interpolation: true,
        opacity: opts.opacity ?? 1,
        img: opts.name === 'network.nii'
          ? new Float32Array([-2, 0, 4])
          : new Float32Array([1])
      });
    },
    setOpacity(idx, op) {
      calls.setOpacity.push([idx, op]);
      if (nv.volumes[idx]) nv.volumes[idx].opacity = op;
    },
    setColormap(volId, cm) { calls.setColormap.push([volId, cm]); },
    setSliceType(t) { calls.setSliceType.push(t); },
    updateGLVolume() { calls.updateGLVolume++; },
    drawScene() { calls.drawScene++; },
    removeVolumeByIndex(idx) {
      calls.removeVolumeByIndex.push(idx);
      nv.volumes.splice(idx, 1);
    }
  };
  return { nv, calls };
}

function fakeFile(name) {
  return { name, type: 'application/octet-stream' };
}

// ---- Test 1: loadBaseVolume calls loadVolumes with a single entry ----
// THE Phase 4 regression target: never call loadVolumes([base, overlay, ...]).
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'), { stage: 'structural' });
  assert.equal(calls.loadVolumes.length, 1, 'loadVolumes called once');
  assert.equal(calls.loadVolumes[0].length, 1,
    'Phase 4 regression: loadVolumes MUST be called with a single-entry array');
  assert.equal(calls.loadVolumes[0][0].name, 't1.nii');
  assert.equal(vc.currentBaseFile.name, 't1.nii');
  // Stage tracking maps base to volume index 0.
  assert.equal(vc.volumeStageIndices.get('structural'), 0);
}

// ---- Test 2: loadOverlay uses addVolumeFromUrl, NOT loadVolumes ----
// The other half of the Phase 4 fix.
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'));
  calls.loadVolumes.length = 0;   // reset to verify overlay path doesn't reuse it

  await vc.loadOverlay(fakeFile('lesion.nii'), 'red', 0.5, { stage: 'lesion' });
  assert.equal(calls.loadVolumes.length, 0,
    'overlay load must NOT call loadVolumes (would reset base + lose overlay LUT)');
  assert.equal(calls.addVolumeFromUrl.length, 1,
    'overlay must use addVolumeFromUrl');
  assert.equal(calls.addVolumeFromUrl[0].colormap, 'red');
  assert.equal(calls.addVolumeFromUrl[0].opacity, 0.5);
  // Overlay is now volume index 1; configureSegmentationVolume kicked in.
  assert.equal(nv.volumes.length, 2);
  assert.equal(nv.volumes[1].interpolation, false,
    'binary overlay must have interpolation disabled');
  assert.equal(vc.volumeStageIndices.get('lesion'), 1);
}

// ---- Test 3: loadVolumeStack delegates to base + overlay path ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  const entries = [
    { file: fakeFile('t1.nii'), stage: 'structural' },
    { file: fakeFile('mask1.nii'), colormap: 'red', opacity: 0.5, stage: 'lesion' },
    { file: fakeFile('mask2.nii'), colormap: 'green', opacity: 0.4, stage: 'brainmask' }
  ];
  await vc.loadVolumeStack(entries);
  assert.equal(calls.loadVolumes.length, 1, 'one loadVolumes call (base)');
  assert.equal(calls.loadVolumes[0].length, 1, 'base load is single-entry');
  assert.equal(calls.addVolumeFromUrl.length, 2, 'two overlays via addVolumeFromUrl');
  assert.equal(nv.volumes.length, 3);
}

// ---- Test 4: empty entries -> clearVolumes ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'));
  assert.equal(nv.volumes.length, 1);
  await vc.loadVolumeStack([]);
  assert.equal(nv.volumes.length, 0,
    'loadVolumeStack([]) must clear volumes');
  assert.equal(vc.currentBaseFile, null);
}

// ---- Test 5: clearOverlay removes only the overlay ----
{
  const { nv } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'));
  await vc.loadOverlay(fakeFile('lesion.nii'), 'red', 0.5, { stage: 'lesion' });
  assert.equal(nv.volumes.length, 2);
  vc.clearOverlay();
  assert.equal(nv.volumes.length, 1, 'base remains after clearOverlay');
  assert.equal(vc.currentOverlayFile, null);
}

// ---- Test 6: setViewType maps strings to NiiVue slice constants ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  vc.setViewType('axial');
  vc.setViewType('coronal');
  vc.setViewType('render');
  assert.deepEqual(calls.setSliceType, [1, 2, 4]);
  // Unknown type: silent no-op (keeps app robust to typos).
  vc.setViewType('madeup');
  assert.equal(calls.setSliceType.length, 3);
}

// ---- Test 7: registerSctColormap installs once + survives second call ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  vc.registerSctColormap({ R: [0], G: [0], B: [0], A: [0] }, 'lnm-yeo7');
  vc.registerSctColormap({ R: [1], G: [1], B: [1], A: [1] }, 'lnm-yeo7');
  assert.equal(calls.addColormap.length, 2,
    'registerSctColormap must always call addColormap (NiiVue overwrites)');
  assert.equal(vc.sctColormapsRegistered.has('lnm-yeo7'), true);
}

// ---- Test 8: getVolumeIndexForStage returns null for stale/missing ----
{
  const { nv } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'), { stage: 'structural' });
  await vc.loadOverlay(fakeFile('lesion.nii'), 'red', 0.5, { stage: 'lesion' });
  assert.equal(vc.getVolumeIndexForStage('structural'), 0);
  assert.equal(vc.getVolumeIndexForStage('lesion'), 1);
  assert.equal(vc.getVolumeIndexForStage('madeup'), null,
    'unknown stage -> null');
  // Stale: overlay was at index 1, but if volumes shrink, the cached
  // index should be invalidated by the bounds check.
  nv.volumes.pop();
  assert.equal(vc.getVolumeIndexForStage('lesion'), null,
    'stage index pointing past volumes.length -> null');
}

// ---- Test 9: getVolumeDataMax handles empty / missing ----
{
  const { nv } = makeNv();
  const vc = new ViewerController({ nv });
  assert.equal(vc.getVolumeDataMax(undefined), 1, 'undefined -> 1 default');
  assert.equal(vc.getVolumeDataMax({}), 1, 'no .img -> 1 default');
  // Use exact Float32-representable values to avoid precision noise.
  assert.equal(vc.getVolumeDataMax({ img: new Float32Array([0.5, 2.0, 0.25, 1.5]) }), 2.0);
  // Non-finite values are skipped.
  // Use exact Float32-representable values; NaN + Infinity must be filtered.
  assert.equal(
    vc.getVolumeDataMax({ img: new Float32Array([NaN, 0.5, Infinity, 0.75]) }),
    0.75,
    'NaN + Infinity must be filtered out'
  );
}

// ---- Test 10: scalar overlays keep signed range and interpolation ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'));
  await vc.loadOverlay(fakeFile('network.nii'), 'blue2red', 0.5, {
    stage: 'network-map',
    scalar: true,
    symmetricCal: true
  });
  assert.equal(nv.volumes.length, 2);
  assert.equal(nv.volumes[1].interpolation, true,
    'scalar t-map overlay must keep interpolation enabled');
  assert.equal(nv.volumes[1].cal_min, -4,
    'scalar t-map overlay must use symmetric negative cal_min');
  assert.equal(nv.volumes[1].cal_max, 4,
    'scalar t-map overlay must use symmetric positive cal_max');
  assert.equal(nv.volumes[1].colormap, 'blue2red');
  assert.deepEqual(calls.setColormap.at(-1), ['vol-1', 'blue2red']);
  assert.equal(vc.volumeStageIndices.get('network-map'), 1);
}

// ---- Test 11: replacing a stage overlay preserves other stage indices ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('yeo-base.nii'), { stage: 'yeo-brain-mask' });
  await vc.loadOverlay(fakeFile('threshold-a.nii'), 'red', 0.5, { stage: 'threshold-preview' });
  await vc.loadOverlay(fakeFile('network.nii'), 'blue2red', 0.5, {
    stage: 'network-map',
    scalar: true,
    symmetricCal: true
  });

  assert.equal(vc.getVolumeIndexForStage('threshold-preview'), 1);
  assert.equal(vc.getVolumeIndexForStage('network-map'), 2);

  await vc.replaceOverlayForStage('threshold-preview', fakeFile('threshold-b.nii'), 'red', 0.65);

  assert.deepEqual(calls.removeVolumeByIndex, [1],
    'replaceOverlayForStage must remove the old stage volume before adding the new one');
  assert.equal(nv.volumes.length, 3,
    'replacement must not accumulate duplicate threshold overlays');
  assert.equal(vc.getVolumeIndexForStage('network-map'), 1,
    'stage indices above the removed overlay must shift down');
  assert.equal(vc.getVolumeIndexForStage('threshold-preview'), 2,
    'replacement threshold overlay must be stage-tracked at its new index');
  assert.equal(calls.addVolumeFromUrl.at(-1).name, 'threshold-b.nii');
  assert.equal(nv.volumes[2].interpolation, false,
    'replacement threshold overlay remains a binary/discrete overlay');
  assert.deepEqual(calls.setOpacity.at(-1), [2, 0.65]);
}

// ---- Test 12: per-stage visibility hides without removing volumes ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'), { stage: 'structural' });
  await vc.loadOverlay(fakeFile('brainmask.nii'), 'green', 0.4, { stage: 'brainmask' });
  await vc.loadOverlay(fakeFile('lesion.nii'), 'red', 0.5, { stage: 'segmentation' });

  assert.equal(vc.setStageVisible('brainmask', false), true);
  assert.equal(nv.volumes.length, 3, 'hiding a stage must not remove its volume');
  assert.equal(vc.getVolumeIndexForStage('brainmask'), 1);
  assert.equal(vc.getVolumeIndexForStage('segmentation'), 2,
    'stage indices must stay stable when a layer is hidden');
  assert.deepEqual(calls.setOpacity.at(-1), [1, 0],
    'hidden stage opacity must be set to 0');

  vc.setOverlayOpacity(0.25);
  assert.equal(nv.volumes[1].opacity, 0,
    'global overlay opacity must keep hidden stages invisible');
  assert.equal(nv.volumes[2].opacity, 0.25,
    'global overlay opacity must still update visible overlays');

  vc.setStageVisible('brainmask', true);
  assert.equal(nv.volumes[1].opacity, 0.25,
    'restoring a hidden stage should use the remembered overlay opacity');
}

// ---- Test 13: base-stage visibility and hidden replacement state ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('t1.nii'), { stage: 'structural' });
  vc.setStageVisible('structural', false);
  assert.equal(nv.volumes.length, 1, 'hiding the base must not clear the viewer');
  assert.deepEqual(calls.setOpacity.at(-1), [0, 0],
    'hidden base opacity must be set to 0');

  await vc.loadOverlay(fakeFile('threshold-a.nii'), 'red', 0.65, { stage: 'threshold-preview' });
  vc.setStageVisible('threshold-preview', false);
  await vc.replaceOverlayForStage('threshold-preview', fakeFile('threshold-b.nii'), 'red', 0.65);
  assert.equal(vc.isStageVisible('threshold-preview'), false,
    'overlay replacement must preserve hidden stage state');
  assert.equal(nv.volumes[1].name, 'threshold-b.nii');
  assert.equal(nv.volumes[1].opacity, 0,
    'replacement overlay must remain hidden when its stage is hidden');
}

// ---- Test 14: setStageOpacity can apply immediately for live blend sliders ----
{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(fakeFile('template.nii'), { stage: 'registration-template' });
  await vc.loadOverlay(fakeFile('registered.nii'), 'gray', 0.5, {
    stage: 'registered-t1-mni160',
    scalar: true
  });

  const applied = vc.setStageOpacity('registered-t1-mni160', 0.2, {
    apply: true,
    redraw: true
  });
  assert.equal(applied, true,
    'live stage-opacity application must report success for active stages');
  assert.deepEqual(calls.setOpacity.at(-1), [1, 0.2],
    'live stage-opacity application must call NiiVue setOpacity immediately');
  assert.equal(nv.volumes[1].opacity, 0.2,
    'live stage-opacity application must update the active volume opacity');
  assert.ok(calls.updateGLVolume > 0 && calls.drawScene > 0,
    'live stage-opacity application must redraw the viewer');
}

// ---- Test 15: MaskDrawingController wraps NiiVue drawing calls ----
{
  globalThis.niivue = { PEN_TYPE: { PEN: 0, RECTANGLE: 1, ELLIPSE: 2 } };
  const drawBytes = new Uint8Array([1, 0, 1, 0]);
  const calls = {
    createEmptyDrawing: 0,
    loadDrawingFromUrl: [],
    setDrawingEnabled: [],
    setPenValue: [],
    setDrawOpacity: [],
    setDrawColormap: [],
    drawUndo: 0,
    drawAddUndoBitmap: 0,
    refreshDrawing: [],
    saveImage: [],
    closeDrawing: 0,
    drawScene: 0
  };
  const nv = {
    back: { dims: [3, 2, 2, 2] },
    opts: { isFilledPen: false, penSize: 1, penValue: 1 },
    document: { opts: { penType: 0 } },
    drawBitmap: null,
    drawUndoBitmaps: [],
    currentDrawUndoBitmap: -1,
    createEmptyDrawing() {
      calls.createEmptyDrawing += 1;
      this.drawBitmap = new Uint8Array(8);
    },
    closeDrawing() {
      calls.closeDrawing += 1;
      this.drawBitmap = null;
    },
    async loadDrawingFromUrl(url, asDrawing) {
      calls.loadDrawingFromUrl.push([url, asDrawing]);
      this.drawBitmap = new Uint8Array(8);
      return true;
    },
    setDrawingEnabled(enabled) { calls.setDrawingEnabled.push(enabled); },
    setPenValue(value, filled) {
      calls.setPenValue.push([value, filled]);
      this.opts.penValue = value;
      this.opts.isFilledPen = filled;
    },
    setDrawOpacity(opacity) { calls.setDrawOpacity.push(opacity); },
    setDrawColormap(colormap) { calls.setDrawColormap.push(colormap); },
    drawAddUndoBitmap() {
      calls.drawAddUndoBitmap += 1;
      this.currentDrawUndoBitmap += 1;
      this.drawUndoBitmaps[this.currentDrawUndoBitmap] = new Uint8Array(this.drawBitmap);
    },
    drawUndo() {
      calls.drawUndo += 1;
      if (this.currentDrawUndoBitmap <= 0) return;
      this.currentDrawUndoBitmap -= 1;
      this.drawBitmap = new Uint8Array(this.drawUndoBitmaps[this.currentDrawUndoBitmap]);
    },
    refreshDrawing(redraw) { calls.refreshDrawing.push(redraw); },
    async saveImage(options) {
      calls.saveImage.push(options);
      return drawBytes;
    },
    drawScene() { calls.drawScene += 1; }
  };
  const messages = [];
  const lesionDrawColormap = {
    R: [0, 0],
    G: [0, 140],
    B: [0, 255],
    A: [0, 255],
    I: [0, 1],
    labels: ['Background', 'Lesion mask']
  };
  const controller = new MaskDrawingController({
    nv,
    defaultColormap: lesionDrawColormap,
    defaultOpacity: 0.65,
    updateOutput: (message) => messages.push(message)
  });

  controller.ensureDrawing();
  assert.equal(calls.createEmptyDrawing, 1,
    'ensureDrawing must create an empty drawing when none exists');
  assert.deepEqual(calls.setDrawOpacity.at(-1), 0.65,
    'ensureDrawing must set drawing opacity');
  assert.equal(calls.setDrawColormap.at(-1), lesionDrawColormap,
    'ensureDrawing must pass the lesion drawing colormap object to NiiVue');
  assert.equal(calls.setDrawingEnabled.at(-1), true,
    'ensureDrawing must enable drawing mode');
  assert.deepEqual(calls.setPenValue.at(-1), [1, false],
    'paint tool must write lesion label 1');

  controller.setTool('erase');
  assert.deepEqual(calls.setPenValue.at(-1), [0, false],
    'erase tool must write background label 0');
  controller.setTool('eraseCluster');
  assert.ok(Object.is(calls.setPenValue.at(-1)[0], -0),
    'erase-cluster tool must pass NiiVue negative zero sentinel');

  await controller.loadSeedFile(fakeFile('seed.nii'));
  assert.equal(calls.loadDrawingFromUrl.length, 1,
    'seed masks must load through NiiVue loadDrawingFromUrl');
  assert.equal(calls.loadDrawingFromUrl[0][0], 'blob:fake-seed.nii');
  assert.equal(calls.loadDrawingFromUrl[0][1], true);
  assert.equal(calls.setDrawColormap.at(-1), lesionDrawColormap,
    'seed drawings must pass the lesion drawing colormap object to NiiVue');
  assert.ok(messages.at(-1).includes('Editable lesion seed loaded'),
    'seed load should report an editable drawing');

  controller.setPenShape('rectangle');
  assert.equal(nv.document.opts.penType, 1,
    'rectangle tool must update NiiVue pen type');
  assert.equal(controller.setBrushSize(5), 5,
    'brush size helper must return the clamped size');
  assert.equal(nv.opts.penSize, 5,
    'brush size helper must update NiiVue pen size');
  controller.setFilled(true);
  assert.equal(calls.setPenValue.at(-1)[1], true,
    'filled toggle must reapply the current pen value with filled mode');

  controller.undo();
  assert.equal(calls.drawUndo, 1,
    'undo must delegate to NiiVue drawUndo');
  nv.drawBitmap = new Uint8Array([0, 1, 1, 0, 0, 0, 2, 0]);
  nv.drawUndoBitmaps = [];
  nv.currentDrawUndoBitmap = -1;
  calls.drawAddUndoBitmap = 0;
  calls.closeDrawing = 0;
  controller.startBlank();
  assert.equal(calls.closeDrawing, 0,
    'blanking a same-sized drawing must preserve the NiiVue drawing/undo stack');
  assert.equal(calls.drawAddUndoBitmap, 2,
    'blanking must record both the previous mask and blank mask for undo');
  assert.deepEqual(Array.from(nv.drawBitmap), [0, 0, 0, 0, 0, 0, 0, 0],
    'blanking must clear the current drawing bitmap in place');
  controller.undo();
  assert.deepEqual(Array.from(nv.drawBitmap), [0, 1, 1, 0, 0, 0, 2, 0],
    'undo after blank must restore the pre-blank mask');

  const exported = await controller.exportDrawingFile('edited.nii');
  assert.equal(exported.name, 'edited.nii',
    'drawing export must wrap NiiVue drawing bytes in a File');
  assert.deepEqual(calls.saveImage.at(-1), { filename: '', isSaveDrawing: true },
    'drawing export must use NiiVue saveImage drawing mode without browser download');
  controller.close();
  assert.equal(calls.setDrawingEnabled.at(-1), false,
    'close must disable drawing mode without clearing volumes');
  assert.equal(calls.closeDrawing, 0,
    'plain close must keep the drawing bitmap available for continued editing');
  controller.setVisible(false);
  assert.equal(calls.setDrawOpacity.at(-1), 0,
    'setVisible(false) must hide the editable drawing overlay');
  controller.setVisible(true);
  assert.equal(calls.setDrawOpacity.at(-1), 0.65,
    'setVisible(true) must restore the editable drawing opacity');
  assert.equal(calls.setDrawColormap.at(-1), lesionDrawColormap,
    'setVisible(true) must restore the editable drawing colormap object');
  controller.close({ clearDrawing: true });
  assert.equal(calls.closeDrawing, 1,
    'accepted masks must be able to close and clear the drawing bitmap');
  assert.equal(nv.drawBitmap, null,
    'clearDrawing close must remove the stale editable drawing overlay');
}

console.log('ViewerController OK: 15 cases (Phase 4 call-shape, drawing wrapper, overlay replace path, scalar overlays, visibility, view + stage + colormap + live opacity).');
