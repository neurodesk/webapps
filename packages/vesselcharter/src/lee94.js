// Clean-room 3D medial-axis parallel thinning (Lee, Kashyap & Chu 1994,
// "Building Skeleton Models via 3-D Medial Surface/Axis Thinning Algorithms",
// CVGIP: Graphical Models and Image Processing 56(6):462-478).
//
// Uses the exact 128-entry 26-connected octant Euler-characteristic lookup
// table, 26-neighborhood simple-point connectivity check, 6 canonical
// directional border subiterations with sequential re-verification, and a
// sparse active-foreground frontier list.

/**
 * Builds the exact 128-entry Lee et al. (1994) octant Euler LUT (values are 8 * dChi_26).
 *
 * Each 7-bit mask encodes the 7 neighbors of center voxel p inside a 2x2x2 octant
 * (bit = 1 means foreground X, bit = 0 means background B):
 *   bit 0: (1,0,0) x      bit 1: (0,1,0) y      bit 2: (1,1,0) xy
 *   bit 3: (0,0,1) z      bit 4: (1,0,1) xz     bit 5: (0,1,1) yz
 *   bit 6: (1,1,1) xyz
 *
 * In the dual 6-connected cubical complex of background B, moving p from X to B
 * contributes 8 * dChi_26(X) = 1 - 2*bAxial + 4*bFaces - 8*bAll7 to this octant.
 */
function buildLee94EulerLut() {
  const lut = new Int8Array(128);
  for (let mask = 0; mask < 128; mask += 1) {
    const bx = (mask & 1) === 0 ? 1 : 0; // (1,0,0) in B
    const by = (mask & 2) === 0 ? 1 : 0; // (0,1,0) in B
    const bxy = (mask & 4) === 0 ? 1 : 0; // (1,1,0) in B
    const bz = (mask & 8) === 0 ? 1 : 0; // (0,0,1) in B
    const bxz = (mask & 16) === 0 ? 1 : 0; // (1,0,1) in B
    const byz = (mask & 32) === 0 ? 1 : 0; // (0,1,1) in B
    const bxyz = (mask & 64) === 0 ? 1 : 0; // (1,1,1) in B

    const bAxial = bx + by + bz;
    const bFaceXY = bx & by & bxy;
    const bFaceXZ = bx & bz & bxz;
    const bFaceYZ = by & bz & byz;
    const bFaces = bFaceXY + bFaceXZ + bFaceYZ;
    const bAll7 = bx & by & bz & bxy & bxz & byz & bxyz;

    // 8 * dChi_26(X) when p is removed from foreground X
    lut[mask] = 1 - 2 * bAxial + 4 * bFaces - 8 * bAll7;
  }
  return lut;
}

export const EULER_LUT = buildLee94EulerLut();

// 26-neighbor relative offsets (dx, dy, dz) in canonical 3x3x3 grid order, skipping (0,0,0).
// Grid index g = (dz + 1) * 9 + (dy + 1) * 3 + (dx + 1) in [0..26], center = 13.
// For each of the 8 octants (sx, sy, sz in {-1, +1}), list the 7 grid indices ordered
// [axial-x, axial-y, xy, axial-z, xz, yz, xyz].
const OCTANTS = [];
for (const sz of [-1, 1]) {
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const g = (dx, dy, dz) => (dz + 1) * 9 + (dy + 1) * 3 + (dx + 1);
      OCTANTS.push([
        g(sx, 0, 0),
        g(0, sy, 0),
        g(sx, sy, 0),
        g(0, 0, sz),
        g(sx, 0, sz),
        g(0, sy, sz),
        g(sx, sy, sz),
      ]);
    }
  }
}

// Precompute 26-adjacency list among the 27 cells of a 3x3x3 neighborhood (excluding center 13).
const LOCAL_26_ADJ = Array.from({ length: 27 }, () => []);
for (let a = 0; a < 27; a += 1) {
  if (a === 13) continue;
  const az = Math.floor(a / 9) - 1;
  const ay = Math.floor((a % 9) / 3) - 1;
  const ax = (a % 3) - 1;
  for (let b = 0; b < 27; b += 1) {
    if (b === 13 || b === a) continue;
    const bz = Math.floor(b / 9) - 1;
    const by = Math.floor((b % 9) / 3) - 1;
    const bx = (b % 3) - 1;
    if (Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1 && Math.abs(az - bz) <= 1) {
      LOCAL_26_ADJ[a].push(b);
    }
  }
}

/**
 * Checks whether the 3x3x3 neighborhood `n` (Uint8Array of length 27) is Euler-invariant
 * under removal of center voxel 13.
 */
export function isEulerInvariant(n) {
  let eulerSum = 0;
  for (let o = 0; o < 8; o += 1) {
    const oct = OCTANTS[o];
    const code =
      n[oct[0]] |
      (n[oct[1]] << 1) |
      (n[oct[2]] << 2) |
      (n[oct[3]] << 3) |
      (n[oct[4]] << 4) |
      (n[oct[5]] << 5) |
      (n[oct[6]] << 6);
    eulerSum += EULER_LUT[code];
  }
  return eulerSum === 0;
}

const bfsQueue = new Int8Array(27);
const bfsSeen = new Uint8Array(27);

/**
 * Checks whether all foreground voxels in the 26-neighborhood (excluding center 13)
 * form a single 26-connected component (simple point condition together with Euler invariance).
 */
export function isSimplePoint(n) {
  let fgCount = 0;
  let first = -1;
  for (let i = 0; i < 27; i += 1) {
    if (i === 13) continue;
    if (n[i]) {
      fgCount += 1;
      if (first < 0) first = i;
    }
  }
  if (fgCount <= 1) {
    return false;
  }
  bfsSeen.fill(0);
  bfsSeen[first] = 1;
  bfsQueue[0] = first;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const cur = bfsQueue[head];
    head += 1;
    const adj = LOCAL_26_ADJ[cur];
    for (let j = 0; j < adj.length; j += 1) {
      const nxt = adj[j];
      if (n[nxt] && !bfsSeen[nxt]) {
        bfsSeen[nxt] = 1;
        bfsQueue[tail] = nxt;
        tail += 1;
      }
    }
  }
  return tail === fgCount;
}

function readNeighborhood(vol, idx, nx, slice, out) {
  let k = 0;
  for (let dz = -1; dz <= 1; dz += 1) {
    const zOff = idx + dz * slice;
    for (let dy = -1; dy <= 1; dy += 1) {
      const yOff = zOff + dy * nx;
      out[k] = vol[yOff - 1];
      out[k + 1] = vol[yOff];
      out[k + 2] = vol[yOff + 1];
      k += 3;
    }
  }
}

/**
 * 3D medial-axis skeletonisation via Lee, Kashyap & Chu (1994).
 *
 * Input `mask` MUST have a 1-voxel zero border on all 6 faces (use cropMaskWithPad
 * first, or this function pads automatically when `padded` is false).
 *
 * Subiteration directional order defaults to symmetric opposite pairs
 * (y-1, y+1, x-1, x+1, z-1, z+1), or can be overridden via `borderOrder`.
 */
export function lee94Skeletonize(
  mask,
  dims,
  {
    padded = false,
    onProgress = null,
    borderOrder = null,
  } = {},
) {
  let work;
  let wx;
  let wy;
  let wz;
  if (padded) {
    [wx, wy, wz] = dims;
    work = new Uint8Array(mask);
  } else {
    const [nx, ny, nz] = dims;
    wx = nx + 2;
    wy = ny + 2;
    wz = nz + 2;
    work = new Uint8Array(wx * wy * wz);
    const srcSlice = nx * ny;
    const dstSlice = wx * wy;
    for (let z = 0; z < nz; z += 1) {
      for (let y = 0; y < ny; y += 1) {
        const srcRow = z * srcSlice + y * nx;
        const dstRow = (z + 1) * dstSlice + (y + 1) * wx + 1;
        work.set(mask.subarray(srcRow, srcRow + nx), dstRow);
      }
    }
  }

  const slice = wx * wy;
  const total = slice * wz;

  // Collect active foreground voxel indices (sparse frontier).
  let fgCount = 0;
  for (let i = 0; i < total; i += 1) {
    if (work[i]) {
      fgCount += 1;
    }
  }
  let active = new Int32Array(fgCount);
  let activeLen = 0;
  for (let i = 0; i < total; i += 1) {
    if (work[i]) {
      active[activeLen] = i;
      activeLen += 1;
    }
  }

  const candidates = new Int32Array(fgCount);
  const neigh = new Uint8Array(27);

  // Symmetric opposite-pair border directions (N, S, W, E, U, D).
  // In Step 2 sequential re-verification, protecting voxels with nFg === 2 when
  // the opposite axial neighbor is already background prevents 2-voxel-thick
  // vessels from zippering down to 0/2 voxels while keeping thick 3D vessels
  // completely symmetric and free of surface hairs.
  const defaultDirections = [-wx, wx, -1, 1, -slice, slice];
  const directions = borderOrder ?? defaultDirections;

  let pass = 0;
  let unchanged = false;
  while (!unchanged) {
    unchanged = true;
    pass += 1;
    let deletedInPass = 0;

    for (let d = 0; d < 6; d += 1) {
      const borderOffset = directions[d];
      let candLen = 0;

      // Step 1: Identify candidate border simple points in parallel.
      for (let i = 0; i < activeLen; i += 1) {
        const idx = active[i];
        if (!work[idx]) {
          continue;
        }
        // Must be a border point for the current direction.
        if (work[idx + borderOffset]) {
          continue;
        }
        readNeighborhood(work, idx, wx, slice, neigh);

        // Endpoint check: do not delete voxels with <= 1 foreground 26-neighbor.
        let nFg = 0;
        for (let k = 0; k < 27; k += 1) {
          if (k !== 13 && neigh[k]) {
            nFg += 1;
          }
        }
        if (nFg <= 1) {
          continue;
        }

        if (!isEulerInvariant(neigh)) {
          continue;
        }
        if (!isSimplePoint(neigh)) {
          continue;
        }
        candidates[candLen] = idx;
        candLen += 1;
      }

      // Step 2: Sequentially re-check each candidate before deleting so parallel
      // deletions never break 2-voxel-thick bridges or zipper 2-voxel-wide tubes.
      for (let i = 0; i < candLen; i += 1) {
        const idx = candidates[i];
        readNeighborhood(work, idx, wx, slice, neigh);
        let nFg = 0;
        for (let k = 0; k < 27; k += 1) {
          if (k !== 13 && neigh[k]) {
            nFg += 1;
          }
        }
        if (nFg <= 1 || (nFg === 2 && !work[idx - borderOffset])) {
          continue;
        }
        if (isEulerInvariant(neigh) && isSimplePoint(neigh)) {
          work[idx] = 0;
          unchanged = false;
          deletedInPass += 1;
        }
      }
    }

    // Compact active list in place after each full 6-subiteration pass.
    if (deletedInPass > 0) {
      let writePos = 0;
      for (let i = 0; i < activeLen; i += 1) {
        const idx = active[i];
        if (work[idx]) {
          active[writePos] = idx;
          writePos += 1;
        }
      }
      activeLen = writePos;
    }
    if (onProgress) {
      onProgress(pass, activeLen, deletedInPass);
    }
  }

  if (padded) {
    return { skeleton: work, passes: pass, skeletonVoxels: activeLen };
  }

  // Strip the temporary 1-voxel padding.
  const [nx, ny, nz] = dims;
  const out = new Uint8Array(nx * ny * nz);
  const dstSlice = nx * ny;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const srcRow = (z + 1) * slice + (y + 1) * wx + 1;
      const dstRow = z * dstSlice + y * nx;
      out.set(work.subarray(srcRow, srcRow + nx), dstRow);
    }
  }
  return { skeleton: out, passes: pass, skeletonVoxels: activeLen };
}
