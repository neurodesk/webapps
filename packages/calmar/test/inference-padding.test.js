import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInferencePipeline } from '../src/inference-pipeline.js';

test('minimum padding keeps sliding windows inside the acquired image', async () => {
  const dims = [5, 6, 7];
  const data = new Float32Array(5 * 6 * 7).fill(1);
  let calls = 0;
  const result = await runInferencePipeline(
    { data, dims, patchSize: [4, 4, 4] },
    async (patch) => {
      calls++;
      // A context-sensitive evaluator rejects windows containing artificial air.
      assert.ok(patch.every((value) => value === 1));
      return new Float32Array(patch.length).fill(10);
    },
    { paddingMode: 'minimum', normalizeInput: false, minComponentSize: 1 }
  );
  assert.equal(calls, 8);
  assert.deepEqual(result.dims, dims);
  assert.equal(result.labels.length, data.length);
  assert.ok(result.labels.every((value) => value === 1));
});

test('minimum padding still supports a short axis and preserves native voxel positions', async () => {
  const dims = [2, 5, 6];
  const data = new Float32Array(2 * 5 * 6).fill(-10);
  data[1 + 3 * 2 + 4 * 2 * 5] = 10;
  const result = await runInferencePipeline(
    { data, dims, patchSize: [4, 4, 4] },
    async (patch) => patch,
    { paddingMode: 'minimum', normalizeInput: false, threshold: 0.9, minComponentSize: 1 }
  );
  assert.deepEqual(result.dims, dims);
  assert.deepEqual(result.labels, Uint8Array.from(data, (value) => value > 0 ? 1 : 0));
});
