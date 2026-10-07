import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readVolume } from '@neurodesk/synthsr';
import { SYNTHSTRIP_MODEL } from '@neurodesk/synthstrip/model';
import { MODEL_ASSETS, checkInstallation, defaultCacheDir, downloadModels, extract } from '../src/node.js';

const cli = fileURLToPath(new URL('../bin/brain-extraction.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'brain-extraction-node-'));
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

test('installation holds the SynthStrip graph the web app loads', () => {
  assert.deepEqual(MODEL_ASSETS, [SYNTHSTRIP_MODEL]);
});

test('the model directory comes from the launcher variable', () => {
  const original = process.env.NEURODESK_BRAIN_EXTRACTION_MODEL_DIR;
  process.env.NEURODESK_BRAIN_EXTRACTION_MODEL_DIR = '/opt/brain-extraction/models';
  try {
    assert.equal(defaultCacheDir(), '/opt/brain-extraction/models');
  } finally {
    if (original === undefined) delete process.env.NEURODESK_BRAIN_EXTRACTION_MODEL_DIR;
    else process.env.NEURODESK_BRAIN_EXTRACTION_MODEL_DIR = original;
  }
});

test('offline installation names the missing model and never downloads', async (t) => {
  const { cache } = await workspace(t);
  const requests = forbidNetwork(t);
  await assert.rejects(downloadModels({ cacheDir: cache, offline: true }), /synthstrip-browser\.onnx is missing from the offline model directory/);
  assert.deepEqual(requests, []);
});

test('the launcher environment alone keeps SynthStrip offline and writes nothing', async (t) => {
  const { root, cache } = await workspace(t);
  const input = join(root, 'head.nii.gz');
  await copyFile(fixture, input);
  const result = run([input, join(root, 'out')], { NEURODESK_BRAIN_EXTRACTION_MODEL_DIR: cache, NEURODESK_OFFLINE: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthstrip-browser\.onnx is missing from the offline model directory/);
  assert.deepEqual((await readdir(root)).sort(), ['head.nii.gz', 'input.nii']);
});

test('a corrupted cached model fails verification instead of loading', async (t) => {
  const { cache } = await workspace(t);
  forbidNetwork(t);
  await mkdir(cache);
  await writeFile(join(cache, SYNTHSTRIP_MODEL.filename), Buffer.alloc(SYNTHSTRIP_MODEL.bytes));
  await assert.rejects(downloadModels({ cacheDir: cache, offline: true }), /Cached synthstrip-browser\.onnx failed checksum verification/);
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
  assert.deepEqual(downloaded, [SYNTHSTRIP_MODEL.url]);
  assert.deepEqual(await readdir(cache).catch(() => []), []);
});

test('BET runs offline without a model and writes the web app\'s file names', async (t) => {
  const { root, cache } = await workspace(t);
  const requests = forbidNetwork(t);
  const output = join(root, 'out');
  const scheduler = process.env.SLURM_CPUS_PER_TASK;
  process.env.SLURM_CPUS_PER_TASK = 'all';
  let result;
  try {
    result = await extract({ input: fixture, output, method: 'bet', fractionalIntensity: '0.5', cacheDir: cache, offline: true });
  } finally {
    if (scheduler === undefined) delete process.env.SLURM_CPUS_PER_TASK;
    else process.env.SLURM_CPUS_PER_TASK = scheduler;
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(await readdir(output), ['T1_bet_brain.nii', 'T1_bet_mask.nii']);
  assert.equal(result.maskVoxels, 246875);
  assert.equal(result.provenance.method, 'bet');
  assert.equal(result.provenance.fractionalIntensity, 0.5);
  const mask = await readFile(join(output, 'T1_bet_mask.nii'));
  assert.equal(readVolume(mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength)).dims.join('x'), '99x117x95');
});

test('extraction refuses a non-empty output directory and keeps its contents', async (t) => {
  const { root, cache } = await workspace(t);
  const output = join(root, 'existing');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'preserve');
  await assert.rejects(extract({ input: fixture, output, method: 'bet', cacheDir: cache, offline: true }), /is not empty/);
  const result = run([fixture, output, '--method', 'bet', '--cache-dir', cache]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'preserve');
});

test('two runs into one empty directory never mix their files', async (t) => {
  const { root, cache } = await workspace(t);
  const output = join(root, 'shared');
  const runs = await Promise.allSettled([0.5, 0.3].map((fractionalIntensity) => extract({ input: fixture, output, method: 'bet', fractionalIntensity, cacheDir: cache, offline: true })));
  const [succeeded, ...others] = runs.filter(({ status }) => status === 'fulfilled');
  const failed = runs.filter(({ status }) => status === 'rejected');
  assert.ok(succeeded);
  assert.deepEqual(others, []);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason.message, /is not empty|Another brain-extraction run/);
  assert.deepEqual(await readdir(output), ['T1_bet_brain.nii', 'T1_bet_mask.nii']);
  const mask = await readFile(join(output, 'T1_bet_mask.nii'));
  const voxels = readVolume(mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength)).data.reduce((sum, value) => sum + value, 0);
  assert.equal(voxels, succeeded.value.maskVoxels);
});

test('options a command does not use are refused instead of ignored', async (t) => {
  const { root, cache } = await workspace(t);
  const bet = run([fixture, join(root, 'out'), '--method', 'bet', '--threads', '2', '--cache-dir', cache]);
  assert.equal(bet.status, 1);
  assert.match(bet.stderr, /--threads applies to --method synthstrip only/);
  const selfCheck = run(['self-check', '--cache-dir', cache]);
  assert.equal(selfCheck.status, 1);
  assert.match(selfCheck.stderr, /self-check does not accept --cache-dir/);
  const download = run(['download-models', '--method', 'bet', '--cache-dir', cache]);
  assert.equal(download.status, 1);
  assert.match(download.stderr, /download-models does not accept --method/);
  assert.deepEqual(await readdir(root), ['input.nii']);
});

test('methods are synthstrip or bet, and mindgrab points to its issue', async (t) => {
  const { root, input, cache } = await workspace(t);
  for (const method of ['BET', 'fsl', '']) {
    const result = run([input, join(root, 'out'), `--method=${method}`, '--cache-dir', cache]);
    assert.equal(result.status, 1, method);
    assert.match(result.stderr, new RegExp(`Method must be synthstrip or bet, not "${method}"`), method);
  }
  const mindgrab = run([input, join(root, 'out'), '--method', 'mindgrab', '--cache-dir', cache]);
  assert.equal(mindgrab.status, 1);
  assert.match(mindgrab.stderr, /MindGrab is not available in the command line yet \(https:\/\/github\.com\/neurodesk\/webapps\/issues\/162\)/);
  assert.deepEqual(await readdir(root), ['input.nii']);
});

test('the fractional intensity is a number from 0 to 1 and applies to BET only', async (t) => {
  const { root, input, cache } = await workspace(t);
  for (const fraction of ['-0.1', '1.5', 'half', '1e-1', '0x1', '', 'NaN']) {
    const result = run([input, join(root, 'out'), '--method', 'bet', `--fractional-intensity=${fraction}`, '--cache-dir', cache]);
    assert.equal(result.status, 1, fraction);
    assert.match(result.stderr, /Fractional intensity must be a number from 0 to 1/, fraction);
  }
  const synthstrip = run([input, join(root, 'out'), '--fractional-intensity', '0.3', '--cache-dir', cache]);
  assert.equal(synthstrip.status, 1);
  assert.match(synthstrip.stderr, /--fractional-intensity applies to --method bet only/);
  await assert.rejects(extract({ input, output: join(root, 'out'), method: 'bet', fractionalIntensity: 2, cacheDir: cache, offline: true }), /from 0 to 1/);
  assert.deepEqual(await readdir(root), ['input.nii']);
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

test('command line reports help, rejects unsupported options and checks both runtimes', async () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--method NAME/);
  assert.match(help.stdout, /--fractional-intensity F/);
  const backend = run(['input.nii', 'out', '--backend', 'webgpu']);
  assert.equal(backend.status, 1);
  assert.match(backend.stderr, /Unknown option '--backend'/);
  const extra = run(['input.nii', 'out', 'more']);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Provide an input image and a new output directory/);
  const report = await checkInstallation();
  assert.equal(report.executable, process.execPath);
  assert.equal(report.onnxRuntime, '1.29.0');
  assert.ok(report.betSmokeTestVoxels > 0);
  assert.equal(report.models, undefined);
});
