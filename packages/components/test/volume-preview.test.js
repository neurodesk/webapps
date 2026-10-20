import assert from 'node:assert/strict';
import test from 'node:test';
import { createNiivueVolumePreview, createPreviewQueue } from '../src/ui/volume-preview.js';

function deferred() {
  const result = {};
  result.promise = new Promise((resolve, reject) => {
    result.resolve = resolve;
    result.reject = reject;
  });
  return result;
}

function fixture({ beforeLoad = async () => {}, afterLoad = async () => {}, beforeClear = async () => {} } = {}) {
  let visible = null;
  const emptyState = { hidden: false };
  const viewer = {
    async loadVolumes([volume]) {
      await beforeLoad(volume);
      visible = { name: volume.name, minimum: volume.calMin, maximum: volume.calMax };
      await afterLoad(volume);
    },
    async removeAllVolumes() {
      await beforeClear();
      visible = null;
    },
  };
  return {
    show: createNiivueVolumePreview({ viewer, ready: Promise.resolve(), emptyState }),
    visible: () => visible,
    emptyState,
  };
}

const a = { file: new File(['a'], 'a.nii.gz') };
const b = { file: new File(['b'], 'b.nii.gz') };
const c = { file: new File(['c'], 'c.nii.gz') };
const gray = (name) => ({ name, minimum: undefined, maximum: undefined });

test('a successful preview displays the requested file and closes the empty state', async () => {
  const f = fixture();
  await f.show(a);
  assert.deepEqual(f.visible(), gray('a.nii.gz'));
  assert.equal(f.emptyState.hidden, true);
});

test('cancelling the first native load restores an empty viewer', async () => {
  const entered = deferred();
  const release = deferred();
  const f = fixture({ beforeLoad: async () => {
    entered.resolve();
    await release.promise;
  } });
  const controller = new AbortController();
  const pending = f.show(b, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.equal(f.visible(), null);
  assert.equal(f.emptyState.hidden, false);
});

test('cancellation settles only after the prior image is restored', async () => {
  const entered = deferred();
  const release = deferred();
  const restoring = deferred();
  const restore = deferred();
  let replacement = false;
  const f = fixture({ beforeLoad: async ({ name }) => {
    if (name === 'b.nii.gz') {
      replacement = true;
      entered.resolve();
      await release.promise;
    } else if (replacement) {
      restoring.resolve();
      await restore.promise;
    }
  } });
  await f.show(a);
  const controller = new AbortController();
  let settled = false;
  const pending = f.show(b, { signal: controller.signal }).finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  release.resolve();
  await restoring.promise;
  assert.equal(settled, false);
  assert.deepEqual(f.visible(), gray('b.nii.gz'));
  restore.resolve();
  await rejected;
  assert.deepEqual(f.visible(), gray('a.nii.gz'));
});

test('restoration preserves a copied scalar-map window', async () => {
  const range = [0, 0.003];
  const error = new Error('replacement decode failed');
  const f = fixture({ afterLoad: async ({ name }) => {
    if (name === 'b.nii.gz') throw error;
  } });
  await f.show({ file: a.file, range });
  range[1] = 100;
  await assert.rejects(f.show(b), (actual) => actual === error);
  assert.deepEqual(f.visible(), { name: 'a.nii.gz', minimum: 0, maximum: 0.003 });
});

test('a queued aborted request never changes the display and does not block a later request', async () => {
  const entered = deferred();
  const release = deferred();
  const loads = [];
  const f = fixture({ beforeLoad: async ({ name }) => {
    loads.push(name);
    if (name === 'a.nii.gz') {
      entered.resolve();
      await release.promise;
    }
  } });
  const first = f.show(a);
  await entered.promise;
  const controller = new AbortController();
  const rejected = assert.rejects(f.show(b, { signal: controller.signal }), { name: 'AbortError' });
  const last = f.show(c);
  controller.abort();
  release.resolve();
  await Promise.all([first, rejected, last]);
  assert.deepEqual(loads, ['a.nii.gz', 'c.nii.gz']);
  assert.deepEqual(f.visible(), gray('c.nii.gz'));
});

test('a new request waits for cancelled replacement rollback', async () => {
  const entered = deferred();
  const release = deferred();
  const restoring = deferred();
  const restore = deferred();
  let replacement = false;
  const loads = [];
  const f = fixture({ beforeLoad: async ({ name }) => {
    loads.push(name);
    if (name === 'b.nii.gz') {
      replacement = true;
      entered.resolve();
      await release.promise;
    }
    if (name === 'a.nii.gz' && replacement) {
      restoring.resolve();
      await restore.promise;
    }
  } });
  await f.show(a);
  const controller = new AbortController();
  const rejected = assert.rejects(f.show(b, { signal: controller.signal }), { name: 'AbortError' });
  await entered.promise;
  const last = f.show(c);
  controller.abort();
  release.resolve();
  await restoring.promise;
  assert.deepEqual(loads, ['a.nii.gz', 'b.nii.gz', 'a.nii.gz']);
  restore.resolve();
  await Promise.all([rejected, last]);
  assert.deepEqual(f.visible(), gray('c.nii.gz'));
});

test('an ordinary failed render restores the display and permits a successful retry', async () => {
  const error = new Error('decode failed');
  const f = fixture({ afterLoad: async ({ name }) => {
    if (name === 'b.nii.gz') throw error;
  } });
  await f.show(a);
  await assert.rejects(f.show(b), (actual) => actual === error);
  assert.deepEqual(f.visible(), gray('a.nii.gz'));
  await f.show(c);
  assert.deepEqual(f.visible(), gray('c.nii.gz'));
});

test('failed restoration clears the stale display and exposes both failures', async () => {
  const original = new Error('decode failed');
  const rollback = new Error('rollback failed');
  let failed = false;
  const f = fixture({ afterLoad: async ({ name }) => {
    if (name === 'b.nii.gz') {
      failed = true;
      throw original;
    }
    if (name === 'a.nii.gz' && failed) throw rollback;
  } });
  await f.show(a);
  await assert.rejects(f.show(b), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, rollback]);
    return true;
  });
  assert.equal(f.visible(), null);
  assert.equal(f.emptyState.hidden, false);
  await f.show(c);
  assert.deepEqual(f.visible(), gray('c.nii.gz'));
});

test('failed clear exposes every cause without poisoning future requests', async () => {
  const original = new Error('decode failed');
  const rollback = new Error('rollback failed');
  const clear = new Error('clear failed');
  let failed = false;
  const f = fixture({
    afterLoad: async ({ name }) => {
      if (name === 'b.nii.gz') {
        failed = true;
        throw original;
      }
      if (name === 'a.nii.gz' && failed) throw rollback;
    },
    beforeClear: async () => {
      throw clear;
    },
  });
  await f.show(a);
  await assert.rejects(f.show(b), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, rollback, clear]);
    return true;
  });
  await f.show(c);
  assert.deepEqual(f.visible(), gray('c.nii.gz'));
});

test('readiness failure leaves the viewer unchanged', async () => {
  const error = new Error('viewer unavailable');
  let loads = 0;
  const emptyState = { hidden: false };
  const show = createNiivueVolumePreview({
    viewer: {
      loadVolumes: async () => {
        loads++;
      },
      removeAllVolumes: async () => {
        loads++;
      },
    },
    ready: Promise.reject(error),
    emptyState,
  });
  await assert.rejects(show(a), (actual) => actual === error);
  assert.equal(loads, 0);
  assert.equal(emptyState.hidden, false);
});


test('the shared queue restores every field of a complete renderer snapshot', async () => {
  const accepted = Object.freeze({ file: 'components.nii', base: 'S0map.nii', frame: 3, range: Object.freeze([0.3, 0.7]), label: 'ICA 3' });
  const replacement = Object.freeze({ file: 'new-input.nii', base: null, frame: 0, range: null, label: 'New echo' });
  const entered = deferred();
  const release = deferred();
  let visible;
  const draws = [];
  const show = createPreviewQueue({
    ready: Promise.resolve(),
    render: async snapshot => {
      visible = snapshot && structuredClone(snapshot);
      draws.push(snapshot?.file ?? null);
      if (snapshot === replacement) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  await show(accepted);
  const controller = new AbortController();
  const failed = assert.rejects(show(replacement, { signal: controller.signal }), { name: 'AbortError' });
  await entered.promise;
  controller.abort();
  release.resolve();
  await failed;
  assert.deepEqual(visible, { file: 'components.nii', base: 'S0map.nii', frame: 3, range: [0.3, 0.7], label: 'ICA 3' });
  assert.deepEqual(draws, ['components.nii', 'new-input.nii', 'components.nii']);
});
