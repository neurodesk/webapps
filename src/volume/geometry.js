export function voxelCount(dims) {
  assertDims(dims);
  return dims[0] * dims[1] * dims[2];
}

export function index3D(x, y, z, dims) {
  return x + y * dims[0] + z * dims[0] * dims[1];
}

export function assertDims(dims) {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some(value => !Number.isInteger(value) || value <= 0)) {
    throw new Error('dims must be [nx, ny, nz] positive integers');
  }
}

export function getOrientationTransform(affine) {
  const mat = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]]
  ];
  const perm = [0, 0, 0];
  const flip = [false, false, false];
  const used = [false, false, false];
  for (let outAxis = 0; outAxis < 3; outAxis++) {
    let bestAxis = -1;
    let bestValue = -1;
    for (let inAxis = 0; inAxis < 3; inAxis++) {
      if (used[inAxis]) continue;
      const value = Math.abs(mat[outAxis][inAxis]);
      if (value > bestValue) {
        bestValue = value;
        bestAxis = inAxis;
      }
    }
    perm[outAxis] = bestAxis;
    flip[outAxis] = mat[outAxis][bestAxis] < 0;
    used[bestAxis] = true;
  }
  return { perm, flip };
}

export function orientToRAS(data, dims, perm, flip, OutputCtor = data.constructor) {
  assertDims(dims);
  const srcDims = [...dims];
  const dstDims = [srcDims[perm[0]], srcDims[perm[1]], srcDims[perm[2]]];
  const [dx, dy, dz] = dstDims;
  const result = new OutputCtor(dx * dy * dz);
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        const coords = [x, y, z];
        const src = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) {
          src[perm[axis]] = flip[axis] ? dstDims[axis] - 1 - coords[axis] : coords[axis];
        }
        result[index3D(x, y, z, dstDims)] = data[index3D(src[0], src[1], src[2], dims)];
      }
    }
  }
  return { data: result, dims: dstDims };
}

export function inverseOrient(data, dims, perm, flip, originalDims, OutputCtor = data.constructor) {
  assertDims(dims);
  assertDims(originalDims);
  const result = new OutputCtor(voxelCount(originalDims));
  const [dx, dy, dz] = dims;
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        const coords = [x, y, z];
        const dst = [0, 0, 0];
        for (let axis = 0; axis < 3; axis++) {
          dst[perm[axis]] = flip[axis] ? dims[axis] - 1 - coords[axis] : coords[axis];
        }
        result[index3D(dst[0], dst[1], dst[2], originalDims)] = data[index3D(x, y, z, dims)];
      }
    }
  }
  return result;
}

export function computeResampledDims(dims, srcSpacing, targetSpacing) {
  assertDims(dims);
  return [
    Math.max(1, Math.round(dims[0] * srcSpacing[0] / targetSpacing[0])),
    Math.max(1, Math.round(dims[1] * srcSpacing[1] / targetSpacing[1])),
    Math.max(1, Math.round(dims[2] * srcSpacing[2] / targetSpacing[2]))
  ];
}

export function resampleVolume(data, dims, srcSpacing, targetSpacing) {
  const actualTarget = targetSpacing.map((value, index) => value < 0 ? srcSpacing[index] : value);
  const newDims = computeResampledDims(dims, srcSpacing, actualTarget);
  const [nx, ny, nz] = dims;
  const [nnx, nny, nnz] = newDims;
  const result = new Float32Array(nnx * nny * nnz);
  const scaleX = (nx - 1) / Math.max(nnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(nny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(nnz - 1, 1);

  for (let z = 0; z < nnz; z++) {
    const sourceZ = z * scaleZ;
    const z0 = Math.floor(sourceZ);
    const z1 = Math.min(z0 + 1, nz - 1);
    const wz = sourceZ - z0;
    for (let y = 0; y < nny; y++) {
      const sourceY = y * scaleY;
      const y0 = Math.floor(sourceY);
      const y1 = Math.min(y0 + 1, ny - 1);
      const wy = sourceY - y0;
      for (let x = 0; x < nnx; x++) {
        const sourceX = x * scaleX;
        const x0 = Math.floor(sourceX);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = sourceX - x0;
        const c000 = data[index3D(x0, y0, z0, dims)];
        const c100 = data[index3D(x1, y0, z0, dims)];
        const c010 = data[index3D(x0, y1, z0, dims)];
        const c110 = data[index3D(x1, y1, z0, dims)];
        const c001 = data[index3D(x0, y0, z1, dims)];
        const c101 = data[index3D(x1, y0, z1, dims)];
        const c011 = data[index3D(x0, y1, z1, dims)];
        const c111 = data[index3D(x1, y1, z1, dims)];
        const c00 = c000 * (1 - wx) + c100 * wx;
        const c10 = c010 * (1 - wx) + c110 * wx;
        const c01 = c001 * (1 - wx) + c101 * wx;
        const c11 = c011 * (1 - wx) + c111 * wx;
        const c0 = c00 * (1 - wy) + c10 * wy;
        const c1 = c01 * (1 - wy) + c11 * wy;
        result[index3D(x, y, z, newDims)] = c0 * (1 - wz) + c1 * wz;
      }
    }
  }

  return { data: result, dims: newDims, spacing: actualTarget };
}

export function resampleLabelsNearest(data, dims, targetDims, OutputCtor = Uint8Array) {
  const [nx, ny, nz] = dims;
  const [tx, ty, tz] = targetDims;
  const result = new OutputCtor(tx * ty * tz);
  for (let z = 0; z < tz; z++) {
    const sz = Math.min(Math.max(0, Math.floor((z + 0.5) * nz / tz)), nz - 1);
    for (let y = 0; y < ty; y++) {
      const sy = Math.min(Math.max(0, Math.floor((y + 0.5) * ny / ty)), ny - 1);
      for (let x = 0; x < tx; x++) {
        const sx = Math.min(Math.max(0, Math.floor((x + 0.5) * nx / tx)), nx - 1);
        result[index3D(x, y, z, targetDims)] = data[index3D(sx, sy, sz, dims)];
      }
    }
  }
  return result;
}

export function computeForegroundBBox(data, dims, margin = 0) {
  assertDims(dims);
  const [nx, ny, nz] = dims;
  let minX = nx;
  let maxX = -1;
  let minY = ny;
  let maxY = -1;
  let minZ = nz;
  let maxZ = -1;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (data[index3D(x, y, z, dims)] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  if (maxX < minX) return null;
  return {
    origin: [Math.max(0, minX - margin), Math.max(0, minY - margin), Math.max(0, minZ - margin)],
    end: [Math.min(nx, maxX + margin + 1), Math.min(ny, maxY + margin + 1), Math.min(nz, maxZ + margin + 1)]
  };
}

export function cropVolume(data, dims, bbox, OutputCtor = data.constructor) {
  const [nx, ny] = dims;
  const [ox, oy, oz] = bbox.origin;
  const [ex, ey, ez] = bbox.end;
  const croppedDims = [ex - ox, ey - oy, ez - oz];
  const [cx, cy, cz] = croppedDims;
  const result = new OutputCtor(cx * cy * cz);
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      const sourceOffset = (z + oz) * nx * ny + (y + oy) * nx + ox;
      const targetOffset = z * cx * cy + y * cx;
      result.set(data.subarray(sourceOffset, sourceOffset + cx), targetOffset);
    }
  }
  return { data: result, dims: croppedDims, origin: bbox.origin.slice() };
}

export function uncropVolume(croppedData, croppedDims, fullDims, origin, OutputCtor = croppedData.constructor) {
  const [nx, ny] = fullDims;
  const [cx, cy, cz] = croppedDims;
  const [ox, oy, oz] = origin;
  const result = new OutputCtor(voxelCount(fullDims));
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      const sourceOffset = z * cx * cy + y * cx;
      const targetOffset = (z + oz) * nx * ny + (y + oy) * nx + ox;
      result.set(croppedData.subarray(sourceOffset, sourceOffset + cx), targetOffset);
    }
  }
  return result;
}
