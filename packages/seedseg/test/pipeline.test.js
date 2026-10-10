import assert from 'node:assert/strict';
import test from 'node:test';
import { createNiftiFromVolume, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { runInference } from '../src/pipeline.js';

const input = createNiftiFromVolume({ img: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8), hdr: {
  dims: [2, 2, 2], pixDims: [1, 1, 1], affine: [[1, 0, 0, 4], [0, 1, 0, 5], [0, 0, 1, 6], [0, 0, 0, 1]],
} });

test('three-class softmax and two-model probability averaging retain the input geometry', async () => {
  const released = [];
  const disposed = [];
  const correction = [];
  const result = await runInference(input, {
    selectedModels: [42, 123], threshold: 0.6, nMarkers: 3,
    qsm: { makehomogeneous_wasm: (...args) => { correction.push(args.slice(1)); return args[0]; } },
    loadModel: async asset => asset.seed,
    Tensor: class { constructor(_type, _data, dims) { assert.deepEqual(dims, [1, 1, 32, 32, 32]); } dispose() { disposed.push(true); } },
    createSession: async seed => ({ inputNames: ['input'], outputNames: ['output'],
      run: async () => {
        const raw = new Float32Array(3 * 32 ** 3);
        raw.fill(Math.log(seed === 42 ? 2 : 6), 32 ** 3, 2 * 32 ** 3);
        return { output: { data: raw } };
      }, release: async () => released.push(seed),
    }),
  });
  assert.deepEqual(correction, [[2, 2, 2, 1, 1, 1, 7, 15]]);
  assert.deepEqual(released, [42, 123]);
  assert.equal(disposed.length, 2);
  for (const [stage, expected] of [['model1', 0.5], ['model2', 0.75], ['avgProb', 0.625], ['consensus', 1]]) {
    const volume = await readNifti(result.stages[stage].niftiData);
    assert.deepEqual(volume.dims, [2, 2, 2]);
    assert.deepEqual(volume.header.affine.map(row => Array.from(row)), [[1, 0, 0, 4], [0, 1, 0, 5], [0, 0, 1, 6], [0, 0, 0, 1]]);
    assert.ok(volume.data.every(value => value === expected), stage);
  }
  assert.equal(result.markerVoxels, 8);
});

test('failed inference releases the real-session adapter resources and emits no result', async () => {
  let released = false;
  let disposed = false;
  let stages = 0;
  await assert.rejects(runInference(input, { selectedModels: [42],
    qsm: { makehomogeneous_wasm: data => data }, loadModel: async () => 42,
    Tensor: class { dispose() { disposed = true; } },
    createSession: async () => ({ inputNames: ['input'], outputNames: ['output'],
      run: async () => { throw new Error('runtime failed'); }, release: async () => { released = true; } }),
    events: { stageData: () => stages++ },
  }), /runtime failed/);
  assert.ok(released && disposed);
  assert.equal(stages, 0);
});
