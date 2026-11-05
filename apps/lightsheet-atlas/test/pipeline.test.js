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
