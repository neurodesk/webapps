import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createNiftiFromData, readNiftiFrames } from '@neurodesk/webapp-components/file-io/nifti';
import { checkInstallation, fit, threadCount } from '../src/node.js';
import { multiShellPhantom } from '../src/phantom.js';

// The niimath build @neurodesk/dwi2trx pins, read from its package.json, not from the version module.
const NIIMATH = JSON.parse(await readFile(new URL('../../../apps/dwi2trx/vendor/niimath/package.json', import.meta.url), 'utf8')).version;

const BIN = fileURLToPath(new URL('../bin/noddi.js', import.meta.url));

async function scratch(t) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'noddi-node-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// The two-shell phantom's files: 12^3 voxels (one 2048-voxel chunk) unless `size` says otherwise.
async function phantomFiles(directory, size = 12) {
  const phantom = multiShellPhantom({ size });
  const files = { dwi: join(directory, 'sub-01_dwi.nii'), bval: join(directory, 'sub-01_dwi.bval'), bvec: join(directory, 'sub-01_dwi.bvec') };
  await writeFile(files.dwi, phantom.nifti);
  await writeFile(files.bval, phantom.bval);
  await writeFile(files.bvec, phantom.bvec);
  return { ...files, phantom };
}

const NAMES = [
  'sub-01_model-tensor_param-fa_dwimap.nii.gz',
  'sub-01_model-tensor_param-md_dwimap.nii.gz',
  'sub-01_model-tensor_param-ad_dwimap.nii.gz',
  'sub-01_model-tensor_param-rd_dwimap.nii.gz',
  'sub-01_model-tensor_param-s0_dwimap.nii.gz',
  'sub-01_model-tensor_param-direction_dwimap.nii.gz',
  'sub-01_model-noddi_param-icvf_dwimap.nii.gz',
  'sub-01_model-noddi_param-isovf_dwimap.nii.gz',
  'sub-01_model-noddi_param-odi_dwimap.nii.gz',
  'sub-01_model-noddi_param-direction_dwimap.nii.gz',
  'sub-01_desc-brain_mask.nii.gz',
];

test('an unmasked two-shell fit writes every tensor and NODDI map and an all-voxel mask', async (t) => {
  const directory = await scratch(t);
  const input = await phantomFiles(directory);
  const output = join(directory, 'out');
  const result = await fit({ ...input, output, noMask: true, threads: 2 });
  assert.deepEqual(result.files, NAMES);
  assert.deepEqual((await readdir(output)).sort(), [...NAMES].sort());
  assert.equal(result.provenance.method, 'dti+noddi-amico');
  assert.equal(result.provenance.mask, 'none');
  assert.equal(result.provenance.maskVoxels, 12 ** 3);
  const direction = readNiftiFrames(gunzipSync(await readFile(join(output, NAMES[9]))));
  assert.equal(direction.frames, 3);
  const mask = readNiftiFrames(gunzipSync(await readFile(join(output, NAMES[10]))));
  assert.ok(mask.data.every((value) => value === 1));
});

// 14^3 = 2744 voxels: two chunks, which one thread fits in turn and three fit at once.
test('the maps do not depend on the number of threads', async (t) => {
  const directory = await scratch(t);
  const input = await phantomFiles(directory, 14);
  const one = await fit({ ...input, output: join(directory, 'one'), noMask: true, threads: 1 });
  const three = await fit({ ...input, output: join(directory, 'three'), noMask: true, threads: 3 });
  for (const name of one.files) {
    const [a, b] = await Promise.all([readFile(join(one.output, name)), readFile(join(three.output, name))]);
    assert.ok(gunzipSync(a).equals(gunzipSync(b)), name);
  }
});

test('a supplied mask limits the fit; a mask off the grid is refused', async (t) => {
  const directory = await scratch(t);
  const input = await phantomFiles(directory);
  const voxels = 12 ** 3;
  const half = new Uint8Array(voxels).map((_, i) => (i < voxels / 2 ? 1 : 0));
  const maskFile = join(directory, 'mask.nii');
  await writeFile(maskFile, new Uint8Array(createNiftiFromData(half, input.phantom.nifti.buffer, { dims: [12, 12, 12] })));
  const result = await fit({ ...input, output: join(directory, 'masked'), maskFile, noddi: false });
  assert.equal(result.provenance.mask, 'supplied');
  assert.equal(result.provenance.maskVoxels, voxels / 2);
  assert.equal(result.provenance.method, 'dti');
  assert.equal(result.files.length, 7);
  const fa = readNiftiFrames(gunzipSync(await readFile(join(result.output, result.files[0]))));
  assert.ok(fa.data.subarray(voxels / 2).every((value) => value === 0));

  const other = join(directory, 'other.nii');
  await writeFile(other, new Uint8Array(createNiftiFromData(new Uint8Array(8 ** 3).fill(1), multiShellPhantom({ size: 8 }).nifti.buffer, { dims: [8, 8, 8] })));
  await assert.rejects(fit({ ...input, output: join(directory, 'off-grid'), maskFile: other }), /not on the DWI grid/);
  const empty = join(directory, 'empty.nii');
  await writeFile(empty, new Uint8Array(createNiftiFromData(new Uint8Array(voxels), input.phantom.nifti.buffer, { dims: [12, 12, 12] })));
  await assert.rejects(fit({ ...input, output: join(directory, 'empty'), maskFile: empty }), /no voxels/);
});

test('inputs and options are checked before any work', async (t) => {
  const directory = await scratch(t);
  const input = await phantomFiles(directory);
  await assert.rejects(fit({ ...input, output: join(directory, 'a'), noMask: true, maskFile: input.dwi }), /not both/);
  await assert.rejects(fit({ ...input, output: join(directory, 'b'), noMask: true, tensorFit: 'nls' }), /wls, ols or niimath-dtifit/);
  await assert.rejects(fit({ ...input, output: join(directory, 'c'), noMask: true, threads: 0 }), /positive whole number/);
  await assert.rejects(fit({ ...input, output: directory, noMask: true }), /not empty/);
  const short = join(directory, 'short.bval');
  await writeFile(short, '0 1000');
  await assert.rejects(fit({ ...input, bval: short, output: join(directory, 'd'), noMask: true }), /bvec row has/);
  assert.equal(threadCount(5), 5);
  assert.ok(threadCount() >= 1);
});

test('the command line prints the written files and its settings', async (t) => {
  const directory = await scratch(t);
  const input = await phantomFiles(directory);
  const output = join(directory, 'out');
  const run = spawnSync(process.execPath, [BIN, input.dwi, input.bval, input.bvec, output, '--no-mask', '--no-noddi', '--tensor-fit', 'ols', '--threads', '2'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), NAMES.filter((name) => !name.includes('noddi')).map((name) => join(output, name)));
  const provenance = JSON.parse(run.stderr.trim().split('\n').at(-1));
  assert.equal(provenance.method, 'dti');
  assert.equal(provenance.tensorFit, 'ols');
  assert.equal(provenance.niimath, null);
  assert.equal(provenance.threads, 2);
  const refused = spawnSync(process.execPath, [BIN, input.dwi, input.bval, input.bvec, join(directory, 'x'), '--mask', input.dwi, '--no-mask'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not both/);
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /^Usage: noddi/);
});

test('the command line selects niimath dtifit and preserves the NODDI maps', async (t) => {
  const directory = await scratch(t);
  const input = await phantomFiles(directory, 4);
  const baseline = await fit({ ...input, output: join(directory, 'wls'), noMask: true, threads: 1 });
  const output = join(directory, 'niimath');
  const run = spawnSync(process.execPath, [BIN, input.dwi, input.bval, input.bvec, output, '--no-mask', '--tensor-fit', 'niimath-dtifit', '--threads', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), NAMES.map((name) => join(output, name)));
  const provenance = JSON.parse(run.stderr.trim().split('\n').at(-1));
  assert.equal(provenance.tensorFit, 'niimath-dtifit');
  assert.equal(provenance.niimath, NIIMATH);
  assert.equal(provenance.method, 'dti+noddi-amico');
  for (const name of NAMES.filter((name) => name.includes('noddi') || name.includes('mask'))) {
    const [actual, expected] = await Promise.all([readFile(join(output, name)), readFile(join(baseline.output, name))]);
    assert.deepEqual(gunzipSync(actual), gunzipSync(expected), name);
  }
});

test('self-check fits the phantom in this runtime', async () => {
  const report = await checkInstallation();
  assert.equal(report.phantomDirectionCosine > 0.95, true);
  assert.equal(report.phantomIcvfError < 0.15, true);
});

test('the command line selects the nonlinear method and reports fit diagnostics', async (t) => {
  const directory = await scratch(t);
  const input = await phantomFiles(directory, 4);
  const baseline = await fit({ ...input, output: join(directory, 'amico'), noMask: true, threads: 1 });
  const output = join(directory, 'dmipy');
  const run = spawnSync(process.execPath, [BIN, input.dwi, input.bval, input.bvec, output, '--no-mask', '--method', 'dmipy', '--threads', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), NAMES.map(name => join(output, name)));
  const provenance = JSON.parse(run.stderr.trim().split('\n').at(-1));
  assert.equal(provenance.method, 'dti+noddi-dmipy');
  assert.equal(provenance.noddiSource, 'AthenaEPI/dmipy@2d6073218eb4ebc97645ac6e275270c36834e33d');
  assert.ok(provenance.noddiDiagnostics.fitted > 0);
  assert.equal(provenance.noddiDiagnostics.fitted + provenance.noddiDiagnostics.skipped, 64);
  assert.equal(provenance.noddiDiagnostics.failed, 0);
  const image = readNiftiFrames(gunzipSync(await readFile(join(output, NAMES[6]))));
  assert.ok(image.data.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.notDeepEqual(gunzipSync(await readFile(join(output, NAMES[6]))), gunzipSync(await readFile(join(baseline.output, NAMES[6]))));
});

test('download-models installs nothing and takes the packager\'s --cache-dir', () => {
  const run = spawnSync(process.execPath, [BIN, 'download-models', '--cache-dir', tmpdir()], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no model downloads/);
  const misplaced = spawnSync(process.execPath, [BIN, 'self-check', '--cache-dir', tmpdir()], { encoding: 'utf8' });
  assert.equal(misplaced.status, 1);
  assert.match(misplaced.stderr, /only applies to download-models/);
});
