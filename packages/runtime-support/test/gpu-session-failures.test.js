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
    let unmaps = 0;
    const createBuffer = device.createBuffer;
    device.createBuffer = options => {
      const buffer = createBuffer(options);
      if (options.label === 'U-Net output readback') buffer.unmap = () => { unmaps++; };
      return buffer;
    };
    const runner = await session(device);
    device.popResults.push(scoped);
    await assert.rejects(runner.run(feeds(async () => new Float32Array(32 ** 3))), /invalid dispatch|pop rejected/);
    assert.equal(device.scopes, 0);
    assert.equal(device.popped, 4);
    assert.equal(unmaps, 1, 'a rejected run must not leave an inaccessible output mapped');
    await runner.release();
  }
});

test('empty-message GPUOutOfMemoryError scopes and uncaptured errors name GPU out of memory even when readback fails', async () => {
  class GPUOutOfMemoryError {
    constructor(message = '') { this.message = message; }
  }

  // 1. Scoped empty-message GPUOutOfMemoryError when readback mapAsync succeeds.
  const device1 = fakeGpuDevice();
  const runner1 = await session(device1);
  device1.popResults.push(null, new GPUOutOfMemoryError(''));
  await assert.rejects(runner1.run(feeds(async () => new Float32Array(32 ** 3))), /GPU out of memory/);
  await runner1.release();

  // 2. Scoped empty-message GPUOutOfMemoryError when readback mapAsync rejects with OperationError.
  const device2 = fakeGpuDevice();
  const createBuffer2 = device2.createBuffer.bind(device2);
  device2.createBuffer = (options) => {
    const buffer = createBuffer2(options);
    if (options.label === 'U-Net output readback') {
      buffer.mapAsync = async () => { throw new Error('OperationError: Buffer is invalid'); };
    }
    return buffer;
  };
  const runner2 = await session(device2);
  device2.popResults.push(null, new GPUOutOfMemoryError(''));
  await assert.rejects(runner2.run(feeds(async () => new Float32Array(32 ** 3))), /GPU out of memory/);
  await runner2.release();

  // 3. Uncaptured empty-message GPUOutOfMemoryError event during run.
  const device3 = fakeGpuDevice();
  let uncapturedHandler = null;
  device3.addEventListener = (type, fn) => {
    if (type === 'uncapturederror') uncapturedHandler = fn;
  };
  const runner3 = await session(device3);
  device3.queue.submit = () => {
    uncapturedHandler?.({ error: new GPUOutOfMemoryError('') });
  };
  await assert.rejects(runner3.run(feeds(async () => new Float32Array(32 ** 3))), /GPU out of memory/);
  await runner3.release();

  // 4. When BOTH validation ("Buffer is invalid") and out-of-memory scopes capture errors,
  //    both initialization and post-readback inference report the root-cause GPU out of memory!
  const device4 = fakeGpuDevice();
  device4.popResults.push({ message: 'Buffer is invalid' }, new GPUOutOfMemoryError(''));
  await assert.rejects(session(device4), /GPU out of memory/);

  const device5 = fakeGpuDevice();
  const runner5 = await session(device5);
  device5.popResults.push({ message: 'Buffer is invalid' }, new GPUOutOfMemoryError(''));
  await assert.rejects(runner5.run(feeds(async () => new Float32Array(32 ** 3))), /GPU out of memory/);
  await runner5.release();
});
