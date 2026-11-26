// Exact anisotropic 3D Euclidean Distance Transform (Felzenszwalb & Huttenlocher 2012)
// and subvoxel-centered point-to-voxel-box inscribed sphere radius estimation.

const INF = 1e30;

/**
 * 1D squared Euclidean distance transform with physical step `step` (s^2 scaling).
 * Computes min_q (f[q] + (step * (p - q))^2) for p in [0, n - 1] in O(n) time.
 */
function edt1d(f, out, n, step, v, z) {
  const s2 = step * step;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q += 1) {
    const fq = f[q];
    if (fq >= INF) {
      continue;
    }
    let s;
    while (true) {
      const r = v[k];
      const fr = f[r];
      if (fr >= INF) {
        if (k === 0) {
          v[0] = q;
          z[0] = -INF;
          z[1] = INF;
          break;
        }
        k -= 1;
        continue;
      }
      s = ((fq + s2 * q * q) - (fr + s2 * r * r)) / (2 * s2 * (q - r));
      if (s <= z[k]) {
        k -= 1;
      } else {
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
        break;
      }
    }
  }

  if (f[v[0]] >= INF) {
    for (let p = 0; p < n; p += 1) {
      out[p] = INF;
    }
    return;
  }

  k = 0;
  for (let p = 0; p < n; p += 1) {
    while (z[k + 1] < p) {
      k += 1;
    }
    const r = v[k];
    const diff = (p - r) * step;
    out[p] = diff * diff + f[r];
  }
}

/**
 * Exact anisotropic 3D Euclidean Distance Transform (center-to-center, matching
 * scipy.ndimage.distance_transform_edt(mask, sampling=spacing)).
 *
 * Returns Float64Array of physical distances in mm (0 for background voxels).
 */
export function euclideanDistanceTransform3D(mask, dims, spacing = [1, 1, 1], { float32 = false } = {}) {
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;
  const slice = nx * ny;
  const total = slice * nz;
  const distSq = float32 ? new Float32Array(total) : new Float64Array(total);

  const maxDim = Math.max(nx, ny, nz);
  const f = new Float64Array(maxDim);
  const out = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  // Pass 1: along X
  for (let iz = 0; iz < nz; iz += 1) {
    const zBase = iz * slice;
    for (let iy = 0; iy < ny; iy += 1) {
      const row = zBase + iy * nx;
      let anyFg = false;
      for (let ix = 0; ix < nx; ix += 1) {
        if (mask[row + ix]) {
          anyFg = true;
          f[ix] = INF;
        } else {
          f[ix] = 0;
        }
      }
      if (!anyFg) {
        continue;
      }
      edt1d(f, out, nx, sx, v, z);
      for (let ix = 0; ix < nx; ix += 1) {
        distSq[row + ix] = out[ix];
      }
    }
  }

  // Pass 2: along Y
  for (let iz = 0; iz < nz; iz += 1) {
    const zBase = iz * slice;
    for (let ix = 0; ix < nx; ix += 1) {
      let anyNonZero = false;
      for (let iy = 0; iy < ny; iy += 1) {
        const val = distSq[zBase + iy * nx + ix];
        f[iy] = val;
        if (val > 0) {
          anyNonZero = true;
        }
      }
      if (!anyNonZero) {
        continue;
      }
      edt1d(f, out, ny, sy, v, z);
      for (let iy = 0; iy < ny; iy += 1) {
        distSq[zBase + iy * nx + ix] = out[iy];
      }
    }
  }

  // Pass 3: along Z
  for (let iy = 0; iy < ny; iy += 1) {
    const yBase = iy * nx;
    for (let ix = 0; ix < nx; ix += 1) {
      const col = yBase + ix;
      let anyNonZero = false;
      for (let iz = 0; iz < nz; iz += 1) {
        const val = distSq[iz * slice + col];
        f[iz] = val;
        if (val > 0) {
          anyNonZero = true;
        }
      }
      if (!anyNonZero) {
        continue;
      }
      edt1d(f, out, nz, sz, v, z);
      for (let iz = 0; iz < nz; iz += 1) {
        const val = out[iz];
        distSq[iz * slice + col] = val > 0 && val < INF ? Math.sqrt(val) : 0;
      }
    }
  }

  return distSq;
}

// 27 candidate subvoxel offsets in {-0.5, 0, +0.5}^3 (origin first).
const SUBVOXEL_OFFSETS = [];
SUBVOXEL_OFFSETS.push([0, 0, 0]);
for (const dz of [-0.5, 0, 0.5]) {
  for (const dy of [-0.5, 0, 0.5]) {
    for (const dx of [-0.5, 0, 0.5]) {
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        SUBVOXEL_OFFSETS.push([dx, dy, dz]);
      }
    }
  }
}

/**
 * Minimum physical clearance from a continuous voxel-space point (cx, cy, cz)
 * to background voxels (using voxel-inscribed-ellipsoid clearance) and to the
 * 6 FOV boundary slabs, returning `{ radiusMm, cropCensored }`.
 */
export function pointToBackgroundBoxDistance(
  mask,
  dims,
  spacing,
  cx,
  cy,
  cz,
  originalDims = null,
  cropOffset = [0, 0, 0],
) {
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;
  const slice = nx * ny;
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  const iz = Math.round(cz);

  if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) {
    return { radiusMm: 0, cropCensored: true };
  }

  // Distance to the 6 original field-of-view boundary planes.
  let fovBound = INF;
  if (originalDims) {
    const [onx, ony, onz] = originalDims;
    const [ox, oy, oz] = cropOffset;
    const gx = cx + ox;
    const gy = cy + oy;
    const gz = cz + oz;
    const dFov = Math.min(
      (gx + 0.5) * sx,
      (onx - 0.5 - gx) * sx,
      (gy + 0.5) * sy,
      (ony - 0.5 - gy) * sy,
      (gz + 0.5) * sz,
      (onz - 0.5 - gz) * sz,
    );
    fovBound = Math.max(0, dFov);
  }

  // Tight initial upper bound by shooting 6 axis-aligned rays to the first background voxel.
  let bestDist = fovBound;
  let cropCensored = originalDims !== null;

  const castAxis = (dx, dy, dz, stepSize) => {
    let x = ix;
    let y = iy;
    let z = iz;
    while (true) {
      x += dx;
      y += dy;
      z += dz;
      if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) {
        const edge =
          dx !== 0
            ? Math.max(Math.abs(cx - x) - 0.5, 0) * sx
            : dy !== 0
              ? Math.max(Math.abs(cy - y) - 0.5, 0) * sy
              : Math.max(Math.abs(cz - z) - 0.5, 0) * sz;
        if (edge < bestDist) {
          bestDist = edge;
          cropCensored = false;
        }
        return;
      }
      if (!mask[z * slice + y * nx + x]) {
        const dist =
          dx !== 0
            ? Math.max(Math.abs(cx - x) - 0.5, 0) * sx
            : dy !== 0
              ? Math.max(Math.abs(cy - y) - 0.5, 0) * sy
              : Math.max(Math.abs(cz - z) - 0.5, 0) * sz;
        if (dist < bestDist) {
          bestDist = dist;
          cropCensored = false;
        }
        return;
      }
      const lower =
        dx !== 0
          ? Math.max(Math.abs(cx - x) - 0.5, 0) * stepSize
          : dy !== 0
            ? Math.max(Math.abs(cy - y) - 0.5, 0) * stepSize
            : Math.max(Math.abs(cz - z) - 0.5, 0) * stepSize;
      if (lower >= bestDist) {
        return;
      }
    }
  };

  castAxis(-1, 0, 0, sx);
  castAxis(1, 0, 0, sx);
  castAxis(0, -1, 0, sy);
  castAxis(0, 1, 0, sy);
  castAxis(0, 0, -1, sz);
  castAxis(0, 0, 1, sz);

  let bestSq = bestDist * bestDist;
  const rx = Math.ceil(bestDist / sx + 0.5);
  const ry = Math.ceil(bestDist / sy + 0.5);
  const rz = Math.ceil(bestDist / sz + 0.5);

  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(nx - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(ny - 1, Math.ceil(cy + ry));
  const z0 = Math.max(0, Math.floor(cz - rz));
  const z1 = Math.min(nz - 1, Math.ceil(cz + rz));

  for (let qz = z0; qz <= z1; qz += 1) {
    const vz = cz - qz;
    const dz = vz * sz;
    const dzMin = Math.max(Math.abs(vz) - 0.5, 0) * sz;
    if (dzMin * dzMin >= bestSq) {
      continue;
    }
    const zBase = qz * slice;
    for (let qy = y0; qy <= y1; qy += 1) {
      const vy = cy - qy;
      const dy = vy * sy;
      const dyMin = Math.max(Math.abs(vy) - 0.5, 0) * sy;
      if (dzMin * dzMin + dyMin * dyMin >= bestSq) {
        continue;
      }
      const row = zBase + qy * nx;
      for (let qx = x0; qx <= x1; qx += 1) {
        if (mask[row + qx]) {
          continue;
        }
        const vx = cx - qx;
        const dx = vx * sx;
        const voxNorm = Math.hypot(vx, vy, vz);
        if (voxNorm <= 0.5) {
          bestSq = 0;
          cropCensored = false;
          continue;
        }
        const physDist = Math.hypot(dx, dy, dz);
        // Distance to the inscribed ellipsoid of background voxel q along ray c -> q:
        // exact 0.5*s boundary along axes (no 2x inflation on 1-vox tubes) without
        // the diagonal -sqrt(3)*0.5*s corner pinch of sharp voxel cubes on round vessels.
        const r = physDist * (1 - 0.5 / voxNorm);
        const rSq = r * r;
        if (rSq < bestSq) {
          bestSq = rSq;
          cropCensored = false;
        }
      }
    }
  }

  const radiusMm = Math.sqrt(bestSq);
  // If the FOV boundary ties or strictly limits the inscribed sphere, mark cropCensored.
  const isFovBinding = originalDims !== null && fovBound <= radiusMm + 1e-9;
  return {
    radiusMm: Math.min(radiusMm, fovBound),
    cropCensored: cropCensored || isFovBinding,
  };
}

/**
 * Estimates the maximal inscribed sphere radius near centerline voxel (ix, iy, iz)
 * by evaluating subvoxel offsets projected onto the plane normal to the local tangent
 * and clamped inside the centerline voxel box [-0.5, 0.5]^3.
 *
 * Recovers exact boundary width on both 1-voxel tubes (0.5 * s radius) and
 * 2-voxel even-width tubes (1.0 * s radius when centered on the shared face).
 */
export function subvoxelInscribedRadius(
  mask,
  dims,
  spacing,
  ix,
  iy,
  iz,
  tangent = null,
  originalDims = null,
  cropOffset = [0, 0, 0],
) {
  const [sx, sy, sz] = spacing;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  let hasTangent = false;
  if (tangent) {
    const norm = Math.hypot(tangent[0], tangent[1], tangent[2]);
    if (norm > 1e-9) {
      tx = tangent[0] / norm;
      ty = tangent[1] / norm;
      tz = tangent[2] / norm;
      hasTangent = true;
    }
  }

  let bestRadius = -1;
  let bestCensored = false;
  let bestCenter = [ix, iy, iz];

  for (let i = 0; i < SUBVOXEL_OFFSETS.length; i += 1) {
    let [dx, dy, dz] = SUBVOXEL_OFFSETS[i];
    if (hasTangent && (dx !== 0 || dy !== 0 || dz !== 0)) {
      // Project physical offset onto plane normal to tangent, then map back to voxel units.
      const px = dx * sx;
      const py = dy * sy;
      const pz = dz * sz;
      const proj = px * tx + py * ty + pz * tz;
      dx = (px - proj * tx) / sx;
      dy = (py - proj * ty) / sy;
      dz = (pz - proj * tz) / sz;
      const maxAbs = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
      if (maxAbs < 1e-6) {
        continue;
      }
      if (maxAbs > 0.5) {
        const s = 0.5 / maxAbs;
        dx *= s;
        dy *= s;
        dz *= s;
      }
    }
    const cx = ix + dx;
    const cy = iy + dy;
    const cz = iz + dz;
    const res = pointToBackgroundBoxDistance(
      mask,
      dims,
      spacing,
      cx,
      cy,
      cz,
      originalDims,
      cropOffset,
    );
    if (res.radiusMm > bestRadius + 1e-12) {
      bestRadius = res.radiusMm;
      bestCensored = res.cropCensored;
      bestCenter = [cx, cy, cz];
    }
  }

  return {
    radiusMm: Math.max(0, bestRadius),
    diameterMm: Math.max(0, 2 * bestRadius),
    cropCensored: bestCensored,
    centerVox: bestCenter,
  };
}
