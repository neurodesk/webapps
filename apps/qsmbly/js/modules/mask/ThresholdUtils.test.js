/**
 * Tests for ThresholdUtils module
 */

import { computeOtsuThreshold, createThresholdMask } from './ThresholdUtils.js';

describe('ThresholdUtils', () => {
  describe('computeOtsuThreshold', () => {
    it('should find threshold for bimodal distribution', () => {
      // Create clean bimodal data: 50 values at 20, 50 values at 80 (no random)
      const data = new Float64Array(100);
      for (let i = 0; i < 50; i++) data[i] = 20;
      for (let i = 50; i < 100; i++) data[i] = 80;

      const result = computeOtsuThreshold(data);

      // Threshold should be between the two peaks (around 50)
      expect(result.thresholdValue).toBeGreaterThan(20);
      expect(result.thresholdValue).toBeLessThan(80);
      // Percent of max (80) should be between 25% and 75%
      expect(result.thresholdPercent).toBeGreaterThanOrEqual(25);
      expect(result.thresholdPercent).toBeLessThanOrEqual(75);
    });

    it('should handle constant image', () => {
      const data = new Float64Array(100).fill(42);
      const result = computeOtsuThreshold(data);

      expect(result.error).toBe('constant image');
    });

    it('should return correct min/max', () => {
      const data = new Float64Array([5, 10, 15, 20, 100]);
      const result = computeOtsuThreshold(data);

      expect(result.minVal).toBe(5);
      expect(result.maxVal).toBe(100);
    });

    it('should clamp percentage between 1 and 100', () => {
      // Very low threshold case
      const data = new Float64Array(100);
      for (let i = 0; i < 99; i++) data[i] = 100;
      data[99] = 1; // One outlier

      const result = computeOtsuThreshold(data);

      expect(result.thresholdPercent).toBeGreaterThanOrEqual(1);
      expect(result.thresholdPercent).toBeLessThanOrEqual(100);
    });
  });

  describe('createThresholdMask', () => {
    it('should create binary mask at threshold', () => {
      const data = new Float64Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
      const mask = createThresholdMask(data, 50, 100); // 50% of 100 = 50

      // Values >= 50 should be 1
      expect(mask[0]).toBe(0);  // 10
      expect(mask[1]).toBe(0);  // 20
      expect(mask[2]).toBe(0);  // 30
      expect(mask[3]).toBe(0);  // 40
      expect(mask[4]).toBe(1);  // 50
      expect(mask[5]).toBe(1);  // 60
      expect(mask[6]).toBe(1);  // 70
      expect(mask[7]).toBe(1);  // 80
      expect(mask[8]).toBe(1);  // 90
      expect(mask[9]).toBe(1);  // 100
    });

    it('should return all zeros at 100% threshold', () => {
      const data = new Float64Array([10, 20, 30, 40, 50]);
      const mask = createThresholdMask(data, 100, 50);

      // Only value exactly at max should be 1
      expect(mask[4]).toBe(1); // 50 >= 50
      expect(mask.filter(v => v === 1).length).toBe(1);
    });

    it('should return all ones at 0% threshold', () => {
      const data = new Float64Array([10, 20, 30, 40, 50]);
      const mask = createThresholdMask(data, 0, 50);

      // All values >= 0 should be 1
      expect(mask.every(v => v === 1)).toBe(true);
    });

    it('should return Float32Array', () => {
      const data = new Float64Array([1, 2, 3]);
      const mask = createThresholdMask(data, 50, 3);

      expect(mask).toBeInstanceOf(Float32Array);
    });
  });
});
