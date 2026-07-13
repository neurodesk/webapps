/**
 * Morphology Operations Module
 *
 * Pure 3D morphological operations for binary masks.
 * All functions operate on Float32Array masks with dimensions [nx, ny, nz].
 */

/**
 * 3D morphological erosion (6-connected)
 * Voxel remains if all 6 neighbors are inside mask.
 *
 * @param {Float32Array} mask - Input binary mask
 * @param {number[]} dims - Dimensions [nx, ny, nz]
 * @returns {Float32Array} Eroded mask
 */
export function erodeMask3D(mask, dims) {
  const [nx, ny, nz] = dims;
  const dst = new Float32Array(mask.length);

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = x + y * nx + z * nx * ny;

        // Check if all 6 neighbors are inside mask
        // Note: boundary voxels are NOT eroded (neighbors outside volume are not checked)
        if (mask[idx] > 0) {
          let allNeighbors = true;

          // Check 6-connected neighbors
          if (x > 0 && mask[idx - 1] === 0) allNeighbors = false;
          if (x < nx - 1 && mask[idx + 1] === 0) allNeighbors = false;
          if (y > 0 && mask[idx - nx] === 0) allNeighbors = false;
          if (y < ny - 1 && mask[idx + nx] === 0) allNeighbors = false;
          if (z > 0 && mask[idx - nx * ny] === 0) allNeighbors = false;
          if (z < nz - 1 && mask[idx + nx * ny] === 0) allNeighbors = false;

          dst[idx] = allNeighbors ? 1 : 0;
        }
      }
    }
  }

  return dst;
}

/**
 * 3D morphological dilation (6-connected)
 * Voxel is set if any of 6 neighbors is in mask.
 *
 * @param {Float32Array} mask - Input binary mask
 * @param {number[]} dims - Dimensions [nx, ny, nz]
 * @returns {Float32Array} Dilated mask
 */
export function dilateMask3D(mask, dims) {
  const [nx, ny, nz] = dims;
  const dst = new Float32Array(mask.length);

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = x + y * nx + z * nx * ny;

        // Check if any of 6 neighbors is in mask
        if (mask[idx] > 0) {
          dst[idx] = 1;
        } else {
          let anyNeighbor = false;

          if (x > 0 && mask[idx - 1] > 0) anyNeighbor = true;
          if (x < nx - 1 && mask[idx + 1] > 0) anyNeighbor = true;
          if (y > 0 && mask[idx - nx] > 0) anyNeighbor = true;
          if (y < ny - 1 && mask[idx + nx] > 0) anyNeighbor = true;
          if (z > 0 && mask[idx - nx * ny] > 0) anyNeighbor = true;
          if (z < nz - 1 && mask[idx + nx * ny] > 0) anyNeighbor = true;

          dst[idx] = anyNeighbor ? 1 : 0;
        }
      }
    }
  }

  return dst;
}

/**
 * Fill holes in 3D mask using flood fill from edges.
 * Holes are defined as regions of zeros completely surrounded by ones.
 *
 * @param {Float32Array} mask - Input binary mask
 * @param {number[]} dims - Dimensions [nx, ny, nz]
 * @returns {Float32Array} Mask with holes filled
 */
export function fillHoles3D(mask, dims) {
  const [nx, ny, nz] = dims;
  const nxy = nx * ny;

  // Create a "visited from outside" array
  const outside = new Uint8Array(mask.length);

  // Use a queue for flood fill
  const queue = [];

  // Seed from all boundary voxels that are outside the mask
  // X boundaries
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const idx0 = 0 + y * nx + z * nxy;
      const idx1 = (nx - 1) + y * nx + z * nxy;
      if (mask[idx0] === 0 && !outside[idx0]) { outside[idx0] = 1; queue.push(idx0); }
      if (mask[idx1] === 0 && !outside[idx1]) { outside[idx1] = 1; queue.push(idx1); }
    }
  }
  // Y boundaries
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const idx0 = x + 0 * nx + z * nxy;
      const idx1 = x + (ny - 1) * nx + z * nxy;
      if (mask[idx0] === 0 && !outside[idx0]) { outside[idx0] = 1; queue.push(idx0); }
      if (mask[idx1] === 0 && !outside[idx1]) { outside[idx1] = 1; queue.push(idx1); }
    }
  }
  // Z boundaries
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const idx0 = x + y * nx + 0 * nxy;
      const idx1 = x + y * nx + (nz - 1) * nxy;
      if (mask[idx0] === 0 && !outside[idx0]) { outside[idx0] = 1; queue.push(idx0); }
      if (mask[idx1] === 0 && !outside[idx1]) { outside[idx1] = 1; queue.push(idx1); }
    }
  }

  // Flood fill from boundary
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % nx;
    const y = Math.floor((idx % nxy) / nx);
    const z = Math.floor(idx / nxy);

    // Check 6-connected neighbors
    const neighbors = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x < nx - 1) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - nx);
    if (y < ny - 1) neighbors.push(idx + nx);
    if (z > 0) neighbors.push(idx - nxy);
    if (z < nz - 1) neighbors.push(idx + nxy);

    for (const nidx of neighbors) {
      if (mask[nidx] === 0 && !outside[nidx]) {
        outside[nidx] = 1;
        queue.push(nidx);
      }
    }
  }

  // Fill holes: set all non-outside, non-mask voxels to 1
  const result = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    result[i] = (mask[i] > 0 || !outside[i]) ? 1 : 0;
  }

  return result;
}
