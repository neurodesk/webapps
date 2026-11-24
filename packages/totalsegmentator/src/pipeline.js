// TotalSegmentator v2 inference pipeline (nnU-Net v2 PlainConvUNet).
// Pure ES module: no DOM, no ONNX Runtime import (sessions / patch runners are injected).
//
// NIfTI voxel buffers store x fastest: index = (z * ny + y) * nx + x, which is identically
// C-order [nz, ny, nx]. Every TotalSegmentator v2 model exported here has transpose_forward
// [0, 1, 2], so C-order [D=nz, H=ny, W=nx] with spacing [sz, sy, sx] matches plans.json directly.

import { CT_PART_LUTS, MR_PART_LUTS } from './labels.js';

export const STEP = 0.5;
export const MAX_INPUT_VOXELS = 512 * 1024 * 1024;
export const MAX_RESAMPLED_VOXELS = 128 * 1024 * 1024;
export const MAX_ACCUM_ELEMENTS = 360_000_000;

const product = (shape) => shape[0] * shape[1] * shape[2];

// IEEE-754 float16 <-> float32 conversion with round-to-nearest-even and exact carry propagation.
const f32View = new Float32Array(1);
const u32View = new Uint32Array(f32View.buffer);

const F16_TO_F32 = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const m = h & 0x03ff;
  let value;
  if (e === 0) value = (s ? -1 : 1) * (m / 1024) * 2 ** -14;
  else if (e === 31) value = m ? NaN : (s ? -Infinity : Infinity);
  else value = (s ? -1 : 1) * (1 + m / 1024) * 2 ** (e - 15);
  F16_TO_F32[h] = value;
}

export function f32ToF16(value) {
  f32View[0] = value;
  const bits = u32View[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  const frac = bits & 0x007fffff;

  if (exp === 0xff) {
    // Infinity or quiet NaN.
    return sign | 0x7c00 | (frac ? ((frac >>> 13) | 1) : 0);
  }

  let hExp = exp - 127 + 15;
  if (hExp >= 31) return sign | 0x7c00;

  if (hExp <= 0) {
    // Subnormal or underflow. Smallest halfway is 2^-25 (exp=102, hExp=-10, frac=0).
    if (hExp < -10) return sign;
    const mant = 0x00800000 | frac;
    const shift = 14 - hExp; // 14..24
    const half = 1 << (shift - 1);
    const mask = (1 << shift) - 1;
    let q = mant >>> shift;
    const rem = mant & mask;
    if (rem > half || (rem === half && (q & 1))) q++;
    // If q === 1024 (0x0400), carry promotes directly into smallest normal (hExp=1, mant=0).
    return sign | q;
  }

  // Normal float16: round 23-bit fraction down to 10 bits using round-to-nearest-even.
  let q = frac >>> 13;
  const rem = frac & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (q & 1))) q++;
  if (q === 0x0400) {
    q = 0;
    hExp++;
    if (hExp >= 31) return sign | 0x7c00;
  }
  return sign | (hExp << 10) | q;
}

export function f16ToF32(bits) {
  return F16_TO_F32[bits];
}

// numpy's round-half-to-even, matching scipy/nnU-Net shape and stride rounding.
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

export function voxelSpacing(affine) {
  return [0, 1, 2].map((a) => Math.hypot(affine[0][a], affine[1][a], affine[2][a]));
}

// Symmetric 3x3 Jacobi eigendecomposition: A = V * diag(d) * V^T.
function jacobiEigen3x3(sym) {
  const A = sym.map((row) => [...row]);
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 50; iter++) {
    let p = 0;
    let q = 1;
    let maxOff = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(A[0][2]); }
    if (Math.abs(A[1][2]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(A[1][2]); }
    if (maxOff <= 1e-15) break;
    const app = A[p][p];
    const aqq = A[q][q];
    const apq = A[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = tau >= 0 ? 1 / (tau + Math.hypot(1, tau)) : -1 / (-tau + Math.hypot(1, tau));
    const c = 1 / Math.hypot(1, t);
    const s = t * c;
    A[p][p] = app - t * apq;
    A[q][q] = aqq + t * apq;
    A[p][q] = 0;
    A[q][p] = 0;
    for (let r = 0; r < 3; r++) {
      if (r !== p && r !== q) {
        const arp = A[r][p];
        const arq = A[r][q];
        A[r][p] = c * arp - s * arq;
        A[p][r] = A[r][p];
        A[r][q] = s * arp + c * arq;
        A[q][r] = A[r][q];
      }
      const vrp = V[r][p];
      const vrq = V[r][q];
      V[r][p] = c * vrp - s * vrq;
      V[r][q] = s * vrp + c * vrq;
    }
  }
  return { values: [A[0][0], A[1][1], A[2][2]], vectors: V };
}

// Finds the signed permutation aligning affine columns closest to canonical +R, +A, +S.
// Exact port of nibabel.orientations.io_orientation: polar decomposition via SVD followed by
// greedy axis assignment ordered from strongest to weakest column alignment (stable on ties).
export function canonicalOrientation(affine) {
  const zooms = voxelSpacing(affine).map((s) => (s === 0 ? 1 : s));
  const RS = [0, 1, 2].map((row) => [0, 1, 2].map((col) => affine[row][col] / zooms[col]));
  // Gram matrix G = RS^T * RS.
  const G = [0, 1, 2].map((i) => [0, 1, 2].map((j) => RS[0][i] * RS[0][j] + RS[1][i] * RS[1][j] + RS[2][i] * RS[2][j]));
  const { values, vectors } = jacobiEigen3x3(G);
  const singular = values.map((v) => Math.sqrt(Math.max(0, v)));
  const maxS = Math.max(...singular);
  const tol = maxS * 3 * Number.EPSILON;

  // R = P[:, keep] * Qs[keep] = sum_{k: s_k > tol} ((RS * v_k) / s_k) * v_k^T.
  const R = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let k = 0; k < 3; k++) {
    if (singular[k] <= tol) continue;
    const invS = 1 / singular[k];
    const v0 = vectors[0][k];
    const v1 = vectors[1][k];
    const v2 = vectors[2][k];
    const p = [
      (RS[0][0] * v0 + RS[0][1] * v1 + RS[0][2] * v2) * invS,
      (RS[1][0] * v0 + RS[1][1] * v1 + RS[1][2] * v2) * invS,
      (RS[2][0] * v0 + RS[2][1] * v1 + RS[2][2] * v2) * invS,
    ];
    for (let r = 0; r < 3; r++) {
      R[r][0] += p[r] * v0;
      R[r][1] += p[r] * v1;
      R[r][2] += p[r] * v2;
    }
  }

  // Process input axes from strongest to weakest (stable on ties), matching nibabel.
  const colKey = [0, 1, 2].map((c) => Math.min(-(R[0][c] ** 2), -(R[1][c] ** 2), -(R[2][c] ** 2)));
  const inAxes = [0, 1, 2].sort((a, b) => (colKey[a] !== colKey[b] ? colKey[a] - colKey[b] : a - b));

  const invPerm = [0, 1, 2];
  const flip = [false, false, false];
  const assigned = [false, false, false];
  for (const inAx of inAxes) {
    let outAx = 0;
    let bestAbs = -1;
    for (let r = 0; r < 3; r++) {
      const a = Math.abs(R[r][inAx]);
      if (a > bestAbs) {
        bestAbs = a;
        outAx = r;
      }
    }
    if (bestAbs > 1e-8) {
      invPerm[outAx] = inAx;
      flip[outAx] = R[outAx][inAx] < 0;
      assigned[outAx] = true;
      R[outAx][0] = 0;
      R[outAx][1] = 0;
      R[outAx][2] = 0;
    }
  }
  const identity = invPerm[0] === 0 && invPerm[1] === 1 && invPerm[2] === 2 && !flip[0] && !flip[1] && !flip[2];
  return { invPerm, flip, identity };
}

// Reorients a NIfTI volume (x fastest) into closest canonical RAS orientation,
// matching nibabel.as_closest_canonical.
export function asClosestCanonical(volume) {
  const { invPerm, flip, identity } = canonicalOrientation(volume.affine);
  if (identity) {
    return {
      volume: { data: volume.data, dims: [...volume.dims], affine: volume.affine.map((row) => [...row]) },
      orientation: { invPerm, flip, identity },
    };
  }
  const srcDims = volume.dims;
  const dstDims = [srcDims[invPerm[0]], srcDims[invPerm[1]], srcDims[invPerm[2]]];
  const [dx, dy, dz] = dstDims;
  const [sx, sy] = srcDims;
  const srcStrides = [1, sx, sx * sy];
  const out = new volume.data.constructor(volume.data.length);

  const axisStride = [srcStrides[invPerm[0]], srcStrides[invPerm[1]], srcStrides[invPerm[2]]];
  const axisStart = [
    flip[0] ? (dx - 1) * axisStride[0] : 0,
    flip[1] ? (dy - 1) * axisStride[1] : 0,
    flip[2] ? (dz - 1) * axisStride[2] : 0,
  ];
  const axisStep = [
    flip[0] ? -axisStride[0] : axisStride[0],
    flip[1] ? -axisStride[1] : axisStride[1],
    flip[2] ? -axisStride[2] : axisStride[2],
  ];

  let dstIdx = 0;
  for (let z = 0; z < dz; z++) {
    const baseZ = axisStart[2] + z * axisStep[2];
    for (let y = 0; y < dy; y++) {
      const baseZY = baseZ + axisStart[1] + y * axisStep[1];
      let srcIdx = baseZY + axisStart[0];
      const stepX = axisStep[0];
      for (let x = 0; x < dx; x++, dstIdx++, srcIdx += stepX) {
        out[dstIdx] = volume.data[srcIdx];
      }
    }
  }

  const affine = volume.affine.map((row) => [...row]);
  for (let r = 0; r < 3; r++) {
    let origin = volume.affine[r][3];
    for (let c = 0; c < 3; c++) {
      const origAxis = invPerm[c];
      const col = volume.affine[r][origAxis];
      if (flip[c]) {
        affine[r][c] = -col;
        origin += col * (dstDims[c] - 1);
      } else {
        affine[r][c] = col;
      }
    }
    affine[r][3] = origin;
  }

  return {
    volume: { data: out, dims: dstDims, affine },
    orientation: { invPerm, flip, identity },
  };
}

// Restores a canonical RAS volume back to the original input volume's voxel grid and orientation,
// matching totalsegmentator.alignment.undo_canonical.
export function undoCanonical(canonicalData, canonicalDims, origDims, orientation) {
  if (orientation.identity) return canonicalData;
  const { invPerm, flip } = orientation;
  const [dx, dy, dz] = canonicalDims;
  const [sx, sy] = origDims;
  const origStrides = [1, sx, sx * sy];
  const out = new canonicalData.constructor(canonicalData.length);

  const axisStride = [origStrides[invPerm[0]], origStrides[invPerm[1]], origStrides[invPerm[2]]];
  const axisStart = [
    flip[0] ? (dx - 1) * axisStride[0] : 0,
    flip[1] ? (dy - 1) * axisStride[1] : 0,
    flip[2] ? (dz - 1) * axisStride[2] : 0,
  ];
  const axisStep = [
    flip[0] ? -axisStride[0] : axisStride[0],
    flip[1] ? -axisStride[1] : axisStride[1],
    flip[2] ? -axisStride[2] : axisStride[2],
  ];

  let canIdx = 0;
  for (let z = 0; z < dz; z++) {
    const baseZ = axisStart[2] + z * axisStep[2];
    for (let y = 0; y < dy; y++) {
      const baseZY = baseZ + axisStart[1] + y * axisStep[1];
      let origIdx = baseZY + axisStart[0];
      const stepX = axisStep[0];
      for (let x = 0; x < dx; x++, canIdx++, origIdx += stepX) {
        out[origIdx] = canonicalData[canIdx];
      }
    }
  }
  return out;
}

// Separable 1D resampling matching scipy.ndimage.zoom(data, zoom, mode='nearest', order=0|1).
// Operates on C-order [D, H, W] arrays.
function resampleAxis(data, shape, axis, newSize, order) {
  const oldSize = shape[axis];
  if (oldSize === newSize) return { data, shape };
  const next = [...shape];
  next[axis] = newSize;
  const OutType = order === 0 ? data.constructor : Float32Array;
  const out = new OutType(product(next));
  const stridesOf = (dims) => [dims[1] * dims[2], dims[2], 1];
  const inStrides = stridesOf(shape);
  const outStrides = stridesOf(next);
  const inStride = inStrides[axis];
  const outStride = outStrides[axis];
  const [p, q] = [0, 1, 2].filter((a) => a !== axis);

  // Precompute 1D coordinate table matching scipy.ndimage.zoom (grid_mode=False).
  const idx0 = new Int32Array(newSize);
  const idx1 = new Int32Array(newSize);
  const frac = new Float32Array(newSize);
  const scale = newSize > 1 ? (oldSize - 1) / (newSize - 1) : 0;
  for (let o = 0; o < newSize; o++) {
    const x = o * scale;
    if (order === 0) {
      // Match scipy.ndimage.zoom order=0 nearest-neighbor rounding: floor(x + 0.5).
      idx0[o] = Math.min(Math.max(Math.floor(x + 0.5), 0), oldSize - 1);
    } else {
      const f = Math.min(Math.max(Math.floor(x), 0), oldSize - 1);
      idx0[o] = f;
      idx1[o] = Math.min(f + 1, oldSize - 1);
      frac[o] = x - f;
    }
  }

  for (let i = 0; i < shape[p]; i++) {
    const inP = i * inStrides[p];
    const outP = i * outStrides[p];
    for (let j = 0; j < shape[q]; j++) {
      const inBase = inP + j * inStrides[q];
      const outBase = outP + j * outStrides[q];
      if (order === 0) {
        for (let k = 0; k < newSize; k++) {
          out[outBase + k * outStride] = data[inBase + idx0[k] * inStride];
        }
      } else {
        for (let k = 0; k < newSize; k++) {
          const v0 = data[inBase + idx0[k] * inStride];
          const v1 = data[inBase + idx1[k] * inStride];
          out[outBase + k * outStride] = v0 + (v1 - v0) * frac[k];
        }
      }
    }
  }
  return { data: out, shape: next };
}

export function resampleZoom(data, shape, newShape, order = 1) {
  if (shape.every((n, a) => n === newShape[a])) return data;
  let current = { data, shape };
  for (const axis of [0, 1, 2]) {
    current = resampleAxis(current.data, current.shape, axis, newShape[axis], order);
  }
  return current.data;
}

// Target C-order shape [nz, ny, nx] for resampling from currentSpacing [sz, sy, sx] to targetSpacing [tz, ty, tx].
export function targetShapeForSpacing(shape, currentSpacing, targetSpacing) {
  return shape.map((n, a) => Math.max(1, roundHalfEven(n * (currentSpacing[a] / targetSpacing[a]))));
}

// nnU-Net CTNormalization: clip to [p005, p995] then (x - mean) / max(std, 1e-8).
export function normalizeCT(data, intensity) {
  const lo = intensity.percentile_00_5;
  const hi = intensity.percentile_99_5;
  const mean = intensity.mean;
  const invStd = 1 / Math.max(intensity.std, 1e-8);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    if (v < lo) v = lo;
    else if (v > hi) v = hi;
    out[i] = (v - mean) * invStd;
  }
  return out;
}

// nnU-Net ZScoreNormalization with use_mask_for_norm = False: normalize over all voxels.
export function normalizeZScore(data) {
  const n = data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - mean;
    sq += d * d;
  }
  const invStd = 1 / Math.max(Math.sqrt(sq / n), 1e-8);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (data[i] - mean) * invStd;
  return out;
}

export function normalizeForModel(data, model) {
  if (model.normalization === 'CTNormalization') return normalizeCT(data, model.ct_intensity);
  return normalizeZScore(data);
}

// Bounding box of nonzero voxels in a C-order [D, H, W] array, matching nnU-Net crop_to_nonzero.
export function nonzeroBoundingBox(data, shape) {
  const [nz, ny, nx] = shape;
  const lo = [nz, ny, nx];
  const hi = [-1, -1, -1];
  let idx = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, idx++) {
        if (data[idx] === 0) continue;
        if (z < lo[0]) lo[0] = z;
        if (z + 1 > hi[0]) hi[0] = z + 1;
        if (y < lo[1]) lo[1] = y;
        if (y + 1 > hi[1]) hi[1] = y + 1;
        if (x < lo[2]) lo[2] = x;
        if (x + 1 > hi[2]) hi[2] = x + 1;
      }
    }
  }
  if (hi[0] < 0) return null;
  return { lo, hi, shape: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

export function cropBox(data, shape, box, OutType = data.constructor) {
  const out = new OutType(product(box.shape));
  let o = 0;
  for (let z = box.lo[0]; z < box.hi[0]; z++) {
    for (let y = box.lo[1]; y < box.hi[1]; y++) {
      const start = (z * shape[1] + y) * shape[2];
      out.set(data.subarray(start + box.lo[2], start + box.hi[2]), o);
      o += box.shape[2];
    }
  }
  return out;
}

export function uncropBox(cropped, fullShape, box, OutType = cropped.constructor) {
  const out = new OutType(product(fullShape));
  let o = 0;
  for (let z = box.lo[0]; z < box.hi[0]; z++) {
    for (let y = box.lo[1]; y < box.hi[1]; y++) {
      const start = (z * fullShape[1] + y) * fullShape[2] + box.lo[2];
      out.set(cropped.subarray(o, o + box.shape[2]), start);
      o += box.shape[2];
    }
  }
  return out;
}

// Keeps the largest 6-connected component of a binary mask (C-order [D, H, W]),
// matching TotalSegmentator's keep_largest_blob_multilabel for body_trunc.
export function keepLargestComponent(mask, shape, targetValue = 1) {
  const [nz, ny, nx] = shape;
  const n = nz * ny * nx;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  let bestIndices = null;

  for (let seed = 0; seed < n; seed++) {
    if (mask[seed] !== targetValue || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      if (x > 0 && mask[i - 1] === targetValue && !visited[i - 1]) { visited[i - 1] = 1; queue[tail++] = i - 1; }
      if (x + 1 < nx && mask[i + 1] === targetValue && !visited[i + 1]) { visited[i + 1] = 1; queue[tail++] = i + 1; }
      if (y > 0 && mask[i - nx] === targetValue && !visited[i - nx]) { visited[i - nx] = 1; queue[tail++] = i - nx; }
      if (y + 1 < ny && mask[i + nx] === targetValue && !visited[i + nx]) { visited[i + nx] = 1; queue[tail++] = i + nx; }
      if (z > 0 && mask[i - nx * ny] === targetValue && !visited[i - nx * ny]) { visited[i - nx * ny] = 1; queue[tail++] = i - nx * ny; }
      if (z + 1 < nz && mask[i + nx * ny] === targetValue && !visited[i + nx * ny]) { visited[i + nx * ny] = 1; queue[tail++] = i + nx * ny; }
    }
    if (!bestIndices || tail > bestIndices.length) bestIndices = queue.slice(0, tail);
  }

  const out = new Uint8Array(n);
  if (bestIndices) {
    for (let k = 0; k < bestIndices.length; k++) out[bestIndices[k]] = targetValue;
  }
  return out;
}

// nnU-Net sliding-window origins along one axis.
export function windowStarts(size, patch, step = STEP) {
  if (size <= patch) return [0];
  const count = Math.ceil((size - patch) / (patch * step)) + 1;
  const stride = (size - patch) / (count - 1);
  return Array.from({ length: count }, (_, i) => roundHalfEven(stride * i));
}

export function windows(shape, patch, step = STEP) {
  const list = [];
  for (const z of windowStarts(shape[0], patch[0], step)) {
    for (const y of windowStarts(shape[1], patch[1], step)) {
      for (const x of windowStarts(shape[2], patch[2], step)) list.push([z, y, x]);
    }
  }
  return list;
}

// Centered Gaussian importance map (sigma = patch / 8), matching nnU-Net compute_gaussian.
export function gaussianWeights(patch) {
  const axis = (n) => Float64Array.from({ length: n }, (_, i) => Math.exp(-((i - Math.floor(n / 2)) ** 2) / (2 * (n / 8) ** 2)));
  const [gz, gy, gx] = patch.map(axis);
  const out = new Float32Array(product(patch));
  let smallest = Infinity;
  let o = 0;
  for (let z = 0; z < patch[0]; z++) {
    for (let y = 0; y < patch[1]; y++) {
      for (let x = 0; x < patch[2]; x++, o++) {
        const w = gz[z] * gy[y] * gx[x] * 10;
        out[o] = w;
        if (w > 0 && w < smallest) smallest = w;
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] === 0) out[i] = smallest;
  return out;
}

function padCentered(image, shape, minimum) {
  const padded = shape.map((n, a) => Math.max(n, minimum[a]));
  const before = padded.map((n, a) => Math.floor((n - shape[a]) / 2));
  if (padded.every((n, a) => n === shape[a])) return { image, shape, before };
  const out = new Float32Array(product(padded));
  for (let z = 0; z < shape[0]; z++) {
    for (let y = 0; y < shape[1]; y++) {
      const src = (z * shape[1] + y) * shape[2];
      const dst = ((z + before[0]) * padded[1] + y + before[1]) * padded[2] + before[2];
      out.set(image.subarray(src, src + shape[2]), dst);
    }
  }
  return { image: out, shape: padded, before };
}

// Reject degenerate all-constant or NaN outputs from broken virtual WebGPU drivers.
export function checkLogits(logits) {
  const first = logits[0];
  let varies = false;
  for (let i = 0; i < logits.length; i++) {
    const value = logits[i];
    if (!Number.isFinite(value)) throw new Error('The network returned non-finite scores.');
    if (value !== first) varies = true;
  }
  if (!varies) throw new Error('The network returned the same score for every voxel.');
}

// Runs one nnU-Net model over a normalized C-order [D, H, W] volume and returns Uint8Array argmax labels.
// Uses a Z-slab ring buffer of depth min(patch[0], shape[0]) over unpadded voxels so peak memory
// stays bounded regardless of scan length along Z.
export async function predictSingleModel({ image, shape, model, runPatch, onPatch = () => {}, signal, useHalf = null }) {
  const patch = model.patch;
  const numClasses = model.num_classes;
  const [sz, sy, sx] = shape;
  const padded = padCentered(image, shape, patch);
  const [bz, by, bx] = padded.before;
  const slabDepth = Math.min(patch[0], sz);
  const sliceVoxels = sy * sx;
  const slabVoxels = slabDepth * sliceVoxels;
  const totalElems = numClasses * slabVoxels;
  if (totalElems > MAX_ACCUM_ELEMENTS) {
    throw new Error(
      `The resampled slab (${slabDepth} × ${sy} × ${sx} × ${numClasses} classes) exceeds browser memory limits. `
      + 'Use the Fast (3 mm) mode or crop the scan first.',
    );
  }

  const zOrigins = windowStarts(padded.shape[0], patch[0]);
  const yOrigins = windowStarts(padded.shape[1], patch[1]);
  const xOrigins = windowStarts(padded.shape[2], patch[2]);
  const totalWindows = zOrigins.length * yOrigins.length * xOrigins.length;
  const weights = gaussianWeights(patch);
  const patchVoxels = product(patch);
  const tile = new Float32Array(patchVoxels);
  const halfBacked = useHalf ?? (totalElems > 16_000_000);
  if (halfBacked) {
    // Keep extreme 3D corner weights above float16 underflow (1e-4 of peak 10) so single-window
    // scan corners never collapse to 0 and tie with background class 0.
    for (let i = 0; i < weights.length; i++) if (weights[i] < 1e-3) weights[i] = 1e-3;
  }
  const sum = halfBacked ? new Uint16Array(totalElems) : new Float32Array(totalElems);
  const labels = new Uint8Array(sz * sliceVoxels);

  let flushedZ = 0;
  const flushUpTo = (limitZ) => {
    const endZ = Math.min(limitZ, sz);
    for (let z = flushedZ; z < endZ; z++) {
      const slotOffset = (z % slabDepth) * sliceVoxels;
      const outBase = z * sliceVoxels;
      for (let i = 0; i < sliceVoxels; i++) {
        const pos = slotOffset + i;
        let bestClass = 0;
        let bestVal = halfBacked ? F16_TO_F32[sum[pos]] : sum[pos];
        for (let c = 1; c < numClasses; c++) {
          const v = halfBacked ? F16_TO_F32[sum[c * slabVoxels + pos]] : sum[c * slabVoxels + pos];
          if (v > bestVal) {
            bestVal = v;
            bestClass = c;
          }
        }
        labels[outBase + i] = bestClass;
      }
      for (let c = 0; c < numClasses; c++) {
        const start = c * slabVoxels + slotOffset;
        sum.fill(0, start, start + sliceVoxels);
      }
    }
    flushedZ = endZ;
  };

  let completed = 0;
  for (const z0 of zOrigins) {
    if (z0 > bz) flushUpTo(z0 - bz);
    for (const y0 of yOrigins) {
      for (const x0 of xOrigins) {
        signal?.throwIfAborted();
        let t = 0;
        for (let z = 0; z < patch[0]; z++) {
          for (let y = 0; y < patch[1]; y++) {
            const start = ((z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
            tile.set(padded.image.subarray(start, start + patch[2]), t);
            t += patch[2];
          }
        }
        const logits = await runPatch(tile, model);
        signal?.throwIfAborted();
        checkLogits(logits);

        const pzStart = Math.max(0, bz - z0);
        const pzEnd = Math.min(patch[0], bz + sz - z0);
        const pyStart = Math.max(0, by - y0);
        const pyEnd = Math.min(patch[1], by + sy - y0);
        const pxStart = Math.max(0, bx - x0);
        const pxEnd = Math.min(patch[2], bx + sx - x0);

        for (let c = 0; c < numClasses; c++) {
          const classDstBase = c * slabVoxels;
          const classSrcBase = c * patchVoxels;
          for (let pz = pzStart; pz < pzEnd; pz++) {
            const slotOffset = ((z0 + pz - bz) % slabDepth) * sliceVoxels;
            const srcZ = pz * patch[1];
            for (let py = pyStart; py < pyEnd; py++) {
              const dstRow = classDstBase + slotOffset + (y0 + py - by) * sx + (x0 - bx);
              const srcRow = (srcZ + py) * patch[2];
              if (halfBacked) {
                for (let px = pxStart; px < pxEnd; px++) {
                  const p = srcRow + px;
                  const dst = dstRow + px;
                  sum[dst] = f32ToF16(F16_TO_F32[sum[dst]] + logits[classSrcBase + p] * weights[p]);
                }
              } else {
                for (let px = pxStart; px < pxEnd; px++) {
                  const p = srcRow + px;
                  sum[dstRow + px] += logits[classSrcBase + p] * weights[p];
                }
              }
            }
          }
        }
        completed++;
        onPatch(completed, totalWindows);
      }
    }
  }

  flushUpTo(sz);
  return { labels, windows: totalWindows };
}

// Predicts one model on a canonical RAS volume: resamples to model.spacing, crops to nonzero,
// normalizes, runs sliding-window inference, and returns labels on the resampled canonical grid.
async function predictCanonicalResampled({ canonical, targetShape, model, runModel, onPatch, signal }) {
  const canShape = [canonical.dims[2], canonical.dims[1], canonical.dims[0]];
  const resampled = resampleZoom(canonical.data, canShape, targetShape, 1);

  // nnU-Net DefaultPreprocessor crops zero borders before normalization and prediction.
  const nzBox = nonzeroBoundingBox(resampled, targetShape);
  if (!nzBox) {
    return { labels: new Uint8Array(product(targetShape)), windows: 0 };
  }
  const cropped = nzBox.shape.every((n, a) => n === targetShape[a])
    ? resampled
    : cropBox(resampled, targetShape, nzBox, Float32Array);
  const normalized = normalizeForModel(cropped, model);

  const predicted = await runModel(model, async (runPatch) => (
    predictSingleModel({
      image: normalized,
      shape: nzBox.shape,
      model,
      runPatch,
      onPatch,
      signal,
    })
  ));

  const labels = nzBox.shape.every((n, a) => n === targetShape[a])
    ? predicted.labels
    : uncropBox(predicted.labels, targetShape, nzBox, Uint8Array);

  return { labels, windows: predicted.windows };
}

// Part model IDs -> LUTs for multi-part tasks.
const PART_LUTS_BY_MODEL = Object.freeze({
  'total-ct-organs': CT_PART_LUTS.organs,
  'total-ct-vertebrae': CT_PART_LUTS.vertebrae,
  'total-ct-cardiac': CT_PART_LUTS.cardiac,
  'total-ct-muscles': CT_PART_LUTS.muscles,
  'total-ct-ribs': CT_PART_LUTS.ribs,
  'total-mr-organs': MR_PART_LUTS.organs,
  'total-mr-muscles': MR_PART_LUTS.muscles,
});

// Validates input geometry and bounds resampled / accumulator memory BEFORE allocating buffers or fetching models.
export function validatePlanMemory({ dims, affine, models, cropModel = null }) {
  if (!dims || dims.length !== 3 || dims.some((d) => !Number.isSafeInteger(d) || d <= 0)) {
    throw new Error('TotalSegmentator requires a valid 3D volume.');
  }
  if (!affine || affine.length !== 4 || affine.some((row) => !row || row.length !== 4 || row.some((v) => !Number.isFinite(v)))) {
    throw new Error('Input volume has a non-finite spatial affine.');
  }
  if (product(dims) > MAX_INPUT_VOXELS) {
    throw new Error(`Input volume (${dims.join(' × ')}) exceeds the 512M voxel limit.`);
  }
  const spacing = voxelSpacing(affine);
  if (spacing.some((s) => !Number.isFinite(s) || s <= 0)) {
    throw new Error('Input volume has invalid (zero or non-finite) voxel spacing.');
  }
  const { invPerm } = canonicalOrientation(affine);
  const canDims = [dims[invPerm[0]], dims[invPerm[1]], dims[invPerm[2]]];
  const canShape = [canDims[2], canDims[1], canDims[0]];
  const canSpacingZyx = [spacing[invPerm[2]], spacing[invPerm[1]], spacing[invPerm[0]]];

  const checkModelGrid = (model, label) => {
    const target = targetShapeForSpacing(canShape, canSpacingZyx, model.spacing);
    if (target.some((n) => !Number.isFinite(n) || n <= 0)) {
      throw new Error(`Invalid resampled grid for ${label}.`);
    }
    const voxels = product(target);
    if (voxels > MAX_RESAMPLED_VOXELS) {
      throw new Error(
        `The resampled volume (${target.join(' × ')} for ${label}) exceeds browser memory limits. `
        + 'Use Fast (3 mm) mode or crop the scan first.',
      );
    }
    const slabDepth = Math.min(model.patch[0], target[0]);
    const slabElems = model.num_classes * slabDepth * target[1] * target[2];
    if (slabElems > MAX_ACCUM_ELEMENTS) {
      throw new Error(
        `The resampled slab (${slabDepth} × ${target[1]} × ${target[2]} × ${model.num_classes} classes) exceeds browser memory limits. `
        + 'Use Fast (3 mm) mode or crop the scan first.',
      );
    }
  };

  if (cropModel) {
    // Only check the crop model upfront; the cropped volume's shape is checked once the trunk box is known.
    checkModelGrid(cropModel, cropModel.id);
  } else {
    for (const model of models) checkModelGrid(model, model.id);
  }
}

// Runs a full TotalSegmentator task (single-model, multi-part, or body-cropped abdominal_muscles).
// `runModel(model, fn)` opens/caches the model's ONNX session, calls `fn(runPatch)`, and releases it.
export async function segmentVolume({
  volume,
  task,
  models,
  cropModel = null,
  runModel,
  onProgress = () => {},
  signal,
}) {
  if (!volume?.data || !volume?.dims || volume.dims.length !== 3) {
    throw new Error('TotalSegmentator requires a 3D NIfTI or DICOM volume.');
  }
  validatePlanMemory({ dims: volume.dims, affine: volume.affine, models, cropModel });

  let workingVolume = volume;
  let cropRegion = null;

  // Optional body_trunc crop (used by abdominal_muscles, matching TotalSegmentator).
  if (cropModel) {
    signal?.throwIfAborted();
    onProgress({ stage: 'crop', part: 0, totalParts: models.length + 1, patch: 0, totalPatches: 1, model: cropModel });
    const { volume: cropCan, orientation: cropOrnt } = asClosestCanonical(volume);
    const cropCanShape = [cropCan.dims[2], cropCan.dims[1], cropCan.dims[0]];
    const cropSpacing = voxelSpacing(cropCan.affine).reverse();
    const cropTarget = targetShapeForSpacing(cropCanShape, cropSpacing, cropModel.spacing);
    const cropPred = await predictCanonicalResampled({
      canonical: cropCan,
      targetShape: cropTarget,
      model: cropModel,
      runModel,
      onPatch: (patch, totalPatches) => onProgress({
        stage: 'crop',
        part: 1,
        totalParts: models.length + 1,
        patch,
        totalPatches,
        model: cropModel,
      }),
      signal,
    });
    const trunkLowRes = keepLargestComponent(cropPred.labels, cropTarget, 1);
    const trunkCan = resampleZoom(trunkLowRes, cropTarget, cropCanShape, 0);
    const trunkOrig = undoCanonical(trunkCan, cropCan.dims, volume.dims, cropOrnt);
    const origShape = [volume.dims[2], volume.dims[1], volume.dims[0]];
    const origSpacingZyx = voxelSpacing(volume.affine).reverse();
    const rawBox = nonzeroBoundingBox(trunkOrig, origShape);
    if (!rawBox) {
      return {
        labels: new Uint8Array(product(volume.dims)),
        dims: [...volume.dims],
        affine: volume.affine.map((row) => [...row]),
        windows: cropPred.windows,
        resampledShape: cropTarget,
      };
    }
    const addon = origSpacingZyx.map((s) => Math.trunc(5 / Math.max(s, 1e-6)));
    const lo = rawBox.lo.map((v, a) => Math.max(0, v - addon[a]));
    const hi = rawBox.hi.map((v, a) => Math.min(origShape[a], v + addon[a]));
    cropRegion = { lo, hi, shape: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
    const croppedData = cropBox(volume.data, origShape, cropRegion, Float32Array);
    const croppedDims = [cropRegion.shape[2], cropRegion.shape[1], cropRegion.shape[0]];
    const croppedAffine = volume.affine.map((row) => [...row]);
    const [bx, by, bz] = [cropRegion.lo[2], cropRegion.lo[1], cropRegion.lo[0]];
    for (let r = 0; r < 3; r++) {
      croppedAffine[r][3] = volume.affine[r][0] * bx + volume.affine[r][1] * by + volume.affine[r][2] * bz + volume.affine[r][3];
    }
    workingVolume = { data: croppedData, dims: croppedDims, affine: croppedAffine };
    validatePlanMemory({ dims: workingVolume.dims, affine: workingVolume.affine, models });
  }

  // Canonical RAS reorientation.
  const { volume: canonical, orientation } = asClosestCanonical(workingVolume);
  const canShape = [canonical.dims[2], canonical.dims[1], canonical.dims[0]];
  const canSpacingZyx = voxelSpacing(canonical.affine).reverse();
  const targetSpacing = models[0].spacing;
  const resampledShape = targetShapeForSpacing(canShape, canSpacingZyx, targetSpacing);
  const resampledVoxels = product(resampledShape);

  const combinedResampled = new Uint8Array(resampledVoxels);
  let totalWindows = 0;
  const totalParts = models.length + (cropModel ? 1 : 0);

  for (let partIdx = 0; partIdx < models.length; partIdx++) {
    signal?.throwIfAborted();
    const model = models[partIdx];
    const partNumber = partIdx + 1 + (cropModel ? 1 : 0);
    const pred = await predictCanonicalResampled({
      canonical,
      targetShape: resampledShape,
      model,
      runModel,
      onPatch: (patch, totalPatches) => onProgress({
        stage: 'predict',
        part: partNumber,
        totalParts,
        patch,
        totalPatches,
        model,
      }),
      signal,
    });
    totalWindows += pred.windows;

    const lut = PART_LUTS_BY_MODEL[model.id];
    if (lut) {
      for (let i = 0; i < resampledVoxels; i++) {
        const local = pred.labels[i];
        if (local !== 0) {
          const globalId = lut[local] ?? 0;
          if (globalId !== 0) combinedResampled[i] = globalId;
        }
      }
    } else {
      combinedResampled.set(pred.labels);
    }
  }

  // Upsample labels back to canonical input grid with nearest neighbor, then undo canonical RAS.
  const canonicalLabels = resampleZoom(combinedResampled, resampledShape, canShape, 0);
  let labels = undoCanonical(canonicalLabels, canonical.dims, workingVolume.dims, orientation);

  if (cropRegion) {
    const fullShape = [volume.dims[2], volume.dims[1], volume.dims[0]];
    labels = uncropBox(labels, fullShape, cropRegion, Uint8Array);
  }

  return {
    labels,
    dims: [...volume.dims],
    affine: volume.affine.map((row) => [...row]),
    task,
    windows: totalWindows,
    resampledShape,
  };
}
