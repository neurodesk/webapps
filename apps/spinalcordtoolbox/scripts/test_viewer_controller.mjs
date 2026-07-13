#!/usr/bin/env node

import assert from 'node:assert/strict';
import { ViewerController } from '../web/js/controllers/ViewerController.js';

function createFakeNiivue() {
  return {
    volumes: [{ name: 'input.nii', opacity: 1 }],
    removedIndexes: [],
    opacityCalls: [],
    loadVolumesCalls: [],
    addVolumeFromUrlCalls: [],
    updateCount: 0,
    drawCount: 0,
    addColormap() {},
    async loadVolumes(volumes) {
      this.loadVolumesCalls.push(volumes.map(v => ({ name: v.name, colormap: v.colormap, url: v.url })));
      this.volumes = volumes.map(volume => ({
        id: volume.name,
        name: volume.name,
        colormap: volume.colormap || 'gray',
        opacity: volume.opacity ?? 1,
        global_max: 1
      }));
    },
    async addVolumeFromUrl(volume) {
      this.addVolumeFromUrlCalls.push({ name: volume.name, colormap: volume.colormap, url: volume.url });
      this.volumes.push({
        id: volume.name,
        name: volume.name,
        colormap: volume.colormap,
        opacity: volume.opacity,
        global_max: 1
      });
    },
    removeVolumeByIndex(index) {
      this.removedIndexes.push(index);
      this.volumes.splice(index, 1);
    },
    setOpacity(index, value) {
      this.opacityCalls.push([index, value]);
      this.volumes[index].opacity = value;
    },
    setColormap(id, colormap) {
      const volume = this.volumes.find(item => item.id === id);
      if (volume) volume.colormap = colormap;
    },
    updateGLVolume() {
      this.updateCount += 1;
    },
    drawScene() {
      this.drawCount += 1;
    }
  };
}

function createFakeComparisonNiivue(created) {
  const nv = createFakeNiivue();
  nv.volumes = [];
  nv.attachedCanvasIds = [];
  nv.lostContext = false;
  nv.sliceTypeMultiplanar = 'multiplanar';
  nv.sliceTypeAxial = 'axial';
  nv.sliceTypeCoronal = 'coronal';
  nv.sliceTypeSagittal = 'sagittal';
  nv.sliceTypeRender = 'render';
  nv.setSliceType = (type) => {
    nv.currentSliceType = type;
  };
  nv.setMultiplanarPadPixels = (pixels) => {
    nv.multiplanarPadPixels = pixels;
  };
  nv.setInterpolation = (enabled) => {
    nv.interpolation = enabled;
  };
  nv.attachTo = async (canvasId) => {
    nv.attachedCanvasIds.push(canvasId);
    nv.gl = {
      getExtension: () => ({
        loseContext: () => {
          nv.lostContext = true;
        }
      })
    };
  };
  created.push(nv);
  return nv;
}

function makeFakeDomElement(tagName = 'div') {
  const element = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    classList: {
      classes: new Set(),
      add(className) { this.classes.add(className); },
      remove(className) { this.classes.delete(className); },
      contains(className) { return this.classes.has(className); }
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    }
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return this._innerHTML || ''; },
    set(value) {
      this._innerHTML = value;
      if (value === '') this.children = [];
    }
  });
  return element;
}

function makeFile(name) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
}

{
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  URL.createObjectURL = (file) => {
    const url = `blob:test-${created.length}-${file.name}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  try {
    const nv = createFakeNiivue();
    const viewer = new ViewerController({ nv });
    const input = makeFile('input_reuse.nii');
    const seg = makeFile('seg_reuse.nii');
    const lesion = makeFile('lesion_reuse.nii');

    await viewer.loadVolumeStack([
      { file: input, stage: 'input' },
      { file: seg, stage: 'segmentation', colormap: 'sct-spinalcord', opacity: 0.7, labelMask: true }
    ]);
    assert.equal(viewer.isCurrentVolumeStack([
      { file: input, stage: 'input' },
      { file: seg, stage: 'segmentation', colormap: 'sct-spinalcord', opacity: 0.7, labelMask: true }
    ]), true, 'loaded stack signature should match the requested stack');
    await viewer.loadVolumeStack([
      { file: input, stage: 'input' },
      { file: seg, stage: 'segmentation', colormap: 'sct-spinalcord', opacity: 0.7, labelMask: true }
    ]);

    assert.deepEqual(created, ['blob:test-0-input_reuse.nii', 'blob:test-1-seg_reuse.nii'], 'viewer reuses stable object URLs for repeated File loads');
    assert.deepEqual(revoked, [], 'viewer must not revoke object URLs while NiiVue may still fetch them');
    assert.equal(nv.loadVolumesCalls[0][0].url, 'blob:test-0-input_reuse.nii');
    assert.equal(nv.addVolumeFromUrlCalls[0].url, 'blob:test-1-seg_reuse.nii');
    assert.equal(nv.loadVolumesCalls.length, 1, 'identical stack reloads must skip nv.loadVolumes');
    assert.equal(nv.addVolumeFromUrlCalls.length, 1, 'identical stack reloads must skip nv.addVolumeFromUrl');

    await viewer.loadVolumeStack([
      { file: input, stage: 'input' },
      { file: seg, stage: 'segmentation', colormap: 'sct-spinalcord', opacity: 0.7, labelMask: true },
      { file: lesion, stage: 'lesion', colormap: 'sct-lesion', opacity: 0.7, labelMask: true }
    ]);
    assert.deepEqual(created, ['blob:test-0-input_reuse.nii', 'blob:test-1-seg_reuse.nii', 'blob:test-2-lesion_reuse.nii'], 'changed stacks reuse existing URLs and create URLs only for new files');
    assert.equal(nv.loadVolumesCalls.length, 2, 'changed stacks must reload the base once');
    assert.equal(nv.addVolumeFromUrlCalls.length, 3, 'changed stacks must add each requested overlay');
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  await viewer.loadOverlay(makeFile('first_seg.nii'), 'sct-spinalcord', 0.5);
  await viewer.loadOverlay(makeFile('second_seg.nii'), 'sct-spinalcord', 0.35);

  assert.equal(nv.volumes.length, 3);
  assert.equal(nv.volumes[0].name, 'input.nii');
  assert.equal(nv.volumes[1].name, 'first_seg.nii');
  assert.equal(nv.volumes[2].name, 'second_seg.nii');
  assert.deepEqual(nv.removedIndexes, []);
  assert.deepEqual(nv.opacityCalls.at(-1), [2, 0.35]);
  assert.equal(viewer.getOverlayIndex(), 2);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  await viewer.loadOverlay(makeFile('seg.nii'), 'sct-spinalcord', 0.5);
  viewer.setBaseOpacity(0);

  assert.equal(nv.volumes[0].opacity, 0);
  assert.equal(nv.volumes[1].opacity, 0.5);
  assert.deepEqual(nv.opacityCalls.at(-1), [0, 0]);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  await viewer.loadOverlay(makeFile('seg_overlay.nii'), 'sct-spinalcord', 0.5);
  await viewer.loadSegmentationAsBase(makeFile('seg_base.nii'), 'sct-spinalcord');

  assert.equal(nv.volumes.length, 1);
  assert.equal(nv.volumes[0].name, 'seg_base.nii');
  assert.equal(nv.volumes[0].colormap, 'sct-spinalcord');
  assert.equal(nv.volumes[0].cal_min, 0);
  assert.equal(nv.volumes[0].cal_max, 1);
  assert.equal(viewer.getOverlayIndex(), null);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });

  nv.volumes.push({
    id: 'vertebrae.nii',
    name: 'vertebrae.nii',
    colormap: 'sct-vertebrae',
    opacity: 0.7,
    global_max: 1,
    img: new Uint8Array([0, 1, 5, 11])
  });
  viewer.configureSegmentationVolume(1, 'sct-vertebrae');

  assert.equal(nv.volumes[1].cal_min, 0);
  assert.equal(nv.volumes[1].cal_max, 11);
  assert.equal(nv.volumes[1].colormap, 'sct-vertebrae');
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });
  const input = makeFile('input_roundtrip.nii');
  const seg = makeFile('seg_roundtrip.nii');

  await viewer.loadBaseVolume(input);
  await viewer.loadOverlay(seg, 'sct-spinalcord', 0.45);
  await viewer.loadSegmentationAsBase(seg, 'sct-spinalcord');
  await viewer.loadBaseVolume(input);
  await viewer.loadOverlay(seg, 'sct-spinalcord', 0.45);

  assert.equal(nv.volumes.length, 2);
  assert.equal(nv.volumes[0].name, 'input_roundtrip.nii');
  assert.equal(nv.volumes[1].name, 'seg_roundtrip.nii');
  assert.equal(nv.volumes[0].opacity, 1);
  assert.equal(nv.volumes[1].opacity, 0.45);
  assert.equal(viewer.getOverlayIndex(), 1);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });
  const input = makeFile('input_multi.nii');
  const seg = makeFile('seg_multi.nii');
  const lesion = makeFile('lesion_multi.nii');
  const vertebrae = makeFile('vertebrae_multi.nii');

  await viewer.loadBaseVolume(input, { stage: 'input' });
  await viewer.loadOverlay(seg, 'sct-spinalcord', 0.45, { stage: 'segmentation' });
  await viewer.loadOverlay(lesion, 'sct-lesion', 0.45, { stage: 'lesion' });
  await viewer.loadOverlay(vertebrae, 'sct-vertebrae', 0.45, { stage: 'vertebrae' });
  viewer.setOverlayOpacity(0.8);

  assert.equal(nv.volumes.length, 4);
  assert.equal(nv.volumes[0].name, 'input_multi.nii');
  assert.equal(nv.volumes[1].colormap, 'sct-spinalcord');
  assert.equal(nv.volumes[2].colormap, 'sct-lesion');
  assert.equal(nv.volumes[3].colormap, 'sct-vertebrae');
  assert.equal(nv.volumes[1].opacity, 0.8);
  assert.equal(nv.volumes[2].opacity, 0.8);
  assert.equal(nv.volumes[3].opacity, 0.8);
  assert.equal(viewer.getVolumeIndexForStage('segmentation'), 1);
  assert.equal(viewer.getVolumeIndexForStage('lesion'), 2);
  assert.equal(viewer.getVolumeIndexForStage('vertebrae'), 3);
}

{
  const nv = createFakeNiivue();
  const viewer = new ViewerController({ nv });
  const input = makeFile('input_stack.nii');
  const seg = makeFile('seg_stack.nii');
  const lesion = makeFile('lesion_stack.nii');
  const vertebrae = makeFile('vertebrae_stack.nii');

  await viewer.loadVolumeStack([
    { file: input, stage: 'input' },
    { file: seg, stage: 'segmentation', colormap: 'sct-spinalcord', opacity: 0.7, labelMask: true },
    { file: lesion, stage: 'lesion', colormap: 'sct-lesion', opacity: 0.7, labelMask: true },
    { file: vertebrae, stage: 'vertebrae', colormap: 'sct-vertebrae', opacity: 0.7, labelMask: true }
  ]);

  assert.equal(nv.volumes.length, 4);
  assert.equal(nv.volumes[0].name, 'input_stack.nii');
  assert.equal(nv.volumes[1].colormap, 'sct-spinalcord');
  assert.equal(nv.volumes[2].colormap, 'sct-lesion');
  assert.equal(nv.volumes[3].colormap, 'sct-vertebrae');
  assert.equal(nv.volumes[1].opacity, 0.7);
  assert.equal(nv.volumes[2].opacity, 0.7);
  assert.equal(nv.volumes[3].opacity, 0.7);
  assert.equal(viewer.getVolumeIndexForStage('input'), 0);
  assert.equal(viewer.getVolumeIndexForStage('segmentation'), 1);
  assert.equal(viewer.getVolumeIndexForStage('lesion'), 2);
  assert.equal(viewer.getVolumeIndexForStage('vertebrae'), 3);

  // Regression: NiiVue 0.68.x silently fails to render binary/label overlays
  // when multiple volumes are loaded in a single `loadVolumes([...])` call
  // (the overlays end up with broken cal_min/cal_max + colormap LUT state).
  // `loadVolumeStack` MUST therefore (1) load the base via `loadVolumes` with
  // a single entry and (2) add each overlay via `addVolumeFromUrl`. If this
  // is reverted, the SCT segmentation overlay disappears in the live app
  // even though the eye toggle is on and the segmentation has voxels.
  assert.equal(nv.loadVolumesCalls.length, 1, 'loadVolumeStack must call nv.loadVolumes exactly once (for the base)');
  assert.equal(nv.loadVolumesCalls[0].length, 1, 'nv.loadVolumes must receive exactly one volume (the base)');
  assert.equal(nv.loadVolumesCalls[0][0].name, 'input_stack.nii');
  assert.equal(nv.addVolumeFromUrlCalls.length, 3, 'each overlay must be added via addVolumeFromUrl');
  assert.equal(nv.addVolumeFromUrlCalls[0].colormap, 'sct-spinalcord');
  assert.equal(nv.addVolumeFromUrlCalls[1].colormap, 'sct-lesion');
  assert.equal(nv.addVolumeFromUrlCalls[2].colormap, 'sct-vertebrae');
}

{
  const originalDocument = globalThis.document;
  const container = makeFakeDomElement('div');
  globalThis.document = {
    createElement: (tagName) => makeFakeDomElement(tagName)
  };

  try {
    const created = [];
    const viewer = new ViewerController({
      nv: createFakeNiivue(),
      viewerConfig: { dragAndDropEnabled: false },
      niivueFactory: () => createFakeComparisonNiivue(created)
    });
    const first = makeFile('session_one.nii.gz');
    const second = makeFile('session_two.nii.gz');

    const rendered = await viewer.loadComparisonVolumes([
      { id: 'session-1', name: first.name, file: first },
      { id: 'session-2', name: second.name, file: second }
    ], {
      container,
      activeSessionId: 'session-2',
      viewType: 'axial',
      colormap: 'hot',
      maxSessions: 4
    });

    assert.equal(rendered, true);
    assert.equal(container.dataset.count, '2');
    assert.equal(container.children.length, 2);
    assert.equal(container.children[0].children[0].textContent, 'session_one.nii.gz');
    assert.equal(container.children[1].classList.contains('active'), true);
    assert.equal(created.length, 2);
    assert.deepEqual(created[0].attachedCanvasIds, ['comparisonCanvas-session-1']);
    assert.deepEqual(created[1].attachedCanvasIds, ['comparisonCanvas-session-2']);
    assert.equal(created[0].loadVolumesCalls.length, 1);
    assert.equal(created[0].loadVolumesCalls[0][0].name, 'session_one.nii.gz');
    assert.equal(created[1].loadVolumesCalls[0][0].name, 'session_two.nii.gz');
    assert.equal(created[0].volumes[0].colormap, 'hot');
    assert.equal(created[1].currentSliceType, 'axial');
    assert.equal(viewer.getComparisonViewerCount(), 2);

    viewer.setComparisonColormap('viridis');
    assert.equal(created[0].volumes[0].colormap, 'viridis');
    assert.equal(created[1].volumes[0].colormap, 'viridis');

    viewer.setComparisonViewType('sagittal');
    assert.equal(created[0].currentSliceType, 'sagittal');
    assert.equal(created[1].currentSliceType, 'sagittal');

    viewer.clearComparisonView(container);
    assert.equal(viewer.getComparisonViewerCount(), 0);
    assert.equal(container.children.length, 0);
    assert.equal(container.dataset.count, '0');
    assert.equal(created[0].lostContext, true);
    assert.equal(created[1].lostContext, true);
  } finally {
    globalThis.document = originalDocument;
  }
}

console.log('ViewerController tests passed');
