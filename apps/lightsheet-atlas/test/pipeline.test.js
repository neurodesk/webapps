import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';
import { chooseLevel, runPipeline } from '../src/pipeline.js';
import { resultFiles } from '../src/outputs.js';

const syntheticStack = (shape, extra = {}) => ({
  shape,
  dtype: 'uint16',
  async readPlane(z) {
    return Uint16Array.from({ length: shape[1] * shape[2] }, (_, i) => 100 + i + z);
  },
  ...extra,
});

test('the grid spacing is permuted with the data, through to the NIfTI header', async () => {
  // sra: planes run superior (atlas axis 1), rows right->left (axis 2), columns anterior (axis 0).
  const result = await runPipeline({ stack: syntheticStack([4, 8, 10]), voxelSizeUm: [5, 2, 1], orientation: 'sra', register: false, cells: [[1, 2, 3]] });
  assert.deepEqual(result.grid.shape, [10, 4, 8]);
  assert.deepEqual(result.spacingUm, [1, 5, 2]);
  const { files } = resultFiles(result, { register: false, voxelSizeUm: [5, 2, 1] });
  for (const bytes of [files.sample, files.marks]) {
    const header = parseNiftiHeader(bytes);
    assert.deepEqual(header.dims.slice(1, 4), [10, 4, 8]);
    assert.deepEqual(header.voxelSize.map((v) => Number(v.toFixed(6))), [0.001, 0.005, 0.002]);
  }
  assert.match(new TextDecoder().decode(files.candidates), /^x,y,z,x_um,y_um,z_um\n1,2,3,1\.00,4\.00,15\.00\n$/);
});

test('a registration-only run reads the coarsest OME-Zarr level at most 50 µm', async () => {
  const levels = [[200, 160, 120], [100, 80, 60], [50, 40, 30], [25, 20, 15]].map((shape) => ({ shape }));
  // Level 0 at 10 µm: levels at 20, 40 and 80 µm; 40 µm is the coarsest within 50 µm.
  assert.deepEqual(chooseLevel({ shape: levels[0].shape, levels }, [10, 10, 10]), { level: 2, shape: [50, 40, 30], voxelSizeUm: [40, 40, 40] });
  assert.equal(chooseLevel({ shape: [5, 5, 5] }, [10, 10, 10]).level, 0);
  const read = new Set();
  const stack = syntheticStack(levels[0].shape, {
    levels,
    async readPlane(z, level = 0) {
      read.add(level);
      const [, h, w] = levels[level].shape;
      return new Uint16Array(h * w);
    },
  });
  const stop = new Error('atlas not needed');
  const loadAtlas = async () => {
    throw stop;
  };
  await assert.rejects(runPipeline({ stack, voxelSizeUm: [10, 10, 10], orientation: 'asr', register: true, detect: false, loadAtlas }), stop);
  assert.deepEqual([...read], [2]);
  // Detection needs full resolution.
  read.clear();
  await assert.rejects(runPipeline({ stack, voxelSizeUm: [10, 10, 10], orientation: 'asr', register: true, cells: [], loadAtlas }), stop);
  assert.deepEqual([...read], [0]);
});

test('the level choice follows the declared OME-Zarr scales, not the shape ratio', () => {
  // An odd-sized pyramid: 101³ at 10.2 µm and 21³ at 51 µm. The shape ratio makes level 1
  // 49.06 µm, but its declared voxels are 51 µm, coarser than the atlas.
  const levels = [
    { shape: [101, 101, 101], scale: { z: 10.2, y: 10.2, x: 10.2 } },
    { shape: [51, 51, 51], scale: { z: 20.4, y: 20.4, x: 20.4 } },
    { shape: [21, 21, 21], scale: { z: 51, y: 51, x: 51 } },
  ];
  const chosen = chooseLevel({ shape: levels[0].shape, levels }, [10.2, 10.2, 10.2]);
  assert.equal(chosen.level, 1);
  assert.deepEqual(chosen.voxelSizeUm.map((v) => Number(v.toFixed(9))), [20.4, 20.4, 20.4]);
  // The user's calibration scales the declared ratios: at 8 µm, level 2 is 40 µm.
  const recalibrated = chooseLevel({ shape: levels[0].shape, levels }, [8, 8, 8]);
  assert.equal(recalibrated.level, 2);
  assert.deepEqual(recalibrated.voxelSizeUm.map((v) => Number(v.toFixed(9))), [40, 40, 40]);
});

test('declared scales without axis units still set the level choice, read through the OME-Zarr reader', async () => {
  // 101³ then 21³ with declared scales 10.2 and 51 but no axis unit: the scale ratio is 5, so at
  // a 10.2 µm calibration level 1 is 51 µm, coarser than the atlas, and level 0 is read.
  const { openOmeZarrStack } = await import('../../../packages/components/src/file-io/microscopy-stack.js');
  const files = [];
  const add = (path, value) => {
    const file = new File([JSON.stringify(value)], path.split('/').at(-1));
    Object.defineProperty(file, 'webkitRelativePath', { value: `sample.zarr/${path}` });
    files.push(file);
  };
  add('.zgroup', { zarr_format: 2 });
  add('.zattrs', { multiscales: [{ version: '0.4', axes: ['z', 'y', 'x'].map((name) => ({ name, type: 'space' })), datasets: [
    { path: '0', coordinateTransformations: [{ type: 'scale', scale: [10.2, 10.2, 10.2] }] },
    { path: '1', coordinateTransformations: [{ type: 'scale', scale: [51, 51, 51] }] },
  ] }] });
  for (const [i, size] of [101, 21].entries()) add(`${i}/.zarray`, { zarr_format: 2, shape: [size, size, size], chunks: [1, size, size], dtype: '<u2', compressor: null, fill_value: 0, order: 'C', filters: null });
  const stack = await openOmeZarrStack(files);
  assert.equal(stack.levels[1].voxelSizeUm.z, null);
  assert.equal(chooseLevel(stack, [10.2, 10.2, 10.2]).level, 0);
  assert.equal(chooseLevel(stack, [9, 9, 9]).level, 1);
});

test('oversized grids and runs are refused before any plane is read', async () => {
  let reads = 0;
  const counting = (shape) => syntheticStack(shape, {
    async readPlane() {
      reads++;
      return new Uint16Array(shape[1] * shape[2]);
    },
  });
  // Millimetres typed as microns: a 100 mm cube is no mouse brain.
  await assert.rejects(runPipeline({ stack: counting([100, 100, 100]), voxelSizeUm: [1000, 1000, 1000], orientation: 'asr', register: true }), /larger than a mouse brain/);
  // 20000 × 20000 planes need tens of GB for detection buffers.
  await assert.rejects(runPipeline({ stack: counting([10, 20000, 20000]), voxelSizeUm: [5, 2, 2], orientation: 'asr', register: false, detect: true }), /working memory/);
  assert.equal(reads, 0);
});
