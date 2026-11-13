import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuSession } from '../src/gpu-unet/session.js';
import { fakeGpuDevice, installGpuConstants } from '../../../test-utils/gpu-device.mjs';

installGpuConstants();
const graph = {
  bytes: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  input: 'image', output: 'third', tensors: {},
  nodes: ['first', 'second', 'third'].map((output, i) => ({
    name: output, op: 'Elu', inputs: [i === 0 ? 'image' : ['first', 'second'][i - 1]], output, attrs: { alpha: 1 },
  })),
};
const feeds = { image: { type: 'float32', dims: [1, 1, 32, 32, 32], getData: async () => new Float32Array(32 ** 3) } };

async function create(device) {
  return createGpuSession(new ArrayBuffer(0), [32, 32, 32], {
    graph, gpu: { async requestAdapter() { return { ...device, async requestDevice() { return device; } }; } },
  });
}

function recordingDevice({ enforceBudget = true } = {}) {
  const device = fakeGpuDevice();
  const submitted = [];
  device.createCommandEncoder = () => {
    const commands = [];
    return {
      beginComputePass({ label }) {
        commands.push(label);
        return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
      },
      copyBufferToBuffer() { commands.push('readback'); },
      finish() { return commands; },
    };
  };
  device.queue.submit = ([commands]) => {
    // Model a device command budget, without pretending to execute GPU shaders.
    if (enforceBudget) assert.ok(commands.filter(command => command !== 'readback').length <= 1, 'a whole inference must not occupy one GPU command buffer');
    submitted.push(commands);
  };
  device.queue.onSubmittedWorkDone = async () => {};
  return { device, submitted };
}

test('each layer completes before the next submission, and repeated inference keeps graph order', async () => {
  const { device, submitted } = recordingDevice();
  let completeFirst;
  device.queue.onSubmittedWorkDone = () => submitted.length === 1 ? new Promise(resolve => { completeFirst = resolve; }) : Promise.resolve();
  const runner = await create(device);
  const pending = runner.run(feeds);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, [['first']]);
  completeFirst();
  await pending;
  assert.deepEqual(submitted, [['first'], ['second'], ['third'], ['readback']]);
  await runner.run(feeds);
  assert.deepEqual(submitted.slice(4), [['first'], ['second'], ['third'], ['readback']]);
  assert.equal(device.scopes, 0);
  await runner.release();
});

test('a failed layer stops later work and retains the device-loss reason', async () => {
  const { device, submitted } = recordingDevice({ enforceBudget: false });
  let lose;
  device.lost = new Promise(resolve => { lose = resolve; });
  device.queue.onSubmittedWorkDone = async () => {
    lose({ message: 'Metal command buffer GPU timeout' });
    throw new Error('OperationError');
  };
  const createBuffer = device.createBuffer;
  device.createBuffer = options => {
    const buffer = createBuffer(options);
    buffer.mapAsync = device.queue.onSubmittedWorkDone;
    return buffer;
  };
  const runner = await create(device);
  await assert.rejects(runner.run(feeds), /GPU device lost: Metal command buffer GPU timeout/);
  assert.deepEqual(submitted, [['first']]);
  assert.equal(device.scopes, 0);
  await runner.release();
});

test('the output is a view over the mapped readback, unmapped on dispose or by the next run', async () => {
  const { device } = recordingDevice();
  const mappings = [];
  let unmaps = 0;
  const createBuffer = device.createBuffer;
  device.createBuffer = options => {
    const buffer = createBuffer(options);
    if (options.label !== 'U-Net output readback') return buffer;
    buffer.getMappedRange = (offset, size) => { const range = new ArrayBuffer(size); mappings.push(range); return range; };
    buffer.unmap = () => { unmaps++; structuredClone(mappings.at(-1), { transfer: [mappings.at(-1)] }); };
    return buffer;
  };
  const runner = await create(device);
  const first = (await runner.run(feeds)).third;
  assert.equal((await first.getData()).buffer, mappings[0], 'the posteriors are not copied out of the readback');
  assert.equal(unmaps, 0);
  const firstView = await first.getData();
  first.dispose();
  assert.equal(firstView.byteLength, 0);
  await assert.rejects(first.getData(), /no longer available/);
  first.dispose();
  assert.equal(unmaps, 1);
  const second = (await runner.run(feeds)).third;
  assert.equal((await second.getData()).buffer, mappings[1]);
  const secondView = await second.getData();
  const third = (await runner.run(feeds)).third;
  const thirdView = await third.getData();
  assert.equal(secondView.byteLength, 0);
  await assert.rejects(second.getData(), /no longer available/);
  first.dispose();
  second.dispose();
  assert.equal(thirdView.byteLength, 32 ** 3 * 4);
  assert.equal(unmaps, 2, 'a run unmaps an output its caller never disposed');
  await runner.release();
  assert.equal(thirdView.byteLength, 0);
  await assert.rejects(third.getData(), /no longer available/);
  assert.equal(unmaps, 3);
});

test('disposing a stale output cannot unmap the current run', async () => {
  const { device } = recordingDevice();
  let unmaps = 0;
  const createBuffer = device.createBuffer;
  device.createBuffer = options => {
    const buffer = createBuffer(options);
    if (options.label === 'U-Net output readback') buffer.unmap = () => { unmaps++; };
    return buffer;
  };
  const runner = await create(device);
  const first = (await runner.run(feeds)).third;
  const second = (await runner.run(feeds)).third;
  assert.equal(unmaps, 1);
  first.dispose();
  assert.equal(unmaps, 1);
  assert.equal((await second.getData()).length, 32 ** 3);
  second.dispose();
  assert.equal(unmaps, 2);
  await runner.release();
});
