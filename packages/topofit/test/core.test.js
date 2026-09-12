import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateBrainAffine } from '../src/affine.js';
import { runTopofit } from '../src/pipeline.js';
import { writeFreeSurfer } from '../src/results.js';
import { axisAlignedVoxelSpacing, cropAndNormalize, imageCenter } from '../src/volume.js';

test('weighted affine fit recovers the source transform', () => {
  const templates = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
    1, 1, 1,
  ]);
  const expected = [
    [2, 0.1, 0, 10],
    [0, 3, 0.2, -4],
    [0.3, 0, 4, 7],
    [0, 0, 0, 1],
  ];
  const targets = new Float32Array(templates.length);
  for (let i = 0; i < templates.length; i += 3) {
    for (let row = 0; row < 3; row += 1) {
      targets[i + row] = expected[row][0] * templates[i] + expected[row][1] * templates[i + 1] + expected[row][2] * templates[i + 2] + expected[row][3];
    }
  }
  const actual = estimateBrainAffine(targets, new Float32Array([0.1, 0.2, 0.3, 0.15, 0.25]), templates);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      assert.ok(Math.abs(actual[row][column] - expected[row][column]) < 1e-4);
    }
  }
});

test('runtime rejects presets without browser and container parity evidence', async () => {
  await assert.rejects(
    runTopofit({ buffer: new ArrayBuffer(0), model: 'synth-1mm' }),
    /Unknown TopoFit model/,
  );
});

test('crop uses BrainNet axis order, zero padding, and quantile normalization', () => {
  const volume = {
    data: Float32Array.from({ length: 27 }, (_, index) => index),
    dims: [3, 3, 3],
    affine: [[1, 0, 0, 4], [0, 1, 0, 5], [0, 0, 1, 6], [0, 0, 0, 1]],
  };
  const output = cropAndNormalize(volume, [3, 3, 3], imageCenter(volume.dims));
  assert.deepEqual(output.offset, [1, 1, 1]);
  const normalized = (value) => value / 25.974;
  assert.ok(Math.abs(output.data[0] - normalized(13)) < 1e-7);
  assert.ok(Math.abs(output.data[1] - normalized(22)) < 1e-7);
  assert.ok(Math.abs(output.data[3] - normalized(16)) < 1e-7);
  assert.ok(Math.abs(output.data[9] - normalized(14)) < 1e-7);
  assert.deepEqual(output.affine, [[1, 0, 0, 5], [0, 1, 0, 6], [0, 0, 1, 7], [0, 0, 0, 1]]);
});

test('axis-aligned spacing follows voxel axes through orientation permutations', () => {
  const affine = [
    [0, 0, -4, 10],
    [2, 0, 0, 20],
    [0, 3, 0, 30],
    [0, 0, 0, 1],
  ];
  assert.deepEqual(axisAlignedVoxelSpacing(affine), [2, 3, 4]);
  assert.throws(
    () => axisAlignedVoxelSpacing([[1, 0.1, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]),
    /axis-aligned/,
  );
});

test('FreeSurfer writer emits triangular geometry and volume metadata', () => {
  const buffer = writeFreeSurfer(
    new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    new Int32Array([0, 1, 2]),
    'test',
  );
  const bytes = new Uint8Array(buffer);
  assert.deepEqual([...bytes.slice(0, 3)], [255, 255, 254]);
  const headerEnd = new TextDecoder().decode(bytes).indexOf('\n\n') + 2;
  const view = new DataView(buffer);
  assert.equal(view.getInt32(headerEnd, false), 3);
  assert.equal(view.getInt32(headerEnd + 4, false), 1);
  assert.match(new TextDecoder().decode(bytes.slice(-180)), /valid = 1/);
});
