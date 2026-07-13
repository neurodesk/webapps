/**
 * Filter Utilities
 *
 * 3D filtering functions for image processing.
 */

/**
 * 3D box filter (mean filter) for smoothing
 * Used for R_0 reliability map computation
 *
 * @param {Float64Array} data - Input 3D data
 * @param {number} nx - X dimension
 * @param {number} ny - Y dimension
 * @param {number} nz - Z dimension
 * @param {number} radius - Filter radius
 * @returns {Float64Array} Filtered data
 */
export function boxFilter3D(data, nx, ny, nz, radius) {
  const voxelCount = nx * ny * nz;
  const result = new Float64Array(voxelCount);

  const idx = (i, j, k) => i + j * nx + k * nx * ny;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let sum = 0;
        let count = 0;

        // Box neighborhood
        for (let dk = -radius; dk <= radius; dk++) {
          const kk = k + dk;
          if (kk < 0 || kk >= nz) continue;

          for (let dj = -radius; dj <= radius; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= ny) continue;

            for (let di = -radius; di <= radius; di++) {
              const ii = i + di;
              if (ii < 0 || ii >= nx) continue;

              sum += data[idx(ii, jj, kk)];
              count++;
            }
          }
        }

        result[idx(i, j, k)] = count > 0 ? sum / count : 0;
      }
    }
  }

  return result;
}

/**
 * 3D box filter using separable 1D passes
 * Matches MATLAB smooth3(data, 'box', [kx, ky, kz])
 * More efficient for large kernels
 *
 * @param {Float64Array} data - Input 3D data
 * @param {number} nx - X dimension
 * @param {number} ny - Y dimension
 * @param {number} nz - Z dimension
 * @param {number} kx - Kernel size in X
 * @param {number} ky - Kernel size in Y
 * @param {number} kz - Kernel size in Z
 * @returns {Float64Array} Filtered data
 */
export function boxFilter3dSeparable(data, nx, ny, nz, kx, ky, kz) {
  const n = nx * ny * nz;
  const halfKx = Math.floor(kx / 2);
  const halfKy = Math.floor(ky / 2);
  const halfKz = Math.floor(kz / 2);

  // Pass 1: smooth along x
  let src = new Float64Array(data);
  let dst = new Float64Array(n);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let sum = 0, count = 0;
        const lo = Math.max(0, i - halfKx);
        const hi = Math.min(nx - 1, i + halfKx);
        for (let ii = lo; ii <= hi; ii++) {
          sum += src[ii + j * nx + k * nx * ny];
          count++;
        }
        dst[i + j * nx + k * nx * ny] = sum / count;
      }
    }
  }

  // Pass 2: smooth along y
  src = dst;
  dst = new Float64Array(n);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        let sum = 0, count = 0;
        const lo = Math.max(0, j - halfKy);
        const hi = Math.min(ny - 1, j + halfKy);
        for (let jj = lo; jj <= hi; jj++) {
          sum += src[i + jj * nx + k * nx * ny];
          count++;
        }
        dst[i + j * nx + k * nx * ny] = sum / count;
      }
    }
  }

  // Pass 3: smooth along z
  src = dst;
  dst = new Float64Array(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        let sum = 0, count = 0;
        const lo = Math.max(0, k - halfKz);
        const hi = Math.min(nz - 1, k + halfKz);
        for (let kk = lo; kk <= hi; kk++) {
          sum += src[i + j * nx + kk * nx * ny];
          count++;
        }
        dst[i + j * nx + k * nx * ny] = sum / count;
      }
    }
  }

  return dst;
}

// Make available globally for non-module contexts (workers)
if (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined') {
  self.FilterUtils = { boxFilter3D, boxFilter3dSeparable };
} else if (typeof window !== 'undefined') {
  window.FilterUtils = { boxFilter3D, boxFilter3dSeparable };
}
