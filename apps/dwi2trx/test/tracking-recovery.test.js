import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

// The tracker imports its siblings without extensions and its WGSL through Vite's
// `?raw`; resolve both as Vite does so Node can load the real source.
const hooks = `
import { readFile } from 'node:fs/promises';
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?raw')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.') || !context.parentURL?.endsWith('.ts')) throw error;
    return next(specifier + '.ts', context);
  }
}
export async function load(url, context, next) {
  if (!url.endsWith('?raw')) return next(url, context);
  const text = await readFile(new URL(url.slice(0, -4)), 'utf8');
  return { format: 'module', source: 'export default ' + JSON.stringify(text), shortCircuit: true };
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

globalThis.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };

console.warn = () => {};
const { trackStreamlines, DEFAULT_PARAMS } = await import('../vendor/gpu-streamlines/src/tracker.ts');

const SEEDS = 12;
const CHUNK = 4;

/**
 * A WebGPU device whose Boot passes give every seed one two-point streamline.
 * `loseAtSubmit` loses it at that queue submission (1-based): later map requests
 * reject as Chromium's do after a device loss.
 */
function fakeDevice(name, { loseAtSubmit = 0 } = {}) {
  let submits = 0;
  let lost = false;
  let resolveLost;
  const lostPromise = new Promise(resolve => { resolveLost = resolve; });
  const buffers = [];
  const device = {
    name,
    buffers,
    limits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 },
    features: new Set(['subgroups']),
    lost: lostPromise,
    lose() {
      if (lost) return;
      lost = true;
      resolveLost({ reason: 'unknown', message: 'GPU reset' });
    },
    createBuffer({ size, label }) {
      const buffer = {
        label,
        data: new ArrayBuffer(size),
        destroyed: false,
        getMappedRange: () => buffer.data,
        unmap() {},
        destroy() { buffer.destroyed = true; },
        async mapAsync() {
          if (lost) throw new Error("Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.");
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createShaderModule: () => ({}),
    createComputePipeline: ({ compute }) => ({ entryPoint: compute.entryPoint, getBindGroupLayout: index => index }),
    createBindGroup: ({ entries }) => ({ entries }),
    createCommandEncoder() {
      const steps = [];
      return {
        beginComputePass: () => ({
          setPipeline(pipeline) { steps.pipeline = pipeline; },
          setBindGroup(index, group) { (steps.groups ??= [])[index] = group; },
          dispatchWorkgroups() { steps.push({ dispatch: steps.pipeline.entryPoint, groups: steps.groups }); },
          end() {},
        }),
        copyBufferToBuffer(source, sourceOffset, target, targetOffset, size) {
          steps.push({ copy: [source, sourceOffset, target, targetOffset, size] });
        },
        finish: () => steps,
      };
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        new Uint8Array(buffer.data, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
      submit([steps]) {
        submits += 1;
        if (submits === loseAtSubmit) device.lose();
        if (lost) return;
        for (const step of steps) {
          if (step.copy) {
            const [source, sourceOffset, target, targetOffset, size] = step.copy;
            new Uint8Array(target.data, targetOffset, size).set(new Uint8Array(source.data, sourceOffset, size));
            continue;
          }
          const buffer = (group, binding) => step.groups[group].entries.find(entry => entry.binding === binding).resource.buffer;
          const nseeds = new Int32Array(buffer(0, 0).data)[9];
          const offsets = new Int32Array(buffer(2, 0).data);
          if (step.dispatch === 'getNumStreamlinesBoot_k') {
            offsets.fill(1, 0, nseeds);
          } else {
            offsets.fill(0, nseeds, 2 * nseeds);
            const meta = new Int32Array(buffer(2, 2).data);
            for (let i = 1; i < meta.length; i += 2) meta[i] = 2;
          }
        }
      },
      onSubmittedWorkDone: async () => {},
    },
  };
  return device;
}

const inputs = {
  dataf: new Float32Array(8),
  dims: [2, 2, 2, 1],
  metricMap: new Float32Array(8),
  sphereVertices: new Float32Array(3),
  sphereEdges: new Int32Array(2),
  H: new Float32Array(1),
  R: new Float32Array(1),
  deltaB: new Float32Array(1),
  deltaQ: new Float32Array(1),
  samplingMatrix: new Float32Array(1),
  b0sMask: new Int32Array(1),
  samplmNr: 1,
  nedges: 1,
  deltaNr: 1,
  modelType: 0,
};

const params = { ...DEFAULT_PARAMS, tcThreshold: 0.1, chunkSize: CHUNK };

const run = (device, replaceDevice, shouldStop) =>
  trackStreamlines(device, inputs, new Float32Array(3 * SEEDS), params, undefined, shouldStop, replaceDevice);

// Each batch of 4 seeds submits a count pass, a counts readback, a generation pass,
// a pending readback, a metadata readback and a streamline readback.
const SUBMITS_PER_BATCH = 6;

test('a device lost in the second batch is replaced and the run completes', async () => {
  const first = fakeDevice('first', { loseAtSubmit: SUBMITS_PER_BATCH + 3 });
  const second = fakeDevice('second');
  const result = await run(first, async () => second);
  assert.equal(result.deviceRecoveries, 1);
  assert.equal(result.deviceLost, false);
  assert.equal(result.truncated, false);
  assert.equal(result.processedSeeds, SEEDS);
  assert.equal(result.lines.length, SEEDS, 'the interrupted batch is committed once');
  assert.ok(first.buffers.every(buffer => buffer.destroyed), 'every buffer on the lost device is freed');
  assert.ok(second.buffers.every(buffer => buffer.destroyed), 'every buffer on the replacement is freed');
});

test('a replacement lost while uploading uses the second attempt', async () => {
  const first = fakeDevice('first', { loseAtSubmit: 3 });
  const broken = fakeDevice('broken');
  broken.lose();
  const third = fakeDevice('third');
  const replacements = [broken, third];
  const result = await run(first, async () => replacements.shift());
  assert.equal(result.deviceRecoveries, 1);
  assert.equal(result.processedSeeds, SEEDS);
  assert.equal(result.lines.length, SEEDS);
  assert.equal(replacements.length, 0);
});

test('without a working replacement, batches already read back are kept', async () => {
  const first = fakeDevice('first', { loseAtSubmit: SUBMITS_PER_BATCH + 3 });
  const result = await run(first, async () => { throw new Error('No WebGPU adapter found.'); });
  assert.equal(result.deviceRecoveries, 0);
  assert.equal(result.deviceLost, true);
  assert.equal(result.truncated, true);
  assert.equal(result.processedSeeds, CHUNK);
  assert.equal(result.lines.length, CHUNK);
});

test('recovery stops after two attempts and keeps what was read back', async () => {
  const first = fakeDevice('first', { loseAtSubmit: SUBMITS_PER_BATCH + 3 });
  let requested = 0;
  const result = await run(first, async () => {
    requested += 1;
    return fakeDevice(`replacement ${requested}`, { loseAtSubmit: 2 });
  });
  assert.equal(requested, 2);
  assert.equal(result.deviceRecoveries, 2);
  assert.equal(result.deviceLost, true);
  assert.equal(result.processedSeeds, CHUNK);
});

test('a run cancelled while the replacement is requested uploads nothing to it', async () => {
  const first = fakeDevice('first', { loseAtSubmit: SUBMITS_PER_BATCH + 3 });
  const second = fakeDevice('second');
  let stopped = false;
  const result = await run(first, async () => { stopped = true; return second; }, () => stopped);
  assert.equal(second.buffers.length, 0);
  assert.equal(result.processedSeeds, CHUNK);
  assert.equal(result.deviceRecoveries, 0);
});

test('inputs larger than the kernel workgroup arrays are refused before any GPU work', async () => {
  const device = fakeDevice('first');
  const tooMany = { ...inputs, dims: [2, 2, 2, 513] };
  await assert.rejects(
    trackStreamlines(device, tooMany, new Float32Array(3 * SEEDS), params),
    /at most 512 volumes, sphere vertices and model coefficients; this run needs 544\./,
  );
  assert.equal(device.buffers.length, 0);
});
