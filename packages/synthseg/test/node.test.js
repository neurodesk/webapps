import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import automation from '../../../apps/synthseg/automation.json' with { type: 'json' };
import { MODEL_ASSETS, PARAMETERS, defaultCacheDir, downloadModels, parseParameters, segment } from '../src/node.js';
import { outputNames } from '../src/results.js';

const cli = fileURLToPath(new URL('../bin/synthseg.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
const [MODEL] = MODEL_ASSETS;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'synthseg-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input.nii.gz');
  await writeFile(input, await readFile(fixture));
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

test('the command line takes the app automation operation\'s parameters', () => {
  assert.deepEqual(PARAMETERS, automation.operations.segment.parameters);
  assert.deepEqual(parseParameters({}), { mode: 'default' });
  assert.deepEqual(parseParameters({ mode: 'fast', ct: true }), { mode: 'fast', ct: true });
  assert.throws(() => parseParameters({ mode: 'quick' }), /--mode: .*\(default or fast\)/);
  assert.deepEqual(outputNames('sub-01_T1w.nii.gz'), { labels: 'sub-01_T1w_synthseg.nii.gz', report: 'sub-01_T1w_synthseg.json' });
});

test('installation holds the pinned 53 MB model and the model directory comes from the launcher', () => {
  assert.deepEqual(MODEL_ASSETS.map(({ filename, bytes }) => [filename, bytes]), [['synthseg-2.0.onnx', 52983030]]);
  const original = process.env.NEURODESK_SYNTHSEG_MODEL_DIR;
  process.env.NEURODESK_SYNTHSEG_MODEL_DIR = '/opt/synthseg/models';
  try {
    assert.equal(defaultCacheDir(), '/opt/synthseg/models');
  } finally {
    if (original === undefined) delete process.env.NEURODESK_SYNTHSEG_MODEL_DIR;
    else process.env.NEURODESK_SYNTHSEG_MODEL_DIR = original;
  }
});

test('offline, a missing model is named and nothing is downloaded or written', async (t) => {
  const { root, input, cache } = await workspace(t);
  const requests = forbidNetwork(t);
  await assert.rejects(downloadModels({ cacheDir: cache, offline: true }), /synthseg-2\.0\.onnx is missing from the offline model directory/);
  assert.deepEqual(requests, []);
  const result = run([input, join(root, 'out')], { NEURODESK_SYNTHSEG_MODEL_DIR: cache });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthseg-2\.0\.onnx is missing from the offline model directory/);
  assert.deepEqual(await readdir(root), ['input.nii.gz']);
});

test('a cached model with the right size but the wrong bytes fails verification', async (t) => {
  const { root, input, cache } = await workspace(t);
  forbidNetwork(t);
  await mkdir(cache);
  await writeFile(join(cache, MODEL.filename), Buffer.alloc(MODEL.bytes));
  await assert.rejects(downloadModels({ cacheDir: cache, offline: true }), /Cached synthseg-2\.0\.onnx failed checksum verification/);
  await assert.rejects(segment({ input, output: join(root, 'out'), cacheDir: cache, offline: true }), /failed checksum verification/);
  assert.deepEqual((await readdir(root)).sort(), ['input.nii.gz', 'models']);
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
  assert.deepEqual(downloaded, [MODEL.url]);
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
});

test('invalid options fail before any model or output is touched', async (t) => {
  const { root, input, cache } = await workspace(t);
  const output = join(root, 'out');
  for (const [args, message] of [
    [['--mode', 'quick'], /--mode: .*\(default or fast\)/],
    [['--threads=0'], /Threads must be a positive integer/],
    [['--threads=1.5'], /Threads must be a positive integer/],
    [['--threads=abc'], /Threads must be a positive integer/],
    [['--unknown'], /Unknown option '--unknown'/],
  ]) {
    const result = run([input, output, '--cache-dir', cache, ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
  }
  const notNifti = join(root, 'input.txt');
  await writeFile(notNifti, 'text');
  assert.match(run([notNifti, output, '--cache-dir', cache]).stderr, /Choose a \.nii or \.nii\.gz image/);
  const fromScheduler = run([input, output, '--cache-dir', cache], { SLURM_CPUS_PER_TASK: 'all' });
  assert.match(fromScheduler.stderr, /Threads must be a positive integer, not "all"/);
  assert.deepEqual((await readdir(root)).sort(), ['input.nii.gz', 'input.txt']);
});

const localModel = fileURLToPath(new URL('../../../exes/synthseg/models/', import.meta.url));
const skipWithoutModel = await readFile(join(localModel, MODEL.filename)).then(() => false, () => 'needs exes/synthseg/models (make -C exes/synthseg check-model)');

test('the command line writes the app\'s label map and report for the small fixture', { skip: skipWithoutModel, timeout: 10 * 60_000 }, async (t) => {
  const { root, input } = await workspace(t);
  const output = join(root, 'out');
  const result = run([input, output, '--mode', 'fast', '--threads', '2'], { NEURODESK_SYNTHSEG_MODEL_DIR: localModel });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(output)).sort(), ['input_synthseg.json', 'input_synthseg.nii.gz']);
  const report = JSON.parse(await readFile(join(output, 'input_synthseg.json'), 'utf8'));
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'app', 'appVersion', 'runId', 'status', 'inputs', 'parameters', 'provenance', 'artifacts', 'measurements']);
  assert.deepEqual(report.parameters, { mode: 'fast', ct: false });
  assert.equal(report.provenance.threads, 2);
  assert.equal(report.provenance.fast, true);
  assert.equal(report.artifacts.labels.filename, 'input_synthseg.nii.gz');
  assert.ok(report.measurements.labels.length > 20, 'the fixture is labelled');
});
