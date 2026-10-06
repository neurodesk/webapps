import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNiftiHeaderFromVolume } from '@neurodesk/webapp-components/file-io';
import { detectCarotids } from '../src/carotid.js';
import { PARAMETERS, checkInstallation, detect, parseParameters } from '../src/node.js';
import { curvesTable, labelImages, variabilityImage } from '../src/outputs.js';
import { tiltedPhantom } from '../src/phantom.js';
import { readSeries } from '../src/series.js';

const bin = fileURLToPath(new URL('../bin/carotid-flow.js', import.meta.url));
const automation = JSON.parse(await readFile(new URL('../../../apps/carotid-flow/automation.json', import.meta.url), 'utf8'));

/** A stored NIfTI of `frames` frames on an nx × ny × slices grid, float32, frame-major. */
function nifti({ nx, ny, slices = 1, frames, affine, pixDims }, data) {
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [4, nx, ny, slices, frames], affine, pixDims } });
  return Buffer.concat([Buffer.from(header), Buffer.from(Float32Array.from(data).buffer)]);
}

/** The tilted phantom as one combined series: amplitude frames, then phase frames. */
function combined(phase = (value) => value) {
  const series = tiltedPhantom();
  const data = [...series.amplitude, ...Array.from(series.phase, phase)];
  return nifti({ nx: series.nx, ny: series.ny, frames: 2 * series.phases, affine: series.affine }, data);
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'carotid-flow-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the command line writes the web app downloads, byte for byte', async (t) => {
  const directory = await workspace(t);
  const input = join(directory, 'neck.nii');
  await writeFile(input, combined());
  const output = join(directory, 'results');
  const result = await detect({ inputs: [input], output, parameters: { candidatePercentile: '97' } });
  assert.deepEqual((await readdir(output)).sort(), ['neck_carotid_curves.csv', 'neck_carotid_labels.nii', 'neck_phase_sd.nii']);

  const series = await readSeries({ combined: new File([await readFile(input)], 'neck.nii') });
  const found = detectCarotids(series, parseParameters({ candidatePercentile: 97 }));
  assert.deepEqual(await readFile(join(output, 'neck_carotid_labels.nii')), Buffer.from(labelImages(found.mask, series).mask.bytes));
  assert.deepEqual(await readFile(join(output, 'neck_phase_sd.nii')), Buffer.from(variabilityImage(found, series).bytes));
  assert.equal(await readFile(join(output, 'neck_carotid_curves.csv'), 'utf8'), curvesTable(found, series).text);
  assert.equal(result.measurements.method, 'variability');
  assert.ok(Math.abs(result.measurements.qc.tiltDegrees - 20) <= 2);
});

test('an output directory that is not empty is refused and left untouched', async (t) => {
  const directory = await workspace(t);
  const input = join(directory, 'neck.nii');
  await writeFile(input, combined());
  const output = join(directory, 'results');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'mine');
  await assert.rejects(detect({ inputs: [input], output }), /not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('raw ±4096 phase without a VENC is refused before anything is written', async (t) => {
  const directory = await workspace(t);
  const input = join(directory, 'raw.nii');
  // Signed and far beyond any velocity in cm/s: raw phase as Siemens stores it.
  await writeFile(input, combined((value) => (value - 100) * 40));
  const output = join(directory, 'results');
  await assert.rejects(detect({ inputs: [input], output }), /raw phase.*--venc/);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('an amplitude and phase pair on different grids is refused', async (t) => {
  const directory = await workspace(t);
  const series = tiltedPhantom();
  const grid = { nx: series.nx, ny: series.ny, frames: series.phases };
  const amplitude = join(directory, 'neck.nii');
  await writeFile(amplitude, nifti({ ...grid, affine: series.affine }, series.amplitude));
  const shifted = series.affine.map((row) => [...row]);
  shifted[0][3] += 10;
  const flipped = series.affine.map((row) => [...row]);
  flipped[1][1] = -flipped[1][1];
  const finer = series.affine.map((row) => [...row]);
  finer[0][0] = -0.5;
  const cases = [['origin', { affine: shifted }], ['orientation', { affine: flipped }], ['spacing', { affine: finer }], ['pixdim', { affine: series.affine, pixDims: [0.5, 1, 2] }]];
  for (const [label, geometry] of cases) {
    const phase = join(directory, `neck_${label}_ph.nii`);
    await writeFile(phase, nifti({ ...grid, ...geometry }, series.phase));
    await assert.rejects(detect({ inputs: [amplitude, phase], output: join(directory, label) }), /different voxel grids/, label);
  }
  const phase = join(directory, 'neck_ph.nii');
  await writeFile(phase, nifti({ ...grid, affine: series.affine }, series.phase));
  const result = await detect({ inputs: [amplitude, phase], output: join(directory, 'results'), parameters: { candidatePercentile: '97' } });
  assert.equal(result.measurements.method, 'variability');
});

test('a series with more than one slice is refused', async (t) => {
  const directory = await workspace(t);
  const input = join(directory, 'volume.nii');
  await writeFile(input, nifti({ nx: 4, ny: 4, slices: 2, frames: 4, affine: tiltedPhantom().affine }, new Float32Array(4 * 4 * 2 * 4)));
  await assert.rejects(detect({ inputs: [input], output: join(directory, 'results') }), /2 slices/);
});

test('settings are checked against the automation contract', () => {
  for (const operation of Object.values(automation.operations)) assert.deepEqual(operation.parameters, PARAMETERS);
  assert.equal(parseParameters().tiltLimit, 30);
  assert.equal(parseParameters({ venc: '100' }).venc, 100);
  assert.throws(() => parseParameters({ tiltLimit: '0.7' }), /--tilt-limit.*0\.5 to 60, in steps of 0\.5/);
  assert.throws(() => parseParameters({ candidatePercentile: '100' }), /--candidate-percentile/);
  assert.throws(() => parseParameters({ venc: 'fast' }), /--venc must be a number/);
  assert.throws(() => parseParameters({ venc: '' }), /--venc must be a number/);
});

test('the executable rejects unknown options and wrong argument counts', () => {
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  const unknown = run('in.nii', 'out', '--threshold', '3');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option '--threshold'/);
  const missing = run('in.nii');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /output directory/);
  const misplaced = run('in.nii', 'out', '--cache-dir', 'models');
  assert.equal(misplaced.status, 1);
  assert.match(misplaced.stderr, /--cache-dir only applies to download-models/);
  const check = run('self-check');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).executable, process.execPath);
});

test('download-models installs nothing, for the portable packager', async (t) => {
  const directory = await workspace(t);
  const run = spawnSync(process.execPath, [bin, 'download-models', '--cache-dir', join(directory, 'models')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^0 model files/);
  assert.deepEqual(await readdir(directory), []);
});

test('self-check runs the detection on the phantom', () => {
  const report = checkInstallation();
  assert.equal(report.phantom.method, 'variability');
  assert.ok(Math.abs(report.phantom.tiltDegrees - 20) <= 2);
});
