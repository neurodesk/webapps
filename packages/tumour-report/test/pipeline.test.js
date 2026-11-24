import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAIN_INPUT_DIMS,
  TUMOUR_PATCH_DIMS,
  checkLogits,
  fromModelTensor,
  patchBoundaries,
  segmentTumour,
  toModelTensor,
} from '../src/pipeline.js';
import { voxelIndex } from '../src/preprocess.js';
import { buildReport, caseName, compareBinaryMasks } from '../src/results.js';
import { computeNativeMorphometry } from '../src/morphometry.js';

const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

test('toModelTensor and fromModelTensor round-trip between Fortran and C order', () => {
  const dims = [3, 4, 5];
  const src = Float32Array.from({ length: 60 }, (_, i) => i + 1);
  const cOrder = toModelTensor(src, dims);
  assert.equal(cOrder[0], src[voxelIndex(0, 0, 0, dims)]);
  assert.equal(cOrder[1], src[voxelIndex(0, 0, 1, dims)]);
  const back = fromModelTensor(cOrder, dims);
  assert.deepEqual(back, src);
});

test('checkLogits rejects constant or non-finite outputs', () => {
  assert.throws(() => checkLogits(new Float32Array(10)), /same score/);
  assert.throws(() => checkLogits(new Float32Array([0, NaN])), /non-finite/);
  assert.doesNotThrow(() => checkLogits(new Float32Array([-1, 1])));
});

test('patchBoundaries snaps final window to volume edge', () => {
  const patches = patchBoundaries([160, 180, 160], TUMOUR_PATCH_DIMS);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0], [[0, 160], [0, 160], [0, 160]]);
  assert.deepEqual(patches[1], [[0, 160], [20, 180], [0, 160]]);
});

test('segmentTumour runs injected runners, supports skullStripped bypass, and builds complete report', async () => {
  const dims = [16, 16, 16];
  const data = new Float32Array(4096);
  for (let z = 3; z < 13; z++) {
    for (let y = 3; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        data[voxelIndex(x, y, z, dims)] = 100 + x + y + z;
      }
    }
  }
  const volume = { data, dims, affine: IDENTITY };

  // Inject mock tumour runner returning high logits inside the centered 10^3 crop.
  const mockTumor = async (tile, shape) => {
    assert.deepEqual(shape, [1, 1, ...TUMOUR_PATCH_DIMS]);
    const out = new Float32Array(tile.length).fill(-10);
    // Center of 160^3 padded from 10^3 is [75..85)
    for (let x = 77; x < 83; x++) {
      for (let y = 77; y < 83; y++) {
        for (let z = 77; z < 83; z++) {
          out[(x * 160 + y) * 160 + z] = 10;
        }
      }
    }
    return out;
  };

  // Skull-stripped mode skips runBrain altogether.
  let brainCalled = false;
  const res = await segmentTumour({
    volume,
    skullStripped: true,
    runBrain: async () => {
      brainCalled = true;
      return new Float32Array(BRAIN_INPUT_DIMS[0] * BRAIN_INPUT_DIMS[1] * BRAIN_INPUT_DIMS[2]);
    },
    runTumorCore: mockTumor,
  });
  assert.equal(brainCalled, false);
  assert.equal(res.patches, 1);
  assert.equal(res.keptComponents, 1);

  const morph = computeNativeMorphometry({
    tumourMask: res.tumourMask,
    brainMask: res.brainMask,
    dims: res.dims,
    affine: res.affine,
  });
  assert.equal(morph.lesionCount, 1);
  assert.ok(morph.totalVoxels > 50);

  const built = buildReport({
    caseLabel: caseName('sub-01_T1c.nii.gz'),
    tumourType: 'glioblastoma',
    dims: res.dims,
    affine: res.affine,
    brainMask: res.brainMask,
    tumourMask: res.tumourMask,
    morphometry: morph,
  });
  assert.equal(built.report.caseLabel, 'sub-01_T1c');
  assert.match(built.lesionsTsv.text, /^lesion_id\tvoxels\tvolume_ml/);
  assert.ok(built.tumourMask.bytes.byteLength > 352);

  const cmp = compareBinaryMasks(res.tumourMask, res.tumourMask);
  assert.equal(cmp.dice, 1);
  assert.equal(cmp.differing, 0);
});

test('segmentTumour aborts cleanly when AbortSignal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const volume = {
    data: Float32Array.from({ length: 64 }, (_, i) => i),
    dims: [4, 4, 4],
    affine: IDENTITY,
  };
  await assert.rejects(
    segmentTumour({
      volume,
      skullStripped: true,
      runTumorCore: async () => new Float32Array(1),
      signal: controller.signal,
    }),
    /cancelled/,
  );
});
