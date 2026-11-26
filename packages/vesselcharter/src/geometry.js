// Physical centerline smoothing (pinned Taubin lambda/mu with foreground clamp),
// tortuosity (Distance Metric & Bullitt SOAM), subvoxel inscribed-sphere diameters,
// sparse foreground Voronoi partition (segment volumes & D_eq), pairwise junction
// angles, diameter-stratified bins, and optional brain/ROI mask density.
import { subvoxelInscribedRadius } from './edt.js';
import { OFFSETS_26 } from './graph.js';
import { voxelToWorld } from './volume.js';

const TAUBIN_LAMBDA = 0.5;
const TAUBIN_MU = -0.53;

export const DIAMETER_BINS = [
  { label: '<0.5 mm', minMm: 0, maxMm: 0.5 },
  { label: '0.5-1.0 mm', minMm: 0.5, maxMm: 1.0 },
  { label: '1.0-1.5 mm', minMm: 1.0, maxMm: 1.5 },
  { label: '1.5-2.0 mm', minMm: 1.5, maxMm: 2.0 },
  { label: '2.0-3.0 mm', minMm: 2.0, maxMm: 3.0 },
  { label: '>=3.0 mm', minMm: 3.0, maxMm: Infinity },
];

function dist3(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function isInsideForeground(mask, dims, vx, vy, vz) {
  const ix = Math.round(vx);
  const iy = Math.round(vy);
  const iz = Math.round(vz);
  if (ix < 0 || ix >= dims[0] || iy < 0 || iy >= dims[1] || iz < 0 || iz >= dims[2]) {
    return false;
  }
  return mask[iz * dims[0] * dims[1] + iy * dims[0] + ix] !== 0;
}

/**
 * Chord-length-weighted Taubin (lambda/mu) smoothing in cropped voxel coordinates
 * with physical spacing weights. Endpoints (and junction centroids) stay pinned;
 * closed loops wrap periodically. Each interior vertex is clamped to +-0.5 voxel
 * from its raw coordinate and guaranteed to remain inside the foreground mask.
 */
export function smoothCenterlineVox(
  pointsVox,
  spacing,
  mask,
  dims,
  { iterations = 6, isClosedLoop = false } = {},
) {
  const n = pointsVox.length;
  if (iterations <= 0 || n <= 2) {
    return pointsVox.map((p) => [p[0], p[1], p[2]]);
  }

  const orig = pointsVox.map((p) => [p[0], p[1], p[2]]);
  let cur = pointsVox.map((p) => [p[0], p[1], p[2]]);
  const m = isClosedLoop ? n - 1 : n;

  const taubinPass = (pts, factor) => {
    const next = pts.map((p) => [p[0], p[1], p[2]]);
    const startIdx = isClosedLoop ? 0 : 1;
    const endIdx = isClosedLoop ? m : n - 1;

    for (let i = startIdx; i < endIdx; i += 1) {
      const iPrev = isClosedLoop ? (i - 1 + m) % m : i - 1;
      const iNext = isClosedLoop ? (i + 1) % m : i + 1;
      const p = pts[i];
      const a = pts[iPrev];
      const b = pts[iNext];

      const da = Math.hypot(
        (p[0] - a[0]) * spacing[0],
        (p[1] - a[1]) * spacing[1],
        (p[2] - a[2]) * spacing[2],
      );
      const db = Math.hypot(
        (b[0] - p[0]) * spacing[0],
        (b[1] - p[1]) * spacing[1],
        (b[2] - p[2]) * spacing[2],
      );
      const wA = da > 1e-9 ? 1 / da : 1;
      const wB = db > 1e-9 ? 1 / db : 1;
      const wSum = wA + wB;

      const lx = (wA * a[0] + wB * b[0]) / wSum - p[0];
      const ly = (wA * a[1] + wB * b[1]) / wSum - p[1];
      const lz = (wA * a[2] + wB * b[2]) / wSum - p[2];

      const nx = clamp(p[0] + factor * lx, orig[i][0] - 0.5, orig[i][0] + 0.5);
      const ny = clamp(p[1] + factor * ly, orig[i][1] - 0.5, orig[i][1] + 0.5);
      const nz = clamp(p[2] + factor * lz, orig[i][2] - 0.5, orig[i][2] + 0.5);

      if (isInsideForeground(mask, dims, nx, ny, nz)) {
        next[i] = [nx, ny, nz];
      }
    }
    if (isClosedLoop && m > 0) {
      next[m] = [next[0][0], next[0][1], next[0][2]];
    }
    return next;
  };

  for (let it = 0; it < iterations; it += 1) {
    cur = taubinPass(cur, TAUBIN_LAMBDA);
    cur = taubinPass(cur, TAUBIN_MU);
  }
  return cur;
}

/**
 * Resamples a 3D world-space polyline uniformly by arc length at step `stepMm`.
 */
function resamplePolylineUniform(worldPts, stepMm) {
  const n = worldPts.length;
  if (n < 2) {
    return worldPts;
  }
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    cum[i] = cum[i - 1] + dist3(worldPts[i - 1], worldPts[i]);
  }
  const totalLen = cum[n - 1];
  if (totalLen <= 1e-9 || stepMm <= 0) {
    return worldPts;
  }
  const numSteps = Math.max(1, Math.round(totalLen / stepMm));
  const actualStep = totalLen / numSteps;
  const out = [worldPts[0]];
  let seg = 0;

  for (let k = 1; k < numSteps; k += 1) {
    const target = k * actualStep;
    while (seg < n - 2 && cum[seg + 1] < target) {
      seg += 1;
    }
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-12 ? (target - cum[seg]) / span : 0;
    const p0 = worldPts[seg];
    const p1 = worldPts[seg + 1];
    out.push([
      p0[0] + t * (p1[0] - p0[0]),
      p0[1] + t * (p1[1] - p0[1]),
      p0[2] + t * (p1[2] - p0[2]),
    ]);
  }
  out.push(worldPts[n - 1]);
  return out;
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * Sum of Angles Metric (Bullitt et al. 2003, IEEE TMI) in rad/mm on a uniformly
 * resampled 3D centerline. Returns null when fewer than 4 resampled points exist.
 */
export function computeSoamRadPerMm(worldPts, totalLengthMm, resampleStepMm) {
  if (totalLengthMm <= 1e-9) {
    return null;
  }
  const pts = resamplePolylineUniform(worldPts, resampleStepMm);
  if (pts.length < 4) {
    return null;
  }
  let totalAngle = 0;
  for (let k = 1; k <= pts.length - 3; k += 1) {
    const t1 = sub3(pts[k], pts[k - 1]);
    const t2 = sub3(pts[k + 1], pts[k]);
    const t3 = sub3(pts[k + 2], pts[k + 1]);
    const n1 = norm3(t1);
    const n2 = norm3(t2);
    const n3 = norm3(t3);
    if (n1 <= 1e-9 || n2 <= 1e-9 || n3 <= 1e-9) {
      continue;
    }
    const ipCos = clamp(dot3(t1, t2) / (n1 * n2), -1, 1);
    const ip = Math.acos(ipCos);

    const b1 = cross3(t1, t2);
    const b2 = cross3(t2, t3);
    const nb1 = norm3(b1);
    const nb2 = norm3(b2);
    let tp = 0;
    if (nb1 > 1e-9 && nb2 > 1e-9) {
      const tpCos = clamp(dot3(b1, b2) / (nb1 * nb2), -1, 1);
      tp = Math.acos(tpCos);
      if (tp > Math.PI / 2) {
        tp = Math.PI - tp;
      }
    }
    totalAngle += Math.hypot(ip, tp);
  }
  return totalAngle / totalLengthMm;
}

/**
 * Computes weighted quantile from parallel (values, weights) arrays.
 */
function weightedQuantile(values, weights, q) {
  if (values.length === 0) {
    return null;
  }
  const order = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  let totalW = 0;
  for (let i = 0; i < order.length; i += 1) {
    totalW += order[i].w;
  }
  if (totalW <= 0) {
    return order[Math.floor(order.length * q)].v;
  }
  const target = q * totalW;
  let acc = 0;
  for (let i = 0; i < order.length; i += 1) {
    acc += order[i].w;
    if (acc >= target) {
      return order[i].v;
    }
  }
  return order[order.length - 1].v;
}

/**
 * Min-heap for sparse foreground anisotropic Voronoi Dijkstra propagation.
 */
class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, val) {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) {
        break;
      }
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop() {
    const keys = this.keys;
    const vals = this.vals;
    const topKey = keys[0];
    const topVal = vals[0];
    const lastKey = keys.pop();
    const lastVal = vals.pop();
    if (keys.length > 0) {
      let i = 0;
      const len = keys.length;
      while (true) {
        const left = (i << 1) + 1;
        const right = left + 1;
        let smallest = i;
        if (left < len && keys[left] < lastKey) {
          smallest = left;
        }
        if (right < len && keys[right] < (smallest === i ? lastKey : keys[smallest])) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        keys[i] = keys[smallest];
        vals[i] = vals[smallest];
        i = smallest;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return [topKey, topVal];
  }
}

/**
 * Multi-source anisotropic Dijkstra over foreground voxels only, partitioning
 * every foreground vessel voxel to its nearest pruned segment (or junction).
 * Returns per-voxel segmentId (Int32Array over crop grid) and local diameter
 * map (Float32Array over crop grid).
 */
function partitionForegroundVoronoi(mask, dims, spacing, segments, segSampleDiameters, isolatedSeeds = []) {
  const [nx, ny, nz] = dims;
  const slice = nx * ny;
  const total = slice * nz;
  const ownerSeg = new Int32Array(total);
  const localDiam = new Float32Array(total);
  const bestDist = new Float64Array(total);
  bestDist.fill(Infinity);

  const heap = new MinHeap();

  // Precompute 26-neighbor physical step distances.
  const stepDists = new Float64Array(26);
  for (let k = 0; k < 26; k += 1) {
    const [dx, dy, dz] = OFFSETS_26[k];
    stepDists[k] = Math.hypot(dx * spacing[0], dy * spacing[1], dz * spacing[2]);
  }

  // Seed every active segment's skeleton voxels.
  for (let s = 0; s < segments.length; s += 1) {
    const seg = segments[s];
    const diams = segSampleDiameters[s];
    const voxList = seg.voxelIndices;
    for (let i = 0; i < voxList.length; i += 1) {
      const idx = voxList[i];
      if (!mask[idx]) {
        continue;
      }
      const dVal = diams[Math.min(i, diams.length - 1)] ?? seg.medianDiameterMm ?? 0;
      if (bestDist[idx] > 0) {
        bestDist[idx] = 0;
        ownerSeg[idx] = seg.id;
        localDiam[idx] = dVal;
        heap.push(0, idx);
      } else if (dVal > localDiam[idx]) {
        localDiam[idx] = dVal;
      }
    }
  }

  // Also seed isolated 1-voxel skeleton points so every retained vessel component
  // receives a valid diameter in the Voronoi-filled diameter NIfTI map.
  for (let i = 0; i < isolatedSeeds.length; i += 1) {
    const { idx, diamMm } = isolatedSeeds[i];
    if (!mask[idx] || bestDist[idx] === 0) {
      continue;
    }
    bestDist[idx] = 0;
    ownerSeg[idx] = 0;
    localDiam[idx] = diamMm;
    heap.push(0, idx);
  }

  while (heap.size > 0) {
    const [dist, idx] = heap.pop();
    if (dist > bestDist[idx]) {
      continue;
    }
    const z = Math.floor(idx / slice);
    const rem = idx - z * slice;
    const y = Math.floor(rem / nx);
    const x = rem - y * nx;
    const segId = ownerSeg[idx];
    const dVal = localDiam[idx];

    for (let k = 0; k < 26; k += 1) {
      const [dx, dy, dz] = OFFSETS_26[k];
      const nx2 = x + dx;
      const ny2 = y + dy;
      const nz2 = z + dz;
      if (nx2 < 0 || nx2 >= nx || ny2 < 0 || ny2 >= ny || nz2 < 0 || nz2 >= nz) {
        continue;
      }
      const nIdx = nz2 * slice + ny2 * nx + nx2;
      if (!mask[nIdx]) {
        continue;
      }
      const nd = dist + stepDists[k];
      if (nd < bestDist[nIdx]) {
        bestDist[nIdx] = nd;
        ownerSeg[nIdx] = segId;
        localDiam[nIdx] = dVal;
        heap.push(nd, nIdx);
      }
    }
  }

  return { ownerSeg, localDiam };
}

/**
 * Fits an outgoing unit tangent vector along a smoothed world polyline starting
 * at endpoint `atEnd` (false = start index 0, true = end index n-1), skipping
 * the junction core `skipMm` and measuring out to `windowMm`.
 */
function outwardTangent(worldPts, atEnd, skipMm, windowMm) {
  const pts = atEnd ? [...worldPts].reverse() : worldPts;
  const n = pts.length;
  if (n < 2) {
    return null;
  }
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i += 1) {
    cum[i] = cum[i - 1] + dist3(pts[i - 1], pts[i]);
  }
  const totalLen = cum[n - 1];
  if (totalLen <= 1e-6) {
    return null;
  }

  const interpAt = (s) => {
    const clamped = clamp(s, 0, totalLen);
    let seg = 0;
    while (seg < n - 2 && cum[seg + 1] < clamped) {
      seg += 1;
    }
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-12 ? (clamped - cum[seg]) / span : 0;
    const a = pts[seg];
    const b = pts[seg + 1];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
  };

  const s0 = Math.min(skipMm, 0.25 * totalLen);
  const s1 = Math.min(s0 + windowMm, totalLen);
  if (s1 - s0 <= 1e-6) {
    return null;
  }
  const p0 = interpAt(s0);
  const p1 = interpAt(s1);
  const v = sub3(p1, p0);
  const len = norm3(v);
  if (len <= 1e-6) {
    return null;
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Computes all physical geometry, diameters, tortuosity, Voronoi volumes,
 * junction angles, diameter-stratified bins, and optional brain/ROI mask density.
 */
export function measureVesselNetwork(
  graph,
  mask,
  dims,
  spatial,
  edtMm,
  {
    originalDims,
    cropOffset,
    smoothIterations = 6,
    brainMask = null,
    inputVesselVoxels = 0,
    retainedVesselVoxels = 0,
    holesFilledVoxels = 0,
    touchesFovVoxels = 0,
    componentStats = null,
  },
) {
  const { affine, spacing, voxelVolumeMm3 } = spatial;
  const maxSpacing = Math.max(spacing[0], spacing[1], spacing[2]);
  const resolutionLimitMm = 2 * maxSpacing;
  const [ox, oy, oz] = cropOffset;

  const cropVoxToWorld = (v) => voxelToWorld(affine, v[0] + ox, v[1] + oy, v[2] + oz);

  // Build lookup of node objects by 1-based id.
  const nodeById = new Map();
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const node = graph.nodes[i];
    node.worldMm = cropVoxToWorld(node.vox);
    nodeById.set(node.id, node);
  }

  // Step 1: Smooth centerlines and measure segment length, chord, tortuosity, and diameters.
  const measuredSegments = [];
  const segSampleDiameters = [];
  const segWorldPolylines = [];

  for (let s = 0; s < graph.segments.length; s += 1) {
    const seg = graph.segments[s];
    const smoothVox = smoothCenterlineVox(seg.pointsVox, spacing, mask, dims, {
      iterations: smoothIterations,
      isClosedLoop: seg.isClosedLoop,
    });
    const worldPts = smoothVox.map(cropVoxToWorld);
    segWorldPolylines.push(worldPts);

    let lengthMm = 0;
    const cumLen = new Float64Array(worldPts.length);
    for (let i = 1; i < worldPts.length; i += 1) {
      lengthMm += dist3(worldPts[i - 1], worldPts[i]);
      cumLen[i] = lengthMm;
    }

    const chordMm = seg.isClosedLoop
      ? 0
      : dist3(worldPts[0], worldPts[worldPts.length - 1]);
    const dmTortuosity = !seg.isClosedLoop && chordMm > 1e-6 ? lengthMm / chordMm : null;
    const soamRadPerMm = computeSoamRadPerMm(worldPts, lengthMm, maxSpacing);

    // Local tangent in the spacing-scaled voxel frame (invariant to affine
    // rotations, permutations and axis flips) & subvoxel inscribed radius.
    const nPts = worldPts.length;
    const sampleDiams = new Float64Array(nPts);
    const sampleWeights = new Float64Array(nPts);
    const sampleCensored = new Uint8Array(nPts);

    for (let i = 0; i < nPts; i += 1) {
      const iPrev = Math.max(0, i - 1);
      const iNext = Math.min(nPts - 1, i + 1);
      const tangVoxPhys = [
        (smoothVox[iNext][0] - smoothVox[iPrev][0]) * spacing[0],
        (smoothVox[iNext][1] - smoothVox[iPrev][1]) * spacing[1],
        (smoothVox[iNext][2] - smoothVox[iPrev][2]) * spacing[2],
      ];
      const rawV = seg.pointsVox[Math.min(i, seg.pointsVox.length - 1)];
      const ix = Math.round(rawV[0]);
      const iy = Math.round(rawV[1]);
      const iz = Math.round(rawV[2]);

      const res = subvoxelInscribedRadius(
        mask,
        dims,
        spacing,
        ix,
        iy,
        iz,
        tangVoxPhys,
        originalDims,
        cropOffset,
      );
      sampleDiams[i] = res.diameterMm;
      sampleCensored[i] = res.cropCensored ? 1 : 0;

      const dlPrev = i > 0 ? cumLen[i] - cumLen[i - 1] : 0;
      const dlNext = i < nPts - 1 ? cumLen[i + 1] - cumLen[i] : 0;
      sampleWeights[i] = Math.max(1e-6, 0.5 * (dlPrev + dlNext));
    }
    segSampleDiameters.push(sampleDiams);

    // Exclude junction/cap guard zones where possible to prevent junction swelling bias.
    const nodeA = nodeById.get(seg.nodeA);
    const nodeB = nodeById.get(seg.nodeB);
    const guardA = seg.isClosedLoop
      ? 0
      : nodeA.kind === 'junction'
        ? Math.max(nodeA.maxEdtMm, maxSpacing)
        : 0.5 * maxSpacing;
    const guardB = seg.isClosedLoop
      ? 0
      : nodeB.kind === 'junction'
        ? Math.max(nodeB.maxEdtMm, maxSpacing)
        : 0.5 * maxSpacing;

    const validVals = [];
    const validW = [];
    let validLen = 0;
    let anyCensored = false;
    for (let i = 0; i < nPts; i += 1) {
      if (sampleCensored[i]) {
        anyCensored = true;
      }
      if (cumLen[i] >= guardA && lengthMm - cumLen[i] >= guardB) {
        validVals.push(sampleDiams[i]);
        validW.push(sampleWeights[i]);
        validLen += sampleWeights[i];
      }
    }
    // Fallback to all samples on short segments whose length <= guardA + guardB.
    const usedGuardFallback = validVals.length === 0;
    if (usedGuardFallback) {
      for (let i = 0; i < nPts; i += 1) {
        validVals.push(sampleDiams[i]);
        validW.push(sampleWeights[i]);
        validLen += sampleWeights[i];
      }
    }

    let wSum = 0;
    let meanD = 0;
    let minD = Infinity;
    let maxD = 0;
    for (let i = 0; i < validVals.length; i += 1) {
      const d = validVals[i];
      const w = validW[i];
      meanD += d * w;
      wSum += w;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    meanD = wSum > 0 ? meanD / wSum : 0;
    let varSum = 0;
    for (let i = 0; i < validVals.length; i += 1) {
      const diff = validVals[i] - meanD;
      varSum += diff * diff * validW[i];
    }
    const sdD = wSum > 0 ? Math.sqrt(varSum / wSum) : 0;
    const medianD = weightedQuantile(validVals, validW, 0.5) ?? meanD;
    const p25D = weightedQuantile(validVals, validW, 0.25) ?? meanD;
    const p75D = weightedQuantile(validVals, validW, 0.75) ?? meanD;

    const midIdx = Math.floor(nPts / 2);
    measuredSegments.push({
      id: seg.id,
      componentId: seg.componentId,
      kind: seg.kind,
      nodeA: seg.nodeA,
      nodeB: seg.nodeB,
      isClosedLoop: seg.isClosedLoop,
      touchesFovBoundary: seg.touchesFovBoundary,
      lengthMm,
      rawLengthMm: seg.rawLengthMm,
      chordMm,
      dmTortuosity,
      soamRadPerMm,
      meanDiameterMm: meanD,
      medianDiameterMm: medianD,
      iqrDiameterMm: p75D - p25D,
      minDiameterMm: Number.isFinite(minD) ? minD : 0,
      maxDiameterMm: maxD,
      sdDiameterMm: sdD,
      equivDiameterMm: 0,
      volumeMm3: 0,
      voxelCount: 0,
      sampledLengthMm: validLen,
      usedGuardFallback,
      cropCensored: anyCensored,
      resolutionLimited: medianD < resolutionLimitMm,
      midpointWorldMm: worldPts[midIdx],
      startWorldMm: worldPts[0],
      endWorldMm: worldPts[nPts - 1],
      worldPointsMm: worldPts,
      sampleRadiiMm: Array.from(sampleDiams, (d) => d * 0.5),
    });
  }

  // Step 2: Sparse foreground Voronoi partition for segment volumes, D_eq, and NIfTI diameter map.
  const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);
  const isolatedSeeds = graph.isolatedVoxels.map((iso) => {
    const res = subvoxelInscribedRadius(
      mask,
      dims,
      spacing,
      iso.vox[0],
      iso.vox[1],
      iso.vox[2],
      null,
      originalDims,
      cropOffset,
    );
    return { idx: iso.idx, diamMm: Math.max(res.diameterMm, minSpacing) };
  });
  const { ownerSeg, localDiam } = partitionForegroundVoronoi(
    mask,
    dims,
    spacing,
    graph.segments,
    segSampleDiameters,
    isolatedSeeds,
  );

  // Fallback: if any retained foreground voxel was not reached (e.g. a small blob
  // whose skeleton collapsed to a zero-arm junction clique or pruned isolated speck),
  // assign its EDT-based diameter so no retained vessel voxel is left zero.
  for (let i = 0; i < ownerSeg.length; i += 1) {
    if (mask[i] && localDiam[i] <= 0) {
      localDiam[i] = Math.max(minSpacing, 2 * edtMm[i] - minSpacing);
    }
  }

  const segVoxelCounts = new Int32Array(measuredSegments.length + 1);
  const binVoxelCounts = new Int32Array(DIAMETER_BINS.length);
  for (let i = 0; i < ownerSeg.length; i += 1) {
    if (!mask[i]) {
      continue;
    }
    const sid = ownerSeg[i];
    if (sid > 0 && sid <= measuredSegments.length) {
      segVoxelCounts[sid] += 1;
    }
    const d = localDiam[i];
    for (let b = 0; b < DIAMETER_BINS.length; b += 1) {
      if (d >= DIAMETER_BINS[b].minMm && d < DIAMETER_BINS[b].maxMm) {
        binVoxelCounts[b] += 1;
        break;
      }
    }
  }

  for (let i = 0; i < measuredSegments.length; i += 1) {
    const seg = measuredSegments[i];
    const vCount = segVoxelCounts[seg.id];
    seg.voxelCount = vCount;
    seg.volumeMm3 = vCount * voxelVolumeMm3;
    seg.equivDiameterMm =
      seg.lengthMm > 1e-6 && seg.volumeMm3 > 0
        ? 2 * Math.sqrt(seg.volumeMm3 / (Math.PI * seg.lengthMm))
        : seg.meanDiameterMm;
  }

  // Step 3: Junction & bifurcation angle geometry.
  const measuredJunctions = [];
  const segById = new Map(measuredSegments.map((seg) => [seg.id, seg]));

  for (let i = 0; i < graph.nodes.length; i += 1) {
    const node = graph.nodes[i];
    if (node.kind !== 'junction') {
      continue;
    }
    // Deduplicate incident segment IDs while noting self-loop exit directions.
    const exits = [];
    const seenSelf = new Set();
    for (let j = 0; j < node.incidentSegmentIds.length; j += 1) {
      const sid = node.incidentSegmentIds[j];
      const seg = segById.get(sid);
      if (!seg) {
        continue;
      }
      if (seg.nodeA === node.id && seg.nodeB === node.id) {
        if (!seenSelf.has(sid)) {
          seenSelf.add(sid);
          exits.push({ sid, seg, atEnd: false });
          exits.push({ sid, seg, atEnd: true });
        }
      } else {
        exits.push({ sid, seg, atEnd: seg.nodeB === node.id });
      }
    }

    const tangents = [];
    for (let e = 0; e < exits.length; e += 1) {
      const { seg, atEnd } = exits[e];
      const skipMm = Math.max(node.maxEdtMm, maxSpacing);
      const winMm = Math.max(2 * seg.medianDiameterMm, 2 * maxSpacing);
      const t = outwardTangent(seg.worldPointsMm, atEnd, skipMm, winMm);
      tangents.push({
        sid: seg.id,
        diam: seg.medianDiameterMm,
        eqDiam: seg.equivDiameterMm,
        tangent: t,
      });
    }

    const pairwiseAnglesDeg = [];
    for (let a = 0; a < tangents.length; a += 1) {
      for (let b = a + 1; b < tangents.length; b += 1) {
        if (!tangents[a].tangent || !tangents[b].tangent) {
          continue;
        }
        const cos = clamp(dot3(tangents[a].tangent, tangents[b].tangent), -1, 1);
        pairwiseAnglesDeg.push((Math.acos(cos) * 180) / Math.PI);
      }
    }

    const minAngleDeg = pairwiseAnglesDeg.length ? Math.min(...pairwiseAnglesDeg) : null;
    const maxAngleDeg = pairwiseAnglesDeg.length ? Math.max(...pairwiseAnglesDeg) : null;
    const meanAngleDeg = pairwiseAnglesDeg.length
      ? pairwiseAnglesDeg.reduce((a, b) => a + b, 0) / pairwiseAnglesDeg.length
      : null;

    // For degree-3 bifurcations with an unambiguously widest parent branch (>= 1.1x daughters),
    // report caliber-inferred daughter angle, area expansion ratio, asymmetry and Murray ratio.
    let parentInferredFromCaliber = false;
    let daughterAngleDeg = null;
    let areaExpansionRatio = null;
    let asymmetryRatio = null;
    let murrayRatioCubed = null;

    if (tangents.length === 3) {
      const sorted = [...tangents].sort((a, b) => b.eqDiam - a.eqDiam);
      const p = sorted[0];
      const d1 = sorted[1];
      const d2 = sorted[2];
      if (p.eqDiam > 0 && d1.eqDiam > 0 && d2.eqDiam > 0 && p.eqDiam >= 1.1 * d1.eqDiam) {
        parentInferredFromCaliber = true;
        if (d1.tangent && d2.tangent) {
          const cos = clamp(dot3(d1.tangent, d2.tangent), -1, 1);
          daughterAngleDeg = (Math.acos(cos) * 180) / Math.PI;
        }
        const r0 = p.eqDiam * 0.5;
        const r1 = d1.eqDiam * 0.5;
        const r2 = d2.eqDiam * 0.5;
        areaExpansionRatio = (r1 * r1 + r2 * r2) / (r0 * r0);
        asymmetryRatio = Math.min(r1, r2) / Math.max(r1, r2);
        murrayRatioCubed = (r1 ** 3 + r2 ** 3) / r0 ** 3;
      }
    }

    measuredJunctions.push({
      id: node.id,
      componentId: node.componentId,
      degree: node.degree,
      worldMm: node.worldMm,
      radiusMm: node.maxEdtMm,
      touchesFovBoundary: node.touchesFov,
      incidentSegmentIds: [...new Set(node.incidentSegmentIds)],
      pairwiseAnglesDeg,
      minAngleDeg,
      maxAngleDeg,
      meanAngleDeg,
      parentInferredFromCaliber,
      daughterAngleDeg,
      areaExpansionRatio,
      asymmetryRatio,
      murrayRatioCubed,
    });
  }

  // Step 4: Diameter-stratified bins.
  const totalLengthMm = measuredSegments.reduce((acc, s) => acc + s.lengthMm, 0);
  const totalVolumeMm3 = retainedVesselVoxels * voxelVolumeMm3;

  const diameterBins = DIAMETER_BINS.map((bin, idx) => {
    const segs = measuredSegments.filter(
      (s) => s.medianDiameterMm >= bin.minMm && s.medianDiameterMm < bin.maxMm,
    );
    const binLen = segs.reduce((acc, s) => acc + s.lengthMm, 0);
    const binVol = binVoxelCounts[idx] * voxelVolumeMm3;
    const dmSegs = segs.filter((s) => s.dmTortuosity !== null);
    const meanDm = dmSegs.length
      ? dmSegs.reduce((acc, s) => acc + s.dmTortuosity * s.lengthMm, 0) /
        Math.max(1e-9, dmSegs.reduce((acc, s) => acc + s.lengthMm, 0))
      : null;
    return {
      label: bin.label,
      minMm: bin.minMm,
      maxMm: Number.isFinite(bin.maxMm) ? bin.maxMm : null,
      segmentCount: segs.length,
      totalLengthMm: binLen,
      lengthFraction: totalLengthMm > 0 ? binLen / totalLengthMm : 0,
      volumeMm3: binVol,
      volumeFraction: totalVolumeMm3 > 0 ? binVol / totalVolumeMm3 : 0,
      meanDmTortuosity: meanDm,
      resolutionLimited: bin.maxMm <= resolutionLimitMm,
    };
  });

  // Step 5: Optional Brain / ROI mask vascular density metrics (strictly inside ROI).
  let roiMetrics = null;
  if (brainMask) {
    const [onx, ony, onz] = originalDims;
    const oSlice = onx * ony;
    const totalOrig = oSlice * onz;
    let roiVoxels = 0;
    for (let i = 0; i < totalOrig; i += 1) {
      if (brainMask[i]) {
        roiVoxels += 1;
      }
    }
    // Count retained vessel voxels inside brainMask.
    const [cnx, cny, cnz] = dims;
    const cSlice = cnx * cny;
    let roiVesselVoxels = 0;
    for (let cz = 0; cz < cnz; cz += 1) {
      const gz = cz + oz;
      if (gz < 0 || gz >= onz) continue;
      for (let cy = 0; cy < cny; cy += 1) {
        const gy = cy + oy;
        if (gy < 0 || gy >= ony) continue;
        const cRow = cz * cSlice + cy * cnx;
        const gRow = gz * oSlice + gy * onx;
        for (let cx = 0; cx < cnx; cx += 1) {
          if (!mask[cRow + cx]) continue;
          const gx = cx + ox;
          if (gx >= 0 && gx < onx && brainMask[gRow + gx]) {
            roiVesselVoxels += 1;
          }
        }
      }
    }

    const voxInsideBrain = (v) => {
      const gx = Math.round(v[0] + ox);
      const gy = Math.round(v[1] + oy);
      const gz = Math.round(v[2] + oz);
      if (gx < 0 || gx >= onx || gy < 0 || gy >= ony || gz < 0 || gz >= onz) {
        return false;
      }
      return brainMask[gz * oSlice + gy * onx + gx] !== 0;
    };

    // Sum smoothed polyline sub-segments whose midpoints lie inside brainMask.
    let roiLengthMm = 0;
    for (let s = 0; s < graph.segments.length; s += 1) {
      const seg = graph.segments[s];
      const worldPts = segWorldPolylines[s];
      const rawPts = seg.pointsVox;
      for (let i = 1; i < worldPts.length; i += 1) {
        const a = rawPts[Math.min(i - 1, rawPts.length - 1)];
        const b = rawPts[Math.min(i, rawPts.length - 1)];
        const mid = [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), 0.5 * (a[2] + b[2])];
        if (voxInsideBrain(mid)) {
          roiLengthMm += dist3(worldPts[i - 1], worldPts[i]);
        }
      }
    }

    let roiJunctionCount = 0;
    let roiEndpointCount = 0;
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const node = graph.nodes[i];
      if (!voxInsideBrain(node.vox)) {
        continue;
      }
      if (node.kind === 'junction') {
        roiJunctionCount += 1;
      } else if (node.kind === 'endpoint') {
        roiEndpointCount += 1;
      }
    }

    const roiVolumeMm3 = roiVoxels * voxelVolumeMm3;
    const roiVolumeCm3 = roiVolumeMm3 / 1000;
    const roiVesselVolumeMm3 = roiVesselVoxels * voxelVolumeMm3;
    roiMetrics = {
      roiVoxelCount: roiVoxels,
      roiVolumeMm3,
      roiVolumeCm3,
      roiVesselVoxelCount: roiVesselVoxels,
      roiVesselVolumeMm3,
      vesselVolumeFraction: roiVolumeMm3 > 0 ? roiVesselVolumeMm3 / roiVolumeMm3 : null,
      roiTotalLengthMm: roiLengthMm,
      vesselLengthDensityMmPerCm3: roiVolumeCm3 > 0 ? roiLengthMm / roiVolumeCm3 : null,
      roiJunctionCount,
      junctionDensityPerCm3: roiVolumeCm3 > 0 ? roiJunctionCount / roiVolumeCm3 : null,
      roiEndpointCount,
      endpointDensityPerCm3: roiVolumeCm3 > 0 ? roiEndpointCount / roiVolumeCm3 : null,
    };
  }

  // Step 6: Global summary aggregates.
  const endpoints = graph.nodes.filter((n) => n.kind === 'endpoint');
  const fovEndpoints = endpoints.filter((n) => n.touchesFov);
  const interiorEndpoints = endpoints.length - fovEndpoints.length;
  const bifurcations = measuredJunctions.filter((j) => j.degree === 3);
  const multifurcations = measuredJunctions.filter((j) => j.degree >= 4);

  const segDiams = measuredSegments.map((s) => s.medianDiameterMm);
  const segEqDiams = measuredSegments.map((s) => s.equivDiameterMm);
  const segLens = measuredSegments.map((s) => s.lengthMm);
  const resLimitedLength = measuredSegments
    .filter((s) => s.resolutionLimited)
    .reduce((acc, s) => acc + s.lengthMm, 0);

  const lengthWeightedMeanDiam =
    totalLengthMm > 0
      ? measuredSegments.reduce((acc, s) => acc + s.meanDiameterMm * s.lengthMm, 0) / totalLengthMm
      : null;
  const lengthWeightedMeanEqDiam =
    totalLengthMm > 0
      ? measuredSegments.reduce((acc, s) => acc + s.equivDiameterMm * s.lengthMm, 0) / totalLengthMm
      : null;

  const dmSegments = measuredSegments.filter((s) => s.dmTortuosity !== null);
  const dmLenTotal = dmSegments.reduce((acc, s) => acc + s.lengthMm, 0);
  const meanDmTortuosity =
    dmLenTotal > 0
      ? dmSegments.reduce((acc, s) => acc + s.dmTortuosity * s.lengthMm, 0) / dmLenTotal
      : null;
  const medianDmTortuosity = weightedQuantile(
    dmSegments.map((s) => s.dmTortuosity),
    dmSegments.map((s) => s.lengthMm),
    0.5,
  );

  const soamSegments = measuredSegments.filter((s) => s.soamRadPerMm !== null);
  const soamLenTotal = soamSegments.reduce((acc, s) => acc + s.lengthMm, 0);
  const meanSoamRadPerMm =
    soamLenTotal > 0
      ? soamSegments.reduce((acc, s) => acc + s.soamRadPerMm * s.lengthMm, 0) / soamLenTotal
      : null;

  const daughterAngles = bifurcations
    .map((j) => j.daughterAngleDeg)
    .filter((v) => v !== null && Number.isFinite(v));
  const meanBifurcationAngleDeg = daughterAngles.length
    ? daughterAngles.reduce((a, b) => a + b, 0) / daughterAngles.length
    : null;

  const approxSurfaceAreaMm2 = measuredSegments.reduce(
    (acc, s) => acc + Math.PI * s.meanDiameterMm * s.lengthMm,
    0,
  );

  // Build full-grid output volumes (diameter map & skeleton topology labels) from crop grid.
  const [onx, ony, onz] = originalDims;
  const oSlice = onx * ony;
  const totalOrig = oSlice * onz;
  const fullDiameterMap = new Float32Array(totalOrig);
  const fullSkeletonLabels = new Uint8Array(totalOrig);

  const [cnx, cny, cnz] = dims;
  const cSlice = cnx * cny;
  for (let cz = 0; cz < cnz; cz += 1) {
    const gz = cz + oz;
    if (gz < 0 || gz >= onz) continue;
    for (let cy = 0; cy < cny; cy += 1) {
      const gy = cy + oy;
      if (gy < 0 || gy >= ony) continue;
      const cRow = cz * cSlice + cy * cnx;
      const gRow = gz * oSlice + gy * onx;
      for (let cx = 0; cx < cnx; cx += 1) {
        const dVal = localDiam[cRow + cx];
        if (dVal > 0) {
          const gx = cx + ox;
          if (gx >= 0 && gx < onx) {
            fullDiameterMap[gRow + gx] = dVal;
          }
        }
      }
    }
  }

  const paintCropIndex = (cIdx, labelVal) => {
    const cz = Math.floor(cIdx / cSlice);
    const rem = cIdx - cz * cSlice;
    const cy = Math.floor(rem / cnx);
    const cx = rem - cy * cnx;
    const gx = cx + ox;
    const gy = cy + oy;
    const gz = cz + oz;
    if (gx >= 0 && gx < onx && gy >= 0 && gy < ony && gz >= 0 && gz < onz) {
      fullSkeletonLabels[gz * oSlice + gy * onx + gx] = labelVal;
    }
  };

  // Label 1 = segment centerline, 2 = junction, 3 = endpoint, 4 = isolated voxel.
  for (let s = 0; s < graph.segments.length; s += 1) {
    const vList = graph.segments[s].voxelIndices;
    for (let i = 0; i < vList.length; i += 1) {
      paintCropIndex(vList[i], 1);
    }
  }
  for (let i = 0; i < graph.isolatedVoxels.length; i += 1) {
    paintCropIndex(graph.isolatedVoxels[i].idx, 4);
  }
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const node = graph.nodes[i];
    const lbl = node.kind === 'junction' ? 2 : node.kind === 'endpoint' ? 3 : 1;
    for (let k = 0; k < node.voxelIndices.length; k += 1) {
      paintCropIndex(node.voxelIndices[k], lbl);
    }
  }

  const summary = {
    schemaVersion: 1,
    input: {
      dimensions: originalDims,
      voxelSpacingMm: spacing,
      voxelVolumeMm3,
      anisotropyRatio: spatial.anisotropyRatio,
      spatialUnit: spatial.unitName,
      assumedUnitsMm: spatial.assumedMm,
      inputVesselVoxels,
      inputVesselVolumeMm3: inputVesselVoxels * voxelVolumeMm3,
      holesFilledVoxels,
      touchesFovVoxels,
      inputComponentCount: componentStats?.inputComponentCount ?? graph.stats.graphComponentCount,
      retainedComponentCount: componentStats?.retainedComponentCount ?? graph.stats.graphComponentCount,
      droppedComponentCount: componentStats?.droppedComponentCount ?? 0,
      droppedVoxels: componentStats?.droppedVoxels ?? 0,
    },
    network: {
      vesselVoxelCount: retainedVesselVoxels,
      vesselVolumeMm3: totalVolumeMm3,
      skeletonVoxelCount: graph.stats.skeletonVoxelCount,
      totalLengthMm,
      totalRawLengthMm: measuredSegments.reduce((acc, s) => acc + s.rawLengthMm, 0),
      unprunedRawLengthMm: graph.stats.rawTotalLengthMm,
      approxSurfaceAreaMm2,
      segmentCount: measuredSegments.length,
      unprunedSegmentCount: graph.stats.rawSegmentCount,
      prunedSpurCount: graph.stats.prunedSpurCount,
      prunedSpurLengthMm: graph.stats.prunedSpurLengthMm,
      prunedIsolatedCount: graph.stats.prunedIsolatedCount,
      prunedIsolatedLengthMm: graph.stats.prunedIsolatedLengthMm,
      junctionCount: measuredJunctions.length,
      bifurcationCount: bifurcations.length,
      multifurcationCount: multifurcations.length,
      endpointCount: endpoints.length,
      interiorEndpointCount: interiorEndpoints,
      fovEndpointCount: fovEndpoints.length,
      isolatedSkeletonVoxels: graph.stats.isolatedVoxelCount,
      connectedComponentCount: graph.stats.graphComponentCount,
      cycleRankBetti1: graph.stats.cycleRankBetti1,
      meanDiameterMm: lengthWeightedMeanDiam,
      medianDiameterMm: weightedQuantile(segDiams, segLens, 0.5),
      p25DiameterMm: weightedQuantile(segDiams, segLens, 0.25),
      p75DiameterMm: weightedQuantile(segDiams, segLens, 0.75),
      p90DiameterMm: weightedQuantile(segDiams, segLens, 0.9),
      meanEquivDiameterMm: lengthWeightedMeanEqDiam,
      medianEquivDiameterMm: weightedQuantile(segEqDiams, segLens, 0.5),
      meanDmTortuosity,
      medianDmTortuosity,
      meanSoamRadPerMm,
      meanBifurcationAngleDeg,
      resolutionLimitMm,
      resolutionLimitedLengthFraction: totalLengthMm > 0 ? resLimitedLength / totalLengthMm : 0,
    },
    roi: roiMetrics,
    diameterBins,
  };

  return {
    summary,
    segments: measuredSegments,
    junctions: measuredJunctions,
    diameterMap: fullDiameterMap,
    skeletonLabels: fullSkeletonLabels,
  };
}
