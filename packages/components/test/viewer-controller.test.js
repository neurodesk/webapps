import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { ViewerController } from '../src/viewer/ViewerController.js';

function file(name) {
  const value = new Blob([new Uint8Array([0])]);
  Object.defineProperty(value, 'name', { value: name });
  return value;
}

function niivue({ failBase = false, failOverlay = false } = {}) {
  return {
    volumes: [],
    async loadVolumes(entries) {
      if (failBase) throw new Error('base failed');
      this.volumes = entries.map(entry => ({ name: entry.name, img: new Uint8Array([0, 1]) }));
    },
    async addVolumeFromUrl(entry) {
      if (failOverlay) throw new Error('overlay failed');
      this.volumes.push({ name: entry.name, img: new Uint8Array([0, 1]) });
    },
    setOpacity(index, opacity) {
      this.volumes[index].opacity = opacity;
    },
    updateGLVolume() {},
    drawScene() {},
  };
}

test('loadVolumeStack reports a failed base load and clears partial state', async () => {
  const nv = niivue({ failBase: true });
  const viewer = new ViewerController({ nv });

  assert.equal(await viewer.loadVolumeStack([{ file: file('base.nii'), stage: 'input' }]), false);
  assert.deepEqual(nv.volumes, []);
  assert.equal(viewer.currentVolumeStackSignature, null);
});

test('loadVolumeStack reports a failed overlay load and clears the loaded base', async () => {
  const nv = niivue({ failOverlay: true });
  const viewer = new ViewerController({ nv });

  assert.equal(await viewer.loadVolumeStack([
    { file: file('base.nii'), stage: 'input' },
    { file: file('seg.nii'), stage: 'segmentation' },
  ]), false);
  assert.deepEqual(nv.volumes, []);
  assert.equal(viewer.currentVolumeStackSignature, null);
});

test('clearing volumes revokes stable object URLs and releases file references', async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.createObjectURL = input => `blob:${input.name}`;
  URL.revokeObjectURL = url => revoked.push(url);

  try {
    const viewer = new ViewerController({ nv: niivue() });
    const base = file('base.nii');
    const seg = file('seg.nii');
    await viewer.loadVolumeStack([
      { file: base, stage: 'input' },
      { file: seg, stage: 'segmentation' },
    ]);

    assert.equal(viewer.objectUrls.size, 2);
    viewer.clearVolumes();
    assert.deepEqual(new Set(revoked), new Set(['blob:base.nii', 'blob:seg.nii']));
    assert.equal(viewer.objectUrls.size, 0);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('a stage removed from a stack is visible when explicitly added again', async () => {
  const nv = niivue();
  const viewer = new ViewerController({ nv });
  const base = file('base.nii');
  const seg = file('seg.nii');

  await viewer.loadVolumeStack([
    { file: base, stage: 'input' },
    { file: seg, stage: 'segmentation', opacity: 0.5 },
  ]);
  viewer.setStageVisible('segmentation', false);
  await viewer.loadVolumeStack([{ file: base, stage: 'input' }]);
  await viewer.loadVolumeStack([
    { file: base, stage: 'input' },
    { file: seg, stage: 'segmentation', opacity: 0.5 },
  ]);

  assert.equal(viewer.isStageVisible('segmentation'), true);
  assert.equal(nv.volumes[1].opacity, 0.5);
});

function twoPhase() {
  const nv = niivue();
  nv.addVolume = function addVolume(image) {
    this.volumes.push(image);
  };
  const decodes = [];
  const NVImage = {
    loadFromUrl: (options) => new Promise((resolve) => {
      decodes.push({ options, finish: () => resolve({ name: options.name, img: new Uint8Array([0, 1]) }) });
    }),
  };
  return { nv, decodes, viewer: new ViewerController({ nv, NVImage }) };
}

test('a load with assertCurrent decodes away from the viewer and commits in one step', async () => {
  const { nv, decodes, viewer } = twoPhase();
  const previous = { name: 'previous.nii' };
  nv.volumes = [previous];
  const order = [];
  const load = viewer.loadBaseVolume(file('base.nii'), {
    stage: 'input',
    assertCurrent: () => order.push(`check ${nv.volumes.map(volume => volume.name)}`),
    onCommit: () => order.push(`commit ${nv.volumes.map(volume => volume.name)} ${viewer.currentBaseFile.name}`),
  });
  await Promise.resolve();
  assert.deepEqual(nv.volumes, [previous], 'the viewer keeps its volumes while the file is decoded');
  decodes[0].finish();
  assert.equal(await load, true);
  assert.deepEqual(order.slice(-2), ['check previous.nii', 'commit base.nii base.nii'], 'the last check is followed by the commit');
  assert.equal(viewer.getVolumeIndexForStage('input'), 0);
});

test('a superseded load never reaches the viewer or the controller record', async () => {
  const { nv, decodes, viewer } = twoPhase();
  const superseded = () => {
    throw new DOMException('superseded', 'AbortError');
  };
  const committed = [];
  const onCommit = () => committed.push('commit');

  const base = viewer.loadBaseVolume(file('base.nii'), { stage: 'input', assertCurrent: superseded, onCommit });
  decodes[0].finish();
  await assert.rejects(base, { name: 'AbortError' });

  const overlay = viewer.loadOverlay(file('seg.nii'), 'red', 0.5, { stage: 'segmentation', assertCurrent: superseded, onCommit });
  decodes[1].finish();
  await assert.rejects(overlay, { name: 'AbortError' });

  const stack = viewer.loadVolumeStack([
    { file: file('template.nii'), stage: 'template' },
    { file: file('map.nii'), stage: 'map', scalar: true },
  ], { assertCurrent: superseded, onCommit });
  decodes[2].finish();
  decodes[3].finish();
  await assert.rejects(stack, { name: 'AbortError' });

  assert.deepEqual(nv.volumes, []);
  assert.deepEqual(committed, []);
  assert.equal(viewer.currentBaseFile, null);
  assert.deepEqual(viewer.volumeFiles, []);
});

test('a stack with assertCurrent replaces the viewer only when every entry is decoded', async () => {
  const { nv, decodes, viewer } = twoPhase();
  const previous = { name: 'previous.nii' };
  nv.volumes = [previous];
  const entries = [
    { file: file('template.nii'), stage: 'template' },
    { file: file('map.nii'), stage: 'map', scalar: true },
  ];
  const stack = viewer.loadVolumeStack(entries, { assertCurrent: () => {} });
  decodes[0].finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(nv.volumes, [previous], 'a decoded base waits for the overlays');
  decodes[1].finish();
  assert.equal(await stack, true);
  assert.deepEqual(nv.volumes.map(volume => volume.name), ['template.nii', 'map.nii']);
  assert.equal(viewer.getVolumeIndexForStage('map'), 1);
  assert.equal(viewer.isCurrentVolumeStack(entries), true);
});

test('a decode releases only the object URL it created, however it ends', async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let created = 0;
  const revoked = [];
  URL.createObjectURL = (input) => {
    created += 1;
    return `blob:${input.name}#${created}`;
  };
  URL.revokeObjectURL = url => revoked.push(url);

  try {
    const { nv, decodes, viewer } = twoPhase();
    const failing = [];
    viewer.NVImage = {
      loadFromUrl: options => new Promise((resolve, reject) => {
        decodes.push({ options, finish: () => resolve({ name: options.name }) });
        failing.push(() => reject(new Error('decode failed')));
      }),
    };
    let supersededA = false;
    const replaced = viewer.loadBaseVolume(file('A.nii'), {
      assertCurrent: () => {
        if (supersededA) throw new DOMException('superseded', 'AbortError');
      },
    });
    const current = viewer.loadBaseVolume(file('B.nii'), { assertCurrent: () => {} });
    supersededA = true;
    failing[0]();
    await assert.rejects(replaced, { name: 'AbortError' }, 'a superseded load that fails ends as superseded');
    assert.deepEqual(revoked, ['blob:A.nii#1'], 'the failed decode releases its own URL and no other');

    decodes[1].finish();
    assert.equal(await current, true);
    assert.deepEqual(nv.volumes.map(volume => volume.name), ['B.nii']);
    assert.deepEqual(revoked, ['blob:A.nii#1'], 'an inserted image keeps its URL');

    const failed = viewer.loadOverlay(file('seg.nii'), 'red', 0.5, { assertCurrent: () => {} });
    failing[2]();
    assert.equal(await failed, false, 'a current load that fails is reported, not thrown');
    assert.deepEqual(revoked, ['blob:A.nii#1', 'blob:seg.nii#3']);

    viewer.clearVolumes();
    assert.deepEqual(revoked, ['blob:A.nii#1', 'blob:seg.nii#3', 'blob:B.nii#2'], 'the URL goes when the image leaves the viewer');
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

function countingUrls() {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let created = 0;
  const revoked = [];
  URL.createObjectURL = (input) => {
    created += 1;
    return `blob:${input.name}#${created}`;
  };
  URL.revokeObjectURL = url => revoked.push(url);
  return {
    revoked,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

for (const kind of ['base', 'overlay', 'stack']) {
  test(`a ${kind} decode failure superseded before its continuation is silent`, async () => {
    const messages = [];
    let fail;
    let current = true;
    const decoded = new Promise((resolve, reject) => { fail = reject; });
    // Another asynchronous action replaces the load after the decode settles,
    // before the controller resumes from awaiting the outcome.
    decoded.catch(() => queueMicrotask(() => { current = false; }));
    const viewer = new ViewerController({ nv: niivue(), updateOutput: message => messages.push(message) });
    viewer.decodeVolume = () => decoded;
    const options = {
      assertCurrent: () => {
        if (!current) throw new DOMException('superseded', 'AbortError');
      },
    };
    const input = file('broken.nii');
    const loading = kind === 'base'
      ? viewer.loadBaseVolume(input, options)
      : kind === 'overlay'
        ? viewer.loadOverlay(input, options)
        : viewer.loadVolumeStack([{ file: input }], options);
    fail(new Error('broken header'));
    await assert.rejects(loading, { name: 'AbortError' });
    assert.ok(messages.every(message => !message.startsWith('Error')), 'superseded failures do not write to the log');
    assert.deepEqual(viewer.nv.volumes, []);
  });
}

test('a superseded stack releases a decoded member while a sibling never ends', async () => {
  const urls = countingUrls();
  try {
    const { nv, decodes, viewer } = twoPhase();
    let current = true;
    const stack = viewer.loadVolumeStack([
      { file: file('done.nii'), stage: 'template' },
      { file: file('never.nii'), stage: 'map' },
    ], {
      assertCurrent: () => {
        if (!current) throw new DOMException('superseded', 'AbortError');
      },
    });
    decodes[0].finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(viewer.decodedUrls.size, 1, 'the decoded member waits for its sibling');

    current = false;
    const next = viewer.loadBaseVolume(file('next.nii'), { assertCurrent: () => {} });
    decodes[2].finish();
    assert.equal(await next, true);
    await assert.rejects(stack, { name: 'AbortError' }, 'the stack ends without waiting for the member that never does');
    assert.equal(viewer.decodedUrls.size, 0);
    assert.deepEqual(urls.revoked, ['blob:done.nii#1'], 'the decoded member is released when the viewer changes');
    assert.deepEqual(nv.volumes.map(volume => volume.name), ['next.nii']);

    decodes[1].finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(viewer.decodedUrls.size, 0, 'a member that settles later releases itself');
    assert.deepEqual(urls.revoked, ['blob:done.nii#1', 'blob:never.nii#2']);
  } finally {
    urls.restore();
  }
});

test('a superseded stack lets go of a decoded image while a sibling never ends', async () => {
  setFlagsFromString('--expose-gc');
  const collectGarbage = runInNewContext('gc');
  const urls = countingUrls();
  try {
    let decoded;
    const viewer = new ViewerController({
      nv: { opts: {}, volumes: [], updateGLVolume() {}, drawScene() {} },
      NVImage: {
        loadFromUrl: ({ name }) => {
          if (name === 'never.nii') return new Promise(() => {});
          const image = { name, img: new Uint8Array(1024 * 1024) };
          decoded = new WeakRef(image);
          return Promise.resolve(image);
        },
      },
    });
    let current = true;
    const stack = viewer.loadVolumeStack([
      { file: file('done.nii'), stage: 'template' },
      { file: file('never.nii'), stage: 'map' },
    ], {
      assertCurrent: () => {
        if (!current) throw new DOMException('superseded', 'AbortError');
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    current = false;
    viewer.clearVolumes();
    await assert.rejects(stack, { name: 'AbortError' });
    for (let round = 0; round < 10 && decoded.deref(); round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
      collectGarbage();
    }
    assert.ok(decoded.deref() === undefined, 'the pending sibling does not keep the decoded image alive');
  } finally {
    urls.restore();
  }
});

test('a stack reports the first failed member while a sibling never ends', async () => {
  const urls = countingUrls();
  try {
    const messages = [];
    const nv = niivue();
    nv.addVolume = function addVolume(image) {
      this.volumes.push(image);
    };
    const NVImage = {
      loadFromUrl: (options) => {
        if (options.name === 'broken.nii') return Promise.reject(new Error('broken header'));
        if (options.name === 'done.nii') return Promise.resolve({ name: options.name });
        return new Promise(() => {});
      },
    };
    const viewer = new ViewerController({ nv, NVImage, updateOutput: message => messages.push(message) });
    const stack = viewer.loadVolumeStack([
      { file: file('done.nii'), stage: 'template' },
      { file: file('broken.nii'), stage: 'map' },
      { file: file('never.nii'), stage: 'other' },
    ], { assertCurrent: () => {} });
    assert.equal(await stack, false);
    assert.deepEqual(messages, ['Error loading viewer volumes: broken header']);
    assert.deepEqual(nv.volumes, []);
    assert.equal(viewer.decodedUrls.size, 0, 'the decoded member is released with the failure');
    assert.deepEqual(urls.revoked.sort(), ['blob:broken.nii#2', 'blob:done.nii#1']);
  } finally {
    urls.restore();
  }
});
