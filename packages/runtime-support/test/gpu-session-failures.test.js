import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuSession } from '../src/gpu-unet/session.js';
import { fakeGpuDevice, installGpuConstants } from '../../../test-utils/gpu-device.mjs';

installGpuConstants();
const graph = {
  bytes: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  input: 'image', output: 'image', nodes: [], tensors: {},
};
async function session(device) {
  return createGpuSession(new ArrayBuffer(0), [32, 32, 32], {
    graph, gpu: { async requestAdapter() { return { ...device, async requestDevice() { return device; } }; } },
  });
}
const feeds = getData => ({ image: { type: 'float32', dims: [1, 1, 32, 32, 32], getData } });

test('GPU run preserves input failure, drains both scopes and clears busy state', async () => {
  const device = fakeGpuDevice();
  const runner = await session(device);
  const primary = new Error('input read failed');
  device.popResults.push(new Error('scope pop failed'), { message: 'validation failed' });
  await assert.rejects(runner.run(feeds(async () => { throw primary; })), error => error === primary);
  assert.equal(device.scopes, 0);
  assert.equal(device.popped, 4);
  await runner.run(feeds(async () => new Float32Array(32 ** 3)));
  assert.equal(device.scopes, 0);
});

test('GPU scopes reject an otherwise successful run and both are drained', async () => {
  for (const scoped of [{ message: 'invalid dispatch' }, new Error('pop rejected'), { synchronousError: new Error('pop rejected synchronously') }]) {
    const device = fakeGpuDevice();
    const runner = await session(device);
    device.popResults.push(scoped);
    await assert.rejects(runner.run(feeds(async () => new Float32Array(32 ** 3))), /invalid dispatch|pop rejected/);
    assert.equal(device.scopes, 0);
    assert.equal(device.popped, 4);
  }
});
