// The SyN-SDC pipeline: its NumPy/SciPy ports against SciPy's own outputs, the acquisition and
// input refusals, a synthetic run whose outputs the n4 and noddi input paths accept, and
// cancellation. syn-gate.test.js holds the comparisons with the native reference runs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnRegistrationThread } from '@neurodesk/hmc/node';
import { companions, readInput } from '@neurodesk/n4/node';
import { loadNoddi } from '@neurodesk/noddi';
import { readDwi } from '@neurodesk/noddi/node';
import { acquisition } from '../src/syn/acquisition.js';
import { restrictDeformation, samplingReference, synParameters } from '../src/syn/grid.js';
import { copyGeometry, readImage } from '../src/syn/nifti.js';
import { advancedClip, dilateBall, gradient, medianFilterBall, normalizeLaplacian, sampleCubic, splineFilter3 } from '../src/syn/numerics.js';
import { nodeRuntime } from '../src/syn/node.js';
import { dwiSidecar } from '../src/syn/outputs.js';
import { correctSusceptibility, outputNames, PRIOR_FILES } from '../src/syn/pipeline.js';
import { unwarpSeries } from '../src/syn/unwarp.js';
import { nifti, synthetic } from './syn-fixture.js';

const scipy = JSON.parse(await readFile(new URL('./fixtures/syn-scipy.json', import.meta.url), 'utf8'));

test('the median filter, clip, dilation, Laplacian normalisation, spline and gradient equal SciPy\'s', () => {
  const dims = scipy.shape;
  const image = Float32Array.from(scipy.image);
  assert.deepEqual(Array.from(medianFilterBall(image, dims)), scipy.median);
  assert.deepEqual(Array.from(advancedClip(image, dims, scipy.clip)), scipy.clip.int16);
  assert.deepEqual(Array.from(dilateBall(Uint8Array.from(scipy.mask), dims)), scipy.dilated);
  assert.deepEqual(Array.from(normalizeLaplacian(scipy.laplacian)), scipy.normalized);
  const coefficients = splineFilter3(Float64Array.from(image), dims);
  const [x, y, z] = scipy.coordinates.map((row) => Float32Array.from(row));
  const sampled = sampleCubic(coefficients, dims, x, y, z, new Float32Array(x.length));
  sampled.forEach((value, i) => assert.ok(Math.abs(value - scipy.sampled[i]) <= 1e-6 * Math.max(1, Math.abs(scipy.sampled[i])), `point ${i}: ${value} vs ${scipy.sampled[i]}`));
  assert.deepEqual(Array.from(gradient(Float32Array.from(scipy.vsm), dims, 1)), scipy.gradientY);
});

test('the PE direction and readout come from options, then the sidecar, then EffectiveEchoSpacing', () => {
  const dims = [116, 116, 69];
  assert.deepEqual(acquisition({ PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.0379504 }, dims).totalReadoutTime, 0.0379504);
  const fromSpacing = acquisition({ PhaseEncodingDirection: 'j-', EffectiveEchoSpacing: 0.000330004 }, dims);
  assert.equal(fromSpacing.totalReadoutTime, 0.000330004 * 115);
  assert.match(fromSpacing.source.totalReadoutTime, /EffectiveEchoSpacing/);
  const explicit = acquisition({ PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.1 }, dims, { phaseEncodingDirection: 'i', totalReadoutTime: 0.05 });
  assert.deepEqual([explicit.phaseEncodingDirection, explicit.totalReadoutTime], ['i', 0.05]);
  assert.throws(() => acquisition({ TotalReadoutTime: 0.03 }, dims), /phase-encoding direction is missing/);
  assert.throws(() => acquisition({ PhaseEncodingDirection: 'y-', TotalReadoutTime: 0.03 }, dims), /not one of/);
  assert.throws(() => acquisition({ PhaseEncodingDirection: 'j', EstimatedTotalReadoutTime: 0.03 }, dims), /total readout time is missing/);
  assert.throws(() => acquisition({ PhaseEncodingDirection: 'j', TotalReadoutTime: -1 }, dims), /positive number/);
});

test('the SyN grid, deformation weights and voxel parameters are those sdcflows rendered for ds005134', () => {
  // The DWI grid of ds005134 sub-01 (LAS, 2 mm) and the 1.2 mm grid of the 1.2 mm reference run.
  const epi = [[-2, 0, 0, 116], [0, 2, 0, -122.377685546875], [0, 0, 2, -44.27118682861328], [0, 0, 0, 1]];
  const grid = samplingReference([116, 116, 69], epi, [1.2, 1.2, 1.2]);
  assert.deepEqual(grid.dims, [193, 193, 115]);
  assert.equal(Math.fround(grid.affine[0][3]), -114);
  const header = grid.affine.map((row) => row.map(Math.fround));
  assert.deepEqual(restrictDeformation(epi, header, 'j-'), [0.1, 1.0, 0.1]);
  const [first, second] = synParameters(epi, header, 'j-', [[0.8, 6.0, 10.0], [0.8, 2.0, 0.5]]);
  assert.equal(String(first[2]), '8.333333002196431');
  assert.equal(String(second[2]), '0.41666665010982157');
});

const forbidden = new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : () => assert.fail(`the runtime's ${String(key)} ran before the refusal`)) });

test('missing PE direction, readout time or T1w is refused before any work', async () => {
  const subject = synthetic();
  const base = { ...subject, fileName: 'sub-01_dwi.nii.gz', prior: null, runtime: forbidden };
  await assert.rejects(correctSusceptibility({ ...base, sidecar: { TotalReadoutTime: 0.03 } }), /phase-encoding direction is missing/);
  await assert.rejects(correctSusceptibility({ ...base, sidecar: { PhaseEncodingDirection: 'j-' } }), /total readout time is missing/);
  await assert.rejects(correctSusceptibility({ ...base, t1w: null }), /needs a T1-weighted image/);
  await assert.rejects(correctSusceptibility({ ...base, prior: undefined }), /prior/);
});

/** A Node runtime whose threads are counted, to check that cancelling ends them. */
async function countedRuntime() {
  const threads = [];
  const runtime = await nodeRuntime({
    spawn: () => {
      const worker = spawnRegistrationThread();
      threads.push(worker);
      return worker;
    },
  });
  return { runtime, threads };
}

test('a synthetic subject gives BIDS outputs that the n4 and noddi input paths accept', { timeout: 1_800_000 }, async () => {
  const subject = synthetic();
  const { runtime, threads } = await countedRuntime();
  const stages = [];
  // The readout time option overrides the sidecar's 0.03 s.
  const result = await correctSusceptibility({ ...subject, fileName: 'sub-01_dir-AP_dwi.nii.gz', prior: null, totalReadoutTime: 0.031, runtime, onProgress: ({ stage }) => stages.push(stage) });
  const names = outputNames('sub-01_dir-AP_dwi.nii.gz');
  assert.deepEqual(Object.keys(result.files).sort(), [
    'sub-01_dir-AP_desc-brain_mask.nii.gz',
    'sub-01_dir-AP_desc-coeff_fieldmap.json',
    'sub-01_dir-AP_desc-coeff_fieldmap.nii.gz',
    'sub-01_dir-AP_desc-preproc_fieldmap.json',
    'sub-01_dir-AP_desc-preproc_fieldmap.nii.gz',
    'sub-01_dir-AP_desc-sdc_dwi.bval',
    'sub-01_dir-AP_desc-sdc_dwi.bvec',
    'sub-01_dir-AP_desc-sdc_dwi.json',
    'sub-01_dir-AP_desc-sdc_dwi.nii.gz',
    'sub-01_dir-AP_from-orig_to-sdc_mode-image_xfm.nii.gz',
  ]);
  assert.ok(['reference', 'anatomical', 'affine', 'syn', 'field', 'unwarp', 'write'].every((stage) => stages.includes(stage)));
  await Promise.all(threads.map((worker) => worker.exited));

  // The series keeps every volume (b0 included), on the input grid, and the gradients pass through.
  const series = await readImage(result.files[names.image]);
  const input = await readImage(subject.dwi);
  assert.deepEqual([series.dims, series.frames], [input.dims, input.frames]);
  assert.deepEqual(series.affine, input.affine);
  assert.equal(new TextDecoder().decode(result.files[names.bval]), subject.bval);
  assert.equal(new TextDecoder().decode(result.files[names.bvec]), subject.bvec);
  const sidecar = JSON.parse(new TextDecoder().decode(result.files[names.sidecar]));
  assert.equal(sidecar.PhaseEncodingDirection, 'j-');
  assert.equal(sidecar.TotalReadoutTime, 0.031);
  assert.equal(sidecar.SusceptibilityDistortionCorrection.TotalReadoutTime, 0.031);
  assert.equal(sidecar.SusceptibilityDistortionCorrection.TotalReadoutTimeSource, 'option');
  assert.equal(sidecar.SusceptibilityDistortionCorrection.Seed, 1234);
  assert.equal(JSON.parse(new TextDecoder().decode(result.files[names.fieldSidecar])).Units, 'Hz');
  const field = await readImage(result.files[names.field]);
  assert.deepEqual([field.dims, field.affine], [input.dims, input.affine]);
  assert.ok(field.data.some((value) => Math.abs(value) > 1), 'the synthetic stretch gives a field');
  const displacement = await readImage(result.files[names.displacement]);
  assert.equal(displacement.frames, 3);
  assert.equal(new DataView(displacement.header).getInt16(68, true), 1007);

  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'sdc-syn-'));
  for (const [name, bytes] of Object.entries(result.files)) await writeFile(join(directory, name), bytes);
  const image = join(directory, names.image);
  const found = await companions(image);
  assert.deepEqual(found, { bval: join(directory, names.bval), bvec: join(directory, names.bvec), json: join(directory, names.sidecar) });
  const n4 = await readInput({ image, bval: found.bval });
  assert.deepEqual(n4.reference, [0, 4]);
  const noddi = await readDwi({ dwi: image, bval: found.bval, bvec: found.bvec, api: await loadNoddi(await readFile(new URL(import.meta.resolve('@neurodesk/noddi/wasm')))) });
  assert.deepEqual(noddi.table.b0, [0, 4]);
  assert.equal(noddi.dims.join('x'), input.dims.join('x'));
});

test('an AbortSignal stops the run and ends its worker threads', { timeout: 600_000 }, async () => {
  const subject = synthetic();
  const { runtime, threads } = await countedRuntime();
  const controller = new AbortController();
  const run = correctSusceptibility({
    ...subject,
    fileName: 'sub-01_dwi.nii.gz',
    prior: null,
    runtime,
    signal: controller.signal,
    onProgress: ({ stage }) => {
      // SyN has started in a kernel thread when the next tick runs.
      if (stage === 'syn') setTimeout(() => controller.abort(), 2000);
    },
  });
  await assert.rejects(run, { name: 'AbortError' });
  assert.ok(threads.length >= 1, 'a kernel thread was running');
  const codes = await Promise.race([Promise.all(threads.map((worker) => worker.exited)), new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
  assert.ok(codes, 'every kernel thread ended');
});

test('the corrected series\' sidecar states the PE direction and readout time the run used', () => {
  const dims = [26, 30, 22];
  for (const [sidecar, options] of [
    [{ PhaseEncodingDirection: 'j', TotalReadoutTime: 0.1, EchoTime: 0.09 }, { phaseEncodingDirection: 'j-', totalReadoutTime: 0.05 }],
    [null, { phaseEncodingDirection: 'i', totalReadoutTime: 0.05 }],
  ]) {
    const acq = acquisition(sidecar, dims, options);
    const written = dwiSidecar(sidecar, { PhaseEncodingDirection: acq.phaseEncodingDirection, TotalReadoutTime: acq.totalReadoutTime });
    assert.equal(written.PhaseEncodingDirection, options.phaseEncodingDirection);
    assert.equal(written.TotalReadoutTime, options.totalReadoutTime);
    if (sidecar) assert.equal(written.EchoTime, 0.09);
  }
});

test('header geometry is copied between big- and little-endian headers', async () => {
  const affine = [[0.8, 0, 0, -80.1], [0, 0.8, 0, -132.6], [0, 0, 0.8, -127.2], [0, 0, 0, 1]];
  const other = [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
  const values = new Uint8Array(4 * 5 * 6);
  const big = await readImage(nifti({ dims: [4, 5, 6], affine, datatype: 2, values, little: false }));
  assert.deepEqual(big.affine, affine.map((row) => row.map(Math.fround)));
  for (const little of [true, false]) {
    const copied = await readImage(copyGeometry(nifti({ dims: [4, 5, 6], affine: other, datatype: 4, values, little }), big));
    assert.deepEqual(copied.affine, big.affine);
    assert.equal(copied.sformCode, 1);
    assert.deepEqual(Array.from(copied.data), Array.from(values));
  }
  const back = await readImage(copyGeometry(nifti({ dims: [4, 5, 6], affine: other, datatype: 2, values, little: false }), await readImage(nifti({ dims: [4, 5, 6], affine, datatype: 2, values }))));
  assert.deepEqual(back.affine, big.affine);
});

test('an abort during the two affine registrations (with the prior) rejects once and ends the threads', { timeout: 600_000 }, async () => {
  const subject = synthetic();
  const { runtime, threads } = await countedRuntime();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const controller = new AbortController();
  // The synthetic head stands in for the template; the run is cancelled before the atlas is read.
  const prior = {
    [PRIOR_FILES.atlas]: subject.t1wMask,
    [PRIOR_FILES.atlasToTemplate]: new Uint8Array(1),
    [PRIOR_FILES.template]: subject.t1w,
    [PRIOR_FILES.templateMask]: subject.t1wMask,
  };
  try {
    const run = correctSusceptibility({
      ...subject,
      fileName: 'sub-01_dwi.nii.gz',
      prior,
      runtime,
      signal: controller.signal,
      onProgress: ({ stage }) => {
        if (stage === 'affine') setTimeout(() => controller.abort(), 1000);
      },
    });
    await assert.rejects(run, { name: 'AbortError' });
    assert.equal(threads.length, 2, 'epi2anat and the MNI affine ran in two kernels');
    const codes = await Promise.race([Promise.all(threads.map((worker) => worker.exited)), new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
    assert.ok(codes, 'every kernel thread ended');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('an abort during the unwarp stops it between volumes', async () => {
  const dims = [48, 48, 32];
  const frames = 40;
  const voxels = dims[0] * dims[1] * dims[2];
  const data = Float32Array.from({ length: voxels * frames }, (_, i) => (i % 97) + 1);
  const controller = new AbortController();
  let done = 0;
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(
    unwarpSeries({
      data,
      dims,
      frames,
      affine: [[-2, 0, 0, 48], [0, 2, 0, -48], [0, 0, 2, -32], [0, 0, 0, 1]],
      field: new Float32Array(voxels).fill(5),
      phaseEncodingDirection: 'j-',
      totalReadoutTime: 0.03,
      signal: controller.signal,
      onVolume: () => done++,
    }),
    { name: 'AbortError' },
  );
  assert.ok(done < frames, `stopped after ${done} of ${frames} volumes`);
});
