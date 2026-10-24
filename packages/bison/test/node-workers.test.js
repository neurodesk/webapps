import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { loadDenoise } from '@neurodesk/ants-denoise/node';
import { loadHmcRegistration } from '@neurodesk/hmc-registration/node';
import { createDenoiser, createRegistration } from '../src/node-workers.js';

const N = 20;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MB = (bytes) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

// A 1 mm float32 NIfTI-1 volume, N^3 voxels, with a sform at the origin.
function nifti(values) {
  const bytes = new Uint8Array(352 + values.length * 4);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  for (const [i, n] of [3, N, N, N, 1, 1, 1, 1].entries()) view.setInt16(40 + 2 * i, n, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (let i = 0; i < 8; i++) view.setFloat32(76 + 4 * i, 1, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  for (const [row, offset] of [[0, 280], [1, 296], [2, 312]]) view.setFloat32(offset + 4 * row, 1, true);
  bytes.set([0x6e, 0x2b, 0x31, 0x00], 344);
  values.forEach((v, i) => view.setFloat32(352 + 4 * i, v, true));
  return bytes;
}

// A bright, smooth-edged sphere centred at `centre` with seeded noise.
function phantom(centre = [9.5, 9.5, 9.5]) {
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const values = [];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const r = Math.hypot(x - centre[0], y - centre[1], z - centre[2]);
        values.push(20 + 80 / (1 + Math.exp(r - 6)) + 10 * (random() - 0.5));
      }
    }
  }
  return nifti(values);
}

const rigidArgv = (moving = 'moving.nii') => [
  '--dimensionality', '3', '--float', '1', '--random-seed', '1234',
  '--transform', 'Rigid[0.1]',
  '--metric', `Mattes[fixed.nii,${moving},1,32,Regular,0.25]`,
  '--convergence', '[50x20,1e-6,10]', '--shrink-factors', '2x1', '--smoothing-sigmas', '1x0vox',
  '--output', '[out]',
];
// A function: the kernel's callMain puts the program name in front of the array it is given.
const applyArgv = () => ['--apply', 'fixed.nii', 'moving.nii.gz', 'resampled.nii', 'BSpline[2]', '0', 'inverse:out.mat'];

const fixed = phantom();
const moving = phantom([10.5, 9, 9.5]);

async function registrationOutputs(instance) {
  const { outputs: reg, log } = await instance.run(rigidArgv(), { 'fixed.nii': fixed, 'moving.nii': Buffer.from(moving) });
  const mat = reg['out0GenericAffine.mat'];
  const { outputs: applied } = await instance.run(applyArgv(), { 'fixed.nii': fixed.buffer, 'moving.nii.gz': gzipSync(moving), 'out.mat': mat });
  return { mat, resampled: applied['resampled.nii'], log };
}

test('the registration worker writes the in-thread kernel bytes, forwards its log and leaves inputs intact', async () => {
  const before = sha256(fixed);
  const expected = await registrationOutputs(await loadHmcRegistration());
  const lines = [];
  const worker = await createRegistration({ onLog: (line) => lines.push(line) });
  try {
    assert.equal(worker.memoryBytes(), 256 * 2 ** 20);
    const actual = await registrationOutputs(worker);
    assert.ok(actual.mat.length > 0 && actual.resampled.length > 352);
    assert.equal(sha256(actual.mat), sha256(expected.mat));
    assert.equal(sha256(actual.resampled), sha256(expected.resampled));
    assert.deepEqual(actual.log, expected.log);
    assert.ok(lines.length >= actual.log.length);
    for (const line of actual.log) assert.ok(lines.includes(line), `onLog missed ${line}`);
    assert.equal(sha256(fixed), before, 'inputs must not be detached or changed');
    assert.equal(fixed.byteLength, 352 + 4 * N ** 3);
  } finally {
    const { heapBytes, runs } = await worker.dispose();
    assert.equal(runs, 2);
    assert.ok(heapBytes >= 256 * 2 ** 20);
  }
});

test('registration errors keep message, log and aborted; an aborted worker refuses work', async () => {
  const worker = await createRegistration();
  await assert.rejects(worker.run(['--float', '0'], {}), (error) => error instanceof Error && /--float 1/.test(error.message));
  await assert.rejects(worker.run('--float 1', {}), (error) => error instanceof TypeError && /array of strings/.test(error.message));
  let caught;
  await assert.rejects(worker.run(rigidArgv('missing.nii'), { 'fixed.nii': fixed, 'moving.nii': moving }), (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.aborted, true);
  assert.match(caught.message, /aborted.*missing\.nii does not exist/s);
  assert.ok(caught.log.some((line) => line.includes('missing.nii does not exist')), caught.log.join('\n'));
  assert.ok(caught.cause instanceof Error);
  await assert.rejects(worker.run(rigidArgv(), { 'fixed.nii': fixed, 'moving.nii': moving }), (later) => later.aborted === true && /load a new one/.test(later.message));
  await worker.dispose();
  await assert.rejects(worker.run(rigidArgv(), {}), /disposed/);
});

test('the denoise worker writes the in-thread module bytes; an abort is reported and refused later', async () => {
  const image = phantom();
  const mask = nifti(Array.from({ length: N ** 3 }, (_, i) => (i < (N ** 3) / 2 ? 1 : 0)));
  const local = await loadDenoise();
  const expected = [await local.denoise({ image }), await local.denoise({ image: gzipSync(image), mask })];
  const worker = await createDenoiser();
  try {
    const actual = [await worker.denoise({ image }), await worker.denoise({ image: gzipSync(image), mask })];
    actual.forEach((bytes, i) => assert.equal(sha256(bytes), sha256(expected[i])));
    assert.ok(worker.memoryBytes() > 0);
  } finally {
    assert.equal((await worker.dispose()).runs, 2);
  }

  const lines = [];
  const broken = await createDenoiser({ onLog: (line) => lines.push(line) });
  await assert.rejects(broken.denoise({ image: new Uint8Array(400) }), (error) => /DenoiseImage aborted/.test(error.message) && error.cause instanceof Error);
  assert.match(lines.join('\n'), /not recognized as a supported image format/);
  await assert.rejects(broken.denoise({ image }), /Create a new denoiser/);
  await broken.dispose();
});

test('a load failure rejects the factory and leaves no worker behind', async () => {
  await assert.rejects(createRegistration({ wasm: new URL('./missing.wasm', import.meta.url) }), /ENOENT|no such file/);
});

// RSS is process-wide and the allocator keeps some pages, so the numbers are reported, not pinned.
test('dispose() returns the worker heap to the system', async (t) => {
  const rss = () => process.memoryUsage().rss;
  const settle = async () => {
    globalThis.gc?.();
    await delay(500);
    return rss();
  };
  const start = await settle();
  const workers = [await createRegistration(), await createRegistration(), await createDenoiser()];
  const big = phantom();
  await registrationOutputs(workers[0]);
  await registrationOutputs(workers[1]);
  await workers[2].denoise({ image: big });
  const loaded = rss();
  const heaps = [];
  for (const worker of workers) heaps.push((await worker.dispose()).heapBytes);
  const after = await settle();
  t.diagnostic(`rss before load ${MB(start)}, after runs ${MB(loaded)}, after dispose ${MB(after)}`);
  t.diagnostic(`wasm heaps at dispose: ${heaps.map(MB).join(', ')}; largest ${MB(Math.max(...heaps))}`);
  assert.ok(loaded > start, 'three live instances should raise RSS');
  assert.ok(after < loaded, 'disposing should lower RSS');
});
