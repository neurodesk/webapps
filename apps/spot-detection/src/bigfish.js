// Port of Big-FISH 0.6.2 spot detection (bigfish.detection, bigfish.stack.log_filter),
// BSD-3-Clause, Copyright (c) 2020, Arthur Imbert.
// See ../LICENSE and ../NOTICE. Each function names the Big-FISH or
// SciPy/NumPy routine it reproduces; the arithmetic order follows theirs so the
// filtered image, the local maxima, the elbow threshold and the spot set equal
// Big-FISH's (validation/reference.json, test/bigfish.test.js).
//
// Images are { data, shape, dtype }: data is a typed array in C order (z, y, x)
// or (y, x); dtype is "uint8", "uint16", "float32" or "float64", the types
// Big-FISH accepts.

export const DTYPES = Object.freeze(["uint8", "uint16", "float32", "float64"]);

// detection.get_object_radius_pixel: radius in pixels per axis.
export function objectRadiusPixel(voxelSizeNm, objectRadiusNm) {
  if (voxelSizeNm.length !== objectRadiusNm.length) throw new Error("Voxel size and spot radius need one value per axis.");
  return voxelSizeNm.map((voxel, axis) => objectRadiusNm[axis] / voxel);
}

// numpy add.reduce on a contiguous float64 vector (NumPy 1.21 pairwise_sum:
// 8 accumulators, blocks of 128).
function pairwise(values, start, n) {
  if (n < 8) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[start + i];
    return sum;
  }
  if (n <= 128) {
    const r = [];
    for (let j = 0; j < 8; j++) r.push(values[start + j]);
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) r[j] += values[start + i + j];
    }
    let sum = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) sum += values[start + i];
    return sum;
  }
  let half = Math.floor(n / 2);
  half -= half % 8;
  return pairwise(values, start, half) + pairwise(values, start + half, n - half);
}

export function numpySum(values) {
  return pairwise(values, 0, values.length);
}

// exp rounded correctly to double, as glibc's exp (which NumPy and SciPy call) is
// in practice; V8's Math.exp can be one ulp off, which moves a few LoG voxels by
// one grey level. Double-double: x = k ln2 + r, Taylor series of exp(r), times 2^k.
const SPLIT = 134217729;
function twoSum(a, b) {
  const s = a + b;
  const v = s - a;
  return [s, (a - (s - v)) + (b - v)];
}
function twoProd(a, b) {
  const p = a * b;
  const ah = a * SPLIT - (a * SPLIT - a);
  const al = a - ah;
  const bh = b * SPLIT - (b * SPLIT - b);
  const bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}
function ddAdd([ah, al], [bh, bl]) {
  const [s, e] = twoSum(ah, bh);
  return twoSum(s, e + al + bl);
}
function ddMul([ah, al], [bh, bl]) {
  const [p, e] = twoProd(ah, bh);
  return twoSum(p, e + ah * bl + al * bh);
}
function ddDivide([h, l], n) {
  const q = h / n;
  const [p, e] = twoProd(q, n);
  return twoSum(q, (h - p - e + l) / n);
}
const LN2 = [0.6931471805599453, 2.3190468138462996e-17];
export function exactExp(x) {
  if (!Number.isFinite(x) || Math.abs(x) > 700) return Math.exp(x);
  const k = Math.round(x / LN2[0]);
  const r = ddAdd([x, 0], ddMul([-k, 0], LN2));
  let term = [1, 0];
  let sum = [1, 0];
  for (let n = 1; n < 40 && Math.abs(term[0]) > 1e-40; n++) {
    term = ddDivide(ddMul(term, r), n);
    sum = ddAdd(sum, term);
  }
  return (sum[0] + sum[1]) * 2 ** k;
}

// scipy.ndimage._filters._gaussian_kernel1d for order 0 and 2.
export function gaussianKernel(sigma, order, radius) {
  const sigma2 = sigma * sigma;
  const factor = -0.5 / sigma2;
  const phi = new Float64Array(2 * radius + 1);
  for (let i = 0; i < phi.length; i++) {
    const x = i - radius;
    phi[i] = exactExp(factor * (x * x));
  }
  const total = numpySum(phi);
  for (let i = 0; i < phi.length; i++) phi[i] /= total;
  if (order === 0) return phi;
  if (order !== 2) throw new Error("Only Gaussian kernels of order 0 and 2 are needed.");
  // q = Q_deriv @ (Q_deriv @ [1, 0, 0]) = [-1/s², 0, 1/s⁴] with p'(x) = 1 / -s².
  const p = 1 / -sigma2;
  const q0 = p;
  const q2 = p * p;
  const kernel = new Float64Array(phi.length);
  for (let i = 0; i < phi.length; i++) {
    const x = i - radius;
    kernel[i] = ((1 * q0 + x * 0) + (x * x) * q2) * phi[i];
  }
  return kernel;
}

// Index into a line of length n with scipy.ndimage mode "reflect" (d c b a | a b c d | d c b a).
function reflect(index, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  let i = index % period;
  if (i < 0) i += period;
  return i < n ? i : period - 1 - i;
}

function strides(shape) {
  const out = new Array(shape.length).fill(1);
  for (let axis = shape.length - 2; axis >= 0; axis--) out[axis] = out[axis + 1] * shape[axis + 1];
  return out;
}

// Visit every 1D line along `axis`: callback(offset of its first element).
function forEachLine(shape, axis, callback) {
  const stride = strides(shape);
  const outer = shape.reduce((n, size, a) => (a === axis ? n : n * size), 1);
  const others = shape.map((_, a) => a).filter((a) => a !== axis);
  const index = new Array(others.length).fill(0);
  for (let line = 0; line < outer; line++) {
    let offset = 0;
    for (let k = 0; k < others.length; k++) offset += index[k] * stride[others[k]];
    callback(offset, stride[axis]);
    for (let k = others.length - 1; k >= 0; k--) {
      if (++index[k] < shape[others[k]]) break;
      index[k] = 0;
    }
  }
}

// scipy.ndimage.correlate1d with a symmetric kernel (NI_Correlate1D's symmetric branch):
// out = in[0] * w[0] + Σ_{j = -r..-1} (in[j] + in[-j]) * w[j], farthest pair first.
// `round` stores each result in the output dtype (Math.fround for float32).
function correlateSymmetric(input, output, shape, axis, kernel, round) {
  const radius = (kernel.length - 1) / 2;
  const n = shape[axis];
  const line = new Float64Array(n + 2 * radius);
  forEachLine(shape, axis, (offset, stride) => {
    for (let i = -radius; i < n + radius; i++) line[i + radius] = input[offset + reflect(i, n) * stride];
    for (let i = 0; i < n; i++) {
      const c = i + radius;
      let acc = line[c] * kernel[radius];
      for (let j = -radius; j < 0; j++) acc += (line[c + j] + line[c - j]) * kernel[radius + j];
      output[offset + i * stride] = round ? Math.fround(acc) : acc;
    }
  });
}

// scipy.ndimage.gaussian_laplace (truncate 4, mode reflect): the sum over axes of
// gaussian_filter with order 2 on that axis, axes filtered in order 0, 1, 2.
export function gaussianLaplace(data, shape, sigma, float32 = false) {
  const size = data.length;
  const Out = float32 ? Float32Array : Float64Array;
  const output = new Out(size);
  const tmp = shape.length > 1 ? new Out(size) : null;
  const kernels = sigma.map((s) => {
    const radius = Math.trunc(4 * s + 0.5);
    return [gaussianKernel(s, 0, radius), gaussianKernel(s, 2, radius)];
  });
  for (let derivative = 0; derivative < shape.length; derivative++) {
    const target = derivative === 0 ? output : tmp;
    for (let axis = 0; axis < shape.length; axis++) {
      const kernel = kernels[axis][axis === derivative ? 1 : 0];
      correlateSymmetric(axis === 0 ? data : target, target, shape, axis, kernel, float32);
    }
    if (derivative > 0) {
      for (let i = 0; i < size; i++) output[i] = float32 ? Math.fround(output[i] + tmp[i]) : output[i] + tmp[i];
    }
  }
  return output;
}

// numpy.rint: round half to even.
function rint(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// skimage img_as_float32 / img_as_float64 for unsigned integers: x * (1 / imax).
function toFloat(image) {
  const { data, dtype } = image;
  if (dtype === "float32" || dtype === "float64") return { values: data, float32: dtype === "float32" };
  const imax = dtype === "uint8" ? 255 : 65535;
  const float32 = dtype === "uint8";
  const scale = float32 ? Math.fround(1 / imax) : 1 / imax;
  const values = float32 ? new Float32Array(data.length) : new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) values[i] = float32 ? Math.fround(data[i] * scale) : data[i] * scale;
  return { values, float32 };
}

// bigfish.stack.log_filter: negative LoG clipped at 0, cast back to the input's
// integer type with skimage img_as_ubyte / img_as_uint (multiply in the filtered
// image's float type, round half to even).
export function logFilter(image, sigma) {
  if (!DTYPES.includes(image.dtype)) throw new Error(`Big-FISH needs a uint8, uint16, float32 or float64 image, not ${image.dtype}.`);
  if (sigma.length !== image.shape.length) throw new Error("The LoG sigma needs one value per image axis.");
  const { values, float32 } = toFloat(image);
  const filtered = gaussianLaplace(values, image.shape, sigma, float32);
  for (let i = 0; i < filtered.length; i++) filtered[i] = filtered[i] < 0 ? -filtered[i] : 0;
  if (image.dtype !== "uint8" && image.dtype !== "uint16") return { data: filtered, shape: image.shape, dtype: image.dtype };
  const imax = image.dtype === "uint8" ? 255 : 65535;
  const out = image.dtype === "uint8" ? new Uint8Array(filtered.length) : new Uint16Array(filtered.length);
  for (let i = 0; i < filtered.length; i++) {
    const v = filtered[i];
    if (v > 1) throw new Error("The LoG response exceeds the integer range Big-FISH casts it to; use a larger spot radius.");
    out[i] = Math.min(imax, rint(float32 ? Math.fround(v * imax) : v * imax));
  }
  return { data: out, shape: image.shape, dtype: image.dtype };
}

// Maximum over a window of `radius` on each side along one axis. Mode reflect only
// mirrors values already inside the window, so the clamped window gives the same maximum.
function maximumAlong(input, output, shape, axis, radius) {
  const n = shape[axis];
  const line = new Float64Array(n);
  forEachLine(shape, axis, (offset, stride) => {
    for (let i = 0; i < n; i++) line[i] = input[offset + i * stride];
    for (let i = 0; i < n; i++) {
      let max = -Infinity;
      const hi = Math.min(n - 1, i + radius);
      for (let j = Math.max(0, i - radius); j <= hi; j++) if (line[j] > max) max = line[j];
      output[offset + i * stride] = max;
    }
  });
}

// detection.local_maximum_detection: image == maximum_filter(image, 2 * ceil(d) + 1).
export function localMaximum(filtered, minDistance) {
  const { data, shape } = filtered;
  const radii = minDistance.map((d) => Math.ceil(d));
  let current = data;
  // A maximum is one of the input's values, so the input's own array type holds it exactly.
  const buffer = new data.constructor(data.length);
  const next = new data.constructor(data.length);
  for (let axis = 0; axis < shape.length; axis++) {
    const target = axis % 2 === 0 ? buffer : next;
    maximumAlong(current, target, shape, axis, radii[axis]);
    current = target;
  }
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) mask[i] = data[i] === current[i] ? 1 : 0;
  return mask;
}

// k-th smallest value (0-based) of the filtered image.
function orderStatistic(filtered, k) {
  const { data, dtype } = filtered;
  if (dtype === "uint8" || dtype === "uint16") {
    const counts = new Float64Array(dtype === "uint8" ? 256 : 65536);
    for (let i = 0; i < data.length; i++) counts[data[i]]++;
    let seen = 0;
    for (let v = 0; v < counts.length; v++) {
      seen += counts[v];
      if (seen > k) return v;
    }
  }
  return Float64Array.from(data).sort()[k];
}

// detection.spot_detection._get_candidate_thresholds with NumPy 1.21's linear
// percentile (below * (1 - w) + above * w), truncated by int().
export function candidateThresholds(filtered) {
  const n = filtered.data.length;
  const index = (99.9999 / 100) * (n - 1);
  const below = Math.floor(index);
  const above = Math.min(below + 1, n - 1);
  const weight = index - below;
  const percentile = orderStatistic(filtered, below) * (1 - weight) + orderStatistic(filtered, above) * weight;
  const end = Math.trunc(percentile);
  if (end < 100) {
    const step = end / 99;
    return Float64Array.from({ length: 100 }, (_, i) => (i === 99 ? end : i * step));
  }
  return Float64Array.from({ length: end + 1 }, (_, i) => i);
}

// stack.centered_moving_average(array, 5): numpy "reflect" padding, then the
// running-sum moving average of stack.moving_average.
export function centeredMovingAverage(values, n = 5) {
  let r;
  if (n % 2 === 0) {
    r = n / 2;
    n += 1;
  } else {
    r = (n - 1) / 2;
  }
  const len = values.length;
  const padded = [];
  const period = 2 * (len - 1);
  for (let i = -r; i < len + r; i++) {
    let j = i;
    if (len > 1) {
      j = ((i % period) + period) % period;
      if (j >= len) j = period - j;
    } else {
      j = 0;
    }
    padded.push(values[j]);
  }
  const cumsum = [0];
  const out = [];
  for (let i = 1; i <= padded.length; i++) {
    cumsum.push(cumsum[i - 1] + padded[i - 1]);
    if (i >= n) out.push((cumsum[i] - cumsum[i - n]) / n);
  }
  return out;
}

// detection.spot_detection._get_spot_counts: log spot count per threshold,
// smoothed, kept where above 2 (and the thresholds truncated to that length).
export function spotCounts(thresholds, values) {
  const sorted = Float64Array.from(values).sort();
  const counts = Array.from(thresholds, (t) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] > t) hi = mid;
      else lo = mid + 1;
    }
    return Math.log(sorted.length - lo);
  });
  const smoothed = centeredMovingAverage(counts, 5).filter((c) => c > 2);
  return { thresholds: Array.from(thresholds.slice(0, smoothed.length)), counts: smoothed };
}

// numpy.gradient with unit spacing and first-order edges.
function gradient(y) {
  const n = y.length;
  if (n < 2) throw new Error("Too few candidate thresholds to find the elbow.");
  const out = new Float64Array(n);
  out[0] = (y[1] - y[0]) / 1;
  out[n - 1] = (y[n - 1] - y[n - 2]) / 1;
  for (let i = 1; i < n - 1; i++) out[i] = (y[i + 1] - y[i - 1]) / 2;
  return out;
}

// detection.utils.get_breaking_point: the elbow of the log-count curve.
export function breakingPoint(x, y) {
  const slope = (y[y.length - 1] - y[0]) / y.length;
  const grad = gradient(y);
  const m = Array.from(grad, (g) => g >= slope);
  const j = m.indexOf(false);
  if (j < 0) throw new Error("The spot count curve has no elbow; set the threshold by hand.");
  const rest = m.slice(j);
  const i = rest.indexOf(true);
  const xs = x.slice(j);
  return Number(xs[i < 0 ? xs.length - 1 : i]);
}

function valuesAboveZero(filtered, mask) {
  const out = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] && filtered.data[i] > 0) out.push(filtered.data[i]);
  return out;
}

// detection.get_elbow_values / automated_threshold_setting for one image.
export function elbowCurve(filtered, mask) {
  const thresholds = candidateThresholds(filtered);
  const curve = spotCounts(thresholds, valuesAboveZero(filtered, mask));
  return { ...curve, threshold: curve.counts.length ? breakingPoint(curve.thresholds, curve.counts) : null };
}

// detection.spots_thresholding with remove_duplicate: connected local maxima above
// the threshold (full connectivity, as skimage.measure.label) collapse to their
// centroid truncated to integers, ordered by first voxel in raster order.
export function thresholdSpots(filtered, mask, threshold) {
  const { data, shape } = filtered;
  const ndim = shape.length;
  const stride = strides(shape);
  const size = data.length;
  const above = new Uint8Array(size);
  for (let i = 0; i < size; i++) above[i] = mask[i] && data[i] > threshold ? 1 : 0;
  const offsets = [];
  const deltas = [];
  for (let k = 0; k < 3 ** ndim; k++) {
    const d = [];
    let rest = k;
    for (let a = 0; a < ndim; a++) {
      d.unshift((rest % 3) - 1);
      rest = Math.floor(rest / 3);
    }
    if (d.some((v) => v !== 0)) deltas.push(d);
  }
  for (const d of deltas) offsets.push(d.reduce((s, v, a) => s + v * stride[a], 0));
  const seen = new Uint8Array(size);
  const coord = new Array(ndim);
  const spots = [];
  for (let start = 0; start < size; start++) {
    if (!above[start] || seen[start]) continue;
    const sum = new Array(ndim).fill(0);
    let count = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const index = stack.pop();
      let rest = index;
      for (let a = 0; a < ndim; a++) {
        coord[a] = Math.floor(rest / stride[a]);
        rest -= coord[a] * stride[a];
        sum[a] += coord[a];
      }
      count++;
      for (let k = 0; k < deltas.length; k++) {
        let inside = true;
        for (let a = 0; a < ndim; a++) {
          const c = coord[a] + deltas[k][a];
          if (c < 0 || c >= shape[a]) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;
        const neighbour = index + offsets[k];
        if (above[neighbour] && !seen[neighbour]) {
          seen[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    spots.push(sum.map((s) => Math.trunc(s / count)));
  }
  return spots;
}

// detection.detect_spots for one image with voxel size and spot radius (nm).
// `threshold` null or undefined selects Big-FISH's automatic elbow threshold; a given
// threshold skips the elbow search, as Big-FISH does, so `curve` is then null.
export function detectSpots(image, { voxelSize, spotRadius, threshold = null, onProgress = () => {} }) {
  const sigma = objectRadiusPixel(voxelSize, spotRadius);
  if (sigma.length !== image.shape.length) throw new Error(`Give ${image.shape.length} voxel sizes and spot radii for a ${image.shape.length}D image.`);
  onProgress("LoG filter", 0.1);
  const filtered = logFilter(image, sigma);
  onProgress("Local maxima", 0.6);
  const mask = localMaximum(filtered, sigma);
  onProgress("Threshold", 0.75);
  const curve = threshold === null ? elbowCurve(filtered, mask) : null;
  const used = threshold ?? curve.threshold;
  const spots = used === null ? [] : thresholdSpots(filtered, mask, used);
  return { sigma, filtered, threshold: used, automaticThreshold: curve?.threshold ?? null, curve, spots };
}

// stack.maximum_projection: the maximum over z of a 3D stack.
export function maximumProjection(image) {
  const [nz, ny, nx] = image.shape;
  const plane = ny * nx;
  const data = new image.data.constructor(plane);
  data.set(image.data.subarray(0, plane));
  for (let z = 1; z < nz; z++) {
    const offset = z * plane;
    for (let i = 0; i < plane; i++) if (image.data[offset + i] > data[i]) data[i] = image.data[offset + i];
  }
  return { data, shape: [ny, nx], dtype: image.dtype };
}
