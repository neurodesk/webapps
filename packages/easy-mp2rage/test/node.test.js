import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import automation from '../../../apps/easy-mp2rage/automation.json' with { type: 'json' };
import { readNifti } from '../src/nifti.js';
import { outputFiles } from '../src/outputs.js';

const cli = fileURLToPath(new URL('../bin/easy-mp2rage.js', import.meta.url));
const phantom = fileURLToPath(new URL('../../../apps/easy-mp2rage/tools/phantom/', import.meta.url));
const golden = fileURLToPath(new URL('../../../apps/easy-mp2rage/tools/golden/', import.meta.url));
const MP2RAGE = '4.3,0.840,2.370,5,6,64,128,0.007,0.96';
const SA2RAGE = '2.4,0.150,1.500,6,6,24,24,0.005,1.5';
const UNI = join(phantom, 'phantom_UNI.nii.gz');
const INV2 = join(phantom, 'phantom_INV2.nii.gz');
const SA = join(phantom, 'phantom_SA2RAGE.nii.gz');
const B1 = join(phantom, 'phantom_B1map_tfl.nii.gz');

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'easy-mp2rage-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function goldenT1() {
  return readFile(join(golden, 'v_corr_T1_ms.npy')).then((bytes) => {
    const headerLength = bytes.readUInt16LE(8);
    const [nx, ny, nz] = bytes.toString('latin1', 10, 10 + headerLength).match(/'shape':\s*\(([^)]*)\)/)[1].split(',').map(Number);
    const values = new Float64Array(nx * ny * nz);
    for (let i = 0; i < nx; i += 1) {
      for (let j = 0; j < ny; j += 1) {
        for (let k = 0; k < nz; k += 1) values[i + nx * (j + ny * k)] = bytes.readDoubleLE(10 + headerLength + 8 * ((i * ny + j) * nz + k));
      }
    }
    return values;
  });
}

test('every automation operation writes exactly its declared artifacts', () => {
  const declared = (operation) => Object.keys(automation.operations[operation].artifacts).filter((key) => key !== 'parameters').sort();
  for (const mode of ['b1map', 'sa2rage']) {
    assert.deepEqual(outputFiles('t1', mode).map(([key]) => key).sort(), declared('correct'));
  }
  assert.deepEqual(outputFiles('denoise').map(([key]) => key).sort(), declared('denoise'));
});

test('SA2RAGE correction writes the web download files and matches the Python golden T1', async (t) => {
  const output = join(await workspace(t), 'results');
  const result = run(['correct', '--uni', UNI, '--inv2', INV2, '--sa2rage', SA, '--sa2rage-params', SA2RAGE, '--mp2rage', MP2RAGE, output]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(output)).sort(), ['B1map_from_SA2RAGE.nii.gz', 'T1map.nii.gz', 'T1map_uncorrected.nii.gz', 'UNI_b1corrected.nii.gz', 'parameters.json']);
  const bytes = await readFile(join(output, 'T1map.nii.gz'));
  const t1 = await readNifti(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const expected = await goldenT1();
  const worst = expected.reduce((largest, value, index) => Math.max(largest, Math.abs(t1.data[index] - value)), 0);
  assert.ok(worst < 0.1, `worst |diff| ${worst} ms`);
  const parameters = JSON.parse(await readFile(join(output, 'parameters.json'), 'utf8'));
  assert.equal(parameters.mode, 'sa2rage');
  assert.deepEqual(parameters.sa2rage, SA2RAGE.split(',').map(Number));
  assert.deepEqual(parameters.mp2rage, MP2RAGE.split(',').map(Number));
});

test('a non-empty output directory is refused and left untouched', async (t) => {
  const output = join(await workspace(t), 'results');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'existing');
  const result = run(['correct', '--uni', UNI, '--b1', B1, '--b1-type', 'tfl', '--mp2rage', MP2RAGE, output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('correction requires exactly one B1 source with declared units and a full acquisition', async (t) => {
  const output = join(await workspace(t), 'results');
  const cases = [
    [['--b1', B1, '--b1-type', 'tfl', '--sa2rage', SA, '--sa2rage-params', SA2RAGE, '--mp2rage', MP2RAGE], /exactly one B1 source/],
    [['--mp2rage', MP2RAGE], /exactly one B1 source/],
    [['--b1', B1, '--mp2rage', MP2RAGE], /B1 map units/],
    [['--b1', B1, '--b1-type', 'degrees', '--mp2rage', MP2RAGE], /B1 map units/],
    [['--sa2rage', SA, '--mp2rage', MP2RAGE], /nine SA2RAGE/],
    [['--b1', B1, '--b1-type', 'tfl', '--mp2rage', '4.3,0.84,2.37'], /needs 9 comma-separated values/],
    [['--b1', B1, '--b1-type', 'tfl', '--mp2rage', '4.3,0.840,2.370,5,6,64,128,0.007,1.2'], /must not exceed 1/],
    [['--b1', B1, '--b1-type', 'tfl', '--mp2rage', '4.3,0.840,2.370,5,6,64,128,0,0.96'], /TRFLASH must be a positive number/],
  ];
  for (const [args, message] of cases) {
    const result = run(['correct', '--uni', UNI, ...args, output]);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
  }
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('denoising refuses inversion images on a different grid', async (t) => {
  const output = join(await workspace(t), 'results');
  const result = run(['denoise', '--uni', UNI, '--inv1', B1, '--inv2', INV2, output]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INV1 \(9x8x7\) and UNI \(24x20x18\) have different dimensions/);
});

test('each command rejects the other command\'s options', async (t) => {
  const output = join(await workspace(t), 'results');
  const denoise = run(['denoise', '--uni', UNI, '--inv1', INV2, '--inv2', INV2, '--b1', B1, output]);
  assert.equal(denoise.status, 1);
  assert.match(denoise.stderr, /denoise does not accept --b1/);
  const correct = run(['correct', '--uni', UNI, '--b1', B1, '--b1-type', 'tfl', '--mp2rage', MP2RAGE, '--regularization', '6', output]);
  assert.equal(correct.status, 1);
  assert.match(correct.stderr, /correct does not accept --regularization/);
});

test('self-check reports the Node runtime that ran it and the WASM core', () => {
  const result = run(['self-check']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
  assert.match(report.wasmCore, /^\d+\.\d+\.\d+$/);
});
