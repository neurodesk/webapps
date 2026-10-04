import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { runSyncro } from '../src/pipeline.js';
import { writeVolume } from '../../synthsr/src/volume.js';

const volume = {
  dims: [10, 10, 10],
  affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  data: Float32Array.from({ length: 1000 }, (_, index) => index + 1),
};

function runWithWarped(warped, template = volume, compressed = false) {
  const source = writeVolume(volume);
  const calls = { complete: false, reslices: 0, releases: 0 };
  const bytes = new Uint8Array(writeVolume(warped));
  const transform = { warped: compressed ? gzipSync(bytes) : bytes };
  const result = runSyncro({
    input: source,
    template: writeVolume(template),
    synthesize: async () => ({ buffer: source, provenance: {} }),
    extractBrain: async () => ({ brain: volume, provenance: {} }),
    registration: {
      register: async () => transform,
      apply: async () => {
        calls.reslices += 1;
        return source;
      },
      release: (value) => {
        assert.equal(value, transform);
        calls.releases += 1;
      },
    },
    onProgress: (name) => {
      if (name === 'complete') calls.complete = true;
    },
  });
  return { result, calls };
}

for (const count of [0, 81, 99]) {
  test(`normalization rejects a brain reduced to ${count} voxels without publishing success`, async () => {
    const warped = { ...volume, data: Float32Array.from(volume.data, (_, index) => index < count ? 1 : 0) };
    const { result, calls } = runWithWarped(warped);
    await assert.rejects(result, /normalization failed.*template/i);
    assert.deepEqual(calls, { complete: false, reslices: 0, releases: 1 });
  });
}

test('exactly 10% template support passes the gross-loss screen', async () => {
  const warped = { ...volume, data: Float32Array.from(volume.data, (_, index) => index < 100 ? 1 : 0) };
  const { result, calls } = runWithWarped(warped);
  await result;
  assert.deepEqual(calls, { complete: true, reslices: 1, releases: 1 });
});

for (const count of [81, 600]) {
  test(`compressed registration output with ${count} supported voxels receives the same quality check`, async () => {
    const warped = { ...volume, data: Float32Array.from(volume.data, (_, index) => index < count ? 1 : 0) };
    const { result, calls } = runWithWarped(warped, volume, true);
    if (count === 81) {
      await assert.rejects(result, /normalization failed.*template/i);
      assert.deepEqual(calls, { complete: false, reslices: 0, releases: 1 });
    } else {
      await result;
      assert.deepEqual(calls, { complete: true, reslices: 1, releases: 1 });
    }
  });
}

test('non-finite normalized intensities fail before resampling and release registration', async () => {
  const warped = { ...volume, data: volume.data.slice() };
  warped.data[0] = NaN;
  const { result, calls } = runWithWarped(warped);
  await assert.rejects(result, /non-finite intensities/i);
  assert.deepEqual(calls, { complete: false, reslices: 0, releases: 1 });
});

test('foreground outside the template cannot make normalization pass', async () => {
  const template = { ...volume, data: Float32Array.from(volume.data, (_, index) => index < 500 ? 1 : 0) };
  const warped = { ...volume, data: Float32Array.from(volume.data, (_, index) => index >= 500 ? 1 : 0) };
  const { result, calls } = runWithWarped(warped, template);
  await assert.rejects(result, /normalization failed.*template/i);
  assert.deepEqual(calls, { complete: false, reslices: 0, releases: 1 });
});

test('normalization rejects a warped brain in a different physical frame and releases it', async () => {
  const warped = { ...volume, affine: volume.affine.map((row) => row.slice()) };
  warped.affine[0][3] = 10;
  const { result, calls } = runWithWarped(warped);
  await assert.rejects(result, /template grid/i);
  assert.deepEqual(calls, { complete: false, reslices: 0, releases: 1 });
});

test('substantial partial template support can still complete normalization', async () => {
  const warped = { ...volume, data: Float32Array.from(volume.data, (value, index) => index < 600 ? value : 0) };
  const { result, calls } = runWithWarped(warped);
  assert.deepEqual(Object.keys((await result).outputs), ['wbt1input.nii.gz', 'winput.nii.gz', 'wbinput.nii.gz']);
  assert.deepEqual(calls, { complete: true, reslices: 1, releases: 1 });
});
