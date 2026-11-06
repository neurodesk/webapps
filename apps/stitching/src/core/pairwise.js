// Pairwise registration of two overlapping tiles by phase correlation, after Preibisch,
// Saalfeld & Tomancak 2009 (Bioinformatics 25:1463), written from the paper.
//
// The approximate layout says where tile B lies relative to tile A. Both tiles are cut to the
// region they share under that layout, the mean is removed and each region is mirrored and
// faded to zero into a power-of-two FFT frame (so the frame edges add no cross of their own).
// The phase correlation matrix, the inverse FFT of A·conj(B)/|A·conj(B)|, has a peak at the
// translation between the two regions, but only modulo the frame: a peak at p means a shift of
// p or p − N along each axis. Each of the strongest peaks is therefore expanded into its 2^d
// possible shifts and every shift is scored by the Pearson correlation of the two regions where
// they overlap after that shift. The best-scoring shift is moved uphill in cross-correlation to
// its integer maximum, and its sub-pixel part comes from a parabola through the correlation at
// that maximum and its two neighbours along each axis. (A fit to the phase correlation peak
// itself was biased by up to a pixel on synthetic pairs with partial overlap; the
// cross-correlation fit was not, see test/pairwise.test.js.)
//
// Tiles: { shape: [nx, ny] or [nx, ny, nz] (x fastest), data: typed array }.
// Offsets are B's position minus A's position, in pixels, x first.
import { fftn, nextPowerOfTwo } from './fft.js';

export const PAIRWISE_DEFAULTS = Object.freeze({
  /** Phase correlation peaks checked by cross-correlation (Fiji's default is 5). */
  peaks: 5,
  /**
   * A candidate shift must keep this fraction of the region overlapping along every axis, so the
   * layout's overlap may be up to four times the true overlap. Smaller overlaps let a few pixels
   * of noise outscore the true shift.
   */
  minOverlap: 0.25,
});

function product(shape) {
  return shape.reduce((a, b) => a * b, 1);
}

function strides(shape) {
  const out = [];
  let stride = 1;
  for (const n of shape) {
    out.push(stride);
    stride *= n;
  }
  return out;
}

/**
 * The region the two tiles share when B sits at `offset` (integers) from A, in A's
 * coordinates, or null when they do not overlap by at least one pixel along every axis.
 */
export function overlapRegion(shapeA, shapeB, offset) {
  const lo = [];
  const size = [];
  for (let d = 0; d < shapeA.length; d++) {
    const start = Math.max(0, offset[d]);
    const end = Math.min(shapeA[d], offset[d] + shapeB[d]);
    if (end - start < 1) return null;
    lo.push(start);
    size.push(end - start);
  }
  return { lo, size };
}

/** A box of `tile` starting at `lo` with `size`, as float64. */
export function extractRegion(tile, lo, size) {
  const out = new Float64Array(product(size));
  const [nx, ny] = tile.shape;
  const [sx, sy = 1, sz = 1] = size;
  const [x0, y0 = 0, z0 = 0] = lo;
  let k = 0;
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      const row = ((z0 + z) * ny + (y0 + y)) * nx + x0;
      for (let x = 0; x < sx; x++) out[k++] = tile.data[row + x];
    }
  }
  return out;
}

function mean(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

// Per axis: for each index of the FFT frame, the source index (mirrored past the edges) and
// its weight (1 inside, a raised cosine to 0 across the padding, split between the two sides).
function axisExtension(size, frame) {
  const source = new Int32Array(frame);
  const weight = new Float64Array(frame);
  const half = (frame - size) / 2;
  for (let i = 0; i < frame; i++) {
    if (i < size) {
      source[i] = i;
      weight[i] = 1;
      continue;
    }
    const right = i - size + 1;
    const left = frame - i;
    const distance = Math.min(right, left);
    const mirrored = right <= left ? size - 1 - right : left;
    source[i] = Math.min(size - 1, Math.max(0, mirrored));
    const t = distance / (half + 1);
    weight[i] = t >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * t));
  }
  return { source, weight };
}

/** The FFT frame for a region: at least 5 % (and 4 px) of padding per axis, power of two. */
export function frameShape(size) {
  return size.map((n) => (n === 1 ? 1 : nextPowerOfTwo(n + 2 * Math.max(4, Math.ceil(0.05 * n)))));
}

function extendIntoFrame(region, size, frame) {
  const average = mean(region);
  const axes = size.map((n, d) => axisExtension(n, frame[d]));
  const [fx, fy = 1, fz = 1] = frame;
  const [sx, sy = 1] = size;
  const out = new Float64Array(product(frame));
  const ax = axes[0];
  const ay = axes[1] ?? { source: [0], weight: [1] };
  const az = axes[2] ?? { source: [0], weight: [1] };
  let k = 0;
  for (let z = 0; z < fz; z++) {
    const wz = az.weight[z];
    const rz = az.source[z] * sy;
    for (let y = 0; y < fy; y++) {
      const wzy = wz * ay.weight[y];
      const row = (rz + ay.source[y]) * sx;
      for (let x = 0; x < fx; x++) {
        const w = wzy * ax.weight[x];
        out[k++] = w === 0 ? 0 : w * (region[row + ax.source[x]] - average);
      }
    }
  }
  return out;
}

/**
 * The phase correlation matrix of two regions of the same size, in an FFT frame. Both real
 * regions go through one complex FFT (A + iB) and are separated by conjugate symmetry.
 */
export function phaseCorrelation(regionA, regionB, size) {
  const frame = frameShape(size);
  const total = product(frame);
  const re = extendIntoFrame(regionA, size, frame);
  const im = extendIntoFrame(regionB, size, frame);
  fftn(re, im, frame);
  const outRe = new Float64Array(total);
  const outIm = new Float64Array(total);
  const [fx, fy = 1, fz = 1] = frame;
  for (let z = 0; z < fz; z++) {
    const nz = (fz - z) % fz;
    for (let y = 0; y < fy; y++) {
      const ny = (fy - y) % fy;
      for (let x = 0; x < fx; x++) {
        const k = x + (y + z * fy) * fx;
        const m = ((fx - x) % fx) + (ny + nz * fy) * fx;
        // A = (X_k + conj X_-k) / 2, B = (X_k − conj X_-k) / 2i
        const aRe = (re[k] + re[m]) / 2;
        const aIm = (im[k] - im[m]) / 2;
        const bRe = (im[k] + im[m]) / 2;
        const bIm = (re[m] - re[k]) / 2;
        const cRe = aRe * bRe + aIm * bIm;
        const cIm = aIm * bRe - aRe * bIm;
        const magnitude = Math.hypot(cRe, cIm);
        if (magnitude > 1e-12) {
          outRe[k] = cRe / magnitude;
          outIm[k] = cIm / magnitude;
        }
      }
    }
  }
  fftn(outRe, outIm, frame, true);
  return { pcm: outRe, frame };
}

function wrap(i, n) {
  return ((i % n) + n) % n;
}

/** The `count` highest local maxima of a periodic array, strongest first, as index vectors. */
export function findPeaks(values, shape, count) {
  const stride = strides(shape);
  const dims = shape.length;
  const offsets = [];
  const walk = (d, current) => {
    if (d === dims) {
      if (current.some((v) => v !== 0)) offsets.push([...current]);
      return;
    }
    for (const v of [-1, 0, 1]) walk(d + 1, [...current, shape[d] > 1 ? v : 0]);
  };
  walk(0, []);
  const unique = [...new Map(offsets.map((o) => [o.join(','), o])).values()];
  const peaks = [];
  const position = new Array(dims).fill(0);
  for (let index = 0; index < values.length; index++) {
    let rest = index;
    for (let d = 0; d < dims; d++) {
      position[d] = rest % shape[d];
      rest = Math.floor(rest / shape[d]);
    }
    const value = values[index];
    if (peaks.length === count && value <= peaks[peaks.length - 1].value) continue;
    let isMax = true;
    for (const offset of unique) {
      let neighbour = 0;
      for (let d = 0; d < dims; d++) neighbour += wrap(position[d] + offset[d], shape[d]) * stride[d];
      if (values[neighbour] > value) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    peaks.push({ position: [...position], value });
    peaks.sort((a, b) => b.value - a.value);
    if (peaks.length > count) peaks.pop();
  }
  return peaks;
}

/**
 * Pearson correlation of region A and region B moved by `shift` (A(x) against B(x − shift)),
 * over the pixels where both exist.
 */
export function shiftedCorrelation(regionA, regionB, size, shift) {
  const [sx, sy = 1, sz = 1] = size;
  const [tx, ty = 0, tz = 0] = shift;
  const x0 = Math.max(0, tx);
  const x1 = Math.min(sx, sx + tx);
  const y0 = Math.max(0, ty);
  const y1 = Math.min(sy, sy + ty);
  const z0 = Math.max(0, tz);
  const z1 = Math.min(sz, sz + tz);
  if (x1 <= x0 || y1 <= y0 || z1 <= z0) return { r: -Infinity, pixels: 0 };
  let n = 0;
  let meanA = 0;
  let meanB = 0;
  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  const originA = regionA[(z0 * sy + y0) * sx + x0];
  const originB = regionB[((z0 - tz) * sy + y0 - ty) * sx + x0 - tx];
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      const rowA = (z * sy + y) * sx;
      const rowB = ((z - tz) * sy + (y - ty)) * sx - tx;
      for (let x = x0; x < x1; x++) {
        const a = regionA[rowA + x] - originA;
        const b = regionB[rowB + x] - originB;
        n++;
        const deltaA = a - meanA;
        const deltaB = b - meanB;
        meanA += deltaA / n;
        meanB += deltaB / n;
        varianceA += deltaA * (a - meanA);
        varianceB += deltaB * (b - meanB);
        covariance += deltaA * (b - meanB);
      }
    }
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return { r: denominator > 0 ? covariance / denominator : 0, pixels: n };
}

function candidateShifts(position, frame, size, minOverlap) {
  let shifts = [[]];
  for (let d = 0; d < position.length; d++) {
    const options = frame[d] === 1 ? [0] : [position[d], position[d] - frame[d]];
    const minimum = Math.max(1, Math.ceil(minOverlap * size[d]));
    const allowed = [...new Set(options)].filter((t) => size[d] - Math.abs(t) >= minimum);
    shifts = shifts.flatMap((prefix) => allowed.map((t) => [...prefix, t]));
  }
  return shifts;
}

/**
 * Registers tile B to tile A near the approximate offset.
 * @returns {{ offset: number[], r: number, region: { lo: number[], size: number[] }, candidates: number } | null}
 *   null when the tiles do not overlap under the approximate layout or no shift can be scored.
 */
export function registerPair(tileA, tileB, approximateOffset, options = {}) {
  const { peaks, minOverlap } = { ...PAIRWISE_DEFAULTS, ...options };
  const start = approximateOffset.map((v) => Math.round(v));
  const region = overlapRegion(tileA.shape, tileB.shape, start);
  if (!region) return null;
  const { lo, size } = region;
  const regionA = extractRegion(tileA, lo, size);
  const regionB = extractRegion(tileB, lo.map((v, d) => v - start[d]), size);
  const { pcm, frame } = phaseCorrelation(regionA, regionB, size);
  let best = null;
  let candidates = 0;
  for (const peak of findPeaks(pcm, frame, peaks)) {
    for (const shift of candidateShifts(peak.position, frame, size, minOverlap)) {
      candidates++;
      const { r } = shiftedCorrelation(regionA, regionB, size, shift);
      if (!best || r > best.r) best = { r, shift, peak };
    }
  }
  if (!best || !Number.isFinite(best.r)) return null;
  const refined = refineShift(regionA, regionB, size, best.shift, best.r, minOverlap);
  const offset = start.map((v, d) => v + refined.shift[d]);
  return { offset, r: refined.r, pixels: refined.pixels, region, candidates };
}

/**
 * Moves an integer shift uphill in cross-correlation to its local maximum, then fits a parabola
 * through r at the maximum and its two neighbours along each axis for the sub-pixel part.
 */
export function refineShift(regionA, regionB, size, shift, r, minOverlap = PAIRWISE_DEFAULTS.minOverlap) {
  const cache = new Map();
  const measure = (s) => {
    const key = s.join(',');
    if (!cache.has(key)) {
      const allowed = s.every((t, d) => size[d] - Math.abs(t) >= Math.max(1, Math.ceil(minOverlap * size[d])));
      cache.set(key, allowed ? shiftedCorrelation(regionA, regionB, size, s) : { r: -Infinity, pixels: 0 });
    }
    return cache.get(key);
  };
  const score = (s) => measure(s).r;
  let current = [...shift];
  let value = r;
  for (let step = 0; step < 8; step++) {
    let next = null;
    for (let d = 0; d < current.length; d++) {
      if (size[d] === 1) continue;
      for (const delta of [-1, 1]) {
        const candidate = [...current];
        candidate[d] += delta;
        const candidateValue = score(candidate);
        if (candidateValue > value && (!next || candidateValue > next.value)) next = { shift: candidate, value: candidateValue };
      }
    }
    if (!next) break;
    current = next.shift;
    value = next.value;
  }
  const fraction = current.map((_, d) => {
    if (size[d] === 1) return 0;
    const before = [...current];
    const after = [...current];
    before[d] -= 1;
    after[d] += 1;
    const a = score(before);
    const c = score(after);
    const curvature = a - 2 * value + c;
    if (!Number.isFinite(curvature) || !(curvature < 0)) return 0;
    return Math.max(-0.5, Math.min(0.5, (a - c) / (2 * curvature)));
  });
  return { shift: current.map((v, d) => v + fraction[d]), r: value, pixels: measure(current).pixels };
}
