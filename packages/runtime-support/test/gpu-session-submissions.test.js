import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import synthseg from '../../synthseg/src/gpu-model.json' with { type: 'json' };
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

function trackedMemoryDevice(limit = 2 ** 31 - 1) {
  const { device, submitted } = recordingDevice();
  device.limits = { maxBufferSize: limit, maxStorageBufferBindingSize: limit };
  const live = new Set();
  const created = [];
  let peakTransientBytes = 0;
  const transientBytes = () => [...live]
    .filter(buf => buf.label.includes(' activation ') || buf.label.endsWith(' output readback'))
    .reduce((sum, buf) => sum + buf.size, 0);
  const baseCreateBuffer = device.createBuffer;
  device.createBuffer = options => {
    const buffer = baseCreateBuffer(options);
    buffer.label = options.label || '';
    buffer.destroyed = false;
    const baseDestroy = buffer.destroy.bind(buffer);
    buffer.destroy = () => {
      buffer.destroyed = true;
      live.delete(buffer);
      baseDestroy();
    };
    live.add(buffer);
    created.push(buffer);
    peakTransientBytes = Math.max(peakTransientBytes, transientBytes());
    return buffer;
  };
  device.createBindGroup = ({ entries }) => {
    for (const entry of entries) {
      assert.equal(entry.resource.buffer.destroyed, false, `bound destroyed buffer ${entry.resource.buffer.label}`);
    }
    return { entries };
  };
  return { device, submitted, live, created, transientBytes, getPeakTransientBytes: () => peakTransientBytes };
}

test('activations live only from producer to last consumer across skips, duplicates, aliases, dead tails and failures', async () => {
  const weights = new Float32Array(16).fill(1);
  const modelBytes = new Uint8Array(weights.buffer);
  const sha256 = createHash('sha256').update(modelBytes).digest('hex');
  const complexGraph = {
    bytes: modelBytes.byteLength,
    sha256,
    input: 'image',
    output: 'exported_alias',
    tensors: { w: { offset: 0, bytes: 16, dims: [4, 1, 1, 1, 1] } },
    nodes: [
      { name: 'skip', op: 'Elu', inputs: ['image'], output: 'skip', attrs: { alpha: 1 } },
      { name: 'dup', op: 'Add', inputs: ['skip', 'skip'], output: 'dup', attrs: {} },
      { name: 'merged', op: 'Concat', inputs: ['skip', 'dup'], output: 'merged', attrs: { axis: 1 } },
      { name: 'alias', op: 'Identity', inputs: ['merged'], output: 'exported_alias', attrs: {} },
      { name: 'dead_tail', op: 'Elu', inputs: ['exported_alias'], output: 'dead_tail', attrs: { alpha: 1 } },
    ],
  };
  const tracker = trackedMemoryDevice();
  const runner = await createGpuSession(modelBytes, [32, 32, 32], {
    graph: complexGraph,
    outputChannels: 2,
    gpu: { async requestAdapter() { return { ...tracker.device, async requestDevice() { return tracker.device; } }; } },
  });
  assert.equal(tracker.transientBytes(), 0, 'setup must not preallocate activation or readback buffers');

  const first = (await runner.run(feeds)).exported_alias;
  const readbackBytes = 32 ** 3 * 2 * 4;
  assert.equal(tracker.transientBytes(), readbackBytes, 'only the mapped readback remains alive after run()');
  first.dispose();
  assert.equal(tracker.transientBytes(), 0, 'dispose() destroys the readback buffer');

  // Verify a second run and mid-run failure cleanup leave zero leaked activation/readback buffers.
  const second = (await runner.run(feeds)).exported_alias;
  assert.equal((await second.getData()).length, 32 ** 3 * 2);
  second.dispose();
  assert.equal(tracker.transientBytes(), 0);

  let failAt = 0;
  tracker.device.queue.onSubmittedWorkDone = async () => {
    if (++failAt === 2) throw new Error('injected step failure');
  };
  await assert.rejects(runner.run(feeds), /injected step failure/);
  assert.equal(tracker.transientBytes(), 0, 'mid-run failure must destroy every live activation buffer');
  await runner.release();
});

test('full-volume SynthSeg frees inactive activations and readback between passes without resizing small steps', async () => {
  // Reuse the pinned 41-node SynthSeg topology with tiny synthetic weights so the test stays offline.
  let maxTensorBytes = 0;
  for (const tensor of Object.values(synthseg.tensors)) maxTensorBytes = Math.max(maxTensorBytes, tensor.bytes);
  const backing = new Uint8Array(maxTensorBytes);
  // Resize scale tensor must be [1, 1, 2, 2, 2] to pass graph validation.
  const scaleOffset = 0;
  const scaleBytes = 20;
  new Float32Array(backing.buffer, scaleOffset, 5).set([1, 1, 2, 2, 2]);
  const tensors = Object.fromEntries(Object.entries(synthseg.tensors).map(([name, tensor]) => [
    name,
    { ...tensor, offset: tensor.bytes === scaleBytes && tensor.dims.join() === '5' ? scaleOffset : 0 },
  ]));
  const syntheticGraph = {
    ...synthseg,
    bytes: backing.byteLength,
    sha256: createHash('sha256').update(backing).digest('hex'),
    tensors,
  };
  const dims = [192, 224, 160];
  const voxels = dims.reduce((a, b) => a * b, 1);
  const fullFeeds = {
    [synthseg.input]: { type: 'float32', dims: [1, 1, ...dims], getData: async () => new Float32Array(voxels) },
  };
  const tracker = trackedMemoryDevice();
  let step16LiveBytes = null;
  let step16OutputBytes = null;
  const baseSubmit = tracker.device.queue.submit;
  tracker.device.queue.submit = ([commands]) => {
    if (commands[0] === 'unet_maxpool_3') {
      step16LiveBytes = tracker.transientBytes();
      step16OutputBytes = [...tracker.live].find(buf => buf.label === 'SynthSeg activation unet_maxpool_3')?.size ?? null;
    }
    return baseSubmit([commands]);
  };
  const runner = await createGpuSession(backing, dims, {
    graph: syntheticGraph,
    outputChannels: 33,
    label: 'SynthSeg',
    gpu: { async requestAdapter() { return { ...tracker.device, async requestDevice() { return tracker.device; } }; } },
  });
  assert.equal(tracker.transientBytes(), 0, 'no full-volume activation or readback buffers allocated at setup');

  for (let pass = 0; pass < 2; pass++) {
    const out = (await runner.run(fullFeeds))[synthseg.output];
    assert.equal(tracker.transientBytes(), voxels * 33 * 4, `pass ${pass + 1}: only the 866 MiB readback survives run()`);
    out.dispose();
    assert.equal(tracker.transientBytes(), 0, `pass ${pass + 1}: dispose() leaves 0 MiB of transient GPU memory`);
  }

  assert.equal(step16OutputBytes, 12 * 14 * 10 * 192 * 4, 'step 16 allocates its exact 1.2 MiB buffer, not a 1.85 GiB slot');
  assert.ok(step16LiveBytes < 900 * 2 ** 20, `step 16 live bytes (${(step16LiveBytes / 2 ** 20).toFixed(1)} MiB) stay below 900 MiB`);
  assert.equal(
    tracker.getPeakTransientBytes(),
    voxels * (24 + 48 + 72) * 4,
    'peak transient GPU memory is the single Concat step (3,780 MiB), ~1 GiB below preallocated slots + readback',
  );
  await runner.release();
});
