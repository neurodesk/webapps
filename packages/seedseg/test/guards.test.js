import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNiftiFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { MODEL_ASSETS, resolveSettings, segment } from '../src/node.js';
import { resolveModels } from '../src/assets.js';
const cli = fileURLToPath(new URL('../bin/seedseg.js', import.meta.url));

test('model and numeric guards preserve published order and reject invalid selections', () => {
  assert.equal(MODEL_ASSETS.length, 4);
  assert.deepEqual(resolveModels([789, 42]).map(asset => asset.seed), [42, 789]);
  for (const models of [[], [42, 42], [42, 'seed42'], [1], [42, 123, 456, 789, 42]]) {
    assert.throws(() => resolveSettings({ models }), /distinct|Unknown|four/);
  }
  assert.throws(() => resolveSettings({ models: [42], ensemble: 1 }), /Choose/);
  for (const ensemble of [0, 5, 1.5, 'abc']) assert.throws(() => resolveSettings({ ensemble }), /Ensemble/);
  for (const threshold of [-0.1, 1.1, NaN, Infinity, '', 'abc']) assert.throws(() => resolveSettings({ threshold }), /Threshold/);
  for (const nMarkers of [0, 11, 1.5, 'abc']) assert.throws(() => resolveSettings({ nMarkers }), /Top-N/);
  for (const threads of [0, -1, 1.5, 'abc']) assert.throws(() => resolveSettings({ threads }), /Threads/);
});

test('CLI rejects unknown, repeated and command-inapplicable options before work', () => {
  for (const args of [['--wat'], ['self-check', '--ensemble', '1'], ['download-models', '--top-n', '2'],
    ['a.nii', 'out', '--threads', '2', '--threads', '4'], ['a.nii', 'out', '--markers', '2', '--top-n', '3']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Unknown option|accepts|Repeated option|Choose one/);
  }
});

test('offline missing and corrupt models, and nonempty outputs, fail without changing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seedseg-guards-'));
  try {
    const input = join(root, 'input.nii');
    const output = join(root, 'results');
    const cacheDir = join(root, 'models');
    await mkdir(cacheDir);
    await writeFile(input, new Uint8Array(createNiftiFromVolume({ img: Float32Array.of(1), hdr: {
      dims: [1, 1, 1], pixDims: [1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    } })));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => { throw new Error('Offline command attempted a network request'); };
      await assert.rejects(segment({ input, output, ensemble: 1, cacheDir, offline: true }), /missing from the offline/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await assert.rejects(readdir(output), { code: 'ENOENT' });
    await writeFile(join(cacheDir, MODEL_ASSETS[0].filename), 'corrupt');
    await assert.rejects(segment({ input, output, ensemble: 1, cacheDir, offline: true }), /checksum/);
    await mkdir(output);
    await writeFile(join(output, 'keep.txt'), 'original');
    await assert.rejects(segment({ input, output, ensemble: 1, cacheDir, offline: true }), /not empty/);
    assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'original');
    assert.deepEqual(await readdir(output), ['keep.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source CPU/QSM self-check leaves a fresh HOME and Windows app-data directories empty without CI', async () => {
  const home = await mkdtemp(join(tmpdir(), 'seedseg-no-ci-home-'));
  const env = { ...process.env };
  for (const key of ['CI', 'ORT_DISABLE_TELEMETRY', 'NEURODESK_SEEDSEG_MODEL_DIR']) delete env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = home;
  try {
    const run = spawnSync(process.execPath, [cli, 'self-check'], { encoding: 'utf8', env, timeout: 30_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.executable, process.execPath);
    assert.equal(report.node, process.version);
    assert.equal(report.onnxRuntime, '1.29.0');
    assert.equal(report.qsmVersion, '0.9.2');
    assert.deepEqual(await readdir(home, { recursive: true }), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('package model and QSM runtime pins equal the authoritative repository manifests', async () => {
  const model = JSON.parse(await readFile(new URL('../model.manifest.json', import.meta.url)));
  const repositoryModel = JSON.parse(await readFile(new URL('../../../models/seedseg.manifest.json', import.meta.url)));
  assert.deepEqual(model, repositoryModel);
  const runtime = JSON.parse(await readFile(new URL('../runtime.manifest.json', import.meta.url)));
  const repositoryRuntime = JSON.parse(await readFile(new URL('../../../runtime-assets/manifest.json', import.meta.url)));
  assert.deepEqual(runtime, [...repositoryRuntime.families, ...repositoryRuntime.downloads].find(group => group.id === 'qsm-wasm'));
});

 test('QSM host logging restores console.log when the synchronous runtime throws', async () => {
  const { withStderrLogging } = await import('../src/node.js');
  const previous = console.log;
  assert.throws(() => withStderrLogging(() => { throw new Error('QSM failure'); }), /QSM failure/);
  assert.equal(console.log, previous);
});
