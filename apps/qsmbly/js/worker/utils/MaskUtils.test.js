/**
 * MaskUtils Tests
 */
import { createThresholdMask, findSeedPoint } from './MaskUtils.js';

describe('MaskUtils', () => {
  describe('createThresholdMask', () => {
    test('should create mask with correct threshold', () => {
      const magnitude = new Float64Array([0, 25, 50, 75, 100]);
      const mask = createThresholdMask(magnitude, 0.5);  // 50% threshold

      // Values > 50 should be masked
      expect(mask[0]).toBe(0);  // 0 <= 50
      expect(mask[1]).toBe(0);  // 25 <= 50
      expect(mask[2]).toBe(0);  // 50 <= 50 (not strictly greater)
      expect(mask[3]).toBe(1);  // 75 > 50
      expect(mask[4]).toBe(1);  // 100 > 50
    });

    test('should return Uint8Array', () => {
      const magnitude = new Float64Array([10, 20, 30]);
      const mask = createThresholdMask(magnitude, 0.5);

      expect(mask).toBeInstanceOf(Uint8Array);
      expect(mask.length).toBe(3);
    });

    test('should handle all zeros', () => {
      const magnitude = new Float64Array([0, 0, 0, 0]);
      const mask = createThresholdMask(magnitude, 0.5);

      // All zeros, threshold = 0, nothing > 0
      expect(mask.every(v => v === 0)).toBe(true);
    });

    test('should handle uniform values', () => {
      const magnitude = new Float64Array([100, 100, 100, 100]);
      const mask = createThresholdMask(magnitude, 0.5);

      // Threshold = 50, all values = 100 > 50
      expect(mask.every(v => v === 1)).toBe(true);
    });

    test('should handle 0% threshold', () => {
      const magnitude = new Float64Array([0, 1, 2, 3]);
      const mask = createThresholdMask(magnitude, 0);

      // Threshold = 0, everything > 0 except first
      expect(mask[0]).toBe(0);
      expect(mask[1]).toBe(1);
      expect(mask[2]).toBe(1);
      expect(mask[3]).toBe(1);
    });
  });

  describe('findSeedPoint', () => {
    test('should find center of mass of mask', () => {
      const nx = 5, ny = 5, nz = 5;
      const mask = new Uint8Array(nx * ny * nz);

      // Create a small cluster in one corner
      // Indices: (1,1,1), (1,1,2), (1,2,1), (2,1,1)
      mask[1 * ny * nz + 1 * nz + 1] = 1;
      mask[1 * ny * nz + 1 * nz + 2] = 1;
      mask[1 * ny * nz + 2 * nz + 1] = 1;
      mask[2 * ny * nz + 1 * nz + 1] = 1;

      const seed = findSeedPoint(mask, nx, ny, nz);

      // Average position: ((1+1+1+2)/4, (1+1+2+1)/4, (1+2+1+1)/4) = (1.25, 1.25, 1.25)
      // Floored: (1, 1, 1)
      expect(seed[0]).toBe(1);
      expect(seed[1]).toBe(1);
      expect(seed[2]).toBe(1);
    });

    test('should return center for empty mask', () => {
      const nx = 10, ny = 10, nz = 10;
      const mask = new Uint8Array(nx * ny * nz);  // All zeros

      const seed = findSeedPoint(mask, nx, ny, nz);

      // Should return center
      expect(seed[0]).toBe(5);
      expect(seed[1]).toBe(5);
      expect(seed[2]).toBe(5);
    });

    test('should handle single voxel mask', () => {
      const nx = 10, ny = 10, nz = 10;
      const mask = new Uint8Array(nx * ny * nz);

      // Single voxel at (7, 3, 5)
      mask[7 * ny * nz + 3 * nz + 5] = 1;

      const seed = findSeedPoint(mask, nx, ny, nz);

      expect(seed[0]).toBe(7);
      expect(seed[1]).toBe(3);
      expect(seed[2]).toBe(5);
    });

    test('should return array of 3 integers', () => {
      const mask = new Uint8Array(27).fill(1);  // 3x3x3 all ones
      const seed = findSeedPoint(mask, 3, 3, 3);

      expect(seed).toHaveLength(3);
      expect(Number.isInteger(seed[0])).toBe(true);
      expect(Number.isInteger(seed[1])).toBe(true);
      expect(Number.isInteger(seed[2])).toBe(true);
    });
  });
});
