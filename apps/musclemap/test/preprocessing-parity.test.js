import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { computeForegroundBBox, cropVolume } from '../../../packages/components/src/volume/geometry.js';
import { zScoreNormalize } from '../../../packages/components/src/volume/normalization.js';
import '../web/js/monai-compat.js';
import '../web/js/sliding-window-policy.js';

const workerSource = readFileSync(new URL('../web/js/inference-worker.js', import.meta.url), 'utf8');
const context = vm.createContext({
  Float32Array,
  Uint8Array,
  computeForegroundBBox,
  cropVolume,
  zScoreNormalize,
  MuscleMapMonaiCompat: globalThis.MuscleMapMonaiCompat,
  MuscleMapSlidingWindowPolicy: globalThis.MuscleMapSlidingWindowPolicy,
  ort: { Tensor: class { constructor(type, data, dims) { this.dims = dims; } dispose() {} } }
});
for (const name of ['prepareSourceChunk', 'computeTilePositions', 'inferSliceLogits']) {
  const match = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(workerSource);
  assert.ok(match, `Worker function ${name} exists`);
  const start = match.index;
  const end = workerSource.indexOf('\n}\n', start) + 2;
  vm.runInContext(workerSource.slice(start, end), context);
}

test('source chunks crop positive normalized foreground and preserve negative intensities', () => {
  const data = new Float32Array(100).fill(1);
  data[50] = 100;
  const affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const actual = context.prepareSourceChunk(data, [100, 1, 1], affine, [1, 1, -1], 20);
  assert.deepEqual(Array.from(actual.cropOrigin), [30, 0, 0]);
  assert.deepEqual(Array.from(actual.dims), [41, 1, 1]);
  assert.ok(Math.abs(actual.data[20] - Math.sqrt(99)) < 1e-6);
  assert.ok(Math.abs(actual.data[0] + 1 / Math.sqrt(99)) < 1e-7);
  assert.equal(actual.data[0], actual.data[40]);
});

test('slices pad to the upstream 256 x 256 grid before 128 x 128 sliding windows', async () => {
  const tiles = [];
  const session = {
    inputNames: ['input'],
    outputNames: ['output'],
    async run({ input }) {
      tiles.push(input.dims[0]);
      return { output: { data: new Float32Array(input.dims[0] * 2 * 128 * 128) } };
    }
  };
  const result = await context.inferSliceLogits({
    session,
    slice: new Float32Array(100 * 90),
    sizeX: 100,
    sizeY: 90,
    padHeight: 256,
    padWidth: 256,
    roiHeight: 128,
    roiWidth: 128,
    numClasses: 2,
    overlap: 0.5,
    gaussianWeights: new Float32Array(128 * 128).fill(1),
    batchSize: 1
  });
  assert.deepEqual(Array.from(result.dims), [256, 256]);
  // MONAI SliceInferer over 256 x 256 with a 128 ROI at 50 % overlap visits a 3 x 3 grid.
  assert.equal(tiles.length, 9);
});

test('native-depth grid preserves PyTorch float64 coordinate rounding', () => {
  const { identity4, torchGridSourcePoint } = globalThis.MuscleMapMonaiCompat;
  const dims = [410, 307, 17];
  const point = torchGridSourcePoint(identity4(), [0, 0, 2], dims, dims);
  // torch 2.4.1 affine_grid(identity, [1, 1, 410, 307, 17], align_corners=False).
  assert.equal(point[2], 1.9999999999999996);
});

test('resampling preserves MONAI intensities and exact zero support before normalization', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('./fixtures/monai-native-depth17.json', import.meta.url), 'utf8'
  ));
  const input = new Float32Array(fixture.dims.reduce((count, size) => count * size, 1));
  const expected = new Float32Array(fixture.outputDims.reduce((count, size) => count * size, 1));
  for (const [index, value] of fixture.input) input[index] = value;
  for (const [index, value] of fixture.output) expected[index] = value;
  const actual = globalThis.MuscleMapMonaiCompat.resampleVolume(
    input, fixture.dims, fixture.affine, [1, 1, -1]
  );
  assert.deepEqual(actual.dims, fixture.outputDims);
  assert.deepEqual(actual.data, expected);
});

const stages = JSON.parse(readFileSync(new URL('./fixtures/monai-resampling-stages.json', import.meta.url), 'utf8'));

function assertMatrixClose(actual, expected, message) {
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      assert.ok(Math.abs(actual[row][column] - expected[row][column]) < 2e-12,
        `${message}[${row},${column}]: ${actual[row][column]} != ${expected[row][column]}`);
    }
  }
}

for (const fixture of stages.cases) {
  test(`pinned MONAI spacing stages: ${fixture.name}`, () => {
    const compat = globalThis.MuscleMapMonaiCompat;
    const input = new Float32Array(fixture.dims.reduce((count, size) => count * size, 1));
    const expected = new Float32Array(fixture.outputDims.reduce((count, size) => count * size, 1));
    for (const [index, value] of fixture.input) input[index] = value;
    for (const [index, value] of fixture.output) expected[index] = value;
    const actual = compat.resampleVolume(input, fixture.dims, fixture.affine, fixture.spacing);
    assert.deepEqual(actual.dims, fixture.outputDims);
    assertMatrixClose(actual.affine, fixture.outputAffine, 'output affine');
    const theta = compat.createTorchGridTransform(fixture.affine, fixture.dims, actual.affine, actual.dims);
    assertMatrixClose(theta, fixture.theta, 'normalized transform');
    for (const point of fixture.points) {
      const source = compat.torchGridSourcePoint(theta, point.output, fixture.dims, actual.dims);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(source[axis] - point.source[axis]) < 2e-12, `source coordinate axis ${axis}`);
      }
    }
    assert.deepEqual(actual.data, expected);
  });
}

const compatSource = readFileSync(new URL('../web/js/monai-compat.js', import.meta.url), 'utf8');
const axisStart = compatSource.indexOf('  function createTorchAxis(');
const axisEnd = compatSource.indexOf('\n  function torchGridSourcePoint', axisStart);
const axisContext = vm.createContext({ Float64Array, DataView, ArrayBuffer, Math, BigInt, Number });
vm.runInContext(compatSource.slice(axisStart, axisEnd), axisContext);

test('private grid axes match pinned CPU torch.linspace bit for bit', () => {
  for (const axis of stages.axes) {
    assert.deepEqual(axisContext.createTorchAxis(axis.size), Float64Array.from(axis.values), `axis size ${axis.size}`);
  }
  assert.deepEqual(axisContext.createTorchAxis(1), new Float64Array([0]));
  const hash = createHash('sha256');
  for (let size = 1; size <= 1024; size++) {
    const axis = axisContext.createTorchAxis(size);
    hash.update(Buffer.from(axis.buffer));
  }
  assert.equal(hash.digest('hex'), stages.axes1Through1024Sha256);
});

test('invalid affines and malformed volumes fail before sampling', () => {
  const { identity4, invert4, resampleVolume } = globalThis.MuscleMapMonaiCompat;
  for (const value of [NaN, Infinity, -Infinity]) {
    const affine = identity4();
    affine[0][3] = value;
    assert.throws(() => resampleVolume(new Float32Array(8), [2, 2, 2], affine, [1, 1, 1]), /finite/);
  }
  for (const value of [0, 1e-13]) {
    const affine = identity4();
    affine[0][0] = value;
    assert.throws(() => invert4(affine), /invertible/);
  }
  const nearThreshold = identity4();
  nearThreshold[0][0] = 1e-12;
  assert.equal(invert4(nearThreshold)[0][0], 1e12);
  const repeated = identity4();
  repeated[1] = repeated[0];
  assert.throws(() => resampleVolume(new Float32Array(8), [2, 2, 2], repeated, [1, 1, 1]), /invertible/);
  assert.throws(() => resampleVolume(new Float32Array(8), [2, 2, 3], identity4(), [1, 1, 1]), /dimensions/);
  assert.throws(() => resampleVolume(new Float32Array(8), [2, 2, 0], identity4(), [1, 1, 1]), /dimensions/);
});
