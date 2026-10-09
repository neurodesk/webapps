import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AIR_TEMPLATE } from '../src/pipeline.js';

const cli = fileURLToPath(new URL('../bin/browserqc.js', import.meta.url));
const fixture = new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url);

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NEURODESK_OFFLINE: '', NEURODESK_BROWSERQC_MODEL_DIR: '', ...env } });
  if (result.error) throw result.error;
  return result;
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'browserqc-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'T1w.nii.gz');
  await copyFile(fixture, input);
  const cache = join(root, 'cache');
  await mkdir(cache);
  return { root, input, cache, output: join(root, 'results') };
}

test('offline, a missing air template fails before segmentation and names the fix', async (t) => {
  const { input, cache, output } = await workspace(t);
  const result = run([input, output, '--cache-dir', cache, '--offline']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /avg152T1\.nii\.gz is missing from the offline model directory .*browserqc download-models/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('NEURODESK_OFFLINE=1 is offline too, for runs and self-check of an installed release', async (t) => {
  const { input, cache, output } = await workspace(t);
  const result = run([input, output, '--cache-dir', cache], { NEURODESK_OFFLINE: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing from the offline model directory/);
  const check = run(['self-check'], { NEURODESK_BROWSERQC_MODEL_DIR: cache });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /missing from the offline model directory/);
});

test('a cached air template with other bytes is refused on load', async (t) => {
  const { input, cache, output } = await workspace(t);
  await writeFile(join(cache, AIR_TEMPLATE.name), 'not the template');
  const result = run([input, output, '--cache-dir', cache, '--offline']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`avg152T1\\.nii\\.gz has SHA-256 [0-9a-f]{64}, not the pinned ${AIR_TEMPLATE.sha256}`));
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('a non-empty output directory is refused and left untouched', async (t) => {
  const { input, cache, output } = await workspace(t);
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'existing');
  const result = run([input, output, '--cache-dir', cache, '--offline']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('invalid options and inputs fail before anything is written', async (t) => {
  const { root, input, cache, output } = await workspace(t);
  const text = join(root, 'notes.nii');
  await writeFile(text, 'not an image'.repeat(40));
  const array = join(root, 'array.json');
  await writeFile(array, '[1, 2]');
  const broken = join(root, 'broken.json');
  await writeFile(broken, '{"EchoTime": ');
  for (const [args, message] of [
    [[input, output, '--model', 'mindgrab'], /Choose a supported BrowserQC segmentation model: 16chan18cls, mindmap, mindsnap, mindmap-pve\./],
    [[input, output, '--model', 'toString'], /Choose a supported BrowserQC segmentation model/],
    [[input, output, '--threads', '2'], /Unknown option '--threads'/],
    [[input], /Provide an input image and a new output directory/],
    [[input, output, 'extra'], /Provide an input image and a new output directory/],
    [[text, output], /notes\.nii is not a NIfTI image/],
    [[input, output, '--bids', array], /array\.json must be a JSON object/],
    [[input, output, '--bids', broken], /broken\.json is not readable JSON/],
    [[join(root, 'missing.nii.gz'), output], /ENOENT/],
    [['self-check', 'extra'], /self-check does not accept arguments/],
    [['download-models', 'extra'], /download-models does not accept positional arguments/],
  ]) {
    const result = run([...args, '--cache-dir', cache, '--offline']);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}`);
    assert.match(result.stderr, message, args.join(' '));
  }
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('self-check reports the pinned runtimes and models', () => {
  const result = run(['self-check']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.mindgrab, '0.1.20260925');
  assert.equal(report.niimath, '1.4.20260928');
  assert.deepEqual(report.models, ['16chan18cls', 'mindmap', 'mindsnap', 'mindmap-pve']);
});
