import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gpuBrowser, hardwareGpu } from '../../../test-utils/hardware-gpu.mjs';
import { diffusion } from './diffusion.mjs';

test.use({ ...gpuBrowser, serviceWorkers: 'block' });

const sourceRoot = new URL('../vendor/gpu-streamlines/src/', import.meta.url);

test('the Boot kernel flags every workgroup whose subgroups are not 32 lanes matching tid.x', async ({ page }) => {
  const [boot, globals] = await Promise.all(['wgsl/boot.wgsl', 'wgsl/globals.wgsl']
    .map(name => readFile(new URL(name, sourceRoot), 'utf8')));
  const guard = boot.match(/var<workgroup> wg_lane_mismatch[^\n]*\n[\s\S]*?\nfn subgroupLayoutMismatch[\s\S]*?\n\}\n/)[0];
  const workgroupSizes = [...boot.matchAll(/@workgroup_size\(([^)]+)\)/g)].map(match => match[1]);
  expect(new Set(workgroupSizes)).toEqual(new Set(['32, 2, 1']));
  const shader = `enable subgroups;
    ${globals}
    ${guard}
    @group(0) @binding(0) var<storage, read_write> output: array<u32>;
    @compute @workgroup_size(${workgroupSizes[0]})
    fn probe(@builtin(local_invocation_id) tid: vec3<u32>, @builtin(workgroup_id) gid: vec3<u32>,
             @builtin(subgroup_size) sg_size: u32, @builtin(subgroup_invocation_id) sg_lane: u32) {
      let mismatch = subgroupLayoutMismatch(tid.x, sg_size, sg_lane);
      let index = (gid.x * 64u + tid.y * 32u + tid.x) * 3u;
      output[index] = select(0u, 1u, mismatch);
      output[index + 1u] = sg_size;
      output[index + 2u] = sg_lane;
    }`;
  await page.goto('/');
  const result = await page.evaluate(async shader => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice({ requiredFeatures: ['subgroups'] });
    try {
      const groups = 8;
      const bytes = groups * 64 * 3 * 4;
      const module = device.createShaderModule({ code: shader });
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'probe' } });
      const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] }));
      pass.dispatchWorkgroups(groups);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Uint32Array(staging.getMappedRange()));
      return { values, minSize: adapter.info.subgroupMinSize, maxSize: adapter.info.subgroupMaxSize };
    } finally {
      device.destroy();
    }
  }, shader);
  const invocations = Array.from({ length: result.values.length / 3 }, (_, index) => ({
    flagged: result.values[index * 3] === 1,
    size: result.values[index * 3 + 1],
    lane: result.values[index * 3 + 2],
    tidx: index % 32,
    group: Math.floor(index / 64),
  }));
  for (let group = 0; group < 8; group++) {
    const members = invocations.filter(invocation => invocation.group === group);
    const matches = members.every(({ size, lane, tidx }) => size === 32 && lane === tidx);
    expect(members.map(({ flagged }) => flagged), `workgroup ${group}`).toEqual(new Array(64).fill(!matches));
  }
  // SwiftShader runs 4-lane subgroups, so the software run is the negative control.
  if (!hardwareGpu) expect(invocations.every(({ flagged }) => flagged)).toBe(true);
  if (result.minSize === 32 && result.maxSize === 32) expect(invocations.some(({ flagged }) => flagged)).toBe(false);
});

test('tractography on a GPU without 32-lane subgroups stops with a clear error', async ({ page }) => {
  test.skip(hardwareGpu, 'Needs the 4-lane SwiftShader adapter.');
  test.setTimeout(180_000);
  await page.context().route('**/brainchop/**', route => route.fulfill({ status: 503, body: 'Model unavailable for fallback check' }));
  await page.goto('/');
  for (const [role, file] of Object.entries(diffusion())) {
    await page.locator('#neurodesk-input-transfer').setInputFiles({ ...file, mimeType: 'application/octet-stream' });
    await page.evaluate(role => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'tractography' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 120_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state).toBe('failed');
  expect(snapshot.error?.message).toMatch(/^tracking needs 32-lane GPU subgroups; this GPU has 4-lane subgroups\.$/);
  await expect(page.locator('footer#status')).toContainText('Streamline tracking failed: tracking needs 32-lane GPU subgroups;');
});
