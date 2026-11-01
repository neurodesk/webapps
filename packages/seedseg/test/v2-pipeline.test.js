import assert from 'node:assert/strict';
import test from 'node:test';
import { createNiftiFromVolume, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { runInference } from '../src/pipeline.js';
import { NNUNET, resolveModels } from '../src/assets.js';
import { runWithFallback } from '../src/session.js';

const input = createNiftiFromVolume({
  img: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8),
  hdr: {
    dims: [2, 2, 2],
    pixDims: [0.6875, 0.6875, 2],
    affine: [
      [0.6875, 0, 0, 4],
      [0, 0.6875, 0, 5],
      [0, 0, 2, 6],
      [0, 0, 0, 1],
    ],
  },
});

function adapter(loaded, released) {
  return {
    qsm: { makehomogeneous_wasm: (data) => data },
    Tensor: class {
      constructor(_type, _data, dims) {
        assert.deepEqual(dims, [1, 1, ...NNUNET.patch_size]);
      }
      dispose() {}
    },
    loadModel: async (asset) => {
      loaded.push(asset.id);
      return asset.fold;
    },
    createSession: async (fold) => ({
      run: async () => {
        const count = NNUNET.patch_size.reduce((a, b) => a * b, 1);
        const logits = new Float32Array(3 * count);
        logits.fill(Math.log(fold === '0' ? 2 : 6), count, 2 * count);
        return { logits: { data: logits, dispose() {} } };
      },
      release: async () => released.push(fold),
    }),
  };
}

test('public v2 default uses only fold 0 and emits ranked markers and world-coordinate detections', async () => {
  const loaded = [],
    released = [];
  const result = await runInference(input, adapter(loaded, released));
  assert.deepEqual(loaded, ['fold0-web']);
  assert.deepEqual(released, ['0']);
  assert.deepEqual(Object.keys(result.stages), ['probability', 'markers']);
  assert.equal(result.pipeline, 'nnunet-v2');
  assert.equal(result.detections.countFlag, true);
  assert.deepEqual(result.detections.markers[0].centroidVox, [0.5, 0.5, 0.5]);
  assert.deepEqual(result.detections.markers[0].centroidWorldMm, [4.34375, 5.34375, 7]);
  const probability = await readNifti(result.stages.probability.niftiData);
  assert.deepEqual(probability.dims, [2, 2, 2]);
  assert.ok(probability.data.every((value) => Math.abs(value - 0.5) < 1e-6));
});

test('fold ensemble averages per-fold probabilities, in published order, with one session at a time', async () => {
  const loaded = [],
    released = [];
  const result = await runInference(input, { ...adapter(loaded, released), folds: [1, 0] });
  assert.deepEqual(loaded, ['fold0-web', 'fold1-web']);
  assert.deepEqual(released, ['0', '1']);
  const probability = await readNifti(result.stages.probability.niftiData);
  assert.ok(probability.data.every((value) => Math.abs(value - 0.625) < 1e-6));
});

for (const failure of ['create', 'run', 'run-and-release']) {
  test(`WebGPU ${failure} failure retries the complete network on WASM and releases sessions`, async () => {
    const created = [],
      released = [],
      executed = [];
    const response = await runWithFallback({
      backend: 'webgpu',
      createSession: async (provider) => {
        created.push(provider);
        if (failure === 'create' && provider === 'webgpu') throw new Error('GPU create failed');
        return { provider, release: async () => {
          released.push(provider);
          if (failure === 'run-and-release' && provider === 'webgpu') throw new Error('GPU release failed');
        } };
      },
      execute: async (session) => {
        executed.push(session.provider);
        if (session.provider === 'webgpu') throw new Error('GPU tile failed');
        return 'complete fold';
      },
      onFallback: (error) => assert.match(error.message, /GPU/),
    });
    assert.deepEqual(created, ['webgpu', 'wasm']);
    assert.deepEqual(released, failure === 'create' ? ['wasm'] : ['webgpu', 'wasm']);
    assert.equal(response.result, 'complete fold');
    assert.equal(response.backend, 'wasm');
    assert.deepEqual(executed, failure === 'create' ? ['wasm'] : ['webgpu', 'wasm']);
  });
}

test('WASM inference errors survive a second failure during cleanup', async () => {
  const inferenceError = new Error('WASM inference failed');
  await assert.rejects(runWithFallback({
    backend: 'wasm',
    createSession: async () => ({ release: async () => { throw new Error('WASM release failed'); } }),
    execute: async () => { throw inferenceError; },
    onFallback: () => assert.fail('WASM has no further fallback'),
  }), error => error === inferenceError);
});

test('v2 fold and variant guards reject unknown and duplicate selections before work', () => {
  assert.deepEqual(
    resolveModels([4, 0]).map((asset) => asset.id),
    ['fold0-web', 'fold4-web'],
  );
  assert.equal(resolveModels([0], { model: 'fp32' })[0].id, 'fold0-fp32');
  for (const folds of [[], [0, '0'], [5], [''], [NaN]])
    assert.throws(() => resolveModels(folds), /distinct|Unknown/);
  assert.throws(() => resolveModels([0], { pipeline: 'unknown' }), /Unknown/);
  assert.throws(() => resolveModels([0], { model: 'unknown' }), /Unknown/);
});
