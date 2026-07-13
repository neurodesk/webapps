/**
 * Jest Test Setup
 *
 * Provides mocks for browser/worker APIs and WASM module.
 */

import { jest } from '@jest/globals';

// Mock WorkerGlobalScope for utility module detection
global.WorkerGlobalScope = class WorkerGlobalScope {};

// Mock self (web worker global)
global.self = {
  postMessage: jest.fn(),
  QSMConfig: null
};

// Mock window (browser global)
global.window = {};

// Mock WASM module functions
global.mockWasmModule = {
  load_nifti_wasm: jest.fn((buffer) => ({
    data: new Float64Array(1000),
    dims: [10, 10, 10],
    voxelSize: [1.0, 1.0, 1.0],
    affine: new Float64Array(16).fill(0).map((_, i) => i % 5 === 0 ? 1 : 0)
  })),
  save_nifti_wasm: jest.fn(() => new Uint8Array(100)),
  wasm_health_check: jest.fn(() => true),
  get_version: jest.fn(() => '1.0.0')
};

// Helper to create test data
global.createTestData = (size, pattern = 'zeros') => {
  const data = new Float64Array(size);
  switch (pattern) {
    case 'ones':
      data.fill(1);
      break;
    case 'random':
      for (let i = 0; i < size; i++) {
        data[i] = Math.random();
      }
      break;
    case 'linear':
      for (let i = 0; i < size; i++) {
        data[i] = i;
      }
      break;
    case 'phase':
      // Simulate phase data in [-π, π]
      for (let i = 0; i < size; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.PI;
      }
      break;
    case 'magnitude':
      // Simulate magnitude data with a central peak
      const center = Math.floor(size / 2);
      for (let i = 0; i < size; i++) {
        const dist = Math.abs(i - center) / center;
        data[i] = Math.exp(-dist * 3) * 1000;
      }
      break;
    default:
      // zeros
      break;
  }
  return data;
};

// Helper to create 3D test mask
global.createTestMask = (nx, ny, nz, fillFraction = 0.5) => {
  const mask = new Uint8Array(nx * ny * nz);
  const centerX = Math.floor(nx / 2);
  const centerY = Math.floor(ny / 2);
  const centerZ = Math.floor(nz / 2);
  const radius = Math.min(nx, ny, nz) * fillFraction / 2;

  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        const dx = x - centerX;
        const dy = y - centerY;
        const dz = z - centerZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const idx = x + y * nx + z * nx * ny;
        mask[idx] = dist <= radius ? 1 : 0;
      }
    }
  }
  return mask;
};
