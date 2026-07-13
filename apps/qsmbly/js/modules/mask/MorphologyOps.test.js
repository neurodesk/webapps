/**
 * Tests for MorphologyOps module
 */

import { erodeMask3D, dilateMask3D, fillHoles3D } from './MorphologyOps.js';

describe('MorphologyOps', () => {
  describe('erodeMask3D', () => {
    it('should preserve solid cube (no internal zeros)', () => {
      // 3x3x3 cube with all ones
      // Note: Original implementation does NOT erode boundary voxels
      // (only checks neighbors that exist within the volume)
      const mask = new Float32Array(27).fill(1);
      const dims = [3, 3, 3];

      const result = erodeMask3D(mask, dims);

      // All voxels remain since no neighbor is 0
      const count = Array.from(result).filter(v => v === 1).length;
      expect(count).toBe(27);
    });

    it('should erode voxels with zero neighbors inside volume', () => {
      // 5x5x5 cube with outer shell of zeros
      const dims = [5, 5, 5];
      const mask = new Float32Array(125).fill(0);

      // Fill interior 3x3x3 cube with ones
      for (let z = 1; z <= 3; z++) {
        for (let y = 1; y <= 3; y++) {
          for (let x = 1; x <= 3; x++) {
            mask[x + y * 5 + z * 25] = 1;
          }
        }
      }

      const result = erodeMask3D(mask, dims);

      // Only center voxel (2,2,2) should remain
      const centerIdx = 2 + 2 * 5 + 2 * 25;
      expect(result[centerIdx]).toBe(1);

      const count = Array.from(result).filter(v => v === 1).length;
      expect(count).toBe(1);
    });

    it('should handle empty mask', () => {
      const mask = new Float32Array(27).fill(0);
      const dims = [3, 3, 3];

      const result = erodeMask3D(mask, dims);

      expect(result.every(v => v === 0)).toBe(true);
    });

    it('should handle single voxel', () => {
      const mask = new Float32Array(27).fill(0);
      mask[13] = 1; // Center voxel
      const dims = [3, 3, 3];

      const result = erodeMask3D(mask, dims);

      // Single voxel has no neighbors inside, so should be removed
      expect(result[13]).toBe(0);
    });
  });

  describe('dilateMask3D', () => {
    it('should expand single voxel to 6-connected neighbors', () => {
      const mask = new Float32Array(27).fill(0);
      mask[13] = 1; // Center of 3x3x3
      const dims = [3, 3, 3];

      const result = dilateMask3D(mask, dims);

      // Center should still be 1
      expect(result[13]).toBe(1);

      // 6 face neighbors should now be 1
      expect(result[12]).toBe(1); // x-1
      expect(result[14]).toBe(1); // x+1
      expect(result[10]).toBe(1); // y-1
      expect(result[16]).toBe(1); // y+1
      expect(result[4]).toBe(1);  // z-1
      expect(result[22]).toBe(1); // z+1

      // Total should be 7 (center + 6 neighbors)
      const count = Array.from(result).filter(v => v === 1).length;
      expect(count).toBe(7);
    });

    it('should handle empty mask', () => {
      const mask = new Float32Array(27).fill(0);
      const dims = [3, 3, 3];

      const result = dilateMask3D(mask, dims);

      expect(result.every(v => v === 0)).toBe(true);
    });
  });

  describe('fillHoles3D', () => {
    it('should fill internal holes', () => {
      // Create 5x5x5 mask with solid shell and empty center
      const dims = [5, 5, 5];
      const mask = new Float32Array(125);

      // Fill edges with 1, leave center as 0
      for (let z = 0; z < 5; z++) {
        for (let y = 0; y < 5; y++) {
          for (let x = 0; x < 5; x++) {
            const isEdge = x === 0 || x === 4 || y === 0 || y === 4 || z === 0 || z === 4;
            const idx = x + y * 5 + z * 25;
            mask[idx] = isEdge ? 1 : 0;
          }
        }
      }

      const result = fillHoles3D(mask, dims);

      // All voxels should now be 1
      expect(result.every(v => v === 1)).toBe(true);
    });

    it('should not fill holes connected to boundary', () => {
      // 3x3x3 with hole at center but connected to boundary
      const dims = [3, 3, 3];
      const mask = new Float32Array(27).fill(1);
      mask[13] = 0; // Center is a hole
      mask[4] = 0;  // Connected to z=0 boundary

      const result = fillHoles3D(mask, dims);

      // Center should still be 0 because it's connected to outside via z=0
      expect(result[13]).toBe(0);
      expect(result[4]).toBe(0);
    });

    it('should handle fully filled mask', () => {
      const mask = new Float32Array(27).fill(1);
      const dims = [3, 3, 3];

      const result = fillHoles3D(mask, dims);

      // Should remain all ones
      expect(result.every(v => v === 1)).toBe(true);
    });
  });
});
