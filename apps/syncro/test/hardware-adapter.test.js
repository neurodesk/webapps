import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHardwareAdapter } from '../e2e/hardware-adapter.js';

const hardware = { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false };

test('hardware verification accepts the adapter in the runner inventory', () => {
  assertHardwareAdapter(hardware, 'Apple');
});

for (const architecture of ['swiftshader', 'llvmpipe', 'lavapipe', 'software', 'cpu']) {
  test(`hardware verification rejects nonfallback ${architecture}`, () => {
    assert.throws(() => assertHardwareAdapter({ ...hardware, architecture }, 'apple'), /software adapter/);
  });
}

test('hardware verification requires an adapter and matching inventory', () => {
  assert.throws(() => assertHardwareAdapter(null, 'apple'), /available adapter/);
  assert.throws(() => assertHardwareAdapter(hardware, ''), /runner inventory/);
  assert.throws(() => assertHardwareAdapter(hardware, 'nvidia'), /match the runner/);
  assert.throws(() => assertHardwareAdapter({ ...hardware, isFallbackAdapter: true }, 'apple'), /fallback adapter/);
});
