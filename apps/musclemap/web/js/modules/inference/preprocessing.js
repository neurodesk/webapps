/**
 * MuscleMap Preprocessing Pipeline
 *
 * 1. Orient to RAS
 * 2. Resample to target spacing [1, 1, original_z]
 * 3. Z-score normalize (nonzero voxels only)
 * 4. Crop foreground with margin
 */

/**
 * Determine the orientation of the volume from the affine matrix.
 * Returns permutation and flip arrays to transform to RAS.
 *
 * @param {Float64Array[]} affine - 4x4 affine matrix (array of 4 rows)
 * @returns {{ perm: number[], flip: boolean[] }}
 */
export function getOrientationTransform(affine) {
  // Extract the 3x3 rotation/scaling part
  const mat = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]]
  ];

  // For each output axis (R, A, S), find which input axis has the largest component
  const perm = [0, 0, 0];
  const flip = [false, false, false];
  const used = [false, false, false];

  for (let outAxis = 0; outAxis < 3; outAxis++) {
    let bestAxis = -1;
    let bestVal = -1;
    for (let inAxis = 0; inAxis < 3; inAxis++) {
      if (used[inAxis]) continue;
      const val = Math.abs(mat[outAxis][inAxis]);
      if (val > bestVal) {
        bestVal = val;
        bestAxis = inAxis;
      }
    }
    perm[outAxis] = bestAxis;
    flip[outAxis] = mat[outAxis][bestAxis] < 0;
    used[bestAxis] = true;
  }

  return { perm, flip };
}

/**
 * Reorient a 3D volume to RAS orientation.
 *
 * @param {Float32Array} data - Volume data in NIfTI order (x varies fastest)
 * @param {number[]} dims - [nx, ny, nz]
 * @param {number[]} perm - Axis permutation
 * @param {boolean[]} flip - Which axes to flip
 * @returns {{ data: Float32Array, dims: number[] }}
 */
export function orientToRAS(data, dims, perm, flip) {
  const [nx, ny, nz] = dims;
  const srcDims = [nx, ny, nz];
  const dstDims = [srcDims[perm[0]], srcDims[perm[1]], srcDims[perm[2]]];
  const [dx, dy, dz] = dstDims;
  const result = new Float32Array(dx * dy * dz);

  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        // Map output coords back to input coords
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dstDims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = src[0] + src[1] * nx + src[2] * nx * ny;
        const dstIdx = ox + oy * dx + oz * dx * dy;
        result[dstIdx] = data[srcIdx];
      }
    }
  }

  return { data: result, dims: dstDims };
}

/**
 * Resample a 3D volume to target spacing using trilinear interpolation.
 *
 * @param {Float32Array} data - Volume data (x varies fastest)
 * @param {number[]} dims - [nx, ny, nz]
 * @param {number[]} srcSpacing - Current voxel spacing [sx, sy, sz]
 * @param {number[]} tgtSpacing - Target voxel spacing [tx, ty, tz] (-1 means keep)
 * @returns {{ data: Float32Array, dims: number[], spacing: number[] }}
 */
export function resampleVolume(data, dims, srcSpacing, tgtSpacing) {
  const [nx, ny, nz] = dims;
  const actualTarget = tgtSpacing.map((t, i) => t < 0 ? srcSpacing[i] : t);

  // Compute new dimensions
  const newDims = [
    Math.round(nx * srcSpacing[0] / actualTarget[0]),
    Math.round(ny * srcSpacing[1] / actualTarget[1]),
    Math.round(nz * srcSpacing[2] / actualTarget[2])
  ];
  const [nnx, nny, nnz] = newDims;
  const result = new Float32Array(nnx * nny * nnz);

  // Scale factors: maps new coords to old coords
  const scaleX = (nx - 1) / Math.max(nnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(nny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(nnz - 1, 1);

  for (let z = 0; z < nnz; z++) {
    const sz = z * scaleZ;
    const z0 = Math.floor(sz);
    const z1 = Math.min(z0 + 1, nz - 1);
    const wz = sz - z0;

    for (let y = 0; y < nny; y++) {
      const sy = y * scaleY;
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, ny - 1);
      const wy = sy - y0;

      for (let x = 0; x < nnx; x++) {
        const sx = x * scaleX;
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = sx - x0;

        // Trilinear interpolation
        const c000 = data[x0 + y0 * nx + z0 * nx * ny];
        const c100 = data[x1 + y0 * nx + z0 * nx * ny];
        const c010 = data[x0 + y1 * nx + z0 * nx * ny];
        const c110 = data[x1 + y1 * nx + z0 * nx * ny];
        const c001 = data[x0 + y0 * nx + z1 * nx * ny];
        const c101 = data[x1 + y0 * nx + z1 * nx * ny];
        const c011 = data[x0 + y1 * nx + z1 * nx * ny];
        const c111 = data[x1 + y1 * nx + z1 * nx * ny];

        const c00 = c000 * (1 - wx) + c100 * wx;
        const c01 = c001 * (1 - wx) + c101 * wx;
        const c10 = c010 * (1 - wx) + c110 * wx;
        const c11 = c011 * (1 - wx) + c111 * wx;
        const c0 = c00 * (1 - wy) + c10 * wy;
        const c1 = c01 * (1 - wy) + c11 * wy;
        const val = c0 * (1 - wz) + c1 * wz;

        result[x + y * nnx + z * nnx * nny] = val;
      }
    }
  }

  return { data: result, dims: newDims, spacing: actualTarget };
}

/**
 * Z-score normalize over nonzero voxels only.
 *
 * @param {Float32Array} data - Volume data
 * @returns {Float32Array} Normalized data
 */
export function zScoreNormalizeNonzero(data) {
  const n = data.length;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    if (data[i] !== 0) {
      sum += data[i];
      count++;
    }
  }

  if (count === 0) return new Float32Array(n);

  const mean = sum / count;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] !== 0) {
      const d = data[i] - mean;
      sumSq += d * d;
    }
  }
  const std = Math.sqrt(sumSq / count) || 1;

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (data[i] !== 0) {
      result[i] = (data[i] - mean) / std;
    }
  }
  return result;
}

/**
 * Compute the bounding box of nonzero voxels and crop with margin.
 *
 * @param {Float32Array} data - Volume data
 * @param {number[]} dims - [nx, ny, nz]
 * @param {number} margin - Voxel margin around bounding box
 * @returns {{ data: Float32Array, dims: number[], origin: number[] }}
 */
export function cropForeground(data, dims, margin = 20) {
  const [nx, ny, nz] = dims;

  let minX = nx, maxX = 0;
  let minY = ny, maxY = 0;
  let minZ = nz, maxZ = 0;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (data[x + y * nx + z * nx * ny] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
  }

  // No foreground found
  if (maxX < minX) {
    return { data: new Float32Array(0), dims: [0, 0, 0], origin: [0, 0, 0] };
  }

  // Apply margin
  const ox = Math.max(0, minX - margin);
  const oy = Math.max(0, minY - margin);
  const oz = Math.max(0, minZ - margin);
  const ex = Math.min(nx, maxX + margin + 1);
  const ey = Math.min(ny, maxY + margin + 1);
  const ez = Math.min(nz, maxZ + margin + 1);

  const cnx = ex - ox;
  const cny = ey - oy;
  const cnz = ez - oz;

  const result = new Float32Array(cnx * cny * cnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOffset = (z + oz) * nx * ny + (y + oy) * nx + ox;
      const dstOffset = z * cnx * cny + y * cnx;
      result.set(data.subarray(srcOffset, srcOffset + cnx), dstOffset);
    }
  }

  return { data: result, dims: [cnx, cny, cnz], origin: [ox, oy, oz] };
}

/**
 * Inverse crop: place cropped data back into full volume.
 *
 * @param {Uint8Array} croppedData - Cropped label data
 * @param {number[]} croppedDims - [cnx, cny, cnz]
 * @param {number[]} fullDims - [nx, ny, nz]
 * @param {number[]} origin - [ox, oy, oz] crop origin
 * @returns {Uint8Array}
 */
export function uncrop(croppedData, croppedDims, fullDims, origin) {
  const [nx, ny, nz] = fullDims;
  const [cnx, cny, cnz] = croppedDims;
  const [ox, oy, oz] = origin;
  const result = new Uint8Array(nx * ny * nz);

  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOffset = z * cnx * cny + y * cnx;
      const dstOffset = (z + oz) * nx * ny + (y + oy) * nx + ox;
      result.set(croppedData.subarray(srcOffset, srcOffset + cnx), dstOffset);
    }
  }

  return result;
}

/**
 * Resample label volume back to original spacing using nearest neighbor.
 *
 * @param {Uint8Array} data - Label data
 * @param {number[]} dims - Current dims
 * @param {number[]} srcSpacing - Current spacing
 * @param {number[]} tgtDims - Target dims
 * @returns {Uint8Array}
 */
export function resampleLabelsNearest(data, dims, srcSpacing, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);

  const scaleX = (nx - 1) / Math.max(tnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(tny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(tnz - 1, 1);

  for (let z = 0; z < tnz; z++) {
    const sz = Math.round(z * scaleZ);
    for (let y = 0; y < tny; y++) {
      const sy = Math.round(y * scaleY);
      for (let x = 0; x < tnx; x++) {
        const sx = Math.round(x * scaleX);
        result[x + y * tnx + z * tnx * tny] = data[sx + sy * nx + sz * nx * ny];
      }
    }
  }

  return result;
}

/**
 * Inverse orient: transform labels from RAS back to original orientation.
 *
 * @param {Uint8Array} data - Label volume in RAS
 * @param {number[]} dims - RAS dims
 * @param {number[]} perm - Original permutation used for orient
 * @param {boolean[]} flip - Original flips used for orient
 * @param {number[]} origDims - Original volume dims
 * @returns {Uint8Array}
 */
export function inverseOrient(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Uint8Array(nx * ny * nz);

  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = ox + oy * dx + oz * dx * dy;
        const dstIdx = src[0] + src[1] * nx + src[2] * nx * ny;
        result[dstIdx] = data[srcIdx];
      }
    }
  }

  return result;
}
