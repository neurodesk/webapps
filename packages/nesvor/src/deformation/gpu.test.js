import test from 'node:test';
import assert from 'node:assert/strict';
import { createGPUDeformation } from './gpu.js';
import { createDeformationModel } from './model.js';
import { fakeGpuDevice, installGpuConstants } from '../../../../test-utils/gpu-device.mjs';

installGpuConstants();
const model = () => createDeformationModel({ boundingBox: [[-1, -1, -1], [1, 1, 1]], slices: 1, features: 2, embeddingFeatures: 2, log2Size: 2, coarsest: 64, finest: 32, width: 4 });

test('deformation preserves operation failure while draining and poisoning invalid scopes', async () => {
  for (const scoped of [{ message: 'validation failed' }, new Error('scope rejected')]) {
    const device = fakeGpuDevice();
    const engine = await createGPUDeformation(device, model());
    const primary = new Error('readback failed');
    device.createBuffer = ({ size }) => ({ size, destroy() {}, async mapAsync() { throw primary; } });
    device.popResults.push(scoped);
    await assert.rejects(engine.readParameters(), error => error === primary);
    assert.equal(device.scopes, 0);
    await assert.rejects(engine.readParameters(), /validation failed|scope rejected/);
    engine.dispose();
  }
});

test('deformation clears busy after a read failure with a clean scope', async () => {
  const device = fakeGpuDevice();
  const engine = await createGPUDeformation(device, model());
  const createBuffer = device.createBuffer;
  device.createBuffer = ({ size }) => ({ size, destroy() {}, async mapAsync() { throw new Error('read failed'); } });
  await assert.rejects(engine.readParameters(), /read failed/);
  device.createBuffer = createBuffer;
  await engine.readParameters();
  assert.equal(device.scopes, 0);
  engine.dispose();
});
