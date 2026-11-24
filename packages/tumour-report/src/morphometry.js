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
        for (let t = 0; t < tris.length; t += 3) {
          const e0 = tris[t];
          const e1 = tris[t + 1];
          const e2 = tris[t + 2];
          const m0 = MC_EDGE_MID_OFFSETS[e0];
          const m1 = MC_EDGE_MID_OFFSETS[e1];
          const m2 = MC_EDGE_MID_OFFSETS[e2];
          const p0 = applyAffinePoint(affine, vx0 + m0[0], vy0 + m0[1], vz0 + m0[2]);
          const p1 = applyAffinePoint(affine, vx0 + m1[0], vy0 + m1[1], vz0 + m1[2]);
          const p2 = applyAffinePoint(affine, vx0 + m2[0], vy0 + m2[1], vz0 + m2[2]);
          const e1x = p1[0] - p0[0];
          const e1y = p1[1] - p0[1];
          const e1z = p1[2] - p0[2];
          const e2x = p2[0] - p0[0];
          const e2y = p2[1] - p0[1];
          const e2z = p2[2] - p0[2];
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          areaMm2 += 0.5 * Math.hypot(nx, ny, nz);

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
  const voxelDiag = Math.hypot(su, vy);
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
  let anySliceMeasurable10x10 = false;

  for (const [sliceIndex, uvList] of bySlice.entries()) {
    if (uvList.length === 1) {
      const longMm = Math.max(su, vy);
      const shortMm = Math.min(su, vy);
      const prod = longMm * shortMm;
      const sliceMeasurable = longMm >= 10 && shortMm >= 10;
      if (sliceMeasurable) anySliceMeasurable10x10 = true;
      if (prod > best.crossProductMm2) {
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

    const isInsideUv = (u, v) => {
      const ru = Math.round(u) - minU;
      const rv = Math.round(v) - minV;
      return ru >= 0 && ru < gw && rv >= 0 && rv < gh && grid[ru + gw * rv] === 1;
    };

    const segmentInsideMask = (u0, v0, u1, v1) => {
      const steps = Math.max(1, Math.ceil(2 * Math.hypot(u1 - u0, v1 - v0)));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        if (!isInsideUv(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t)) return false;
      }
      return true;
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
    let pA = boundary[0];
    let pB = boundary[0];
    for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i];
      for (let j = i + 1; j < boundary.length; j++) {
        const b = boundary[j];
        const dx = b[2] - a[2];
        const dy = b[3] - a[3];
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestLongD2) continue;
        if (segmentInsideMask(a[0], a[1], b[0], b[1])) {
          bestLongD2 = d2;
          pA = a;
          pB = b;
        }
      }
    }

    const longDist = bestLongD2 > 0 ? Math.sqrt(bestLongD2) : 0;
    let ux = 1;
    let uy = 0;
    if (longDist > 1e-9) {
      ux = (pB[2] - pA[2]) / longDist;
      uy = (pB[3] - pA[3]) / longDist;
    }
    const px = -uy;
    const py = ux;

    // Step along strictly interior points of the supported major chord (excluding exact
    // endpoint voxels so thin hollow rings / L-corners cannot produce a fake crossing chord)
    // and measure the longest contiguous mask-supported perpendicular segment.
    const stepMm = Math.max(0.25, 0.5 * Math.min(su, vy));
    const [stepPu, stepPv] = physDeltaToUv(px * stepMm, py * stepMm);
    const chordSteps = Math.max(2, Math.ceil(longDist / stepMm));
    const maxPerpSteps = Math.ceil((Math.hypot(gw * su + gh * Math.abs(vx), gh * vy) + voxelDiag) / stepMm) + 2;

    let maxPerpCenterDist = 0;
    for (let s = 1; s < chordSteps; s++) {
      const t = s / chordSteps;
      const qu = pA[0] + (pB[0] - pA[0]) * t;
      const qv = pA[1] + (pB[1] - pA[1]) * t;
      const rqu = Math.round(qu);
      const rqv = Math.round(qv);
      if ((rqu === pA[0] && rqv === pA[1]) || (rqu === pB[0] && rqv === pB[1])) continue;
      if (!isInsideUv(qu, qv)) continue;
      let posSteps = 0;
      for (let k = 1; k <= maxPerpSteps; k++) {
        if (!isInsideUv(qu + k * stepPu, qv + k * stepPv)) break;
        posSteps = k;
      }
      let negSteps = 0;
      for (let k = 1; k <= maxPerpSteps; k++) {
        if (!isInsideUv(qu - k * stepPu, qv - k * stepPv)) break;
        negSteps = k;
      }
      const span = (posSteps + negSteps) * stepMm;
      if (span > maxPerpCenterDist) maxPerpCenterDist = span;
    }

    // Exact directional pixel width along unit vector (dx, dy) in physical coordinates.
    const dirPixelWidth = (dx, dy) => {
      const [du, dv] = physDeltaToUv(dx, dy);
      const scale = Math.max(Math.abs(du), Math.abs(dv));
      return scale > 1e-12 ? 1 / scale : Math.min(su, vy);
    };
    const rawLongMm = longDist + dirPixelWidth(ux, uy);
    const rawShortMm = Math.min(rawLongMm, maxPerpCenterDist + dirPixelWidth(px, py));
    const longMm = rawLongMm;
    const shortMm = rawShortMm;
    const prod = longMm * shortMm;
    const sliceMeasurable = longMm >= 10 && shortMm >= 10;
    if (sliceMeasurable) anySliceMeasurable10x10 = true;
    if (prod > best.crossProductMm2) {
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
    surfaceMm: [],
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

        const exposed = x === 0 || x === nx - 1
          || y === 0 || y === ny - 1
          || z === 0 || z === nz - 1
          || labels[idx - 1] !== id
          || labels[idx + 1] !== id
          || labels[idx - nx] !== id
          || labels[idx + nx] !== id
          || labels[idx - slice] !== id
          || labels[idx + slice] !== id;
        if (exposed) {
          b.surfaceMm.push(applyAffinePoint(affine, x, y, z));
        }
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
    const max3d = exactMaxDiameter3dMm(b.surfaceMm);
    const axial = computeAxialBidimensional(b.voxels, affine, axAxis);
    rawLesions.push({
      voxels: n,
      volumeMl: Number(volMl.toFixed(3)),
      meshVolumeMl: Number(mesh.meshVolumeMl.toFixed(3)),
      _volumeMlExact: volMl,
      _surfaceMm: b.surfaceMm,
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

  // Native multifocality: foci >= multifocalVolumeThresholdMl with exact minimum
  // surface distance >= multifocalDistanceThresholdMm (distinct from Raidionics MNI HD95).
  const qualifying = rawLesions.filter((l) => l._volumeMlExact >= multifocalVolumeThresholdMl);
  let multifocal = false;
  let maxMinDist = -1;
  if (qualifying.length > 1) {
    const main = qualifying[0];
    for (let i = 1; i < qualifying.length; i++) {
      const d = exactMinSurfaceDistanceMm(qualifying[i]._surfaceMm, main._surfaceMm);
      if (d > maxMinDist) maxMinDist = d;
    }
    if (maxMinDist >= multifocalDistanceThresholdMm) {
      multifocal = true;
    }
  }

  const lesions = rawLesions.map((l, idx) => {
    const { _volumeMlExact, _surfaceMm, ...pub } = l;
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
