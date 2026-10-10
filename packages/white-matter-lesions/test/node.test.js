import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeVolume } from '@neurodesk/synthsr';
import { FLAMES_FOLDS, SYNTHSTRIP } from '../src/assets.js';
import { MODEL_ASSETS, checkInstallation, defaultCacheDir, downloadModels, segment } from '../src/node.js';

const ort = await import('onnxruntime-node');

const cli = fileURLToPath(new URL('../bin/flames.js', import.meta.url));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'flames-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input.nii');
  await writeFile(input, 'not a NIfTI image');
  return { root, input, cache: join(root, 'models') };
}

function forbidNetwork(t) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error('network is not available in this test');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NEURODESK_OFFLINE: '1', ...env },
  });
  if (result.error) throw result.error;
  return result;
}

test('installation holds SynthStrip and all five folds, so the ensemble runs offline', () => {
  assert.deepEqual(MODEL_ASSETS.map(({ filename }) => filename), [
    'synthstrip-browser.onnx',
    'flames-fold0.onnx',
    'flames-fold1.onnx',
    'flames-fold2.onnx',
    'flames-fold3.onnx',
    'flames-fold4.onnx',
  ]);
});

test('the model directory comes from the launcher variable', () => {
  const original = process.env.NEURODESK_FLAMES_MODEL_DIR;
  process.env.NEURODESK_FLAMES_MODEL_DIR = '/opt/flames/models';
  try {
    assert.equal(defaultCacheDir(), '/opt/flames/models');
  } finally {
    if (original === undefined) delete process.env.NEURODESK_FLAMES_MODEL_DIR;
    else process.env.NEURODESK_FLAMES_MODEL_DIR = original;
  }
});

test('offline installation names the first missing model file and never downloads', async (t) => {
  const { cache } = await workspace(t);
  const requests = forbidNetwork(t);
  await assert.rejects(
    downloadModels({ cacheDir: cache, offline: true }),
    /synthstrip-browser\.onnx is missing from the offline model directory/,
  );
  assert.deepEqual(requests, []);
});

test('the launcher environment alone keeps the command line offline', async (t) => {
  const { root, cache } = await workspace(t);
  const input = join(root, 'flair.nii');
  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  await writeFile(input, new Uint8Array(writeVolume({ dims: [8, 8, 8], affine: identity, data: Float32Array.from({ length: 512 }, (_, i) => i) })));
  const result = run([input, join(root, 'out')], { NEURODESK_FLAMES_MODEL_DIR: cache, NEURODESK_OFFLINE: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthstrip-browser\.onnx is missing from the offline model directory/);
  assert.deepEqual((await readdir(root)).sort(), ['flair.nii', 'input.nii']);
});

test('a corrupted cached model fails verification instead of loading', async (t) => {
  const { cache } = await workspace(t);
  forbidNetwork(t);
  await mkdir(cache);
  await writeFile(join(cache, SYNTHSTRIP.filename), Buffer.alloc(SYNTHSTRIP.bytes));
  await assert.rejects(
    downloadModels({ cacheDir: cache, offline: true }),
    new RegExp(`Cached ${SYNTHSTRIP.filename} failed checksum verification`),
  );
});

test('a download that fails verification leaves no model file behind', async (t) => {
  const { cache } = await workspace(t);
  const downloaded = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) => {
    downloaded.push(String(url));
    return new Response('wrong bytes');
  };
  await assert.rejects(downloadModels({ cacheDir: cache, offline: false }), /download failed checksum verification/);
  assert.deepEqual(downloaded, [SYNTHSTRIP.url]);
  assert.deepEqual(await readdir(cache).catch(() => []), []);
});

test('segmentation refuses a non-empty output directory and keeps its contents', async (t) => {
  const { root, input, cache } = await workspace(t);
  const output = join(root, 'existing');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'preserve');
  await assert.rejects(segment({ input, output, cacheDir: cache, offline: true }), /is not empty/);
  const result = run([input, output, '--cache-dir', cache]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'preserve');
});

test('thread counts must be positive integers', async (t) => {
  const { root, input, cache } = await workspace(t);
  for (const threads of ['abc', '0', '-2', '1.5', '1e1', '0x10', '']) {
    const result = run([input, join(root, 'out'), `--threads=${threads}`, '--cache-dir', cache]);
    assert.equal(result.status, 1, threads);
    assert.match(result.stderr, /Threads must be a positive integer/, threads);
  }
  const fromScheduler = run([input, join(root, 'out'), '--cache-dir', cache], { SLURM_CPUS_PER_TASK: 'all' });
  assert.equal(fromScheduler.status, 1);
  assert.match(fromScheduler.stderr, /Threads must be a positive integer, not "all"/);
  await assert.rejects(segment({ input, output: join(root, 'out'), threads: 2.5, cacheDir: cache, offline: true }), /positive integer/);
  assert.deepEqual(await readdir(root), ['input.nii']);
});

test('the ensemble size is one fold or all five', async (t) => {
  const { root, input, cache } = await workspace(t);
  for (const folds of ['0', '2', '3', 'all', '5.0', '']) {
    const result = run([input, join(root, 'out'), `--folds=${folds}`, '--cache-dir', cache]);
    assert.equal(result.status, 1, folds);
    assert.match(result.stderr, new RegExp(`Folds must be 1 or 5, not "${folds.replace('.', '\\.')}"`), folds);
  }
  await assert.rejects(segment({ input, output: join(root, 'out'), folds: 4, cacheDir: cache, offline: true }), /Folds must be 1 or 5/);
  assert.deepEqual(await readdir(root), ['input.nii']);
});

test('self-check writes nothing to the home directory', async (t) => {
  const { root } = await workspace(t);
  const home = join(root, 'home');
  await mkdir(home);
  const result = spawnSync(process.execPath, [cli, 'self-check'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(home, { recursive: true }), []);
});

test('the direct Node API executes without writing to an empty home outside CI', async (t) => {
  const { root } = await workspace(t);
  const home = join(root, 'api-home');
  await mkdir(home);
  const script = `
    const { checkInstallation } = await import(${JSON.stringify(new URL('../src/node.js', import.meta.url).href)});
    console.log(JSON.stringify(await checkInstallation()));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).executionProvider, 'cpu');
  assert.deepEqual(await readdir(home, { recursive: true }), []);
});

test('command line reports help, rejects unsupported options and checks the CPU runtime', async () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--folds N/);
  assert.match(help.stdout, /--skull-stripped/);
  const backend = run(['input.nii', 'out', '--backend', 'webgpu']);
  assert.equal(backend.status, 1);
  assert.match(backend.stderr, /Unknown option '--backend'/);
  const extra = run(['input.nii', 'out', 'more']);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Provide an input image and a new output directory/);
  const report = await checkInstallation();
  assert.equal(report.executable, process.execPath);
  assert.equal(report.onnxRuntime, '1.29.0');
  assert.equal(report.executionProvider, 'cpu');
  assert.equal(report.models, undefined);
});


test('selected model preflight fails before opening a session or preprocessing the brain', async (t) => {
  const { root, cache } = await workspace(t);
  const input = join(root, 'empty-brain.nii');
  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  await writeFile(input, new Uint8Array(writeVolume({ dims: [2, 2, 2], affine: identity, data: new Float32Array(8) })));
  const original = ort.InferenceSession.create;
  ort.InferenceSession.create = () => assert.fail('preflight must precede all sessions');
  t.after(() => { ort.InferenceSession.create = original; });
  forbidNetwork(t);
  const options = { input, output: join(root, 'out'), skullStripped: true, folds: 5, cacheDir: cache, offline: true, threads: 1 };
  await assert.rejects(segment(options), /flames-fold0.onnx is missing/);
  await mkdir(cache);
  await writeFile(join(cache, FLAMES_FOLDS[0].filename), 'corrupt graph');
  await assert.rejects(segment(options), /flames-fold0.onnx failed checksum verification/);
  assert.deepEqual(await readdir(root), ['empty-brain.nii', 'input.nii', 'models']);
});
