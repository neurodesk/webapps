import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNiftiFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { MODEL_KEYS, selectModel, segment, validateSettings, resolveThreads } from '../src/node.js';
const cli = fileURLToPath(new URL('../bin/musclemap.js', import.meta.url));
test('all seven checkpoint keys retain their own label space and verified asset', () => {
  assert.equal(MODEL_KEYS.length, 7);
  assert.equal(new Set(MODEL_KEYS.map(key => selectModel(key).asset.sha256)).size, 7);
  assert.equal(selectModel().model.modelVersion, '1.4');
  for (const key of MODEL_KEYS) {
    const { model, asset } = selectModel(key);
    assert.equal(model.labelSpaceId, model.labelSpace.id);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => selectModel('unknown'), /Unknown model/);
});
test('numeric and IMF option guards reject unsupported inputs', () => {
  for (const overlap of [-1, 1, NaN, 'abc']) assert.throws(() => validateSettings({ overlap }), /Overlap/);
  for (const sourceChunkSize of [0, -1, 1.5, 'abc']) assert.throws(() => validateSettings({ sourceChunkSize }), /Source chunk/);
  for (const batchSize of [0, 1.5, 3, 5]) assert.throws(() => validateSettings({ batchSize }), /Batch/);
  assert.throws(() => validateSettings({ imfMethod: 'random' }), /IMF method/);
  assert.throws(() => validateSettings({ imfComponents: 4 }), /IMF components/);
  for (const value of [0, -1, 1.5, 'abc']) assert.throws(() => resolveThreads(value), /Threads/);
});
test('CLI rejects unknown, duplicate and command-inapplicable options before work', () => {
  for (const args of [['self-check', '--threads', '4'], ['download-models', '--model', 'leg-v0.0'],
    ['--wat'], ['a.nii', 'out', '--threads', '4', '--threads', '2']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 1, `${args}: ${run.stdout}`);
    assert.match(run.stderr, /accepts|Unknown option|Repeated option/);
  }
});
test('offline missing, corrupted model and nonempty output guards leave files untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'musclemap-guards-'));
  try {
    const cacheDir = join(root, 'models');
    const input = join(root, 'input.nii');
    const output = join(root, 'output');
    await mkdir(cacheDir);
    const data = createNiftiFromVolume({ dims: [2, 2, 2], img: new Float32Array(8).fill(1) });
    await writeFile(input, new Uint8Array(data));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => { throw new Error('Offline inference attempted a network request'); };
      await assert.rejects(segment({ input, output, cacheDir, offline: true }), /missing from the offline/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await assert.rejects(readdir(output), { code: 'ENOENT' });
    const { asset } = selectModel();
    await writeFile(join(cacheDir, asset.filename), 'corrupt');
    await assert.rejects(segment({ input, output, cacheDir, offline: true }), /checksum/);
    await mkdir(output);
    await writeFile(join(output, 'keep.txt'), 'original');
    await assert.rejects(segment({ input, output, cacheDir, offline: true }), /not empty/);
    assert.deepEqual(await readdir(output), ['keep.txt']);
    await assert.rejects(segment({ input, output: join(root, 'new'), imfMethod: 'dixon' }), /requires --fat/);
    await assert.rejects(segment({ input, output: join(root, 'new'), fat: input, water: input }), /require a Dixon/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source CLI self-check writes nothing to a fresh HOME without CI', async () => {
  const home = await mkdtemp(join(tmpdir(), 'musclemap-no-ci-home-'));
  const env = { ...process.env };
  for (const key of ['CI', 'ORT_DISABLE_TELEMETRY', 'NEURODESK_MUSCLEMAP_MODEL_DIR']) delete env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = home;
  try {
    const run = spawnSync(process.execPath, [cli, 'self-check'], { encoding: 'utf8', env, timeout: 30_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.executable, process.execPath);
    assert.equal(report.node, process.version);
    assert.equal(report.onnxRuntime, '1.29.0');
    assert.deepEqual(await readdir(home, { recursive: true }), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
