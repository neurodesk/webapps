import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { finalNcc } from '../src/node.js';
import { registeredFileName } from '../src/outputs.js';

const cli = fileURLToPath(new URL('../bin/fireants.js', import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

// A 24^3 float32 NIfTI-1 holding a Gaussian blob centred at `centre` (voxels), 2 mm isotropic.
function blob(centre) {
  const size = 24;
  const bytes = Buffer.alloc(352 + size ** 3 * 4);
  bytes.writeInt32LE(348, 0);
  for (const [offset, value] of [[40, 3], [42, size], [44, size], [46, size], [48, 1], [70, 16], [72, 32]]) bytes.writeInt16LE(value, offset);
  for (const [offset, value] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1]]) bytes.writeFloatLE(value, offset);
  bytes.writeInt16LE(1, 254);
  for (const [offset, value] of [[280, 2], [284, 0], [288, 0], [292, -24], [296, 0], [300, 2], [304, 0], [308, -24], [312, 0], [316, 0], [320, 2], [324, -24]]) bytes.writeFloatLE(value, offset);
  bytes.write('n+1\0', 344, 'latin1');
  for (let k = 0; k < size; k += 1) {
    for (let j = 0; j < size; j += 1) {
      for (let i = 0; i < size; i += 1) {
        const distance = (i - centre[0]) ** 2 + (j - centre[1]) ** 2 + (k - centre[2]) ** 2;
        bytes.writeFloatLE(1000 * Math.exp(-distance / 18), 352 + 4 * (i + size * (j + size * k)));
      }
    }
  }
  return bytes;
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'fireants-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moving = join(root, 'moving_T1w.nii');
  const fixed = join(root, 'fixed.nii');
  await writeFile(moving, blob([13, 12, 11]));
  await writeFile(fixed, blob([11, 12, 12]));
  return { root, moving, fixed };
}

test('the registered image keeps the web download name', () => {
  assert.equal(registeredFileName('t1_brain.nii.gz'), 't1_brain_registered.nii.gz');
  assert.equal(registeredFileName('scan.NII'), 'scan_registered.nii.gz');
});

test('the final similarity is the last stage NCC the engine logs', () => {
  const log = 'Moments: 1.3s (NCC -0.7516)\n  Rigid: 229.5s (NCC -0.7170)\n  Greedy: 75.5s (NCC -0.8586)\nTotal: 563.2s';
  assert.equal(finalNcc(log), -0.8586);
  assert.equal(finalNcc('Total: 1.0s'), null);
});

test('a registration writes only the gzipped registered image on the fixed grid', async (t) => {
  const { root, moving, fixed } = await workspace(t);
  const output = join(root, 'results');
  const result = run([moving, fixed, output, '--threads', '2']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(output), ['moving_T1w_registered.nii.gz']);
  assert.equal(result.stdout.trim(), join(output, 'moving_T1w_registered.nii.gz'));
  assert.match(result.stderr, /greedy registration on 2 CPU threads in [\d.]+ s, final NCC -0\.\d+/);
  const image = gunzipSync(await readFile(join(output, 'moving_T1w_registered.nii.gz')));
  assert.deepEqual([42, 44, 46].map((offset) => image.readInt16LE(offset)), [24, 24, 24]);
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

test('only the automation presets, positive thread counts and CPU execution are accepted', async (t) => {
  const { root, moving, fixed } = await workspace(t);
  const output = join(root, 'results');
  for (const [args, message] of [
    [['--transform', 'rigid'], /Transform must be greedy or syn/],
    [['--threads', '0'], /Threads must be a positive integer/],
    [['--threads', '2.5'], /Threads must be a positive integer/],
    [['--backend', 'webgpu'], /Unknown option '--backend'/],
  ]) {
    const result = run([moving, fixed, output, ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
  }
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('help states that brain extraction and WebGPU are not included', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /MindGrab brain extraction is not\s+included/);
  assert.match(result.stdout, /CPU only/);
});

test('download-models installs nothing because FireANTs uses no model files', async (t) => {
  const { root } = await workspace(t);
  const cache = join(root, 'models');
  const result = run(['download-models', '--cache-dir', cache]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /needs no model files/);
  await assert.rejects(readdir(cache), { code: 'ENOENT' });
});

test('self-check compiles the engine and reports the Node runtime that ran it', () => {
  const result = run(['self-check']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
  assert.match(report.engine, /^@fireants\/fireants \d+\.\d+\.\d+$/);
  assert.equal(report.backend, 'cpu');
});
