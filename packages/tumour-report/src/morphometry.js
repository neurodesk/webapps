// Pure native-space tumour morphometry and per-lesion geometric measurements.
// Computes 26-connected components without hidden size cutoffs, physical volumes,
// centroids, IBSI-aligned surface area / sphericity, 3D maximum diameter,
// automated axial bidimensional diameters (longest x maximal perpendicular chord),
// and Raidionics multifocality status.
import { applyAffinePoint, labelComponents26, voxelSpacingMm, voxelVolumeMl } from './preprocess.js';

export const MULTIFOCAL_VOLUME_THRESHOLD_ML = 0.1;
export const MULTIFOCAL_DISTANCE_THRESHOLD_MM = 5.0;

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

// Compute exact 2D convex hull (Andrew's monotone chain) on [x, y] pairs in mm.
function convexHull2d(points) {
  if (points.length <= 2) return points;
  const sorted = [...points].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Compute automated 2D bidimensional measurement (longest in-plane diameter and
// longest perpendicular chord across the lesion mask on that slice) over all
// axial slices of one component.
function computeAxialBidimensional(compVoxels, dims, affine, axialAxis) {
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

  // In-plane basis vectors in physical mm (projected onto the slice plane)
  const eu = [affine[0][uAx], affine[1][uAx], affine[2][uAx]];
  const ev = [affine[0][vAx], affine[1][vAx], affine[2][vAx]];
  const su = Math.hypot(eu[0], eu[1], eu[2]);
  const dot = eu[0] * ev[0] + eu[1] * ev[1] + eu[2] * ev[2];
  // Orthonormal 2D coordinates on the slice plane: p = u * (su, 0) + v * (dot/su, sv_perp)
  const vx = su > 0 ? dot / su : 0;
  const vySq = Math.max(0, ev[0] * ev[0] + ev[1] * ev[1] + ev[2] * ev[2] - vx * vx);
  const vy = Math.sqrt(vySq);
  const voxelDiag = Math.hypot(su, vy);

  let best = {
    sliceIndex: null,
    axialAxis,
    longAxisMm: 0,
    shortAxisMm: 0,
    crossProductMm2: 0,
    measurable10x10mm: false,
  };

  for (const [sliceIndex, uvList] of bySlice.entries()) {
    if (uvList.length === 1) {
      const longMm = Math.max(su, vy);
      const shortMm = Math.min(su, vy);
      const prod = longMm * shortMm;
      if (prod > best.crossProductMm2) {
        best = {
          sliceIndex,
          axialAxis,
          longAxisMm: Number(longMm.toFixed(2)),
          shortAxisMm: Number(shortMm.toFixed(2)),
          crossProductMm2: Number(prod.toFixed(2)),
          measurable10x10mm: longMm >= 10 && shortMm >= 10,
        };
      }
      continue;
    }

    const pts2d = uvList.map(([u, v]) => [u * su + v * vx, v * vy]);
    const hull = convexHull2d(pts2d);
    let maxDistSq = -1;
    let pA = hull[0];
    let pB = hull[0];
    for (let i = 0; i < hull.length; i++) {
      for (let j = i + 1; j < hull.length; j++) {
        const dx = hull[j][0] - hull[i][0];
        const dy = hull[j][1] - hull[i][1];
        const d2 = dx * dx + dy * dy;
        if (d2 > maxDistSq) {
          maxDistSq = d2;
          pA = hull[i];
          pB = hull[j];
        }
      }
    }
    const longDist = Math.sqrt(Math.max(0, maxDistSq));
    // Include one voxel width along the major direction (center-to-center + 1 voxel spacing).
    let ux = 1;
    let uy = 0;
    if (longDist > 1e-9) {
      ux = (pB[0] - pA[0]) / longDist;
      uy = (pB[1] - pA[1]) / longDist;
    }
    const px = -uy;
    const py = ux;
    // Bin along the major axis at half-voxel resolution to measure the maximal
    // perpendicular chord inside the lesion (rather than bounding-box width).
    const step = Math.max(0.5, Math.min(su, vy));
    const bins = new Map();
    for (const [x, y] of pts2d) {
      const tLong = Math.round((x * ux + y * uy) / step);
      const tPerp = x * px + y * py;
      const prev = bins.get(tLong);
      if (!prev) {
        bins.set(tLong, [tPerp, tPerp]);
      } else {
        if (tPerp < prev[0]) prev[0] = tPerp;
        if (tPerp > prev[1]) prev[1] = tPerp;
      }
    }
    let maxPerp = 0;
    for (const [lo, hi] of bins.values()) {
      const span = hi - lo;
      if (span > maxPerp) maxPerp = span;
    }
    const perpStep = Math.abs(px) * su + Math.abs(py) * vy;
    const longStep = Math.abs(ux) * su + Math.abs(uy) * vy;
    const longMm = longDist + Math.min(longStep, voxelDiag);
    const shortMm = maxPerp + Math.min(perpStep, voxelDiag);
    const prod = longMm * shortMm;
    if (prod > best.crossProductMm2) {
      best = {
        sliceIndex,
        axialAxis,
        longAxisMm: Number(longMm.toFixed(2)),
        shortAxisMm: Number(shortMm.toFixed(2)),
        crossProductMm2: Number(prod.toFixed(2)),
        measurable10x10mm: longMm >= 10 && shortMm >= 10,
      };
    }
  }
  return best;
}

// Compute max 3D Euclidean diameter in mm over surface voxels.
// If a component has many surface voxels (> 1500), select extremal points across
// 26 uniform directions plus bounding-box extremes so complexity stays bounded.
function maxDiameter3dMm(surfacePtsMm) {
  if (surfacePtsMm.length <= 1) return 0;
  let pts = surfacePtsMm;
  if (pts.length > 1500) {
    const picked = new Map();
    const dirs = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          dirs.push([dx, dy, dz]);
        }
      }
    }
    for (const [dx, dy, dz] of dirs) {
      let bestIdx = 0;
      let bestDot = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dot = pts[i][0] * dx + pts[i][1] * dy + pts[i][2] * dz;
        if (dot > bestDot) {
          bestDot = dot;
          bestIdx = i;
        }
      }
      picked.set(bestIdx, pts[bestIdx]);
    }
    pts = Array.from(picked.values());
  }
  let maxD2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    for (let j = i + 1; j < pts.length; j++) {
      const b = pts[j];
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxD2) maxD2 = d2;
    }
  }
  return Math.sqrt(maxD2);
}

// Minimum Euclidean surface distance in mm between two sets of surface points.
function minSurfaceDistanceMm(ptsA, ptsB) {
  if (!ptsA.length || !ptsB.length) return -1;
  // Subsample uniformly only if huge to keep O(N*M) bounded while exact for typical foci.
  const strideA = Math.max(1, Math.floor(ptsA.length / 2000));
  const strideB = Math.max(1, Math.floor(ptsB.length / 2000));
  let bestD2 = Infinity;
  for (let i = 0; i < ptsA.length; i += strideA) {
    const a = ptsA[i];
    for (let j = 0; j < ptsB.length; j += strideB) {
      const b = ptsB[j];
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) bestD2 = d2;
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
  const spacing = voxelSpacingMm(affine);
  const faceX = spacing[1] * spacing[2];
  const faceY = spacing[0] * spacing[2];
  const faceZ = spacing[0] * spacing[1];
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
    surfaceAreaMm2: 0,
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

        let exposed = 0;
        let area = 0;
        if (x === 0 || labels[idx - 1] !== id) {
          exposed++;
          area += faceX;
        }
        if (x === nx - 1 || labels[idx + 1] !== id) {
          exposed++;
          area += faceX;
        }
        if (y === 0 || labels[idx - nx] !== id) {
          exposed++;
          area += faceY;
        }
        if (y === ny - 1 || labels[idx + nx] !== id) {
          exposed++;
          area += faceY;
        }
        if (z === 0 || labels[idx - slice] !== id) {
          exposed++;
          area += faceZ;
        }
        if (z === nz - 1 || labels[idx + slice] !== id) {
          exposed++;
          area += faceZ;
        }
        if (exposed > 0) {
          b.surfaceAreaMm2 += area;
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
    const equivDiam = Math.cbrt((6 * volMm3) / Math.PI);
    const max3d = maxDiameter3dMm(b.surfaceMm);
    const rawSphericity = b.surfaceAreaMm2 > 0
      ? (Math.cbrt(Math.PI) * Math.pow(6 * volMm3, 2 / 3)) / b.surfaceAreaMm2
      : 0;
    const sphericity = Math.min(1, Math.max(0, rawSphericity));
    const axial = computeAxialBidimensional(b.voxels, dims, affine, axAxis);
    rawLesions.push({
      voxels: n,
      volumeMl: Number(volMl.toFixed(3)),
      _volumeMlExact: volMl,
      _surfaceMm: b.surfaceMm,
      centroidVoxel: [Number(cx.toFixed(2)), Number(cy.toFixed(2)), Number(cz.toFixed(2))],
      centroidMm: [Number(cMm[0].toFixed(2)), Number(cMm[1].toFixed(2)), Number(cMm[2].toFixed(2))],
      bboxVoxel: [b.minX, b.minY, b.minZ, b.maxX + 1, b.maxY + 1, b.maxZ + 1],
      equivalentDiameterMm: Number(equivDiam.toFixed(2)),
      maxDiameter3dMm: Number(max3d.toFixed(2)),
      surfaceAreaMm2: Number(b.surfaceAreaMm2.toFixed(2)),
      sphericity: Number(sphericity.toFixed(4)),
      axialBidimensional: axial,
    });
  }

  rawLesions.sort((a, b) => b.voxels - a.voxels);

  // Multifocality: foci >= multifocalVolumeThresholdMl with min surface distance >= multifocalDistanceThresholdMm
  const qualifying = rawLesions.filter((l) => l._volumeMlExact >= multifocalVolumeThresholdMl);
  let multifocal = false;
  let maxMinDist = -1;
  if (qualifying.length > 1) {
    const main = qualifying[0];
    for (let i = 1; i < qualifying.length; i++) {
      const d = minSurfaceDistanceMm(qualifying[i]._surfaceMm, main._surfaceMm);
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
