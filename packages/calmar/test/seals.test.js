import assert from 'node:assert/strict';
import test from 'node:test';
import reference from './fixtures/seals-reference.json' with { type: 'json' };
import {
  adcFromB0,
  cropAndNormalize,
  fillHoles,
  gaussianImportance,
  grid1mm,
  predictLesionProbability,
  resampleLinearItk,
  slidingWindowSteps
} from '../src/seals.js';

// Expected values: validation/seals-reference.py, from nnU-Net v1's own
// functions (SEALS' copy) and scipy.ndimage.binary_fill_holes.

test('sliding-window steps match nnU-Net, including numpy round-half-even', () => {
  for (const [size, steps] of Object.entries(reference.steps)) {
    assert.deepEqual(slidingWindowSteps(Number(size)), steps, `size ${size}`);
  }
});

test('Gaussian importance matches nnU-Net _get_gaussian(128, 1/8)', () => {
  const g = gaussianImportance();
  for (const [key, value] of Object.entries(reference.gaussian)) {
    const [x, y, z] = key.split(',').map(Number);
    const got = g[x + 128 * (y + 128 * z)];
    assert.ok(Math.abs(got - value) <= 1e-6 * Math.max(value, 1e-5), `${key}: ${got} vs ${value}`);
  }
});

test('hole filling matches scipy binary_fill_holes (6-connected)', () => {
  assert.deepEqual(Array.from(fillHoles(Uint8Array.from(reference.fill_mask), [7, 6, 5])), reference.fill_holes);
});

test('crop and normalisation match nnU-Net v1 crop_to_nonzero + masked z-score', () => {
  const channels = reference.crop_input.map(c => Float32Array.from(c));
  const crop = cropAndNormalize(channels, [8, 7, 6]);
  assert.deepEqual(crop.offset, reference.crop_offset);
  assert.deepEqual(crop.dims, reference.crop_dims);
  for (let c = 0; c < 2; c++) {
    const worst = reference.crop_data[c].reduce((m, v, i) => Math.max(m, Math.abs(v - crop.data[c][i])), 0);
    assert.ok(worst < 1e-5, `channel ${c} differs by ${worst}`);
  }
});

test('linear resampling matches SimpleITK, including its half-voxel edges', () => {
  for (const { size, spacing, origin, out_size: outSize, values, expected } of reference.resample) {
    const affine = [[spacing[0], 0, 0, origin[0]], [0, spacing[1], 0, origin[1]], [0, 0, spacing[2], origin[2]], [0, 0, 0, 1]];
    const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    const got = resampleLinearItk(Float32Array.from(values), size, affine, outSize, identity);
    const worst = expected.reduce((m, v, i) => Math.max(m, Math.abs(v - got[i])), 0);
    assert.ok(worst < 1e-3, `${size} at ${spacing}: differs by ${worst}`);
  }
});

test('1 mm grid keeps origin and directions and rounds the extent', () => {
  const grid = grid1mm([256, 256, 30], [[-0.9375, 0, 0, 120], [0, 0.9375, 0, -100], [0, 0, 5, -60], [0, 0, 0, 1]]);
  assert.deepEqual(grid.dims, [240, 240, 150]);
  assert.deepEqual(grid.affine, [[-1, 0, 0, 120], [0, 1, 0, -100], [0, 0, 1, -60], [0, 0, 0, 1]]);
});

test('ADC from b0 and TRACE is ln(b0 / TRACE) / b, zero where undefined or negative', () => {
  const adc = adcFromB0(Float32Array.from([1000, 1000, 0, 500, 100]), Float32Array.from([367.879, 1000, 50, 0, 200]));
  assert.ok(Math.abs(adc[0] - 0.001) < 1e-8, `${adc[0]}`);
  assert.deepEqual(Array.from(adc.slice(1)), [0, 0, 0, 0]);
});

test('the sliding window averages softmax over 8 mirrorings and maps patches back unflipped', async () => {
  // A stand-in model that marks voxels whose first channel exceeds the
  // second; it is equivariant under flips, so mirroring must not move the
  // lesion, and every voxel is seen by a full 128^3 patch after padding.
  const dims = [20, 30, 10];
  const n = dims[0] * dims[1] * dims[2];
  const a = new Float32Array(n);
  const b = new Float32Array(n).fill(1);
  const lesion = (x, y, z) => x >= 3 && x < 7 && y >= 20 && y < 25 && z >= 2 && z < 4;
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) if (lesion(x, y, z)) a[x + dims[0] * (y + dims[1] * z)] = 5;
    }
  }
  let calls = 0;
  const runPatch = async (patch, p) => {
    calls++;
    const per = p ** 3;
    const logits = new Float32Array(2 * per);
    for (let i = 0; i < per; i++) logits[per + i] = patch[i] > patch[per + i] ? 6 : -6;
    return logits;
  };
  const probability = await predictLesionProbability([a, b], dims, runPatch);
  assert.equal(calls, 8, 'one padded window, 8 mirrorings');
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        assert.equal(probability[x + dims[0] * (y + dims[1] * z)] > 0.5, lesion(x, y, z), `voxel ${x},${y},${z}`);
      }
    }
  }
});
