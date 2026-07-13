/**
 * FilterUtils Tests
 */
import { boxFilter3D, boxFilter3dSeparable } from './FilterUtils.js';

describe('FilterUtils', () => {
  describe('boxFilter3D', () => {
    const nx = 5, ny = 5, nz = 5;

    test('should smooth data with radius 1', () => {
      const data = new Float64Array(nx * ny * nz).fill(0);
      // Set center voxel to 1
      const centerIdx = 2 + 2 * nx + 2 * nx * ny;
      data[centerIdx] = 27;  // Will be averaged with 26 zeros

      const result = boxFilter3D(data, nx, ny, nz, 1);

      // Center should be averaged: 27/27 = 1
      expect(result[centerIdx]).toBeCloseTo(1, 5);
    });

    test('should preserve uniform data', () => {
      const data = new Float64Array(nx * ny * nz).fill(42);
      const result = boxFilter3D(data, nx, ny, nz, 1);

      // All values should still be 42
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeCloseTo(42, 5);
      }
    });

    test('should handle radius 0', () => {
      const data = new Float64Array(nx * ny * nz);
      for (let i = 0; i < data.length; i++) {
        data[i] = i;
      }

      const result = boxFilter3D(data, nx, ny, nz, 0);

      // Radius 0 means only the voxel itself, so no change
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeCloseTo(data[i], 5);
      }
    });

    test('should return Float64Array', () => {
      const data = new Float64Array(nx * ny * nz);
      const result = boxFilter3D(data, nx, ny, nz, 1);

      expect(result).toBeInstanceOf(Float64Array);
      expect(result.length).toBe(data.length);
    });
  });

  describe('boxFilter3dSeparable', () => {
    const nx = 5, ny = 5, nz = 5;

    test('should produce similar results to boxFilter3D', () => {
      const data = new Float64Array(nx * ny * nz);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin(i * 0.1);
      }

      // Use kernel size 3 (radius 1)
      const result1 = boxFilter3D(data, nx, ny, nz, 1);
      const result2 = boxFilter3dSeparable(data, nx, ny, nz, 3, 3, 3);

      // Results should be close (separable approximation)
      // Note: They won't be identical because boxFilter3D uses cubic neighborhood
      // while separable uses axis-aligned passes
      for (let i = 0; i < result1.length; i++) {
        expect(Math.abs(result1[i] - result2[i])).toBeLessThan(0.5);
      }
    });

    test('should smooth along each axis independently', () => {
      const data = new Float64Array(nx * ny * nz).fill(0);

      // Create a line along x-axis at y=2, z=2
      for (let x = 0; x < nx; x++) {
        const idx = x + 2 * nx + 2 * nx * ny;
        data[idx] = 1;
      }

      // Smooth with large y kernel
      const result = boxFilter3dSeparable(data, nx, ny, nz, 1, 5, 1);

      // Values should spread in y direction
      const centerIdx = 2 + 2 * nx + 2 * nx * ny;
      const aboveIdx = 2 + 3 * nx + 2 * nx * ny;
      expect(result[aboveIdx]).toBeGreaterThan(0);
    });

    test('should handle asymmetric kernels', () => {
      const data = new Float64Array(nx * ny * nz).fill(1);
      const result = boxFilter3dSeparable(data, nx, ny, nz, 3, 1, 5);

      // Uniform data should stay uniform
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeCloseTo(1, 5);
      }
    });

    test('should preserve total mass approximately', () => {
      const data = new Float64Array(nx * ny * nz);
      let inputSum = 0;
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random();
        inputSum += data[i];
      }

      const result = boxFilter3dSeparable(data, nx, ny, nz, 3, 3, 3);
      let outputSum = 0;
      for (let i = 0; i < result.length; i++) {
        outputSum += result[i];
      }

      // Total mass should be approximately preserved (within 5% for small volumes with boundary effects)
      const relativeDiff = Math.abs(outputSum - inputSum) / inputSum;
      expect(relativeDiff).toBeLessThan(0.05);
    });

    test('should return Float64Array', () => {
      const data = new Float64Array(nx * ny * nz);
      const result = boxFilter3dSeparable(data, nx, ny, nz, 3, 3, 3);

      expect(result).toBeInstanceOf(Float64Array);
      expect(result.length).toBe(data.length);
    });
  });
});
