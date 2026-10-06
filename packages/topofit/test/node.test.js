import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import manifest from '../model.manifest.json' with { type: 'json' };
import { MODEL_ASSETS, checkInstallation, downloadModels, reconstruct } from '../src/node.js';

const cli = fileURLToPath(new URL('../bin/topofit.js', import.meta.url));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'topofit-node-'));
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

test('offline installation names the first missing model file and never downloads', async (t) => {
  const { cache } = await workspace(t);
  const requests = forbidNetwork(t);
  await assert.rejects(
    downloadModels({ cacheDir: cache, offline: true }),
    new RegExp(`${manifest.assets[0].filename} is missing from the offline model directory`),
  );
  assert.deepEqual(requests, []);
});

test('a corrupted cached model fails verification instead of loading', async (t) => {
  const { cache } = await workspace(t);
  forbidNetwork(t);
  const [first] = manifest.assets;
  await mkdir(cache);
  await writeFile(join(cache, first.filename), Buffer.alloc(first.bytes));
  await assert.rejects(
    downloadModels({ cacheDir: cache, offline: true }),
    new RegExp(`Cached ${first.filename} failed checksum verification`),
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
  assert.deepEqual(downloaded, [new URL(manifest.assets[0].filename, manifest.base_url).href]);
  assert.deepEqual(await readdir(cache).catch(() => []), []);
});

test('installation holds every asset of the validated preset and no unvalidated graph', () => {
  const names = MODEL_ASSETS.map(({ filename }) => filename);
  assert.ok(names.includes('trega-synth-random.onnx'));
  assert.ok(names.includes('topofit-t1w-1mm-white-order-6.onnx'));
  assert.ok(names.includes('faces-lh.i32'));
  assert.deepEqual(names.filter((name) => name.startsWith('topofit-synth-')), []);
  assert.equal(names.length, manifest.assets.filter(({ filename }) => !filename.startsWith('topofit-synth-')).length);
});

test('reconstruction refuses a non-empty output directory and keeps its contents', async (t) => {
  const { root, input, cache } = await workspace(t);
  const output = join(root, 'existing');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'preserve');
  await assert.rejects(reconstruct({ input, output, cacheDir: cache, offline: true }), /is not empty/);
  const result = run([input, output, '--cache-dir', cache]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not empty/);
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
  await assert.rejects(reconstruct({ input, output: join(root, 'out'), threads: 2.5, cacheDir: cache, offline: true }), /positive integer/);
  assert.deepEqual(await readdir(root), ['input.nii']);
});

test('unknown model presets are rejected with the available choice', async (t) => {
  const { root, input, cache } = await workspace(t);
  for (const model of ['synth-1mm', 'T1w']) {
    const result = run([input, join(root, 'out'), '--model', model, '--cache-dir', cache]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Unknown TopoFit model ${model}\\. Available: t1w-1mm\\.`));
  }
  assert.deepEqual(await readdir(root), ['input.nii']);
});

test('command line reports help, rejects unsupported options and checks the CPU runtime', async () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-conform/);
  assert.match(help.stdout, /web app only/);
  const executionProvider = run(['input.nii', 'out', '--ep', 'coreml']);
  assert.equal(executionProvider.status, 1);
  assert.match(executionProvider.stderr, /Unknown option '--ep'/);
  const report = await checkInstallation();
  assert.equal(report.executable, process.execPath);
  assert.equal(report.onnxRuntime, '1.29.0');
  assert.equal(report.executionProvider, 'cpu');
  assert.equal(report.models, undefined);
});
