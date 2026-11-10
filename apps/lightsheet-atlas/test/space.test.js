import test from 'node:test';
import assert from 'node:assert/strict';
import { areaWeights, atlasOrderShape, createDownsampler, downsampledShape, parseOrientation, stackToGrid } from '../src/space.js';
import { gridHeader, sampleTrilinear } from '../src/registration.js';
import { parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';

test('orientations name each anatomical axis once', () => {
  assert.deepEqual(parseOrientation('psl'), [{ atlasAxis: 0, flip: true }, { atlasAxis: 1, flip: false }, { atlasAxis: 2, flip: true }]);
  assert.deepEqual(parseOrientation('SAL').map((a) => a.atlasAxis), [1, 0, 2]);
  assert.throws(() => parseOrientation('pss'), /names one anatomical axis twice/);
  assert.throws(() => parseOrientation('xyz'), /three letters/);
});

test("the example brain gets brainreg's downsampled grid", () => {
  // brainreg's downsampled.tiff for -v 50 40 40 --orientation psl on 270 × 193 × 271 planes
  assert.deepEqual(downsampledShape([270, 193, 271], [50, 40, 40], 50), [270, 154, 217]);
  assert.deepEqual(atlasOrderShape([270, 154, 217], 'psl'), [270, 154, 217]);
  assert.deepEqual(atlasOrderShape([10, 20, 30], 'lai'), [20, 30, 10]);
});

test('area weights cover every source voxel once', () => {
  for (const [n, m] of [[193, 154], [10, 3], [3, 7]]) {
    const total = new Float64Array(n);
    for (const taps of areaWeights(n, m)) for (const [i, w] of taps) total[i] += (w * n) / m;
    for (const t of total) assert.ok(Math.abs(t - 1) < 1e-12);
  }
});

test('downsampling averages areas and reorients to asr', () => {
  // A 2 × 2 × 4 stack in "psl" averaged to 1 µm -> 2 µm in-plane: columns pair up, then
  // planes (posterior first) and columns (left first) are reversed.
  const shape = [2, 2, 4];
  const ds = createDownsampler({ shape, voxelSizeUm: [2, 2, 1], orientation: 'psl', resolutionUm: 2 });
  ds.push(0, Float32Array.from([1, 3, 5, 7, 9, 11, 13, 15]));
  ds.push(1, Float32Array.from([2, 4, 6, 8, 10, 12, 14, 16]));
  const { data, shape: out } = ds.finish();
  assert.deepEqual(out, [2, 2, 2]);
  const at = (a, s, r) => data[a + 2 * (s + 2 * r)];
  // asr a=0 is the last stack plane (z=1); r=0 is the last column pair.
  assert.equal(at(0, 0, 0), (6 + 8) / 2);
  assert.equal(at(1, 0, 0), (5 + 7) / 2);
  assert.equal(at(1, 1, 1), (9 + 11) / 2);
});

test('stack voxels map to the same grid positions the downsampler uses', () => {
  const shape = [270, 193, 271];
  const target = [270, 154, 217];
  const p = stackToGrid([0, 0, 0], shape, target, 'psl');
  assert.ok(Math.abs(p[0] - 269) < 1e-9);
  assert.ok(Math.abs(p[1] - ((0.5 * 154) / 193 - 0.5)) < 1e-9);
  assert.ok(Math.abs(p[2] - (216 - ((0.5 * 217) / 271 - 0.5))) < 1e-9);
});

test('trilinear sampling interpolates and refuses outside or unmapped voxels', () => {
  const shape = [2, 2, 2];
  const volume = Float32Array.from([0, 1, 0, 1, 0, 1, 0, 1]);
  assert.equal(sampleTrilinear(volume, shape, [0.25, 0.5, 0.5]), 0.25);
  assert.equal(sampleTrilinear(volume, shape, [2, 0, 0]), null);
  volume[0] = -1;
  assert.equal(sampleTrilinear(volume, shape, [0.25, 0, 0]), null);
});

test('grid headers carry the spacing in millimetres and the asr axes', () => {
  const header = parseNiftiHeader(gridHeader([10, 20, 30], [5, 2, 2]));
  assert.deepEqual(header.dims.slice(1, 4), [10, 20, 30]);
  assert.deepEqual(header.voxelSize.map((v) => Number(v.toFixed(6))), [0.005, 0.002, 0.002]);
  const a = header.affine.map((row) => [...row].map((v) => Number(v.toFixed(6))));
  assert.deepEqual(a.slice(0, 3), [[0, 0, -0.002, 0], [-0.005, 0, 0, 0], [0, -0.002, 0, 0]]);
});
