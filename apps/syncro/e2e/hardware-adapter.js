import assert from 'node:assert/strict';

export function assertHardwareAdapter(info, expectedVendor = process.env.SYNCRO_HARDWARE_GPU_VENDOR) {
  assert.ok(info, 'Hardware WebGPU requires an available adapter');
  assert.equal(info.isFallbackAdapter, false, 'A fallback adapter cannot validate hardware WebGPU');
  const identity = [info.vendor, info.architecture, info.device, info.description].join(' ');
  assert.doesNotMatch(identity, /swiftshader|llvmpipe|lavapipe|software|basic render|\bwarp\b|\bcpu\b/i,
    'A software adapter cannot validate hardware WebGPU');
  assert.ok(expectedVendor?.trim(), 'Set SYNCRO_HARDWARE_GPU_VENDOR to the GPU vendor in the runner inventory');
  assert.equal(info.vendor.toLowerCase(), expectedVendor.trim().toLowerCase(),
    'Selected WebGPU adapter must match the runner GPU vendor');
}
