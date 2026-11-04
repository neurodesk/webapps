// SPDX-License-Identifier: Apache-2.0
// The NumPy and SciPy steps of sdcflows 2.17.1's SyN-SDC workflows (niworkflows 1.15.3,
// NumPy 2.5.4, SciPy 1.18.1, scikit-image 0.26.0), ported to JavaScript with the same dtypes:
// a float32 step rounds every operation with Math.fround, as NumPy computes it.
// Volumes are x-fastest, as NIfTI stores them; `dims` is [nx, ny, nz].

const f32 = Math.fround;

/** skimage.morphology.ball(radius): the offsets [dx, dy, dz] with dx² + dy² + dz² <= radius². */
export function ball(radius) {
  const offsets = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dy * dy + dz * dz <= radius * radius) offsets.push([dx, dy, dz]);
      }
    }
  }
  return offsets;
}

/** SciPy's 'reflect' extension (d c b a | a b c d | d c b a) of index i on an axis of length n. */
function reflect(i, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  i %= period;
  if (i < 0) i += period;
  return i < n ? i : period - 1 - i;
}

/** The k-th smallest of values[0..length) (0-based), reordering values. */
function select(values, length, k) {
  let left = 0;
  let right = length - 1;
  while (right > left) {
    const pivot = values[(left + right) >> 1];
    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const t = values[i];
        values[i] = values[j];
        values[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return values[k];
  }
  return values[k];
}

/** scipy.ndimage.median_filter(data, footprint=ball(radius)) with mode 'reflect'. */
export function medianFilterBall(data, dims, radius = 3) {
  const [nx, ny, nz] = dims;
  const offsets = ball(radius);
  const size = offsets.length;
  const rank = size >> 1;
  const steps = Int32Array.from(offsets, ([dx, dy, dz]) => dx + nx * (dy + ny * dz));
  const window = new Float64Array(size);
  const out = new Float32Array(data.length);
  for (let z = 0; z < nz; z++) {
    const zInside = z >= radius && z < nz - radius;
    for (let y = 0; y < ny; y++) {
      const yzInside = zInside && y >= radius && y < ny - radius;
      for (let x = 0; x < nx; x++) {
        const index = x + nx * (y + ny * z);
        if (yzInside && x >= radius && x < nx - radius) {
          let same = true;
          const first = data[index + steps[0]];
          for (let o = 0; o < size; o++) {
            const value = data[index + steps[o]];
            window[o] = value;
            if (value !== first) same = false;
          }
          out[index] = same ? first : select(window, size, rank);
        } else {
          for (let o = 0; o < size; o++) {
            const [dx, dy, dz] = offsets[o];
            window[o] = data[reflect(x + dx, nx) + nx * (reflect(y + dy, ny) + ny * reflect(z + dz, nz))];
          }
          out[index] = select(window, size, rank);
        }
      }
    }
  }
  return out;
}

/**
 * numpy.percentile(values, q) with the default 'linear' method. `float32` follows NumPy's
 * float32 path, in which the interpolation weight is a Python float and every step rounds.
 * `values` must be sorted ascending.
 */
export function percentileSorted(values, q, { float32 = false } = {}) {
  const n = values.length;
  if (!n) throw new Error('The percentile of an empty set is undefined.');
  const virtual = (n - 1) * (q / 100);
  const previous = Math.floor(virtual);
  if (virtual >= n - 1) return values[n - 1];
  if (virtual < 0) return values[0];
  const a = values[previous];
  const b = values[previous + 1];
  const t = virtual - previous;
  if (!float32) {
    const diff = b - a;
    return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
  }
  const diff = f32(b - a);
  return t >= 0.5 ? f32(b - f32(diff * f32(1 - t))) : f32(a + f32(diff * f32(t)));
}

/** NumPy's round half to even. */
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * niworkflows `_advanced_clip` (IntensityClip): percentiles of the median-filtered positive
 * voxels bound the float32 image, which is scaled to [0, 1] and, for an integer output,
 * rounded to [0, 255]. Returns an Int16Array (dtype 'int16') or a Float32Array ('float32').
 */
export function advancedClip(data, dims, { pMin = 35, pMax = 99.98, dtype = 'int16' } = {}) {
  const image = data instanceof Float32Array ? data : Float32Array.from(data);
  const denoised = medianFilterBall(image, dims, 3);
  let count = 0;
  for (const value of denoised) if (value > 0) count++;
  if (!count) throw new Error('The image has no positive voxel to set its intensity range from.');
  const positive = new Float32Array(count);
  let k = 0;
  for (const value of denoised) if (value > 0) positive[k++] = value;
  positive.sort();
  const low = percentileSorted(positive, pMin, { float32: true });
  const high = percentileSorted(positive, pMax, { float32: true });
  const clipped = new Float32Array(image.length);
  let min = Infinity;
  for (let i = 0; i < image.length; i++) {
    const value = Math.min(Math.max(image[i], low), high);
    clipped[i] = value;
    if (value < min) min = value;
  }
  let max = -Infinity;
  for (let i = 0; i < clipped.length; i++) {
    clipped[i] = f32(clipped[i] - min);
    if (clipped[i] > max) max = clipped[i];
  }
  for (let i = 0; i < clipped.length; i++) clipped[i] = f32(clipped[i] / max);
  if (dtype === 'float32') return clipped;
  if (dtype !== 'int16') throw new Error(`Unsupported clip dtype ${dtype}.`);
  return Int16Array.from(clipped, (value) => roundHalfEven(f32(255 * value)));
}

/** scipy.ndimage.binary_dilation(mask > 0, ball(radius)), border 0, as uint8. */
export function dilateBall(mask, dims, radius = 3) {
  const [nx, ny, nz] = dims;
  const offsets = ball(radius);
  const out = new Uint8Array(mask.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!(mask[x + nx * (y + ny * z)] > 0)) continue;
        for (const [dx, dy, dz] of offsets) {
          const i = x + dx;
          const j = y + dy;
          const k = z + dz;
          if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz) out[i + nx * (j + ny * k)] = 1;
        }
      }
    }
  }
  return out;
}

/** numpy.median of a copy of the values (float64). */
function median(values) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const middle = n >> 1;
  return n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * sdcflows `_norm_lap`: subtract the median, scale the positive part by its 99.8th percentile
 * and the negative part by its 0.2th, clip to [-1, 1]; float64, written as float32.
 */
export function normalizeLaplacian(values) {
  const data = Float64Array.from(values);
  const centre = median(data);
  let positives = 0;
  let negatives = 0;
  for (let i = 0; i < data.length; i++) {
    data[i] -= centre;
    if (data[i] > 0) positives++;
    else if (data[i] < 0) negatives++;
  }
  const up = new Float64Array(positives);
  const down = new Float64Array(negatives);
  let p = 0;
  let n = 0;
  for (const value of data) {
    if (value > 0) up[p++] = value;
    else if (value < 0) down[n++] = value;
  }
  const lMax = percentileSorted(up.sort(), 99.8);
  const lMin = percentileSorted(down.sort(), 0.2);
  const negativeScale = -1.0 / lMin;
  const positiveScale = 1.0 / lMax;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    let value = data[i];
    if (value < 0) value *= negativeScale;
    else if (value > 0) value *= positiveScale;
    out[i] = Math.min(Math.max(value, -1), 1);
  }
  return out;
}

/**
 * SciPy's cubic spline prefilter (spline_filter, order 3, float64) with the mirror boundary
 * that SciPy uses for mode 'constant', applied along x, then y, then z, in place.
 */
export function splineFilter3(coefficients, dims) {
  const z = Math.sqrt(3) - 2;
  const gain = (1 - z) * (1 - 1 / z);
  const [nx, ny, nz] = dims;
  const strides = [1, nx, nx * ny];
  const lengths = [nx, ny, nz];
  for (let axis = 0; axis < 3; axis++) {
    const n = lengths[axis];
    if (n === 1) continue;
    const stride = strides[axis];
    const line = new Float64Array(n);
    const zN1 = Math.pow(z, n - 1);
    const others = coefficients.length / n;
    for (let o = 0; o < others; o++) {
      // The start of the o-th line along this axis.
      let start;
      if (axis === 0) start = o * nx;
      else if (axis === 1) start = (o % nx) + nx * ny * Math.floor(o / nx);
      else start = o;
      for (let i = 0; i < n; i++) line[i] = coefficients[start + i * stride] * gain;
      // _init_causal_mirror
      let zi = z;
      line[0] = line[0] + zN1 * line[n - 1];
      for (let i = 1; i < n - 1; i++) {
        line[0] += zi * (line[i] + zN1 * line[n - 1 - i]);
        zi *= z;
      }
      line[0] /= 1 - zN1 * zN1;
      for (let i = 1; i < n; i++) line[i] += z * line[i - 1];
      // _init_anticausal_mirror
      line[n - 1] = ((z * line[n - 2] + line[n - 1]) * z) / (z * z - 1);
      for (let i = n - 2; i >= 0; i--) line[i] = z * (line[i + 1] - line[i]);
      for (let i = 0; i < n; i++) coefficients[start + i * stride] = line[i];
    }
  }
  return coefficients;
}

/** SciPy's cubic B-spline weights at the fractional position of x. */
function cubicWeights(x, weights) {
  const t = x - Math.floor(x);
  const y = t;
  const w = 1 - t;
  weights[0] = (w * w * w) / 6;
  weights[1] = (y * y * (y - 2) * 3 + 4) / 6;
  weights[2] = (w * w * (w - 2) * 3 + 4) / 6;
  weights[3] = 1 - (weights[0] + weights[1] + weights[2]);
}

/** The mirror index SciPy reads beyond an edge (d c b | a b c d | c b a). */
function mirror(i, n) {
  if (n <= 1) return 0;
  const s2 = 2 * n - 2;
  if (i < 0) {
    i = s2 * Math.trunc(-i / s2) + i;
    return i <= 1 - n ? i + s2 : -i;
  }
  if (i >= n) {
    i -= s2 * Math.trunc(i / s2);
    return i >= n ? s2 - i : i;
  }
  return i;
}

/**
 * scipy.ndimage.map_coordinates(data, coordinates, order=3, mode='constant', cval=0,
 * prefilter=True) at the points (x[i], y[i], z[i]) in voxel units, from prefiltered
 * float64 `coefficients` (splineFilter3). A point outside [0, n - 1] on any axis gives 0.
 */
export function sampleCubic(coefficients, dims, x, y, z, out) {
  const [nx, ny, nz] = dims;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const wz = new Float64Array(4);
  const ix = new Int32Array(4);
  const iy = new Int32Array(4);
  const iz = new Int32Array(4);
  for (let p = 0; p < out.length; p++) {
    const cx = x[p];
    const cy = y[p];
    const cz = z[p];
    if (!(cx >= 0 && cx <= nx - 1 && cy >= 0 && cy <= ny - 1 && cz >= 0 && cz <= nz - 1)) {
      out[p] = 0;
      continue;
    }
    const sx = Math.floor(cx) - 1;
    const sy = Math.floor(cy) - 1;
    const sz = Math.floor(cz) - 1;
    for (let l = 0; l < 4; l++) {
      ix[l] = mirror(sx + l, nx);
      iy[l] = mirror(sy + l, ny) * nx;
      iz[l] = mirror(sz + l, nz) * nx * ny;
    }
    cubicWeights(cx, wx);
    cubicWeights(cy, wy);
    cubicWeights(cz, wz);
    let t = 0;
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        for (let c = 0; c < 4; c++) {
          t += coefficients[ix[a] + iy[b] + iz[c]] * wx[a] * wy[b] * wz[c];
        }
      }
    }
    out[p] = t;
  }
  return out;
}

/** numpy.gradient of a float32 volume along one axis (unit spacing, edge_order 1). */
export function gradient(values, dims, axis) {
  const [nx, ny] = dims;
  const n = dims[axis];
  const stride = [1, nx, nx * ny][axis];
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const position = Math.floor(i / stride) % n;
    if (n < 2) out[i] = 0;
    else if (position === 0) out[i] = f32(values[i + stride] - values[i]);
    else if (position === n - 1) out[i] = f32(values[i] - values[i - stride]);
    else out[i] = f32(f32(values[i + stride] - values[i - stride]) / 2);
  }
  return out;
}

/**
 * The float32 voxels that nibabel reads back after writing float64 `values` into an int16
 * header, as nipype's N4BiasFieldCorrection(copy_header=True) does with the input's header:
 * slope and intercept map the range onto -32768..32767 and are stored as float32, the voxels
 * are rounded half to even, and reading scales them in float32.
 */
export function int16RoundTrip(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const out = new Float32Array(values.length);
  if (min === max) {
    out.fill(min);
    return out;
  }
  const exactSlope = (max - min) / 65535;
  const slope = f32(exactSlope);
  const inter = f32(min + 32768 * exactSlope);
  for (let i = 0; i < values.length; i++) {
    const raw = Math.min(32767, Math.max(-32768, roundHalfEven((values[i] - inter) / slope)));
    out[i] = f32(f32(raw * slope) + inter);
  }
  return out;
}
