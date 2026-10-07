import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { REGISTRATION_WASM_SHA256 } from '@neurodesk/registration/node';
import { artifactName } from '../src/outputs.js';

const cli = fileURLToPath(new URL('../bin/ants.js', import.meta.url));
const fixture = new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url);
const WEB_NAMES = ['moving_T1w_registered.nii.gz', 'moving_T1w_0GenericAffine.mat', 'moving_T1w_1Warp.nii.gz', 'moving_T1w_1InverseWarp.nii.gz'];

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'ants-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moving = join(root, 'moving_T1w.nii.gz');
  const fixed = join(root, 'fixed.nii.gz');
  await copyFile(fixture, moving);
  await copyFile(fixture, fixed);
  return { root, moving, fixed };
}

test('outputs keep the web download names', () => {
  assert.equal(artifactName('t1_brain.nii.gz', 'registered'), 't1_brain_registered.nii.gz');
  assert.equal(artifactName('scan.NII', 'affine'), 'scan_0GenericAffine.mat');
  assert.equal(artifactName('scan.nii', 'warp'), 'scan_1Warp.nii.gz');
  assert.equal(artifactName('scan.nii.gz', 'inverse-warp'), 'scan_1InverseWarp.nii.gz');
});

test('a registration writes the four web downloads, lists them on stdout and logs to stderr', async (t) => {
  const { root, moving, fixed } = await workspace(t);
  const output = join(root, 'results');
  const result = run([moving, fixed, output]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(output)).sort(), [...WEB_NAMES].sort());
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), WEB_NAMES.map((name) => join(output, name)));
  assert.match(result.stderr, /Elapsed time \(stage 1\)/);
  assert.match(result.stderr, /ANTs SyN registration in [\d.]+ s/);
  const fixedHeader = gunzipSync(await readFile(fixed));
  for (const name of [WEB_NAMES[0], WEB_NAMES[2], WEB_NAMES[3]]) {
    const image = gunzipSync(await readFile(join(output, name)));
    assert.deepEqual([42, 44, 46].map((offset) => image.readInt16LE(offset)), [42, 44, 46].map((offset) => fixedHeader.readInt16LE(offset)), name);
  }
  const affine = await readFile(join(output, WEB_NAMES[1]));
  assert.match(affine.toString('latin1'), /AffineTransform_float_3_3/);
});

test('a non-empty output directory is refused and left untouched', async (t) => {
  const { root, moving, fixed } = await workspace(t);
  const output = join(root, 'results');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'existing');
  const result = run([moving, fixed, output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('invalid arguments and inputs fail before anything is written', async (t) => {
  const { root, moving, fixed } = await workspace(t);
  const output = join(root, 'results');
  const text = join(root, 'notes.nii');
  await writeFile(text, 'not an image'.repeat(40));
  for (const [args, message] of [
    [[moving, fixed, output, '--transform', 'syn'], /Unknown option '--transform'/],
    [[moving, fixed], /Provide a moving image, a fixed image and a new output directory/],
    [[moving, fixed, output, 'extra'], /Provide a moving image, a fixed image and a new output directory/],
    [[moving, fixed, output, '--cache-dir', root], /--cache-dir applies only to download-models/],
    [[text, fixed, output], /moving image .*notes\.nii is not NIfTI/],
    [[moving, text, output], /fixed image .*notes\.nii is not NIfTI/],
    [[join(root, 'missing.nii.gz'), fixed, output], /ENOENT/],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
    await assert.rejects(readdir(output), { code: 'ENOENT' }, args.join(' '));
  }
});

test('help states that brain extraction is not included and the memory limit', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Brain extraction is not included/);
  assert.match(result.stdout, /issues\/162/);
  assert.match(result.stdout, /SynthStrip/);
  assert.match(result.stdout, /4 GiB/);
  assert.match(result.stdout, /ANTsPy\s+0\.6\.1/);
});

test('download-models installs nothing because ANTs uses no model files', async (t) => {
  const { root } = await workspace(t);
  const cache = join(root, 'models');
  const result = run(['download-models', '--cache-dir', cache]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /needs no model files/);
  await assert.rejects(readdir(cache), { code: 'ENOENT' });
});

test('self-check loads the pinned kernel and reports the Node runtime that ran it', () => {
  const result = run(['self-check']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
  assert.equal(report.registrationWasmSha256, REGISTRATION_WASM_SHA256);
  assert.match(report.engine, /^ANTs 2\.6\.2 WebAssembly/);
});
