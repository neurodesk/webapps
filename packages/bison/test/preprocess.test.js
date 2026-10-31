import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFloat32Nifti, createNiftiHeaderFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { AV_FLAIR, MODE_ASSETS, TEMPLATE_MASK, TEMPLATE_T1 } from '../src/assets.js';
import { N4_OPTIONS, n4Arguments, normalise, preprocess, readVolume, registrationSession } from '../src/preprocess.js';
import { GREEDY_NONLINEAR } from '../src/register.js';
import { fitVolumePol } from '../src/volume-pol.js';

const DIMS = [12, 10, 8];
const VOXELS = DIMS[0] * DIMS[1] * DIMS[2];
const HEADER = createNiftiHeaderFromVolume({ hdr: { dims: [3, ...DIMS, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] } });

function nifti(fill) {
  return new Uint8Array(createFloat32Nifti(Float32Array.from({ length: VOXELS }, (_, i) => fill(i)), HEADER));
}

// A brain-like block in the middle of the grid.
const inside = (i) => {
  const x = i % DIMS[0];
  const y = Math.floor(i / DIMS[0]) % DIMS[1];
  const z = Math.floor(i / (DIMS[0] * DIMS[1]));
  return x > 2 && x < 9 && y > 1 && y < 8 && z > 1 && z < 6;
};
const intensity = (i, scale) => (inside(i) ? scale * (40 + (i % 7) * 10) : scale * (i % 3));

test('N4 runs four full levels from 200 mm knots with a weight image', () => {
  assert.deepEqual(n4Arguments({ input: 'in.nii', weight: 'w.nii', output: 'out.nii.gz' }), ['in.nii', '-n4', '-weight', 'w.nii', ...N4_OPTIONS, 'out.nii.gz', '-odt', 'float']);
  const option = (name) => N4_OPTIONS[N4_OPTIONS.indexOf(name) + 1];
  assert.equal(option('-iter'), '50x50x50x50');
  assert.equal(option('-bspline'), '200');
  assert.equal(option('-convergence'), '0');
  assert.equal(option('-shrink'), '4');
  assert.equal(option('-fwhm'), '0.15');
  assert.ok(!N4_OPTIONS.includes('-mask'));
});

test('registrationSession keeps one kernel for every run and loads a new one after an abort', async () => {
  let loads = 0;
  const create = async () => {
    loads++;
    return {
      run: (argv) => {
        if (argv[0] === 'abort') throw Object.assign(new Error('trap'), { aborted: true });
        return { outputs: {} };
      },
    };
  };
  const session = registrationSession(create);
  for (let i = 0; i < 50; i++) await session.run(['x']);
  assert.equal(loads, 1);
  await assert.rejects(session.run(['abort']), /trap/);
  await session.run(['x']);
  assert.equal(loads, 2);
});

test('registrationSession disposes each instance it replaces and keeps the largest heap', async () => {
  const disposed = [];
  let loads = 0;
  const create = async () => {
    const id = loads++;
    return {
      run: (argv) => {
        if (argv[0] === 'abort') throw Object.assign(new Error('trap'), { aborted: true });
        return { outputs: {} };
      },
      memoryBytes: () => (id + 1) * 100,
      dispose: async () => disposed.push(id),
    };
  };
  const session = registrationSession(create);
  await session.run(['x']);
  await assert.rejects(session.run(['abort']), /trap/);
  await session.run(['x']);
  await assert.rejects(session.run(['abort']), /trap/);
  await session.run(['x']);
  assert.deepEqual(disposed, [0, 1]);
  assert.equal(session.peakHeapBytes(), 300);
  await session.dispose();
  assert.deepEqual(disposed, [0, 1, 2]);
  assert.equal(session.peakHeapBytes(), 300);
});

test('normalise fits inside the masks and scales every voxel', async () => {
  const image = nifti((i) => intensity(i, 2));
  const sourceMask = Uint8Array.from({ length: VOXELS }, (_, i) => (inside(i) ? 1 : 0));
  const target = { data: Float32Array.from({ length: VOXELS }, (_, i) => intensity(i, 1)) };
  const result = await normalise({ image, sourceMask, target, targetMask: sourceMask });
  const source = (await readVolume(image)).data;
  const expected = fitVolumePol({ source, sourceMask, target: target.data, targetMask: sourceMask, order: 1 });
  assert.deepEqual(result.coefficients, expected.coefficients);
  assert.ok(Math.abs(result.coefficients[0] - 0.5) < 0.02);
  const written = (await readVolume(result.nifti)).data;
  assert.equal(written[0], Math.fround(source[0] * result.coefficients[0]));
  assert.deepEqual(written, result.data);
});

// Fake tools on one shared grid: Greedy returns the identity and a placeholder warp, --apply returns
// the moving image, denoise and N4 return their input. Checks the wiring, not the numbers.
const IDENTITY = '1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n';

function fakeDrivers() {
  const calls = { greedy: [], svf: [], apply: [], denoise: 0, niimath: [], loads: 0, disposed: 0 };
  const greedyMethod = (method) => async ({ fixed, moving, ...options }) => {
    // Raw .nii bytes: decompressed before they reach the module.
    assert.ok(fixed[0] !== 0x1f && moving[0] !== 0x1f);
    calls.greedy.push(method);
    if (method !== 'svf') return IDENTITY;
    calls.svf.push(options);
    return new Uint8Array([2]);
  };
  const drivers = {
    createGreedy: async () => ({
      memoryBytes: () => 300,
      dispose: async () => { calls.disposed++; },
      affine: greedyMethod('affine'),
      rigid: greedyMethod('rigid'),
      svf: greedyMethod('svf'),
    }),
    createRegistration: async () => {
      calls.loads++;
      return {
        memoryBytes: () => 1000,
        dispose: async () => { calls.disposed++; },
        run(argv, inputs) {
          for (const token of argv) {
            const name = token.replace(/^inverse:/, '');
            if (/\.(mat|nii|nii\.gz)$/.test(name) && argv[0] === '--apply' && argv.indexOf(token) > 5) assert.ok(inputs[name], `${name} is an input`);
          }
          assert.equal(argv[0], '--apply', 'the registration kernel only resamples');
          calls.apply.push(argv.slice(4));
          return { outputs: { [argv[3]]: inputs[argv[2]] }, log: [] };
        },
      };
    },
    createDenoiser: async () => ({
      memoryBytes: () => 500,
      dispose: async () => { calls.disposed++; },
      denoise: async ({ image, mask }) => {
        calls.denoise++;
        assert.ok(mask);
        return image;
      },
    }),
    niimath: async (args, { inputs, outputs }) => {
      calls.niimath.push(args);
      return { outputs: { [outputs[0]]: inputs['input.nii'] }, log: [] };
    },
  };
  return { drivers, calls };
}

function fakeAssets() {
  const assets = new Map();
  assets.set(TEMPLATE_T1, nifti((i) => intensity(i, 1)));
  assets.set(TEMPLATE_MASK, nifti((i) => (inside(i) ? 1 : 0)));
  assets.set(AV_FLAIR, nifti((i) => intensity(i, 0.7)));
  for (const mode of ['t1', 't1-flair']) {
    MODE_ASSETS[mode].priors.forEach((filename, k) => assets.set(filename, nifti((i) => (inside(i) ? (k + 1) / 10 : 0))));
  }
  return assets;
}

test('preprocess runs every step in the native order and returns T1-grid images', async () => {
  const { drivers, calls } = fakeDrivers();
  const checkpoints = [];
  const progress = [];
  const result = await preprocess({
    t1: nifti((i) => intensity(i, 3)),
    flair: nifti((i) => intensity(i, 1.5)),
    modes: ['t1', 't1-flair'],
    assets: fakeAssets(),
    drivers,
    onProgress: (message) => progress.push(message),
    checkpoint: async (name) => checkpoints.push(name),
  });
  assert.deepEqual(calls.greedy, ['affine', 'svf', 'rigid']);
  // The warp starts from the inverse of the first affine, here the identity, unmasked.
  assert.deepEqual(calls.svf, [{ matrix: IDENTITY, ...GREEDY_NONLINEAR }]);
  assert.equal(calls.denoise, 2);
  assert.equal(calls.niimath.length, 2);
  assert.ok(calls.loads >= 3, 'a fresh kernel per stage group');
  assert.equal(calls.disposed, calls.loads + calls.denoise + calls.greedy.length, 'every instance ends with its stage');
  assert.deepEqual(Object.keys(result.memory).sort(), ['flair_denoise', 'flair_linear', 'flair_resample', 'flair_rigid', 'mask_nl', 't1_affine', 't1_denoise', 't1_linear', 't1_nonlinear', 'warp']);
  assert.equal(result.memory.t1_nonlinear, 300);
  assert.equal(result.memory.t1_affine, 300);
  assert.equal(result.memory.t1_denoise, 500);
  // Linear mask, Mask_nl, the distinct priors and averages, FLAIR mask, FLAIR on the T1 grid.
  const interpolations = calls.apply.map((argv) => argv[0]);
  assert.equal(interpolations.filter((value) => value === 'NearestNeighbor').length, 3);
  assert.equal(interpolations.filter((value) => value === 'Linear').length, 1);
  assert.equal(calls.apply.find((argv) => argv[0] === 'Linear').slice(2).join(' '), 'rigid.mat');
  assert.ok(calls.apply.filter((argv) => argv[0] === 'BSpline[2]').every((argv) => argv.slice(2).join(' ') === 'inverse:lin.mat warp.nii'));
  assert.deepEqual(checkpoints.slice(0, 7), ['T1toTemplate0GenericAffine.mat', 'T1_Mask.nii', 'T1_NLM.nii', 'T1_N4.nii.gz', 'T1_norm', 'T1_VP.nii', 'T1toTemplate_ppWarp.nii']);
  for (const name of ['Mask_nl.nii', 'av_t1.nii', 'av_flair.nii', 't1/sp_1.nii', 't1-flair/sp_9.nii', 'FLAIR_Mask.nii', 'FLAIR_VP.nii', 'FLAIR_CR.nii']) assert.ok(checkpoints.includes(name), name);
  assert.equal(result.priors.t1.length, 8);
  assert.equal(result.priors['t1-flair'].length, 9);
  for (const volume of [result.t1, result.avT1, result.avFlair, result.flair, result.mask, ...result.priors.t1]) assert.equal(volume.length, VOXELS);
  assert.ok(Math.abs(result.volumePol.t1.coefficients[0] - 1 / 3) < 0.02);
  assert.ok(Math.abs(result.volumePol.flair.coefficients[0] - 0.7 / 1.5) < 0.02);
  assert.ok(result.timings.t1_nonlinear >= 0);
  assert.ok(progress.length > 5);
});

test('the T1 + FLAIR mode needs a FLAIR image', async () => {
  const { drivers } = fakeDrivers();
  await assert.rejects(preprocess({ t1: nifti(() => 1), modes: ['t1-flair'], assets: fakeAssets(), drivers }), /needs a FLAIR/);
});

test('a 4D input is refused', async () => {
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [4, ...DIMS, 2, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1] } });
  const bytes = new Uint8Array(createFloat32Nifti(new Float32Array(VOXELS * 2), header, [...DIMS, 2]));
  await assert.rejects(readVolume(bytes, 'T1'), /single 3D volume/);
});
