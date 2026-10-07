import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createNiftiFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { Niimath } from '@niivue/niimath';
import { OUTPUT_DATA_TYPE, registeredName, registrationChain } from '../src/registration.js';

const BIN = fileURLToPath(new URL('../bin/edgereg.js', import.meta.url));
const edgereg = (args, options = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });

// A bright block in a 2 mm 20^3 volume, `shift` voxels along x.
function block(shift) {
  const size = 20;
  const img = new Float32Array(size ** 3);
  for (let z = 5; z < 13; z += 1) {
    for (let y = 4; y < 14; y += 1) {
      for (let x = 4 + shift; x < 12 + shift; x += 1) img[x + size * (y + size * z)] = 50 + x + 2 * y + 3 * z;
    }
  }
  const affine = [[2, 0, 0, -20], [0, 2, 0, -20], [0, 0, 2, -20]];
  return Buffer.from(createNiftiFromVolume({ img, hdr: { dims: [3, size, size, size, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine } }));
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'edgereg-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moving = join(directory, 'subject.nii.gz');
  const fixed = join(directory, 'template.nii');
  await writeFile(moving, gzipSync(block(0)));
  await writeFile(fixed, block(3));
  return { directory, moving, fixed };
}

test('the download is named after the moving image, as in the web app', () => {
  assert.equal(registeredName('t1_crop.nii.gz'), 't1_crop_registered.nii');
  assert.equal(registeredName('T1.NII'), 'T1_registered.nii');
});

test('the chain the web app runs is niimath -gz 0 [-robustfov] -allineate FIXED in the input datatype', () => {
  const niimath = new Niimath();
  niimath.setOutputDataType(OUTPUT_DATA_TYPE);
  const moving = new File([new Uint8Array(4)], 'moving.nii.gz');
  const fixed = new File([new Uint8Array(4)], 'MNI 152.nii.gz');
  const plain = registrationChain(niimath.image(moving), fixed);
  assert.deepEqual(plain.commands, ['-gz', '0', '-allineate', '__nimx0_MNI_152.nii.gz']);
  assert.equal(plain.outputDataType, 'input');
  const cropped = registrationChain(niimath.image(moving), fixed, { robustFov: true });
  assert.deepEqual(cropped.commands, ['-gz', '0', '-robustfov', '-allineate', '__nimx0_MNI_152.nii.gz']);
});

test('a registration writes the web download, lists it on stdout and its settings on stderr', async (t) => {
  const { directory, moving, fixed } = await workspace(t);
  for (const robustFov of [false, true]) {
    const output = join(directory, `results-${robustFov}`);
    const run = edgereg([moving, fixed, output, ...(robustFov ? ['--robust-fov'] : [])]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(await readdir(output), ['subject_registered.nii']);
    assert.equal(run.stdout.trim(), join(output, 'subject_registered.nii'));
    const provenance = JSON.parse(run.stderr.trim());
    assert.equal(provenance.robustFov, robustFov);
    assert.equal(provenance.argv.includes('-robustfov'), robustFov);
    assert.deepEqual(provenance.argv.slice(-3), ['registered.nii', '-odt', 'input']);
    const image = await readFile(join(output, 'subject_registered.nii'));
    assert.equal(image.readInt32LE(0), 348);
    assert.equal(image.readInt16LE(70), 16, 'keeps the moving image datatype');
  }
});

test('a non-empty output directory is refused and left untouched', async (t) => {
  const { directory, moving, fixed } = await workspace(t);
  const output = join(directory, 'results');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'mine');
  const run = edgereg([moving, fixed, output]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /is not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('invalid arguments and inputs fail before anything is written', async (t) => {
  const { directory, moving, fixed } = await workspace(t);
  const output = join(directory, 'results');
  const text = join(directory, 'notes.nii');
  await writeFile(text, 'not an image'.repeat(40));
  const cases = [
    [[moving, fixed], /Provide a moving image, a fixed image and a new output directory/],
    [[moving, fixed, output, 'extra'], /Provide a moving image/],
    [[moving, fixed, output, '--robust-fov=yes'], /robust-fov/],
    [[moving, fixed, output, '--cost', 'nmi'], /Unknown option '--cost'/],
    [[moving, fixed, output, '--cache-dir', directory], /--cache-dir applies only to download-models/],
    [[text, fixed, output], /moving image .* is not NIfTI/],
    [[moving, text, output], /fixed image .* is not NIfTI/],
    [[join(directory, 'missing.nii'), fixed, output], /ENOENT/],
  ];
  for (const [args, message] of cases) {
    const run = edgereg(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, message);
  }
  assert.deepEqual((await readdir(directory)).sort(), ['notes.nii', 'subject.nii.gz', 'template.nii']);
});

test('download-models installs nothing because EdgeReg uses no model files', async (t) => {
  const { directory } = await workspace(t);
  const run = edgereg(['download-models', '--cache-dir', join(directory, 'models')]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no model files/);
  assert.deepEqual((await readdir(directory)).sort(), ['subject.nii.gz', 'template.nii']);
});

test('self-check registers a phantom with the pinned niimath build', () => {
  const run = edgereg(['self-check']);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.niimath, '1.4.20260909');
  assert.equal(report.node, process.version);
});
