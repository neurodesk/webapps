// Pure-JS volume operations used by the SynthStrip brain-extraction stage and
// (later) the lesion-segmentation pipeline.
//
// Ported from neurodesk/vesselboost-webapp@/web/js/inference-worker.js
// (lines 520..1010; SynthStrip-related helpers). Behavior preserved
// byte-for-byte; structure adjusted to ES module exports.
//
// Conventions:
//   - All volumes are flat typed arrays in Fortran order: index = x + y*nx + z*nx*ny
//     (matches NIfTI's voxel ordering).
//   - dims is [nx, ny, nz]; spacing is [sx, sy, sz] in mm.
//   - resampleVolume is linear-interp on Float32 intensity volumes.
//   - resampleLabelsNearest is nearest-neighbor on Uint8 (or any TypedArray
//     readable as integer); preserves discrete labels.

export function computeResampledDims(dims, srcSpacing, tgtSpacing) {
  return [
    Math.max(1, Math.round(dims[0] * srcSpacing[0] / tgtSpacing[0])),
    Math.max(1, Math.round(dims[1] * srcSpacing[1] / tgtSpacing[1])),
    Math.max(1, Math.round(dims[2] * srcSpacing[2] / tgtSpacing[2]))
  ];
}

export function resampleVolume(data, dims, srcSpacing, tgtSpacing) {
  const [nx, ny, nz] = dims;
  const newDims = computeResampledDims(dims, srcSpacing, tgtSpacing);
  const [nnx, nny, nnz] = newDims;
  const result = new Float32Array(nnx * nny * nnz);

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

        result[x + y * nnx + z * nnx * nny] = c0 * (1 - wz) + c1 * wz;
      }
    }
  }

  return { data: result, dims: newDims, spacing: tgtSpacing };
}

// scipy.ndimage.zoom(order=0)-equivalent: source = floor((dst + 0.5) * srcSize / dstSize)
export function resampleLabelsNearest(data, dims, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);
  for (let z = 0; z < tnz; z++) {
    const sz = Math.min(Math.max(0, Math.floor((z + 0.5) * nz / tnz)), nz - 1);
    for (let y = 0; y < tny; y++) {
      const sy = Math.min(Math.max(0, Math.floor((y + 0.5) * ny / tny)), ny - 1);
      for (let x = 0; x < tnx; x++) {
        const sx = Math.min(Math.max(0, Math.floor((x + 0.5) * nx / tnx)), nx - 1);
        result[x + y * tnx + z * tnx * tny] = data[sx + sy * nx + sz * nx * ny];
      }
    }
  }
  return result;
}

export function computeForegroundBBox(data, dims, margin = 0) {
  const [nx, ny, nz] = dims;
  let minX = nx, maxX = -1, minY = ny, maxY = -1, minZ = nz, maxZ = -1;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (data[x + y * nx + z * nx * ny] !== 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
  }

  if (maxX < minX) return null;

  return {
    origin: [
      Math.max(0, minX - margin),
      Math.max(0, minY - margin),
      Math.max(0, minZ - margin)
    ],
    end: [
      Math.min(nx, maxX + margin + 1),
      Math.min(ny, maxY + margin + 1),
      Math.min(nz, maxZ + margin + 1)
    ]
  };
}

export function cropVolume(data, dims, bbox) {
  const [nx, ny] = dims;
  const [ox, oy, oz] = bbox.origin;
  const [ex, ey, ez] = bbox.end;
  const cnx = ex - ox, cny = ey - oy, cnz = ez - oz;

  const result = new Float32Array(cnx * cny * cnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = (z + oz) * nx * ny + (y + oy) * nx + ox;
      const dstOff = z * cnx * cny + y * cnx;
      result.set(data.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }

  return { data: result, dims: [cnx, cny, cnz], origin: [ox, oy, oz] };
}

export function uncrop(croppedData, croppedDims, fullDims, origin) {
  const [nx, ny] = fullDims;
  const [cnx, cny, cnz] = croppedDims;
  const [ox, oy, oz] = origin;
  const result = new Uint8Array(fullDims[0] * fullDims[1] * fullDims[2]);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = z * cnx * cny + y * cnx;
      const dstOff = (z + oz) * nx * ny + (y + oy) * nx + ox;
      result.set(croppedData.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }
  return result;
}

// Two-pass union-find with 26-connectivity (the SynthStrip pipeline assumes
// 26-conn; full 3x3x3 backwards mask).
export function connectedComponents3D(binaryMask, dims) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const labels = new Int32Array(n);
  let nextLabel = 1;
  const parent = [0];
  const rank = [0];

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }

  const neighborOffsets = [];
  for (let dz = -1; dz <= 0; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && dy === 0 && dx >= 0) continue;
        neighborOffsets.push([dx, dy, dz]);
      }
    }
  }

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = z * ny * nx + y * nx + x;
        if (!binaryMask[idx]) continue;
        const neighborLabels = [];
        for (let i = 0; i < neighborOffsets.length; i++) {
          const nx2 = x + neighborOffsets[i][0];
          const ny2 = y + neighborOffsets[i][1];
          const nz2 = z + neighborOffsets[i][2];
          if (nx2 < 0 || nx2 >= nx || ny2 < 0 || ny2 >= ny || nz2 < 0 || nz2 >= nz) continue;
          const nIdx = nz2 * ny * nx + ny2 * nx + nx2;
          if (labels[nIdx] > 0) neighborLabels.push(labels[nIdx]);
        }
        if (neighborLabels.length === 0) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          rank.push(0);
          nextLabel++;
        } else {
          let minLabel = find(neighborLabels[0]);
          for (let i = 1; i < neighborLabels.length; i++) {
            const c = find(neighborLabels[i]);
            if (c < minLabel) minLabel = c;
          }
          labels[idx] = minLabel;
          for (let i = 0; i < neighborLabels.length; i++) union(minLabel, neighborLabels[i]);
        }
      }
    }
  }

  const canonicalMap = new Map();
  let finalLabel = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 0) continue;
    const root = find(labels[i]);
    if (!canonicalMap.has(root)) canonicalMap.set(root, ++finalLabel);
    labels[i] = canonicalMap.get(root);
  }
  return { labels, numComponents: finalLabel };
}

export function removeSmallComponents(binaryMask, dims, minSize) {
  const n = dims[0] * dims[1] * dims[2];
  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);
  if (numComponents === 0) return binaryMask;

  const sizes = new Int32Array(numComponents + 1);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) sizes[labels[i]]++;
  }

  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0 && sizes[labels[i]] >= minSize) result[i] = 1;
  }
  return result;
}

// FreeSurfer SynthStrip: connected_component_mask(k=1, fill=True). Keeps the
// largest CC, then fills any background CC that does not touch the volume
// border (these are interior holes).
export function keepLargestComponentAndFill(binaryMask, dims) {
  const n = dims[0] * dims[1] * dims[2];
  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);
  if (numComponents <= 1) return binaryMask;

  const sizes = new Int32Array(numComponents + 1);
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) sizes[labels[i]]++;
  }
  let largestLabel = 1;
  for (let l = 2; l <= numComponents; l++) {
    if (sizes[l] > sizes[largestLabel]) largestLabel = l;
  }

  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === largestLabel) result[i] = 1;
  }

  const inverted = new Uint8Array(n);
  for (let i = 0; i < n; i++) inverted[i] = result[i] ? 0 : 1;
  const bgCC = connectedComponents3D(inverted, dims);

  const [nx, ny, nz] = dims;
  const borderLabels = new Set();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1) {
          const idx = z * ny * nx + y * nx + x;
          if (bgCC.labels[idx] > 0) borderLabels.add(bgCC.labels[idx]);
        }
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (bgCC.labels[i] > 0 && !borderLabels.has(bgCC.labels[i])) result[i] = 1;
  }

  return result;
}

// Generic axis permutation + flip (forward + inverse).
function _orientGeneric(data, dims, perm, flip, ResultCtor) {
  const [dx, dy, dz] = dims;
  const newDims = [dims[perm[0]], dims[perm[1]], dims[perm[2]]];
  const [nx, ny, nz] = newDims;
  const result = new ResultCtor(nx * ny * nz);
  for (let oz = 0; oz < nz; oz++) {
    for (let oy = 0; oy < ny; oy++) {
      for (let ox = 0; ox < nx; ox++) {
        const dst = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (newDims[i] - 1 - dst[i]) : dst[i];
        }
        const srcIdx = src[0] + src[1] * dx + src[2] * dx * dy;
        const dstIdx = ox + oy * nx + oz * nx * ny;
        result[dstIdx] = data[srcIdx];
      }
    }
  }
  return { data: result, dims: newDims };
}

export function orientFloat32(data, dims, perm, flip) {
  return _orientGeneric(data, dims, perm, flip, Float32Array);
}

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

export function inverseOrientFloat32(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Float32Array(nx * ny * nz);
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
