import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { b0Index, countDirections, parseNumbers } from '../src/gradients.js';
import { TENSOR_MAPS, mapFileName } from '../src/tensor.js';

const BIN = fileURLToPath(new URL('../bin/dwi2trx.js', import.meta.url));
const dwi2trx = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

const DIRECTIONS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [Math.SQRT1_2, Math.SQRT1_2, 0], [Math.SQRT1_2, 0, Math.SQRT1_2], [0, Math.SQRT1_2, Math.SQRT1_2]];

// A NIfTI-1 on a 1 mm 8^3 grid with `frames` float32 volumes from value(frame, voxel).
function nifti(frames, value, { origin = 0 } = {}) {
  const bytes = Buffer.alloc(352 + 8 ** 3 * frames * 4);
  bytes.writeInt32LE(348, 0);
  [frames > 1 ? 4 : 3, 8, 8, 8, frames, 1, 1, 1].forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  bytes.writeInt16LE(16, 70);
  bytes.writeInt16LE(32, 72);
  for (let i = 0; i < 8; i += 1) bytes.writeFloatLE(1, 76 + 4 * i);
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(1, 112);
  bytes.writeInt16LE(1, 254);
  for (const offset of [280, 300, 320]) bytes.writeFloatLE(1, offset);
  bytes.writeFloatLE(origin, 292);
  bytes.write('n+1\0', 344, 'latin1');
  for (let frame = 0; frame < frames; frame += 1) {
    for (let voxel = 0; voxel < 8 ** 3; voxel += 1) bytes.writeFloatLE(value(frame, voxel), 352 + 4 * (frame * 8 ** 3 + voxel));
  }
  return bytes;
}

// One tensor with eigenvalues 1.5, 0.5, 0.5 um^2/ms, b = 1000: FA 0.6030 everywhere.
const signal = (frame) => {
  const [x, y, z] = DIRECTIONS[frame];
  return 1000 * Math.exp(-1000 * (0.0015 * x * x + 0.0005 * y * y + 0.0005 * z * z));
};

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dwi2trx-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    directory,
    dwi: join(directory, 'sub-01_dwi.nii.gz'),
    bval: join(directory, 'sub-01_dwi.bval'),
    bvec: join(directory, 'sub-01_dwi.bvec'),
    mask: join(directory, 'mask.nii'),
  };
  await writeFile(paths.dwi, gzipSync(nifti(DIRECTIONS.length, signal)));
  await writeFile(paths.bval, DIRECTIONS.map((_, i) => (i ? 1000 : 0)).join(' '));
  await writeFile(paths.bvec, [0, 1, 2].map((axis) => DIRECTIONS.map((d) => d[axis]).join(' ')).join('\n'));
  await writeFile(paths.mask, nifti(1, (_, voxel) => (voxel < 256 ? 1 : 0)));
  return paths;
}

const fa = async (path) => {
  const bytes = gunzipSync(await readFile(path));
  return Array.from({ length: 8 ** 3 }, (_, i) => bytes.readFloatLE(352 + 4 * i));
};

test('gradients are parsed and validated as the web app does', () => {
  assert.deepEqual(parseNumbers(' 0  2500\t2500 \n'), [0, 2500, 2500]);
  assert.deepEqual(parseNumbers(''), []);
  const bvec = '0 0.1 0.2\n0 0.3 0.4\n0 0.5 0.6';
  assert.equal(countDirections('0 2500 2500', bvec), 3);
  for (const [bval, bvecText, message] of [
    ['', bvec, /empty/],
    ['a b c', bvec, /non-numeric/],
    ['0 2500 2500', '0 0.1 0.2\n0 0.3 0.4', /3 rows/],
    ['0 2500 2500', '0 0.1\n0 0.3\n0 0.5', /values but bval lists/],
    ['0 2500 2500', 'x y z\n0 0 0\n0 0 0', /non-numeric/],
    ['0 Infinity 2500', bvec, /finite/],
    ['0 -1000 2500', bvec, /negative/],
  ]) assert.throws(() => countDirections(bval, bvecText), message);
  assert.equal(b0Index('1000 5 1000'), 1, 'b < 50 counts as b0, as in dtifit');
  assert.equal(b0Index('1000 1000'), 0);
});

test('maps are named as the web app downloads them', () => {
  assert.equal(mapFileName('sub-01_dwi.nii.gz', 'FA'), 'sub-01_dwi_FA.nii.gz');
  assert.equal(mapFileName('scan.NII', 'tensor'), 'scan_tensor.nii.gz');
  assert.equal(mapFileName('.nii', 'V1'), 'dwi_V1.nii.gz');
});

test('a fit writes every dtifit map, lists them on stdout and records the mask on stderr', async (t) => {
  const paths = await workspace(t);
  const unmasked = join(paths.directory, 'unmasked');
  let run = dwi2trx([paths.dwi, paths.bval, paths.bvec, unmasked, '--no-mask']);
  assert.equal(run.status, 0, run.stderr);
  const expected = TENSOR_MAPS.map((map) => `sub-01_dwi_${map}.nii.gz`);
  assert.deepEqual((await readdir(unmasked)).sort(), [...expected].sort());
  assert.deepEqual(run.stdout.trim().split('\n'), expected.map((file) => join(unmasked, file)));
  const settings = JSON.parse(run.stderr.trim().split('\n').at(-1));
  assert.deepEqual([settings.masked, settings.mask, settings.maskFailure], [false, null, null]);
  for (const value of await fa(join(unmasked, 'sub-01_dwi_FA.nii.gz'))) assert.ok(Math.abs(value - 0.603) < 1e-3, `unmasked FA ${value}`);

  const masked = join(paths.directory, 'masked');
  run = dwi2trx([paths.dwi, paths.bval, paths.bvec, masked, '--mask', paths.mask]);
  assert.equal(run.status, 0, run.stderr);
  const provenance = JSON.parse(run.stderr.trim().split('\n').at(-1));
  assert.deepEqual([provenance.masked, provenance.mask], [true, { source: 'provided', name: 'mask.nii' }]);
  const values = await fa(join(masked, 'sub-01_dwi_FA.nii.gz'));
  assert.ok(values.slice(0, 256).every((value) => Math.abs(value - 0.603) < 1e-3), 'inside the mask');
  assert.ok(values.slice(256).every((value) => value === 0), 'outside the mask');
});

test('a non-empty output directory is refused and left untouched', async (t) => {
  const paths = await workspace(t);
  const output = join(paths.directory, 'results');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'mine');
  const run = dwi2trx([paths.dwi, paths.bval, paths.bvec, output, '--no-mask']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /is not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('invalid arguments and inputs fail before anything is written', async (t) => {
  const paths = await workspace(t);
  const output = join(paths.directory, 'results');
  const text = join(paths.directory, 'notes.nii');
  const short = join(paths.directory, 'short.bval');
  const shifted = join(paths.directory, 'shifted.nii');
  await writeFile(text, 'not an image'.repeat(40));
  await writeFile(short, '0 1000 1000');
  await writeFile(shifted, nifti(1, () => 1, { origin: 4 }));
  // NIfTI-2 announces a 540-byte header; the same grid stored in metres sits 1000 times further out.
  const nifti2 = join(paths.directory, 'nifti2.nii');
  const fourD = join(paths.directory, 'four-d.nii');
  const metres = join(paths.directory, 'metres.nii');
  const two = Buffer.from(nifti(DIRECTIONS.length, signal));
  two.writeInt32LE(540, 0);
  await writeFile(nifti2, two);
  await writeFile(fourD, nifti(2, () => 1));
  const inMetres = nifti(1, () => 1);
  inMetres.writeUInt8(1, 123);
  await writeFile(metres, inMetres);
  const cases = [
    [[paths.dwi, paths.bval, output], /Provide a diffusion image, its bval and bvec files/],
    [[paths.dwi, paths.bval, paths.bvec, output, 'extra'], /Provide a diffusion image/],
    [[paths.dwi, paths.bval, paths.bvec, output, '--mask', paths.mask, '--no-mask'], /not both/],
    [[paths.dwi, paths.bval, paths.bvec, output, '--threads', '2'], /Unknown option '--threads'/],
    [[paths.dwi, paths.bval, paths.bvec, output, '--cache-dir', paths.directory], /--cache-dir applies only to download-models/],
    [[text, paths.bval, paths.bvec, output, '--no-mask'], /diffusion image .* is not little-endian NIfTI-1/],
    [[nifti2, paths.bval, paths.bvec, output, '--no-mask'], /diffusion image .* is not little-endian NIfTI-1/],
    [[paths.dwi, paths.bval, paths.bvec, output, '--mask', fourD], /single 3D volume/],
    [[paths.dwi, paths.bval, paths.bvec, output, '--mask', metres], /not on the diffusion image's voxel grid/],
    [[paths.dwi, short, paths.bvec, output, '--no-mask'], /bvec row has 7 values but bval lists 3/],
    [[paths.dwi, paths.bval, paths.bvec, output, '--mask', text], /brain mask .* is not little-endian NIfTI-1/],
    [[paths.dwi, paths.bval, paths.bvec, output, '--mask', shifted], /not on the diffusion image's voxel grid/],
  ];
  for (const [args, message] of cases) {
    const run = dwi2trx(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, message, args.join(' '));
  }
  assert.ok(!(await readdir(paths.directory)).includes('results'));
});

test('a volume count that does not match the gradients is refused', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.dwi, gzipSync(nifti(5, () => 1)));
  const run = dwi2trx([paths.dwi, paths.bval, paths.bvec, join(paths.directory, 'results'), '--no-mask']);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /has 5 volumes but its bval\/bvec list 7 directions/);
});

test('help states that tracking is not included because it needs WebGPU subgroups', () => {
  const run = dwi2trx(['--help']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Tractography is not included/);
  assert.match(run.stdout, /subgroups/);
});

test('download-models installs nothing', async (t) => {
  const paths = await workspace(t);
  const run = dwi2trx(['download-models', '--cache-dir', join(paths.directory, 'models')]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!(await readdir(paths.directory)).includes('models'));
});

test('self-check fits the phantom tensor with the vendored dtifit build', () => {
  const run = dwi2trx(['self-check']);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.niimath, '1.2.0-dtifit.0');
  assert.equal(report.mindgrab, '0.1.20260925');
  assert.equal(report.phantomFa, 0.603);
});
