/**
 * FilterUtils Tests
 */
import { boxFilter3dSeparable } from './FilterUtils.js';

// Brute-force reference: mean over the in-bounds part of a kx*ky*kz box (MATLAB smooth3 'box').
function boxMeanReference(data, nx, ny, nz, kx, ky, kz) {
  const [hx, hy, hz] = [kx, ky, kz].map(k => Math.floor(k / 2));
  const out = new Float64Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let sum = 0, count = 0;
        for (let kk = Math.max(0, k - hz); kk <= Math.min(nz - 1, k + hz); kk++) {
          for (let jj = Math.max(0, j - hy); jj <= Math.min(ny - 1, j + hy); jj++) {
            for (let ii = Math.max(0, i - hx); ii <= Math.min(nx - 1, i + hx); ii++) {
              sum += data[ii + jj * nx + kk * nx * ny];
              count++;
            }
          }
        }
        out[i + j * nx + k * nx * ny] = sum / count;
      }
    }
  }
  return out;
}

describe('FilterUtils', () => {
  describe('boxFilter3dSeparable', () => {
    const nx = 5, ny = 5, nz = 5;

    test('should match a brute-force box mean, including at the borders', () => {
      // Non-cubic grid and an asymmetric kernel, so a transposed axis or a wrong
      // border normalization shows up as a mismatch.
      const [gx, gy, gz] = [6, 5, 4];
      const data = new Float64Array(gx * gy * gz);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin(i * 0.7) + 0.1 * i;
      }

      const expected = boxMeanReference(data, gx, gy, gz, 3, 5, 1);
      const result = boxFilter3dSeparable(data, gx, gy, gz, 3, 5, 1);

      for (let i = 0; i < expected.length; i++) {
        expect(result[i]).toBeCloseTo(expected[i], 10);
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
