import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArguments, writeMatTransform } from '@neurodesk/hmc-registration';
import { loadGreedySingleThread } from '@neurodesk/greedy/single';
import { loadHmcRegistration } from '@neurodesk/hmc-registration/node';
import { createFloat32Nifti, createNiftiHeaderFromVolume, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import {
  applyArguments,
  flairToT1,
  GREEDY_NONLINEAR,
  greedyMatrixToMat,
  invertGreedyMatrix,
  niftiName,
  templateToFlair,
  templateToT1,
  templateToT1Linear,
} from '../src/register.js';

test('the nonlinear warp is NCC with radius 2 down to the 1 mm level', () => {
  assert.equal(GREEDY_NONLINEAR.metric, 'NCC 2x2x2');
  assert.ok(GREEDY_NONLINEAR.iterations.split('x').map(Number).every((iterations) => iterations > 0));
});

test('invertGreedyMatrix gives the matrix that undoes it, in the same text form', () => {
  const [c, s] = [Math.cos(0.3), Math.sin(0.3)];
  const text = `${1.1 * c} ${-s} 0.05 3\n${s} ${0.9 * c} 0 -5\n0 0.03 1.2 2\n0 0 0 1\n`;
  const rows = (value) => value.trim().split('\n').map((line) => line.split(' ').map(Number));
  const [m, inverse] = [rows(text), rows(invertGreedyMatrix(text))];
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) {
      const product = [0, 1, 2, 3].reduce((sum, j) => sum + m[r][j] * inverse[j][k], 0);
      assert.ok(Math.abs(product - (r === k ? 1 : 0)) < 1e-12, `${r},${k}: ${product}`);
    }
  }
  assert.throws(() => invertGreedyMatrix('1 0 0 0\n0 0 0 0\n0 0 1 0\n0 0 0 1\n'), /invertible/);
});

test('transform lists put the transform that acts first on the output point last', () => {
  assert.deepEqual(templateToT1Linear({ affine: 'lin.mat' }), ['inverse:lin.mat']);
  assert.deepEqual(templateToT1({ affine: 'lin.mat', warp: 'warp.nii' }), ['inverse:lin.mat', 'warp.nii']);
  assert.deepEqual(templateToFlair({ t1Affine: 'lin.mat', rigid: 'rigid.mat' }), ['inverse:lin.mat', 'inverse:rigid.mat']);
  assert.deepEqual(flairToT1({ rigid: 'rigid.mat' }), ['rigid.mat']);
});

test('applyArguments builds --apply argv and refuses unknown interpolation', () => {
  assert.deepEqual(
    applyArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o.nii', interpolation: 'BSpline[2]', transforms: ['a.mat'] }),
    ['--apply', 'f.nii', 'm.nii', 'o.nii', 'BSpline[2]', '0', 'a.mat'],
  );
  assert.throws(() => applyArguments({ fixed: 'f', moving: 'm', output: 'o', interpolation: 'Cubic', transforms: ['a.mat'] }), /interpolation/);
  assert.throws(() => applyArguments({ fixed: 'f', moving: 'm', output: 'o', interpolation: 'Linear', transforms: [] }), /transform/);
  assert.deepEqual(checkArguments(applyArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o.nii', interpolation: 'Linear', transforms: ['inverse:a.mat'] })).length, 7);
});

test('niftiName keeps .nii.gz for gzipped bytes', () => {
  assert.equal(niftiName('t1', new Uint8Array([0x1f, 0x8b, 8])), 't1.nii.gz');
  assert.equal(niftiName('t1', new Uint8Array([92, 1, 0])), 't1.nii');
});

const matFile = (parameters) => writeMatTransform({ transform: 'AffineTransform_double_3_3', parameters, fixed: [0, 0, 0] });

test('hmc --apply applies the last listed transform first', async () => {
  // A 3-voxel cube at k = 32 on a 1 mm identity grid; T moves +10 mm along z, S doubles z.
  // Last listed first: moving(T(S(p))), so the cube lands at 2k + 10 = 32, k = 11 (else k = 6).
  const n = 64;
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, n, n, n, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] } });
  const image = new Float32Array(n ** 3);
  for (let z = 31; z <= 33; z++) {
    for (let y = 31; y <= 33; y++) {
      for (let x = 39; x <= 41; x++) image[(z * n + y) * n + x] = 100;
    }
  }
  const ants = await loadHmcRegistration();
  const { outputs } = ants.run(['--apply', 'image.nii', 'image.nii', 'out.nii', 'Linear', '0', 'T.mat', 'S.mat'], {
    'image.nii': new Uint8Array(createFloat32Nifti(image, header)),
    'T.mat': matFile([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 10]),
    'S.mat': matFile([1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]),
  });
  const { data } = readNiftiImageData(outputs['out.nii']);
  let peak = 0;
  for (let i = 1; i < data.length; i++) if (data[i] > data[peak]) peak = i;
  assert.equal(Math.floor(peak / (n * n)), 11);
});

test('a Greedy matrix as .mat resamples through --apply as Greedy reslices with it', async () => {
  // An oblique, flipped 2 mm grid and a smooth image, so a sign or axis error moves the result.
  const n = 40;
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, n, n, n, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine: [[-2, 0.2, 0, 38], [0.1, 2, 0, -41], [0, 0, 2, -37]] } });
  const image = new Float32Array(n ** 3).map((_, i) => {
    const [x, y, z] = [i % n, Math.floor(i / n) % n, Math.floor(i / n ** 2)];
    return 100 * Math.exp(-((x - 18) ** 2 + (y - 22) ** 2 + (z - 20) ** 2) / 60) + x + 2 * y + 3 * z;
  });
  const bytes = new Uint8Array(createFloat32Nifti(image, header));
  // A rotation about z of 0.2 rad, a small shear and a translation, in RAS from fixed to moving.
  const [c, s] = [Math.cos(0.2), Math.sin(0.2)];
  const matrix = `${c} ${-s} 0.05 3\n${s} ${c} 0 -5\n0 0.03 1.1 2\n0 0 0 1\n`;
  const greedy = await loadGreedySingleThread();
  const expected = readNiftiImageData(greedy.reslice_affine_options(bytes, bytes, matrix, false, 0).buffer).data;
  const ants = await loadHmcRegistration();
  const { outputs } = ants.run(['--apply', 'image.nii', 'image.nii', 'out.nii', 'Linear', '0', 'greedy.mat'], { 'image.nii': bytes, 'greedy.mat': greedyMatrixToMat(matrix) });
  const { data } = readNiftiImageData(outputs['out.nii']);
  // The two differ only within a voxel of the moving image's edge, where Greedy blends in the
  // background and ITK does not interpolate: compare voxels whose neighbours both filled.
  const filled = (i) => data[i] !== 0 && expected[i] !== 0;
  const inner = (i) => [i % n, Math.floor(i / n) % n, Math.floor(i / n ** 2)].every((k) => k > 0 && k < n - 1);
  let compared = 0;
  for (let i = 0; i < data.length; i++) {
    if (!inner(i) || ![0, 1, -1, n, -n, n * n, -n * n].every((step) => filled(i + step))) continue;
    assert.ok(Math.abs(data[i] - expected[i]) < 1e-3, `voxel ${i}: ${data[i]} against ${expected[i]}`);
    compared++;
  }
  assert.ok(compared > n ** 3 / 3, `${compared} voxels compared`);
});

test('a Greedy warp after the inverse T1 affine resamples through --apply as Greedy reslices', async () => {
  // As in BISON: the affine maps template (here `moving`) points to T1 (`fixed`) points, and the
  // warp is registered on the fixed grid from its inverse. templateToT1 must list them so --apply
  // maps a T1 point through the warp, then the inverse affine.
  const n = 32;
  const grid = (affine) => createNiftiHeaderFromVolume({ hdr: { dims: [3, n, n, n, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine } });
  const blob = (cx, cy, cz) => new Float32Array(n ** 3).map((_, i) => {
    const [x, y, z] = [i % n, Math.floor(i / n) % n, Math.floor(i / n ** 2)];
    return 100 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) / 20) + 0.5 * x + y;
  });
  const fixed = new Uint8Array(createFloat32Nifti(blob(15, 16, 16), grid([[-2, 0.1, 0, 30], [0, 2, 0, -31], [0, 0, 2, -29]])));
  const moving = new Uint8Array(createFloat32Nifti(blob(17, 15, 16), grid([[-2, 0, 0, 32], [0, 2, 0, -30], [0, 0.1, 2, -30]])));
  const affine = '1.02 0.03 0 1\n-0.02 0.98 0 -2\n0 0 1 0.5\n0 0 0 1\n';
  const start = invertGreedyMatrix(affine);
  const greedy = await loadGreedySingleThread();
  const warp = greedy.register_svf_masked_wasm(fixed, moving, null, start, 'NCC 2x2x2', '5x5x0');
  const expected = readNiftiImageData(greedy.reslice_warp_affine(fixed, moving, warp, start).buffer).data;
  const ants = await loadHmcRegistration();
  const transforms = templateToT1({ affine: 'lin.mat', warp: 'warp.nii' });
  const { outputs } = ants.run(['--apply', 'fixed.nii', 'moving.nii', 'out.nii', 'Linear', '0', ...transforms], {
    'fixed.nii': fixed, 'moving.nii': moving, 'lin.mat': greedyMatrixToMat(affine), 'warp.nii': warp,
  });
  const { data } = readNiftiImageData(outputs['out.nii']);
  const filled = (i) => data[i] !== 0 && expected[i] !== 0;
  const inner = (i) => [i % n, Math.floor(i / n) % n, Math.floor(i / n ** 2)].every((k) => k > 0 && k < n - 1);
  let compared = 0;
  for (let i = 0; i < data.length; i++) {
    if (!inner(i) || ![0, 1, -1, n, -n, n * n, -n * n].every((step) => filled(i + step))) continue;
    assert.ok(Math.abs(data[i] - expected[i]) < 1e-2, `voxel ${i}: ${data[i]} against ${expected[i]}`);
    compared++;
  }
  assert.ok(compared > n ** 3 / 3, `${compared} voxels compared`);
});

test('greedyMatrixToMat refuses text that is not a 4 x 4 matrix', () => {
  assert.throws(() => greedyMatrixToMat('1 0 0\n0 1 0\n0 0 1'), /four rows of four numbers/);
  assert.throws(() => greedyMatrixToMat('1 0 0 x\n0 1 0 0\n0 0 1 0\n0 0 0 1'), /four rows of four numbers/);
});
