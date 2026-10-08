import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareAssets } from '../src/shared-assets.js';

test('two hemispheres requesting the same model trigger one load and receive independent buffers', async () => {
  const loads = [];
  const asset = shareAssets(async (name, from, to) => {
    loads.push({ name, from, to });
    return Uint8Array.from([1, 2, 3]).buffer;
  });
  const [left, right] = await Promise.all([asset('white-order-6.onnx', 0.8, 0.85), asset('white-order-6.onnx', 0.8, 0.85)]);
  assert.deepEqual(loads, [{ name: 'white-order-6.onnx', from: 0.8, to: 0.85 }]);
  assert.notEqual(left, right);
  structuredClone(left, { transfer: [left] });
  assert.equal(left.byteLength, 0);
  assert.deepEqual([...new Uint8Array(right)], [1, 2, 3], 'transferring one buffer must not detach the other');
});

test('a sequential second hemisphere still shares the first load, and the model is released after both', async () => {
  let loads = 0;
  const asset = shareAssets(async () => {
    loads += 1;
    return new ArrayBuffer(4);
  });
  await asset('pial.onnx');
  await asset('pial.onnx');
  assert.equal(loads, 1);
  await asset('pial.onnx');
  assert.equal(loads, 2, 'a third request loads again because the cache released the model');
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
