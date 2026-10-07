import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareAssets } from '../src/shared-assets.js';

test('two hemispheres requesting the same model trigger one load and receive independent copies', async () => {
  const loads = [];
  const asset = shareAssets(async (name, from, to) => {
    loads.push({ name, from, to });
    return Uint8Array.from([1, 2, 3]).buffer;
  });
  const [left, right] = await Promise.all([asset('white-order-6.onnx', 0.8, 0.85), asset('white-order-6.onnx', 0.8, 0.85)]);
  const later = await asset('white-order-6.onnx', 0.8, 0.85);
  assert.deepEqual(loads, [{ name: 'white-order-6.onnx', from: 0.8, to: 0.85 }]);
  assert.notEqual(left, right);
  assert.notEqual(left, later);
  assert.deepEqual([...new Uint8Array(left)], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(right)], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(later)], [1, 2, 3]);
  assert.equal(left.byteLength, 3, 'transferring one copy must not detach another');
});

test('different models load separately and a failed load rejects every requester', async () => {
  const asset = shareAssets(async (name) => {
    if (name === 'bad.onnx') throw new Error(`Model size mismatch for ${name}`);
    return new ArrayBuffer(1);
  });
  assert.equal((await asset('a.onnx')).byteLength, 1);
  assert.equal((await asset('b.onnx')).byteLength, 1);
  await assert.rejects(asset('bad.onnx'), /Model size mismatch/);
  await assert.rejects(asset('bad.onnx'), /Model size mismatch/);
});
