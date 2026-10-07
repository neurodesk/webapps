import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHardwareAdapter } from '../test-utils/hardware-gpu.mjs';

const hardware = { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false };

test('hardware verification accepts the adapter in the runner inventory', () => {
  assertHardwareAdapter(hardware, 'Apple');
});

for (const architecture of ['swiftshader', 'llvmpipe', 'lavapipe', 'software', 'cpu']) {
  test(`hardware verification rejects nonfallback ${architecture}`, () => {
    assert.throws(() => assertHardwareAdapter({ ...hardware, architecture }, 'apple'), /software adapter/);
  });
}

test('hardware verification accepts any hardware vendor when none is expected', () => {
  assertHardwareAdapter(hardware, '');
});

test('hardware verification requires an adapter and a matching vendor', () => {
  assert.throws(() => assertHardwareAdapter(null, 'apple'), /available adapter/);
  assert.throws(() => assertHardwareAdapter(hardware, 'nvidia'), /match the runner/);
  assert.throws(() => assertHardwareAdapter({ ...hardware, isFallbackAdapter: true }, 'apple'), /fallback adapter/);
});
