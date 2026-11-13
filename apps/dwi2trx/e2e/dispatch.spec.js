import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { gpuBrowser, hardwareGpu, assertHardwareAdapter, readAdapterInfo } from '../../../test-utils/hardware-gpu.mjs';

test.use({ ...gpuBrowser, serviceWorkers: 'block' });

test('physical dispatch windows preserve the actual Boot Philox seed and lane streams', async ({ page }) => {
  test.skip(!hardwareGpu, 'Requires a hardware WebGPU adapter.');
  const sourceRoot = new URL('../vendor/gpu-streamlines/src/', import.meta.url);
  const [dispatch, boot, globals, philox] = await Promise.all(['dispatch.ts', 'wgsl/boot.wgsl', 'wgsl/globals.wgsl', 'wgsl/philox_rng.wgsl']
    .map(name => readFile(new URL(name, sourceRoot), 'utf8')));
  const expressions = name => [...boot.matchAll(new RegExp(`let ${name} = ([^;]+);`, 'g'))].map(match => match[1]);
  const logicalGroups = expressions('logical_group');
  const globalIds = expressions('global_id');
  const initializers = [...boot.matchAll(/\bst = (philox_init\([\s\S]*?\));/g)].map(match => match[1]);
  const workgroupSizes = [...boot.matchAll(/@workgroup_size\(([^)]+)\)/g)].map(match => match[1]);
  expect(logicalGroups).toHaveLength(2);
  expect(globalIds).toHaveLength(2);
  expect(initializers).toHaveLength(2);
  expect(workgroupSizes).toHaveLength(2);
  expect(workgroupSizes[0]).toBe(workgroupSizes[1]);
  expect(logicalGroups[0]).toBe(logicalGroups[1]);
  expect(globalIds[0]).toBe(globalIds[1]);
  const shader = `${globals}\n${philox}\n${boot.match(/struct BootTrackingParams \{[^}]+\}/)[0]}
    @group(0) @binding(0) var<storage, read> params: BootTrackingParams;
    @group(0) @binding(1) var<storage, read_write> output: array<u32>;
    @compute @workgroup_size(${workgroupSizes[0]})
    fn probe(@builtin(local_invocation_id) tid: vec3<u32>, @builtin(workgroup_id) gid: vec3<u32>) {
      let tidx = tid.x;
      let tidy = tid.y;
      let logical_group = ${logicalGroups[0]};
      let global_id = ${globalIds[0]};
      output[global_id * 2u] = philox_uint(${initializers[0]}).value;
      output[global_id * 2u + 1u] = philox_uint(${initializers[1]}).value;
    }`;
  await page.route('**/tracking-dispatch-probe.js', route => route.fulfill({
    contentType: 'text/javascript', body: stripTypeScriptTypes(dispatch),
  }));
  await page.goto('/');
  assertHardwareAdapter(await readAdapterInfo(page));
  const results = await page.evaluate(async shader => {
    const { dispatchBootWindows } = await import('/tracking-dispatch-probe.js');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const gridX = 37;
    const bytes = gridX * 64 * 2 * 4;
    const module = device.createShaderModule({ code: shader });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'probe' } });
    try {
      const results = [];
      for (const window of [37, 16, 7, 1]) {
        const parameters = device.createBuffer({ size: 100, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
        new Uint32Array(parameters.getMappedRange())[6] = 1234;
        parameters.unmap();
        const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: parameters } }, { binding: 1, resource: { buffer: output } },
          ] });
          await dispatchBootWindows(device, pipeline, gridX, [group], parameters, undefined, window);
          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(output, 0, staging, 0, bytes);
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);
          results.push(Array.from(new Uint32Array(staging.getMappedRange())));
          staging.unmap();
        } finally {
          parameters.destroy(); output.destroy(); staging.destroy();
        }
      }
      return results;
    } finally { device.destroy(); }
  }, shader);
  expect(new Set(results[0]).size).toBeGreaterThan(100);
  for (const result of results.slice(1)) expect(result).toEqual(results[0]);
});

async function trackExample(browser, baseURL, overrides = {}, { loseDeviceAtCommand = 0 } = {}) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.addInitScript(({ overrides, loseDeviceAtCommand }) => {
      Object.assign(globalThis, overrides);
      window.trackingDispatches = [];
      window.trackingDestroyedDevices = 0;
      const pipelines = new WeakMap();
      const devices = new WeakMap();
      const passes = new WeakMap();
      const passDevices = new WeakMap();
      let generationCommands = 0;
      const createPipeline = GPUDevice.prototype.createComputePipeline;
      GPUDevice.prototype.createComputePipeline = function (descriptor) {
        const pipeline = createPipeline.call(this, descriptor);
        pipelines.set(pipeline, descriptor.compute.entryPoint);
        devices.set(pipeline, this);
        return pipeline;
      };
      const setPipeline = GPUComputePassEncoder.prototype.setPipeline;
      GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
        passes.set(this, pipelines.get(pipeline));
        passDevices.set(this, devices.get(pipeline));
        if (pipelines.get(pipeline) === 'genStreamlinesMergeBoot_k') {
          generationCommands += 1;
          // Stands in for a driver reset partway through the first generation pass (#598).
          if (generationCommands === loseDeviceAtCommand) {
            window.trackingDestroyedDevices += 1;
            passDevices.get(this).destroy();
          }
        }
        return setPipeline.call(this, pipeline);
      };
      const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
      GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...counts) {
        window.trackingDispatches.push({ entryPoint: passes.get(this), x: counts[0] });
        return dispatch.apply(this, counts);
      };
    }, { overrides, loseDeviceAtCommand });
    await page.goto('/');
    assertHardwareAdapter(await readAdapterInfo(page));
    for (const [role, extension] of [['image', 'nii.gz'], ['bval', 'bval'], ['bvec', 'bvec']]) {
      await page.locator('#neurodesk-input-transfer').setInputFiles(`${process.env.DWI2TRX_FIXTURE_DIR}/dwi.${extension}`);
      await page.evaluate(role => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
    }
    await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'tractography' }));
    await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 540_000 }).not.toBe('running');
    const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
    expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
    const passes = await page.evaluate(() => window.trackingDispatches.filter(({ entryPoint }) =>
      ['getNumStreamlinesBoot_k', 'genStreamlinesMergeBoot_k'].includes(entryPoint)));
    const tracts = Object.values(snapshot.report.artifacts).find(({ role }) => role === 'tracts');
    const destroyedDevices = await page.evaluate(() => window.trackingDestroyedDevices);
    const { parameters, gpus } = snapshot.report.provenance.tracking;
    return { measurements: snapshot.report.measurements, parameters, gpus, tracts: tracts.sha256, passes, destroyedDevices };
  } finally {
    await context.close();
  }
}

// One command per pass, each seed tracked to the end, is the pre-#598 dispatch;
// the example is small enough to finish that way.
const UNBOUNDED = { neurodeskTrackingDispatchWorkgroups: 1_000_000, neurodeskTrackingDispatchSteps: 1_000_000 };
const total = (run, entryPoint) => run.passes.filter(pass => pass.entryPoint === entryPoint).reduce((sum, { x }) => sum + x, 0);

function expectSameTracts(run, reference) {
  for (const result of [reference, run]) {
    expect(result.measurements.processedSeeds).toBe(result.measurements.seeds);
    expect(result.measurements.partial).toBe(false);
  }
  expect(run.measurements).toEqual(reference.measurements);
  expect(run.tracts).toBe(reference.tracts);
}

test('bounded dispatch windows and step budgets write the same TRX as one command per pass', async ({ browser, baseURL }) => {
  test.skip(!hardwareGpu || !process.env.DWI2TRX_FIXTURE_DIR, 'Requires hardware WebGPU with subgroups and DWI2TRX_FIXTURE_DIR.');
  test.setTimeout(1_200_000);
  const single = await trackExample(browser, baseURL, UNBOUNDED);
  const bounded = await trackExample(browser, baseURL);
  expect(single.parameters.maxWorkgroupsPerDispatch).toBe(1_000_000);
  expect(single.parameters.maxStepsPerDispatch).toBe(1_000_000);
  expect(bounded.parameters.maxWorkgroupsPerDispatch).toBe(16);
  expect(bounded.parameters.maxStepsPerDispatch).toBe(32);
  const largest = run => Math.max(...run.passes.map(({ x }) => x));
  expect(largest(single), 'the example must need more than one 16-workgroup window').toBeGreaterThan(16);
  expect(largest(bounded)).toBeLessThanOrEqual(16);
  expect(total(bounded, 'getNumStreamlinesBoot_k')).toBe(total(single, 'getNumStreamlinesBoot_k'));
  expect(total(single, 'genStreamlinesMergeBoot_k')).toBe(total(single, 'getNumStreamlinesBoot_k'));
  expect(total(bounded, 'genStreamlinesMergeBoot_k'), 'some seeds must need more than one 32-step command')
    .toBeGreaterThan(total(single, 'genStreamlinesMergeBoot_k'));
  expectSameTracts(bounded, single);
  // Logged so CI runs of different kernels on the same runner can be compared (#598).
  console.log(`dwi2trx example TRX sha256 ${single.tracts}; GPU ${JSON.stringify(single.gpus)}`);
  await test.info().attach('dispatch-equivalence.json', {
    body: JSON.stringify({ tracts: single.tracts, measurements: single.measurements,
      commands: { single: single.passes.length, bounded: bounded.passes.length },
      workgroups: { single: total(single, 'genStreamlinesMergeBoot_k'), bounded: total(bounded, 'genStreamlinesMergeBoot_k') } }, null, 2),
    contentType: 'application/json',
  });
});

test('pausing after every few tracking steps writes the same TRX', { tag: '@slow' }, async ({ browser, baseURL }) => {
  test.skip(!hardwareGpu || !process.env.DWI2TRX_FIXTURE_DIR, 'Requires hardware WebGPU with subgroups and DWI2TRX_FIXTURE_DIR.');
  test.setTimeout(3_600_000);
  const single = await trackExample(browser, baseURL, UNBOUNDED);
  // Three steps pause most streamlines mid-direction and some right after a direction ends.
  const stepped = await trackExample(browser, baseURL, { neurodeskTrackingDispatchSteps: 3 });
  expect(stepped.parameters.maxStepsPerDispatch).toBe(3);
  expectSameTracts(stepped, single);
});

test('the seed batch size does not change the TRX', async ({ browser, baseURL }) => {
  test.skip(!hardwareGpu || !process.env.DWI2TRX_FIXTURE_DIR, 'Requires hardware WebGPU with subgroups and DWI2TRX_FIXTURE_DIR.');
  test.setTimeout(1_200_000);
  const whole = await trackExample(browser, baseURL);
  // An odd batch size gives four batches, each ending mid-workgroup.
  const chunkSize = 2 * Math.floor(whole.measurements.seeds / 8) + 1;
  expect(chunkSize).toBeGreaterThan(1);
  const batched = await trackExample(browser, baseURL, { neurodeskTrackingChunkSeeds: chunkSize });
  expect(batched.parameters.chunkSize).toBe(chunkSize);
  expectSameTracts(batched, whole);
});

test('a GPU device lost mid-run is replaced and the TRX is unchanged', async ({ browser, baseURL }) => {
  test.skip(!hardwareGpu || !process.env.DWI2TRX_FIXTURE_DIR, 'Requires hardware WebGPU with subgroups and DWI2TRX_FIXTURE_DIR.');
  test.setTimeout(1_200_000);
  const whole = await trackExample(browser, baseURL);
  const recovered = await trackExample(browser, baseURL, {}, { loseDeviceAtCommand: 3 });
  expect(whole.destroyedDevices).toBe(0);
  expect(recovered.destroyedDevices).toBe(1);
  expect(whole.measurements.deviceRecoveries).toBe(0);
  expect(recovered.measurements.deviceRecoveries).toBe(1);
  expect(whole.gpus).toHaveLength(1);
  expect(recovered.gpus, 'the replacement must be the same GPU for byte-identical output').toEqual([whole.gpus[0], whole.gpus[0]]);
  const countPasses = run => run.passes.filter(pass => pass.entryPoint === 'getNumStreamlinesBoot_k').length;
  expect(countPasses(recovered), 'the interrupted batch must be counted again').toBeGreaterThan(countPasses(whole));
  expectSameTracts(recovered, { ...whole, measurements: { ...whole.measurements, deviceRecoveries: 1 } });
});
