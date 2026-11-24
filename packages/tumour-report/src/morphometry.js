// Pure native-space tumour morphometry and per-lesion geometric measurements.
// Computes 26-connected components without hidden size cutoffs, voxel and IBSI
// Lorensen Marching Cubes mesh volume/surface area/sphericity, exact 3D maximum
// Euclidean diameter, mask-supported automated axial bidimensional diameters
// (never bridging holes or concave gaps), and exact nearest-surface-distance
// native multifocality (distinct from Raidionics MNI 6-CC HD95 multifocality).
import { applyAffinePoint, labelComponents26, voxelVolumeMl } from './preprocess.js';
import MC_TRI_TABLE from './data/marching_cubes.json' with { type: 'json' };

export const MULTIFOCAL_VOLUME_THRESHOLD_ML = 0.1;
export const MULTIFOCAL_DISTANCE_THRESHOLD_MM = 5.0;

// 12 edges of the unit cube [0,1]^3 with corners indexed by x + 2*y + 4*z.
const CUBE_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

const MC_EDGE_MID_OFFSETS = [
  [0, 1], [1, 3], [2, 3], [0, 2],
  [4, 5], [5, 7], [6, 7], [4, 6],
  [0, 4], [1, 5], [3, 7], [2, 6],
].map(([a, b]) => [
  0.5 * (CUBE_OFFSETS[a][0] + CUBE_OFFSETS[b][0]),
  0.5 * (CUBE_OFFSETS[a][1] + CUBE_OFFSETS[b][1]),
  0.5 * (CUBE_OFFSETS[a][2] + CUBE_OFFSETS[b][2]),
]);

// Determine which image axis aligns most closely with superior-inferior (RAS Z)
// so axial slices follow anatomical axial orientation even on sagittal/coronal acquisitions.
export function axialAxisIndex(affine) {
  let best = 2;
  let bestCos = -1;
  for (let col = 0; col < 3; col++) {
    const norm = Math.hypot(affine[0][col], affine[1][col], affine[2][col]);
    const cosZ = norm > 0 ? Math.abs(affine[2][col]) / norm : 0;
    if (cosZ > bestCos) {
      bestCos = cosZ;
      best = col;
    }
  }
  return best;
}

// Physical-space IBSI surface mesh via Lorensen Marching Cubes (isovalue 0.5)
// on the component's 1-voxel zero-padded bounding box. Matches IBSI / scikit-image
// marching_cubes exactly and handles anisotropic, oblique, and sheared affines.
function computeIbsiMeshMetrics(voxels, bbox, affine, originMm) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = bbox;
  const gx = maxX - minX + 2;
  const gy = maxY - minY + 2;
  const gz = maxZ - minZ + 2;
  const grid = new Uint8Array(gx * gy * gz);
  const gSlice = gx * gy;
  for (let i = 0; i < voxels.length; i++) {
    const [x, y, z] = voxels[i];
    grid[(x - minX + 1) + gx * (y - minY + 1) + gSlice * (z - minZ + 1)] = 1;
  }

  let areaMm2 = 0;
  let signedVol6 = 0;
  const vertMap = new Map();
  const trianglesMm = [];

  for (let iz = 0; iz < gz - 1; iz++) {
    const zBase = iz * gSlice;
    const vz0 = minZ - 1 + iz;
    for (let iy = 0; iy < gy - 1; iy++) {
      const yBase = zBase + iy * gx;
      const vy0 = minY - 1 + iy;
      for (let ix = 0; ix < gx - 1; ix++) {
        const base = yBase + ix;
        const bits = (grid[base])
          | (grid[base + 1] << 1)
          | (grid[base + gx] << 2)
          | (grid[base + gx + 1] << 3)
          | (grid[base + gSlice] << 4)
          | (grid[base + gSlice + 1] << 5)
          | (grid[base + gSlice + gx] << 6)
          | (grid[base + gSlice + gx + 1] << 7);
        const tris = MC_TRI_TABLE[bits];
        if (!tris.length) continue;

        const vx0 = minX - 1 + ix;
        const edgeVertex = (e) => {
          const m = MC_EDGE_MID_OFFSETS[e];
          const hx = 2 * vx0 + Math.round(2 * m[0]);
          const hy = 2 * vy0 + Math.round(2 * m[1]);
          const hz = 2 * vz0 + Math.round(2 * m[2]);
          const key = `${hx},${hy},${hz}`;
          let pt = vertMap.get(key);
          if (!pt) {
            pt = applyAffinePoint(affine, vx0 + m[0], vy0 + m[1], vz0 + m[2]);
            vertMap.set(key, pt);
          }
          return pt;
        };

        for (let t = 0; t < tris.length; t += 3) {
          const p0 = edgeVertex(tris[t]);
          const p1 = edgeVertex(tris[t + 1]);
          const p2 = edgeVertex(tris[t + 2]);
          const e1x = p1[0] - p0[0];
          const e1y = p1[1] - p0[1];
          const e1z = p1[2] - p0[2];
          const e2x = p2[0] - p0[0];
          const e2y = p2[1] - p0[1];
          const e2z = p2[2] - p0[2];
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          const area2 = Math.hypot(nx, ny, nz);
          if (area2 > 1e-15) {
            areaMm2 += 0.5 * area2;
            trianglesMm.push([p0, p1, p2]);
          }

          const ax = p0[0] - originMm[0];
          const ay = p0[1] - originMm[1];
          const az = p0[2] - originMm[2];
          const bx = p1[0] - originMm[0];
          const by = p1[1] - originMm[1];
          const bz = p1[2] - originMm[2];
          const cx = p2[0] - originMm[0];
          const cy = p2[1] - originMm[1];
          const cz = p2[2] - originMm[2];
          signedVol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
        }
      }
    }
  }

  const meshVolumeMm3 = Math.abs(signedVol6) / 6;
  const rawSphericity = areaMm2 > 0
    ? (Math.cbrt(Math.PI) * Math.pow(6 * meshVolumeMm3, 2 / 3)) / areaMm2
    : 0;
  return {
    meshVolumeMm3,
    meshVolumeMl: meshVolumeMm3 * 1e-3,
    surfaceAreaMm2: areaMm2,
    sphericity: Math.min(1, Math.max(0, rawSphericity)),
    verticesMm: Array.from(vertMap.values()),
    trianglesMm,
  };
}

// Compute mask-supported 2D bidimensional measurement (longest in-mask diameter
// and longest mask-supported perpendicular chord intersecting it) over all axial slices.
// Never bridges across hollow cavities or concave indentations.
function computeAxialBidimensional(compVoxels, affine, axialAxis) {
  const inPlaneAxes = [0, 1, 2].filter((a) => a !== axialAxis);
  const [uAx, vAx] = inPlaneAxes;
  const bySlice = new Map();
  for (const [x, y, z] of compVoxels) {
    const coord = [x, y, z];
    const s = coord[axialAxis];
    let list = bySlice.get(s);
    if (!list) {
      list = [];
      bySlice.set(s, list);
    }
    list.push([coord[uAx], coord[vAx]]);
  }

  // Physical in-plane basis vectors (handling oblique and sheared affines cleanly).
  const eu = [affine[0][uAx], affine[1][uAx], affine[2][uAx]];
  const ev = [affine[0][vAx], affine[1][vAx], affine[2][vAx]];
  const su = Math.hypot(eu[0], eu[1], eu[2]);
  const dot = eu[0] * ev[0] + eu[1] * ev[1] + eu[2] * ev[2];
  const vx = su > 0 ? dot / su : 0;
  const vy = Math.sqrt(Math.max(0, ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2] - vx * vx));
  // Inverse 2x2 mapping physical (px, py) -> voxel offsets (du, dv):
  // px = du * su + dv * vx, py = dv * vy
  const invSu = su > 1e-12 ? 1 / su : 0;
  const invVy = vy > 1e-12 ? 1 / vy : 0;
  const physDeltaToUv = (dpx, dpy) => {
    const dv = dpy * invVy;
    const du = (dpx - dv * vx) * invSu;
    return [du, dv];
  };

  let best = {
    sliceIndex: null,
    axialAxis,
    longAxisMm: 0,
    shortAxisMm: 0,
    crossProductMm2: 0,
    measurable10x10mm: false,
  };
  let bestProd = -1;
  let anySliceMeasurable10x10 = false;

  for (const [sliceIndex, uvList] of bySlice.entries()) {
    if (uvList.length === 1) {
      const longMm = Math.max(su, vy);
      const shortMm = Math.min(su, vy);
      const prod = longMm * shortMm;
      const sliceMeasurable = longMm + 1e-6 >= 10 && shortMm + 1e-6 >= 10;
      if (sliceMeasurable) anySliceMeasurable10x10 = true;
      if (prod > bestProd) {
        bestProd = prod;
        best = {
          sliceIndex,
          axialAxis,
          longAxisMm: Number(longMm.toFixed(2)),
          shortAxisMm: Number(shortMm.toFixed(2)),
          crossProductMm2: Number(prod.toFixed(2)),
          measurable10x10mm: sliceMeasurable,
        };
      }
      continue;
    }

    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const [u, v] of uvList) {
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const gw = maxU - minU + 1;
    const gh = maxV - minV + 1;
    const grid = new Uint8Array(gw * gh);
    for (const [u, v] of uvList) {
      grid[(u - minU) + gw * (v - minV)] = 1;
    }

    const isCellOccupied = (cu, cv) => {
      const lu = cu - minU;
      const lv = cv - minV;
      return lu >= 0 && lu < gw && lv >= 0 && lv < gh && grid[lu + gw * lv] === 1;
    };

    // Exact 2D Amanatides-Woo DDA ray traversal over unit voxel cells [u-0.5, u+0.5] x [v-0.5, v+0.5].
    // Returns true iff every cell intersected by the open segment (u0, v0) -> (u1, v1) is occupied.
    const segmentInsideMask = (u0, v0, u1, v1) => {
      const du = u1 - u0;
      const dv = v1 - v0;
      let cu = Math.floor(u0 + 0.5);
      let cv = Math.floor(v0 + 0.5);
      const endU = Math.floor(u1 + 0.5);
      const endV = Math.floor(v1 + 0.5);
      if (!isCellOccupied(cu, cv) || !isCellOccupied(endU, endV)) return false;
      const stepU = du > 0 ? 1 : du < 0 ? -1 : 0;
      const stepV = dv > 0 ? 1 : dv < 0 ? -1 : 0;
      const nextEdgeU = () => (stepU !== 0 ? ((cu + (stepU > 0 ? 0.5 : -0.5) - u0) / du) : Infinity);
      const nextEdgeV = () => (stepV !== 0 ? ((cv + (stepV > 0 ? 0.5 : -0.5) - v0) / dv) : Infinity);
      let tMaxU = nextEdgeU();
      let tMaxV = nextEdgeV();
      const eps = 1e-12;
      const maxIter = gw + gh + 4;
      for (let iter = 0; iter < maxIter; iter++) {
        if (cu === endU && cv === endV) return true;
        if (Math.abs(tMaxU - tMaxV) <= eps) {
          // Ray passes through a shared grid corner: check diagonal target cell (and require at least one flanking cell so a diagonal never bridges across two empty corner-touching background cells).
          const nextU = cu + stepU;
          const nextV = cv + stepV;
          if (!isCellOccupied(nextU, nextV)) return false;
          if (!isCellOccupied(nextU, cv) && !isCellOccupied(cu, nextV)) return false;
          cu = nextU;
          cv = nextV;
          tMaxU = nextEdgeU();
          tMaxV = nextEdgeV();
        } else if (tMaxU < tMaxV) {
          cu += stepU;
          tMaxU = nextEdgeU();
          if (!isCellOccupied(cu, cv)) return false;
        } else {
          cv += stepV;
          tMaxV = nextEdgeV();
          if (!isCellOccupied(cu, cv)) return false;
        }
      }
      return false;
    };

    // Exact DDA ray distance in physical mm from (qu, qv) along unit physical direction (dx, dy)
    // to the exact boundary where the ray first exits the occupied voxel union.
    // Symmetric at cell boundaries/corners: nudges by eps in the ray's forward direction
    // (and checks adjacent occupied cells if travelling parallel to a shared grid edge)
    // so mirrored/rotated masks yield identical measurements.
    const rayExitDistanceMm = (qu, qv, dx, dy) => {
      const [du, dv] = physDeltaToUv(dx, dy);
      const eps = 1e-9;
      const stepU = du > 1e-12 ? 1 : du < -1e-12 ? -1 : 0;
      const stepV = dv > 1e-12 ? 1 : dv < -1e-12 ? -1 : 0;
      const onBoundaryU = Math.abs((qu + 0.5) - Math.round(qu + 0.5)) <= eps;
      const onBoundaryV = Math.abs((qv + 0.5) - Math.round(qv + 0.5)) <= eps;
      const candU = onBoundaryU
        ? (stepU > 0 ? [Math.round(qu + 0.5)] : stepU < 0 ? [Math.round(qu + 0.5) - 1] : [Math.round(qu + 0.5) - 1, Math.round(qu + 0.5)])
        : [Math.floor(qu + 0.5)];
      const candV = onBoundaryV
        ? (stepV > 0 ? [Math.round(qv + 0.5)] : stepV < 0 ? [Math.round(qv + 0.5) - 1] : [Math.round(qv + 0.5) - 1, Math.round(qv + 0.5)])
        : [Math.floor(qv + 0.5)];

      // If starting at a shared corner moving diagonally, require at least one flanking cell.
      if (onBoundaryU && onBoundaryV && stepU !== 0 && stepV !== 0) {
        const nu = candU[0];
        const nv = candV[0];
        const pu = nu - stepU;
        const pv = nv - stepV;
        if (!isCellOccupied(nu, nv) || (!isCellOccupied(nu, pv) && !isCellOccupied(pu, nv))) {
          return 0;
        }
      }

      // When moving strictly along a shared grid edge, the ray stays inside the closed mask
      // as long as either adjacent row/column cell is occupied.
      const maxIter = gw + gh + 4;
      if (stepV === 0 && candV.length > 1) {
        let cu = candU[0];
        if (!candV.some((v) => isCellOccupied(cu, v))) return 0;
        for (let iter = 0; iter < maxIter; iter++) {
          const tExit = (cu + (stepU > 0 ? 0.5 : -0.5) - qu) / du;
          cu += stepU;
          if (!candV.some((v) => isCellOccupied(cu, v))) return Math.max(0, tExit);
        }
        return 0;
      }
      if (stepU === 0 && candU.length > 1) {
        let cv = candV[0];
        if (!candU.some((u) => isCellOccupied(u, cv))) return 0;
        for (let iter = 0; iter < maxIter; iter++) {
          const tExit = (cv + (stepV > 0 ? 0.5 : -0.5) - qv) / dv;
          cv += stepV;
          if (!candU.some((u) => isCellOccupied(u, cv))) return Math.max(0, tExit);
        }
        return 0;
      }

      let cu = candU[0];
      let cv = candV[0];
      if (!isCellOccupied(cu, cv)) return 0;
      const nextEdgeU = () => (stepU !== 0 ? ((cu + (stepU > 0 ? 0.5 : -0.5) - qu) / du) : Infinity);
      const nextEdgeV = () => (stepV !== 0 ? ((cv + (stepV > 0 ? 0.5 : -0.5) - qv) / dv) : Infinity);
      let tMaxU = nextEdgeU();
      let tMaxV = nextEdgeV();
      for (let iter = 0; iter < maxIter; iter++) {
        if (Math.abs(tMaxU - tMaxV) <= 1e-12) {
          const tExit = tMaxU;
          const nextU = cu + stepU;
          const nextV = cv + stepV;
          if (!isCellOccupied(nextU, nextV) || (!isCellOccupied(nextU, cv) && !isCellOccupied(cu, nextV))) {
            return Math.max(0, tExit);
          }
          cu = nextU;
          cv = nextV;
          tMaxU = nextEdgeU();
          tMaxV = nextEdgeV();
        } else if (tMaxU < tMaxV) {
          const tExit = tMaxU;
          cu += stepU;
          tMaxU = nextEdgeU();
          if (!isCellOccupied(cu, cv)) return Math.max(0, tExit);
        } else {
          const tExit = tMaxV;
          cv += stepV;
          tMaxV = nextEdgeV();
          if (!isCellOccupied(cu, cv)) return Math.max(0, tExit);
        }
      }
      return 0;
    };

    // Collect 4-connected boundary pixels on this slice (endpoints of any maximal chord lie on the boundary).
    const boundary = [];
    for (const [u, v] of uvList) {
      const lu = u - minU;
      const lv = v - minV;
      const exposed = lu === 0 || lu === gw - 1 || lv === 0 || lv === gh - 1
        || !grid[(lu - 1) + gw * lv]
        || !grid[(lu + 1) + gw * lv]
        || !grid[lu + gw * (lv - 1)]
        || !grid[lu + gw * (lv + 1)];
      if (exposed) {
        boundary.push([u, v, u * su + v * vx, v * vy]);
      }
    }

    let bestLongD2 = -1;
    let bestPairs = [[boundary[0], boundary[0], 0]];
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i];
      for (let j = i + 1; j < boundary.length; j++) {
        const b = boundary[j];
        const dx = b[2] - a[2];
        const dy = b[3] - a[3];
        const d2 = dx * dx + dy * dy;
        const collectTol = 2e-9 * Math.max(1, bestLongD2);
        if (d2 + collectTol < bestLongD2) continue;
        if (!segmentInsideMask(a[0], a[1], b[0], b[1])) continue;
        if (d2 > bestLongD2 + collectTol) {
          bestLongD2 = d2;
          bestPairs = [[a, b, d2]];
        } else {
          if (d2 > bestLongD2) bestLongD2 = d2;
          bestPairs.push([a, b, d2]);
        }
      }
    }
    const finalTol = 1e-9 * Math.max(1, bestLongD2);
    const tiedPairs = bestLongD2 > 0
      ? bestPairs.filter((entry) => bestLongD2 - entry[2] <= finalTol)
      : bestPairs;

    // Evaluate every tied maximal supported chord (filtered against the final true maximum)
    // so selection is strictly independent of voxel traversal order, mirroring, and rotation.
    const measured = [];
    let maxRawLong = -1;
    for (const [pA, pB] of tiedPairs) {
      const longDist = Math.hypot(pB[2] - pA[2], pB[3] - pA[3]);
      let ux = 1;
      let uy = 0;
      if (longDist > 1e-9) {
        ux = (pB[2] - pA[2]) / longDist;
        uy = (pB[3] - pA[3]) / longDist;
      }
      const px = -uy;
      const py = ux;

      // Exact boundary-to-boundary length of the supported major axis starting from exact
      // occupied endpoint centres pA and pB (never rounds a shared midpoint corner asymmetrically).
      const rawLongMm = longDist
        + rayExitDistanceMm(pB[0], pB[1], ux, uy)
        + rayExitDistanceMm(pA[0], pA[1], -ux, -uy);

      // Step along strictly interior points of the supported major chord (excluding closed
      // endpoint cells so thin hollow rings / L-corners cannot produce a fake crossing chord)
      // and measure exact boundary-to-boundary DDA perpendicular length.
      const chordSteps = Math.max(2, Math.ceil(2 * Math.hypot(pB[0] - pA[0], pB[1] - pA[1])));
      let maxPerpMm = 0;
      for (let s = 1; s < chordSteps; s++) {
        const t = s / chordSteps;
        const qu = pA[0] + (pB[0] - pA[0]) * t;
        const qv = pA[1] + (pB[1] - pA[1]) * t;
        const inEndpointA = Math.abs(qu - pA[0]) <= 0.5 + 1e-9 && Math.abs(qv - pA[1]) <= 0.5 + 1e-9;
        const inEndpointB = Math.abs(qu - pB[0]) <= 0.5 + 1e-9 && Math.abs(qv - pB[1]) <= 0.5 + 1e-9;
        if (inEndpointA || inEndpointB) continue;
        const span = rayExitDistanceMm(qu, qv, px, py) + rayExitDistanceMm(qu, qv, -px, -py);
        if (span > maxPerpMm) maxPerpMm = span;
      }
      if (maxPerpMm === 0) {
        const midU = 0.5 * (pA[0] + pB[0]);
        const midV = 0.5 * (pA[1] + pB[1]);
        maxPerpMm = rayExitDistanceMm(midU, midV, px, py) + rayExitDistanceMm(midU, midV, -px, -py);
      }

      if (rawLongMm > maxRawLong) maxRawLong = rawLongMm;
      measured.push({ rawLongMm, maxPerpMm });
    }

    const rawLongTol = 1e-9 * Math.max(1, maxRawLong);
    let chosen = measured[0];
    for (let i = 0; i < measured.length; i++) {
      const m = measured[i];
      if (maxRawLong - m.rawLongMm > rawLongTol) continue;
      if (maxRawLong - chosen.rawLongMm > rawLongTol || m.maxPerpMm > chosen.maxPerpMm) {
        chosen = m;
      }
    }
    const longMm = Math.max(chosen.rawLongMm, chosen.maxPerpMm);
    const shortMm = Math.min(chosen.rawLongMm, chosen.maxPerpMm);
    const prod = longMm * shortMm;
    const sliceMeasurable = longMm + 1e-6 >= 10 && shortMm + 1e-6 >= 10;
    if (sliceMeasurable) anySliceMeasurable10x10 = true;
    if (prod > bestProd) {
      bestProd = prod;
      best = {
        sliceIndex,
        axialAxis,
        longAxisMm: Number(longMm.toFixed(2)),
        shortAxisMm: Number(shortMm.toFixed(2)),
        crossProductMm2: Number(prod.toFixed(2)),
        measurable10x10mm: sliceMeasurable,
      };
    }
  }
  best.measurable10x10mm = anySliceMeasurable10x10;
  return best;
}

function buildSpatialCells(pts, cellSize) {
  const map = new Map();
  const inv = 1 / cellSize;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const cx = Math.floor(p[0] * inv);
    const cy = Math.floor(p[1] * inv);
    const cz = Math.floor(p[2] * inv);
    const key = `${cx},${cy},${cz}`;
    let cell = map.get(key);
    if (!cell) {
      cell = { pts: [], sx: 0, sy: 0, sz: 0 };
      map.set(key, cell);
    }
    cell.pts.push(p);
    cell.sx += p[0];
    cell.sy += p[1];
    cell.sz += p[2];
  }
  const cells = [];
  for (const cell of map.values()) {
    const n = cell.pts.length;
    const mx = cell.sx / n;
    const my = cell.sy / n;
    const mz = cell.sz / n;
    let r2 = 0;
    for (let i = 0; i < n; i++) {
      const p = cell.pts[i];
      const d2 = (p[0] - mx) ** 2 + (p[1] - my) ** 2 + (p[2] - mz) ** 2;
      if (d2 > r2) r2 = d2;
    }
    cells.push({ pts: cell.pts, cx: mx, cy: my, cz: mz, r: Math.sqrt(r2) });
  }
  return cells;
}

// Exact maximum 3D Euclidean diameter over all surface points using spatial cell
// branch-and-bound (guaranteed identical to brute-force O(N^2) while fast on large lesions).
export function exactMaxDiameter3dMm(surfacePtsMm) {
  const n = surfacePtsMm.length;
  if (n <= 1) return 0;
  if (n <= 2000) {
    let maxD2 = 0;
    for (let i = 0; i < n; i++) {
      const a = surfacePtsMm[i];
      for (let j = i + 1; j < n; j++) {
        const b = surfacePtsMm[j];
        const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
        if (d2 > maxD2) maxD2 = d2;
      }
    }
    return Math.sqrt(maxD2);
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = surfacePtsMm[i];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
  const cells = buildSpatialCells(surfacePtsMm, Math.max(2, span / 8));
  const pairs = [];
  for (let i = 0; i < cells.length; i++) {
    const ci = cells[i];
    for (let j = i; j < cells.length; j++) {
      const cj = cells[j];
      const dist = Math.hypot(ci.cx - cj.cx, ci.cy - cj.cy, ci.cz - cj.cz);
      pairs.push({ i, j, upper: dist + ci.r + cj.r });
    }
  }
  pairs.sort((a, b) => b.upper - a.upper);
  let bestD2 = 0;
  for (let p = 0; p < pairs.length; p++) {
    const { i, j, upper } = pairs[p];
    if (upper * upper <= bestD2) break;
    const ptsA = cells[i].pts;
    const ptsB = cells[j].pts;
    if (i === j) {
      for (let aIdx = 0; aIdx < ptsA.length; aIdx++) {
        const a = ptsA[aIdx];
        for (let bIdx = aIdx + 1; bIdx < ptsA.length; bIdx++) {
          const b = ptsA[bIdx];
          const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
          if (d2 > bestD2) bestD2 = d2;
        }
      }
    } else {
      for (let aIdx = 0; aIdx < ptsA.length; aIdx++) {
        const a = ptsA[aIdx];
        for (let bIdx = 0; bIdx < ptsB.length; bIdx++) {
          const b = ptsB[bIdx];
          const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
          if (d2 > bestD2) bestD2 = d2;
        }
      }
    }
  }
  return Math.sqrt(bestD2);
}

// Exact squared distance from point P to triangle (A, B, C) in 3D (Ericson, RTCD §5.1.5).
function pointTriangleDistSq(p, a, b, c) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = p[0] - b[0];
  const bpy = p[1] - b[1];
  const bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = a[0] + v * abx - p[0];
    const dy = a[1] + v * aby - p[1];
    const dz = a[2] + v * abz - p[2];
    return dx * dx + dy * dy + dz * dz;
  }

  const cpx = p[0] - c[0];
  const cpy = p[1] - c[1];
  const cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = a[0] + w * acx - p[0];
    const dy = a[1] + w * acy - p[1];
    const dz = a[2] + w * acz - p[2];
    return dx * dx + dy * dy + dz * dz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const dx = b[0] + w * (c[0] - b[0]) - p[0];
    const dy = b[1] + w * (c[1] - b[1]) - p[1];
    const dz = b[2] + w * (c[2] - b[2]) - p[2];
    return dx * dx + dy * dy + dz * dz;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const dx = a[0] + abx * v + acx * w - p[0];
  const dy = a[1] + aby * v + acy * w - p[1];
  const dz = a[2] + abz * v + acz * w - p[2];
  return dx * dx + dy * dy + dz * dz;
}

// Exact squared distance between 3D line segments (p1, q1) and (p2, q2) (Ericson, RTCD §5.1.9).
function segmentSegmentDistSq(p1, q1, p2, q2) {
  const d1x = q1[0] - p1[0];
  const d1y = q1[1] - p1[1];
  const d1z = q1[2] - p1[2];
  const d2x = q2[0] - p2[0];
  const d2y = q2[1] - p2[1];
  const d2z = q2[2] - p2[2];
  const rx = p1[0] - p2[0];
  const ry = p1[1] - p2[1];
  const rz = p1[2] - p2[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  let s = 0;
  let t = 0;
  if (a <= 1e-15 && e <= 1e-15) {
    return rx * rx + ry * ry + rz * rz;
  }
  if (a <= 1e-15) {
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-15) {
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const dx = p1[0] + d1x * s - (p2[0] + d2x * t);
  const dy = p1[1] + d1y * s - (p2[1] + d2y * t);
  const dz = p1[2] + d1z * s - (p2[2] + d2z * t);
  return dx * dx + dy * dy + dz * dz;
}

function triangleTriangleDistSq(t1, t2) {
  let best = pointTriangleDistSq(t1[0], t2[0], t2[1], t2[2]);
  let d = pointTriangleDistSq(t1[1], t2[0], t2[1], t2[2]);
  if (d < best) best = d;
  d = pointTriangleDistSq(t1[2], t2[0], t2[1], t2[2]);
  if (d < best) best = d;
  d = pointTriangleDistSq(t2[0], t1[0], t1[1], t1[2]);
  if (d < best) best = d;
  d = pointTriangleDistSq(t2[1], t1[0], t1[1], t1[2]);
  if (d < best) best = d;
  d = pointTriangleDistSq(t2[2], t1[0], t1[1], t1[2]);
  if (d < best) best = d;
  for (let i = 0; i < 3; i++) {
    const a1 = t1[i];
    const b1 = t1[(i + 1) % 3];
    for (let j = 0; j < 3; j++) {
      d = segmentSegmentDistSq(a1, b1, t2[j], t2[(j + 1) % 3]);
      if (d < best) best = d;
    }
  }
  return best;
}

function buildTriangleCells(tris, cellSize) {
  const map = new Map();
  const inv = 1 / cellSize;
  for (let i = 0; i < tris.length; i++) {
    const tri = tris[i];
    const mx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
    const my = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    const mz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
    const tr = Math.sqrt(Math.max(
      (tri[0][0] - mx) ** 2 + (tri[0][1] - my) ** 2 + (tri[0][2] - mz) ** 2,
      (tri[1][0] - mx) ** 2 + (tri[1][1] - my) ** 2 + (tri[1][2] - mz) ** 2,
      (tri[2][0] - mx) ** 2 + (tri[2][1] - my) ** 2 + (tri[2][2] - mz) ** 2,
    ));
    const key = `${Math.floor(mx * inv)},${Math.floor(my * inv)},${Math.floor(mz * inv)}`;
    let cell = map.get(key);
    if (!cell) {
      cell = { tris: [], sx: 0, sy: 0, sz: 0 };
      map.set(key, cell);
    }
    cell.tris.push({ tri, cx: mx, cy: my, cz: mz, r: tr });
    cell.sx += mx;
    cell.sy += my;
    cell.sz += mz;
  }
  const cells = [];
  for (const cell of map.values()) {
    const n = cell.tris.length;
    const cx = cell.sx / n;
    const cy = cell.sy / n;
    const cz = cell.sz / n;
    let r2 = 0;
    for (let i = 0; i < n; i++) {
      const tri = cell.tris[i].tri;
      for (let k = 0; k < 3; k++) {
        const p = tri[k];
        const d2 = (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2;
        if (d2 > r2) r2 = d2;
      }
    }
    cells.push({ tris: cell.tris, cx, cy, cz, r: Math.sqrt(r2) });
  }
  return cells;
}

// Exact minimum Euclidean distance between two closed triangulated surfaces
// (handles interior triangle-face and edge-edge closest points, not just vertices).
export function exactMinMeshDistanceMm(trisA, trisB) {
  if (!trisA.length || !trisB.length) return -1;
  const cellsA = buildTriangleCells(trisA, 4);
  const cellsB = buildTriangleCells(trisB, 4);
  const pairs = [];
  for (let i = 0; i < cellsA.length; i++) {
    const ci = cellsA[i];
    for (let j = 0; j < cellsB.length; j++) {
      const cj = cellsB[j];
      const dist = Math.hypot(ci.cx - cj.cx, ci.cy - cj.cy, ci.cz - cj.cz);
      const lower = Math.max(0, dist - ci.r - cj.r);
      pairs.push({ i, j, lower });
    }
  }
  pairs.sort((a, b) => a.lower - b.lower);
  let bestD2 = Infinity;
  let bestD = Infinity;
  for (let p = 0; p < pairs.length; p++) {
    const { i, j, lower } = pairs[p];
    if (lower >= bestD) break;
    const aList = cellsA[i].tris;
    const bList = cellsB[j].tris;
    for (let ai = 0; ai < aList.length; ai++) {
      const a = aList[ai];
      for (let bi = 0; bi < bList.length; bi++) {
        const b = bList[bi];
        const lb = Math.hypot(a.cx - b.cx, a.cy - b.cy, a.cz - b.cz) - a.r - b.r;
        if (lb >= bestD) continue;
        const d2 = triangleTriangleDistSq(a.tri, b.tri);
        if (d2 < bestD2) {
          bestD2 = d2;
          bestD = Math.sqrt(d2);
        }
      }
    }
  }
  return bestD;
}

// Exact minimum Euclidean surface distance between two point sets via spatial
// cell branch-and-bound (never subsamples; exact at any multifocality boundary).
export function exactMinSurfaceDistanceMm(ptsA, ptsB) {
  if (!ptsA.length || !ptsB.length) return -1;
  if (ptsA.length * ptsB.length <= 2_000_000) {
    let bestD2 = Infinity;
    for (let i = 0; i < ptsA.length; i++) {
      const a = ptsA[i];
      for (let j = 0; j < ptsB.length; j++) {
        const b = ptsB[j];
        const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
        if (d2 < bestD2) bestD2 = d2;
      }
    }
    return Math.sqrt(bestD2);
  }
  const cellsA = buildSpatialCells(ptsA, 8);
  const cellsB = buildSpatialCells(ptsB, 8);
  const pairs = [];
  for (let i = 0; i < cellsA.length; i++) {
    const ci = cellsA[i];
    for (let j = 0; j < cellsB.length; j++) {
      const cj = cellsB[j];
      const dist = Math.hypot(ci.cx - cj.cx, ci.cy - cj.cy, ci.cz - cj.cz);
      const lower = Math.max(0, dist - ci.r - cj.r);
      pairs.push({ i, j, lower });
    }
  }
  pairs.sort((a, b) => a.lower - b.lower);
  let bestD2 = Infinity;
  for (let p = 0; p < pairs.length; p++) {
    const { i, j, lower } = pairs[p];
    if (lower * lower >= bestD2) break;
    const aList = cellsA[i].pts;
    const bList = cellsB[j].pts;
    for (let aIdx = 0; aIdx < aList.length; aIdx++) {
      const a = aList[aIdx];
      for (let bIdx = 0; bIdx < bList.length; bIdx++) {
        const b = bList[bIdx];
        const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
        if (d2 < bestD2) bestD2 = d2;
      }
    }
  }
  return Math.sqrt(bestD2);
}

export function computeNativeMorphometry({
  tumourMask,
  brainMask = null,
  dims,
  affine,
  multifocalVolumeThresholdMl = MULTIFOCAL_VOLUME_THRESHOLD_ML,
  multifocalDistanceThresholdMm = MULTIFOCAL_DISTANCE_THRESHOLD_MM,
}) {
  const [nx, ny, nz] = dims;
  const voxMl = voxelVolumeMl(affine);
  const voxMm3 = voxMl * 1000;
  const axAxis = axialAxisIndex(affine);

  let brainVoxels = null;
  let brainVolumeMl = null;
  if (brainMask) {
    let bv = 0;
    for (let i = 0; i < brainMask.length; i++) {
      if (brainMask[i]) bv++;
    }
    brainVoxels = bv;
    brainVolumeMl = Number((bv * voxMl).toFixed(2));
  }

  const { labels, count } = labelComponents26(tumourMask, dims);
  if (count === 0) {
    return {
      status: 'no_lesions_segmented',
      lesionCount: 0,
      totalVoxels: 0,
      totalVolumeMl: 0,
      brainVoxels,
      brainVolumeMl,
      brainPercentage: brainVolumeMl ? 0 : null,
      multifocal: false,
      multifocalCount: 0,
      maxMinFociDistanceMm: -1,
      largestDiameters: null,
      lesions: [],
    };
  }

  const buckets = Array.from({ length: count + 1 }, () => ({
    voxels: [],
    sumX: 0,
    sumY: 0,
    sumZ: 0,
    minX: nx,
    minY: ny,
    minZ: nz,
    maxX: -1,
    maxY: -1,
    maxZ: -1,
  }));

  const slice = nx * ny;
  for (let z = 0; z < nz; z++) {
    const zOff = z * slice;
    for (let y = 0; y < ny; y++) {
      const yOff = zOff + y * nx;
      for (let x = 0; x < nx; x++) {
        const idx = yOff + x;
        const id = labels[idx];
        if (!id) continue;
        const b = buckets[id];
        b.voxels.push([x, y, z]);
        b.sumX += x;
        b.sumY += y;
        b.sumZ += z;
        if (x < b.minX) b.minX = x;
        if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        if (y > b.maxY) b.maxY = y;
        if (z < b.minZ) b.minZ = z;
        if (z > b.maxZ) b.maxZ = z;
      }
    }
  }

  const rawLesions = [];
  let totalVoxels = 0;
  for (let id = 1; id <= count; id++) {
    const b = buckets[id];
    const n = b.voxels.length;
    totalVoxels += n;
    const volMl = n * voxMl;
    const volMm3 = n * voxMm3;
    const cx = b.sumX / n;
    const cy = b.sumY / n;
    const cz = b.sumZ / n;
    const cMm = applyAffinePoint(affine, cx, cy, cz);
    const bboxVoxel = [b.minX, b.minY, b.minZ, b.maxX + 1, b.maxY + 1, b.maxZ + 1];
    const mesh = computeIbsiMeshMetrics(b.voxels, bboxVoxel, affine, cMm);
    const equivDiam = Math.cbrt((6 * volMm3) / Math.PI);
    const max3d = exactMaxDiameter3dMm(mesh.verticesMm);
    const axial = computeAxialBidimensional(b.voxels, affine, axAxis);
    rawLesions.push({
      voxels: n,
      volumeMl: Number(volMl.toFixed(3)),
      meshVolumeMl: Number(mesh.meshVolumeMl.toFixed(3)),
      _volumeMlExact: volMl,
      _trianglesMm: mesh.trianglesMm,
      centroidVoxel: [Number(cx.toFixed(2)), Number(cy.toFixed(2)), Number(cz.toFixed(2))],
      centroidMm: [Number(cMm[0].toFixed(2)), Number(cMm[1].toFixed(2)), Number(cMm[2].toFixed(2))],
      bboxVoxel,
      equivalentDiameterMm: Number(equivDiam.toFixed(2)),
      maxDiameter3dMm: Number(max3d.toFixed(2)),
      surfaceAreaMm2: Number(mesh.surfaceAreaMm2.toFixed(2)),
      sphericity: Number(mesh.sphericity.toFixed(4)),
      axialBidimensional: axial,
    });
  }

  rawLesions.sort((a, b) => b.voxels - a.voxels);

  // Native multifocality: foci >= multifocalVolumeThresholdMl with exact triangle-to-triangle
  // minimum surface distance >= multifocalDistanceThresholdMm (distinct from Raidionics MNI HD95).
  const qualifying = rawLesions.filter((l) => l._volumeMlExact >= multifocalVolumeThresholdMl);
  let multifocal = false;
  let maxMinDist = -1;
  if (qualifying.length > 1) {
    const main = qualifying[0];
    for (let i = 1; i < qualifying.length; i++) {
      const d = exactMinMeshDistanceMm(qualifying[i]._trianglesMm, main._trianglesMm);
      if (d > maxMinDist) maxMinDist = d;
    }
    if (maxMinDist + 1e-6 >= multifocalDistanceThresholdMm) {
      multifocal = true;
    }
  }

  const lesions = rawLesions.map((l, idx) => {
    const { _volumeMlExact, _trianglesMm, ...pub } = l;
    return { id: idx + 1, ...pub };
  });

  const totalVolumeMl = Number((totalVoxels * voxMl).toFixed(3));
  const largest = lesions[0];
  return {
    status: 'lesions_segmented',
    lesionCount: lesions.length,
    totalVoxels,
    totalVolumeMl,
    brainVoxels,
    brainVolumeMl,
    brainPercentage: brainVolumeMl ? Number(((totalVolumeMl / brainVolumeMl) * 100).toFixed(2)) : null,
    multifocal,
    multifocalCount: qualifying.length,
    maxMinFociDistanceMm: maxMinDist >= 0 ? Number(maxMinDist.toFixed(2)) : -1,
    largestDiameters: {
      equivalentDiameterMm: largest.equivalentDiameterMm,
      maxDiameter3dMm: largest.maxDiameter3dMm,
      axialLongMm: largest.axialBidimensional.longAxisMm,
      axialShortMm: largest.axialBidimensional.shortAxisMm,
      axialCrossProductMm2: largest.axialBidimensional.crossProductMm2,
    },
    lesions,
  };
}
