import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gpuBrowser, hardwareGpu, assertHardwareAdapter, readAdapterInfo } from '../../../test-utils/hardware-gpu.mjs';

test.use(gpuBrowser);

test('Philips real-data crop completes tractography without losing the hardware device', async ({ page }) => {
  test.skip(!hardwareGpu || !process.env.DWI2TRX_REAL_DWI_DIR, 'Requires hardware WebGPU and the provisioned Philips crop.');
  test.setTimeout(30 * 60_000);
  const directory = process.env.DWI2TRX_REAL_DWI_DIR;
  const crop = JSON.parse(await readFile(join(directory, 'crop.json'), 'utf8'));
  expect(crop.shape).toEqual([72, 72, 39]);
  expect(crop.origin).toEqual([28, 28, 15]);
  expect(crop.frames).toBe(136);
  expect(crop.resampled).toBe(false);
  await test.info().attach('philips-crop.json', { body: JSON.stringify(crop, null, 2), contentType: 'application/json' });
  const input = await readFile(join(directory, 'dwi.nii'));
  expect(createHash('sha256').update(input).digest('hex')).toBe(crop.sha256);
  await page.addInitScript(() => {
    window.trackingDeviceLosses = [];
    window.trackingGpuEvents = [];
    const pipelines = new WeakMap();
    const passes = new WeakMap();
    const copies = new WeakMap();
    const record = event => window.trackingGpuEvents.push({ ...event, at: performance.now() });
    const createPipeline = GPUDevice.prototype.createComputePipeline;
    GPUDevice.prototype.createComputePipeline = function (descriptor) {
      const pipeline = createPipeline.call(this, descriptor);
      pipelines.set(pipeline, descriptor.compute.entryPoint);
      return pipeline;
    };
    const setPipeline = GPUComputePassEncoder.prototype.setPipeline;
    GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
      passes.set(this, pipelines.get(pipeline));
      return setPipeline.call(this, pipeline);
    };
    const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
    GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...counts) {
      record({ kind: 'dispatch', entryPoint: passes.get(this), counts });
      return dispatch.apply(this, counts);
    };
    // Completion times show how long the command that loses the device actually ran.
    const workDone = GPUQueue.prototype.onSubmittedWorkDone;
    GPUQueue.prototype.onSubmittedWorkDone = async function (...args) {
      await workDone.apply(this, args);
      record({ kind: 'work-done' });
    };
    const copy = GPUCommandEncoder.prototype.copyBufferToBuffer;
    GPUCommandEncoder.prototype.copyBufferToBuffer = function (source, sourceOffset, destination, ...rest) {
      copies.set(destination, source.label);
      return copy.call(this, source, sourceOffset, destination, ...rest);
    };
    const map = GPUBuffer.prototype.mapAsync;
    GPUBuffer.prototype.mapAsync = async function (...args) {
      const source = copies.get(this) ?? this.label;
      record({ kind: 'map-start', source, bytes: this.size });
      try {
        await map.apply(this, args);
        record({ kind: 'map-complete', source, bytes: this.size });
      } catch (error) {
        record({ kind: 'map-failed', source, bytes: this.size, message: error.message });
        throw error;
      }
    };
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await request.apply(this, args);
      device.lost.then(info => {
        if (info.reason !== 'destroyed') window.trackingDeviceLosses.push({ reason: info.reason, message: info.message, at: performance.now() });
      });
      return device;
    };
  });
  await page.goto('/');
  const adapter = await readAdapterInfo(page);
  assertHardwareAdapter(adapter);
  await test.info().attach('hardware-adapter.json', { body: JSON.stringify(adapter, null, 2), contentType: 'application/json' });
  for (const [role, name] of [['image', 'dwi.nii'], ['bval', 'dwi.bval'], ['bvec', 'dwi.bvec']]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(join(directory, name));
    await page.evaluate(role => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'tractography' }));
  try {
    await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, {
      timeout: 25 * 60_000,
      intervals: [2000],
    }).not.toBe('running');
  } finally {
    const diagnostics = await page.evaluate(() => ({ events: window.trackingGpuEvents, losses: window.trackingDeviceLosses }));
    const path = test.info().outputPath('gpu-dispatches.json');
    await writeFile(path, JSON.stringify({ adapter, crop, ...diagnostics }, null, 2));
    await test.info().attach('gpu-dispatches.json', { path, contentType: 'application/json' });
  }
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  const measured = snapshot.report.measurements;
  expect(measured.seeds).toBeGreaterThan(0);
  expect(measured.processedSeeds).toBe(measured.seeds);
  expect(measured.partial).toBe(false);
  expect(measured.truncated).toBe(false);
  expect(measured.capped).toBe(false);
  expect(measured.streamlines).toBeGreaterThan(0);
  expect(measured.points).toBeGreaterThan(0);
  expect(snapshot.report.provenance.tracking.parameters.chunkSize).toBe(10000);
  const dispatches = await page.evaluate(() => window.trackingGpuEvents.filter(event => event.kind === 'dispatch'
    && ['getNumStreamlinesBoot_k', 'genStreamlinesMergeBoot_k'].includes(event.entryPoint)));
  expect(dispatches.filter(event => event.entryPoint === 'genStreamlinesMergeBoot_k').length).toBeGreaterThan(1);
  expect(dispatches.every(event => event.counts[0] <= 16 && event.counts[1] === 1 && event.counts[2] === 1)).toBe(true);
  const [artifactId, artifact] = Object.entries(snapshot.report.artifacts).find(([, artifact]) => artifact.role === 'tracts');
  const pending = page.waitForEvent('download');
  await page.evaluate(artifactId => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
  const downloaded = await pending;
  const path = await downloaded.path();
  const bytes = await readFile(path);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  const header = JSON.parse(execFileSync('unzip', ['-p', path, 'header.json'], { encoding: 'utf8' }));
  expect(header.DIMENSIONS).toEqual([72, 72, 39]);
  expect(header.NB_STREAMLINES).toBe(measured.streamlines);
  expect(header.NB_VERTICES).toBe(measured.points);
  const positions = execFileSync('unzip', ['-p', path, 'positions.3.float32'], { maxBuffer: 512 * 1024 * 1024 });
  expect(positions.byteLength).toBe(measured.points * 3 * 4);
  const view = new DataView(positions.buffer, positions.byteOffset, positions.byteLength);
  let invalidCoordinate = -1;
  for (let offset = 0; offset < view.byteLength; offset += 4) {
    if (!Number.isFinite(view.getFloat32(offset, true))) {
      invalidCoordinate = offset / 4;
      break;
    }
  }
  expect(invalidCoordinate, 'Every tracked world coordinate must be finite').toBe(-1);
  // The app intentionally destroys its private tracking device after download
  // preparation. Reject other losses, then prove the adapter still performs IO.
  const probe = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    try {
      const buffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.queue.writeBuffer(buffer, 0, new Uint32Array([0x12345678]));
      await buffer.mapAsync(GPUMapMode.READ);
      const value = new Uint32Array(buffer.getMappedRange())[0];
      buffer.unmap();
      buffer.destroy();
      return { value, losses: window.trackingDeviceLosses };
    } finally {
      device.destroy();
    }
  });
  expect(probe).toEqual({ value: 0x12345678, losses: [] });
});
