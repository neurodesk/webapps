import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFloat32Nifti, createNiftiHeaderFromVolume, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { gunzipSync } from 'fflate';
import { AV_FLAIR, BISON_LICENCE, MODE_ASSETS, TEMPLATE_COPYING, TEMPLATE_MASK, TEMPLATE_T1 } from '../src/assets.js';
import { checkInput, classVolumes, modeFor, runBison } from '../src/pipeline.js';

const DIMS = [12, 10, 8];
const VOXELS = DIMS[0] * DIMS[1] * DIMS[2];

function header({ dims = DIMS, mm = 1 } = {}) {
  return createNiftiHeaderFromVolume({
    hdr: {
      dims: [3, ...dims, 1, 1, 1, 1],
      pixDims: [1, mm, mm, mm, 1, 1, 1, 1],
      affine: [[mm, 0, 0, 0], [0, mm, 0, 0], [0, 0, mm, 0]],
    },
  });
}

function nifti(fill, options = {}) {
  return new Uint8Array(createFloat32Nifti(Float32Array.from({ length: VOXELS }, (_, i) => fill(i)), header(options)));
}

// The shared writer always writes 3D, so a second frame is appended and the dims patched.
function twoFrames() {
  const single = nifti((i) => i);
  const bytes = new Uint8Array(single.length + VOXELS * 4);
  bytes.set(single);
  const view = new DataView(bytes.buffer);
  view.setInt16(40, 4, true);
  view.setInt16(48, 2, true);
  return bytes;
}

const inside = (i) => {
  const x = i % DIMS[0];
  const y = Math.floor(i / DIMS[0]) % DIMS[1];
  const z = Math.floor(i / (DIMS[0] * DIMS[1]));
  return x > 2 && x < 9 && y > 1 && y < 8 && z > 1 && z < 6;
};
const intensity = (i, scale) => (inside(i) ? scale * (40 + (i % 7) * 10) : scale * (i % 3));

test('the mode follows the inputs and a FLAIR alone is refused', () => {
  assert.equal(modeFor({ t1: new Uint8Array(1) }), 't1');
  assert.equal(modeFor({ t1: new Uint8Array(1), flair: new Uint8Array(1) }), 't1-flair');
  assert.throws(() => modeFor({ flair: new Uint8Array(1) }), /FLAIR alone/);
  assert.throws(() => modeFor({}), /needs a T1/);
});

test('checkInput refuses 4D, non-finite, constant and coarse images', async () => {
  const good = await checkInput(nifti((i) => intensity(i, 1)), 'T1', { maxVoxelMm: 2 });
  assert.deepEqual(good.dims, DIMS);
  await assert.rejects(checkInput(twoFrames(), 'T1'), /single 3D volume/);
  await assert.rejects(checkInput(nifti((i) => (i === 5 ? NaN : i)), 'T1'), /NaN or infinite/);
  await assert.rejects(checkInput(nifti((i) => (i === 5 ? Infinity : i)), 'FLAIR'), /FLAIR has NaN or infinite/);
  await assert.rejects(checkInput(nifti(() => 7), 'T1'), /constant/);
  await assert.rejects(checkInput(nifti((i) => i, { mm: 2.5 }), 'T1', { maxVoxelMm: 2 }), /2\.50 x 2\.50 x 2\.50 mm/);
  await checkInput(nifti((i) => i, { mm: 2.5 }), 'FLAIR');
});

test('checkInput refuses non-finite and singular image geometry', async () => {
  for (const [offset, value] of [[280, 0], [280, NaN], [292, Infinity]]) {
    const image = nifti((i) => i);
    new DataView(image.buffer, image.byteOffset, image.byteLength).setFloat32(offset, value, true);
    await assert.rejects(checkInput(image, 'T1'), /T1.*geometry/);
  }
  const collinear = nifti((i) => i);
  const header = new DataView(collinear.buffer, collinear.byteOffset, collinear.byteLength);
  header.setFloat32(284, 1, true);
  header.setFloat32(300, 0, true);
  await assert.rejects(checkInput(collinear, 'FLAIR'), /FLAIR.*geometry/);
});

test('classVolumes counts each class in millilitres', () => {
  const labels = Uint8Array.of(0, 1, 1, 8, 8, 8);
  const volumes = classVolumes(labels, 't1', { affine: [[2, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] });
  assert.equal(volumes.length, 8);
  assert.deepEqual(volumes[0], { label: 1, slug: 'ventricles', voxels: 2, ml: 0.004 });
  assert.equal(volumes[7].ml, 0.006);
});

// Placeholder tools: registration returns the moving image, denoise and N4 their input, and the
// forest gives every voxel class (prior 1 > 0.5 ? 1 : 2). Checks the wiring, not the numbers.
function fakeDrivers() {
  const calls = { registration: 0, sessions: 0, released: 0 };
  return {
    calls,
    drivers: {
      createRegistration: async () => ({
        run(argv, inputs) {
          if (argv[0] === '--apply') return { outputs: { [argv[3]]: inputs[argv[2]] }, log: [] };
          calls.registration++;
          const prefix = argv[argv.indexOf('--output') + 1].slice(1, -1);
          return { outputs: { [`${prefix}0GenericAffine.mat`]: new Uint8Array([1]), [`${prefix}1Warp.nii.gz`]: new Uint8Array([2]), [`${prefix}1InverseWarp.nii.gz`]: new Uint8Array([3]) }, log: [] };
        },
      }),
      createDenoiser: async () => ({ denoise: async ({ image }) => image }),
      niimath: async (args, { inputs, outputs }) => ({ outputs: { [outputs[0]]: inputs['input.nii'] }, log: [] }),
      ort: {
        Tensor: class {
          constructor(type, data, dims) {
            Object.assign(this, { type, data, dims });
          }
        },
        InferenceSession: {
          create: async () => {
            calls.sessions++;
            return {
              outputNames: ['label', 'probabilities'],
              release: async () => { calls.released++; },
              run: async ({ X }) => {
                const [rows, features] = X.dims;
                const classes = features === 18 ? 9 : 10;
                const label = new BigInt64Array(rows);
                const probabilities = new Float32Array(rows * classes);
                for (let r = 0; r < rows; r++) {
                  const k = X.data[r * features] > 0.05 ? 1 : 2;
                  label[r] = BigInt(k);
                  probabilities[r * classes + k] = 1;
                }
                return { label: { data: label }, probabilities: { data: probabilities, dims: [rows, classes] } };
              },
            };
          },
        },
      },
    },
  };
}

function fakeAssets(modes) {
  const assets = new Map();
  const text = (value) => new TextEncoder().encode(value);
  assets.set(TEMPLATE_T1, nifti((i) => intensity(i, 1)));
  assets.set(TEMPLATE_MASK, nifti((i) => (inside(i) ? 1 : 0)));
  assets.set(TEMPLATE_COPYING, text('licence'));
  assets.set(BISON_LICENCE, text('licence'));
  assets.set(AV_FLAIR, nifti((i) => intensity(i, 0.7)));
  for (const mode of modes) {
    const files = MODE_ASSETS[mode];
    const classes = files.priors.length;
    files.priors.forEach((filename, k) => assets.set(filename, nifti((i) => (inside(i) ? (k + 1) / 10 : 0))));
    const histogram = text(JSON.stringify({ pdf: Array.from({ length: 256 }, () => new Array(classes).fill(0.1)) }));
    assets.set(files.t1Histogram, histogram);
    if (files.flairHistogram) assets.set(files.flairHistogram, histogram);
    assets.set(files.classifier, new Uint8Array([0]));
  }
  return assets;
}

for (const mode of ['t1', 't1-flair']) {
  test(`runBison (${mode}) writes labels, one probability per class and the mask on the T1 grid`, async () => {
    const { drivers, calls } = fakeDrivers();
    const t1 = nifti((i) => intensity(i, 3));
    const flair = mode === 't1-flair' ? nifti((i) => intensity(i, 1.5)) : null;
    const progress = [];
    const result = await runBison({ t1, flair, t1Name: '/data/sub-01_T1w.nii.gz' }, drivers, fakeAssets([mode]), { onProgress: (m) => progress.push(m) });
    assert.equal(result.mode, mode);
    const classes = mode === 't1' ? 8 : 9;
    assert.equal(result.files.length, classes + 2);
    assert.equal(result.files[0].name, 'sub-01_T1w_bison-labels.nii.gz');
    assert.equal(result.files.at(-1).name, 'sub-01_T1w_bison-mask.nii.gz');
    assert.equal(calls.registration, mode === 't1' ? 2 : 3);
    assert.equal(calls.sessions, 1);
    assert.equal(calls.released, 1);
    const labels = await readNifti(gunzipSync(result.files[0].bytes), Uint8Array);
    assert.deepEqual(labels.dims, DIMS);
    let brain = 0;
    for (let i = 0; i < VOXELS; i++) {
      assert.equal(labels.data[i] > 0, inside(i));
      brain += inside(i);
    }
    assert.equal(result.volumes[0].voxels + result.volumes[1].voxels, brain);
    assert.ok(Math.abs(result.volumes[0].ml + result.volumes[1].ml - brain / 1000) < 1e-12);
    assert.ok(Number.isFinite(result.timings.classify));
    assert.ok(progress.includes('Classifying tissues'));
  });
}

test('runBison refuses missing assets, a missing runtime and bad inputs before any work', async () => {
  const { drivers, calls } = fakeDrivers();
  const t1 = nifti((i) => intensity(i, 3));
  const assets = fakeAssets(['t1']);
  await assert.rejects(runBison({ t1, flair: t1 }, drivers, assets), /models\/bison-t1-flair\.onnx is missing/);
  await assert.rejects(runBison({ t1 }, { ...drivers, ort: undefined }, assets), /ONNX Runtime/);
  await assert.rejects(runBison({ t1: nifti((i) => i, { mm: 3 }) }, drivers, assets), /2 mm or finer/);
  await assert.rejects(runBison({ t1: null, flair: t1 }, drivers, assets), /FLAIR alone/);
  assert.equal(calls.registration, 0);
});

test('runBison stops at the next step when aborted', async () => {
  const { drivers, calls } = fakeDrivers();
  const controller = new AbortController();
  const hooks = { signal: controller.signal, onProgress: () => controller.abort() };
  await assert.rejects(runBison({ t1: nifti((i) => intensity(i, 3)) }, drivers, fakeAssets(['t1']), hooks), { name: 'AbortError' });
  assert.equal(calls.registration, 0);
});
