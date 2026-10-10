import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAsset,
  hash,
  assertNewOutput,
  validateOptions,
  mapLesion,
  prepareLesion,
} from '../src/node.js';
import { map, prepare } from '../src/pipeline.js';
import { assertAtlasGrid } from '../src/nifti.js';
import { writeNifti1 } from '../src/nifti-writer.js';

test('offline missing models and corrupted installed assets fail without writes', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'calmar-guards-'));
  try {
    const asset = {
      filename: 'model.onnx',
      bytes: 4,
      sha256: hash('real'),
      url: 'https://example.invalid/model',
    };
    await assert.rejects(loadAsset(asset, { cacheDir, offline: true }), /Offline asset missing/);
    assert.deepEqual(await readdir(cacheDir), []);
    await writeFile(join(cacheDir, asset.filename), 'fake');
    await assert.rejects(loadAsset(asset, { cacheDir, offline: true }), /checksum/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('occupied output directories are preserved', async () => {
  const output = await mkdtemp(join(tmpdir(), 'calmar-output-'));
  try {
    await writeFile(join(output, 'keep'), 'data');
    await assert.rejects(assertNewOutput(output), /not empty/);
    await assert.rejects(prepareLesion({ input: 'missing', output }), /not empty/);
    await assert.rejects(mapLesion({ input: 'missing', output, reviewed: true }), /not empty/);
    assert.deepEqual(await readdir(output), ['keep']);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('invalid atlas, thread, quantile and cluster options fail', () => {
  for (const options of [
    { atlas: 'unknown' },
    { threads: 0 },
    { threads: 1.1 },
    { threshold: NaN },
    { threshold: 1.1 },
    { minCluster: -1 },
  ])
    assert.throws(() => validateOptions(options));
});

test('review is required before any mapping or asset access', async () => {
  await assert.rejects(mapLesion({ input: 'missing', output: 'unused' }), /Review/);
  await assert.rejects(
    map(
      {},
      {
        assertAtlasGrid() {
          throw new Error('reached computation');
        },
      }
    ),
    /Review/
  );
  const result = await prepare('input', { segment: async (input) => input });
  assert.equal(result.requiresReview, true);
});

test('mapping refuses mismatched dimensions and affines', () => {
  const atlas = {
    dims: [2, 2, 2],
    affine: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
  };
  assert.throws(() => assertAtlasGrid({ ...atlas, dims: [3, 2, 2] }, atlas), /atlas grid/);
  assert.throws(
    () => assertAtlasGrid({ ...atlas, affine: [[1, 0, 0, 1], ...atlas.affine.slice(1)] }, atlas),
    /atlas grid/
  );
});

test('invalid options reach the command operations before file or model access', async () => {
  await assert.rejects(
    prepareLesion({ input: 'missing', output: 'unused', threads: 0 }),
    /Threads/
  );
  await assert.rejects(
    mapLesion({ input: 'missing', output: 'unused', reviewed: true, atlas: 'unknown' }),
    /Atlas/
  );
  await assert.rejects(
    mapLesion({ input: 'missing', output: 'unused', reviewed: true, threshold: 2 }),
    /Threshold/
  );
  await assert.rejects(
    mapLesion({ input: 'missing', output: 'unused', reviewed: true, minCluster: -1 }),
    /cluster/
  );
});


test('native reviewed masks must match their structural T1 before any asset access', async () => {
  const work = await mkdtemp(join(tmpdir(), 'calmar-native-grid-'));
  try {
    const input = join(work, 'mask.nii');
    const structural = join(work, 'T1.nii');
    await writeFile(input, new Uint8Array(writeNifti1(new Uint8Array([0, 1]), { dims: [2, 1, 1] })));
    await writeFile(structural, new Uint8Array(writeNifti1(new Float32Array(4).fill(1), { dims: [2, 2, 1] })));
    await assert.rejects(
      mapLesion({ input, structural, output: join(work, 'output'), reviewed: true, offline: true, cacheDir: join(work, 'missing-models') }),
      /Reviewed native lesion mask must match the --structural T1 dimensions and affine/
    );
    assert.deepEqual((await readdir(work)).sort(), ['T1.nii', 'mask.nii']);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
