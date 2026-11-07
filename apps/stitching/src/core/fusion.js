// Fusion of placed tiles into one image with linear blending: every output pixel is the
// weighted mean of the tiles that cover it, each tile sampled by linear interpolation at its
// sub-pixel position and weighted by the product over axes of its distance to the tile's
// nearest edge (in pixels, from 1 at the outermost pixel), so seams fade across the overlap.
// Pixels no tile covers are 0.
//
// 8- and 16-bit tiles accumulate the weighted sum and the weights in float32, which holds every
// value of those types exactly. 32-bit integer and float tiles accumulate in float64 as a running
// weighted mean (mean += w / W · (value − mean)), so a pixel one tile covers keeps its value
// exactly (uint32 16777217 stays 16777217) and no weighted sum can overflow (float32 3e38,
// float64 1e100).
//
// Positions are pixel coordinates of each tile's first pixel; the fused image starts at the
// floor of the smallest position along each axis.

/** The fused image's origin (pixels, integer) and shape for tiles of `shapes` at `positions`. */
export function fusedGeometry(shapes, positions) {
  const dims = shapes[0].length;
  const origin = [];
  const shape = [];
  for (let d = 0; d < dims; d++) {
    const low = Math.min(...positions.map((p) => p[d]));
    const high = Math.max(...positions.map((p, k) => p[d] + shapes[k][d]));
    const start = Math.floor(low + 1e-9);
    origin.push(start);
    shape.push(Math.max(1, Math.ceil(high - 1e-9) - start));
  }
  return { origin, shape };
}

function edgeWeights(n) {
  const weights = new Float64Array(n);
  for (let i = 0; i < n; i++) weights[i] = Math.min(i + 1, n - i);
  return weights;
}

// For one axis of one tile: the output range it covers and, per output index, the source index,
// the interpolation fraction and the blending weight (interpolated between neighbouring pixels).
function axisSampling(position, origin, outSize, size) {
  const shift = position - origin;
  const first = Math.max(0, Math.ceil(shift - 1e-9));
  const last = Math.min(outSize - 1, Math.floor(shift + size - 1 + 1e-9));
  const count = Math.max(0, last - first + 1);
  const index = new Int32Array(count);
  const fraction = new Float64Array(count);
  const weight = new Float64Array(count);
  const edges = edgeWeights(size);
  for (let k = 0; k < count; k++) {
    const u = Math.min(size - 1, Math.max(0, first + k - shift));
    const i0 = Math.min(size - 1, Math.floor(u));
    const f = size === 1 ? 0 : u - i0;
    index[k] = i0;
    fraction[k] = f;
    weight[k] = f > 0 ? edges[i0] * (1 - f) + edges[Math.min(size - 1, i0 + 1)] * f : edges[i0];
  }
  return { first, count, index, fraction, weight };
}

const NARROW = [Uint8Array, Uint16Array, Int8Array, Int16Array];

/** Whether tiles of this typed array accumulate in float64 (32-bit integers and floats). */
export function accumulatesInFloat64(data) {
  return !NARROW.some((Type) => data instanceof Type);
}

/** Whether tiles of this sample type accumulate in float64. */
export function accumulatesInFloat64Type(dtype) {
  return !['uint8', 'uint16', 'int8', 'int16'].includes(dtype);
}

/**
 * @param {{ shape: number[], data: ArrayLike<number> }[]} tiles
 * @param {number[][]} positions
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [options]
 * @returns {{ data: Float32Array | Float64Array, shape: number[], origin: number[] }}
 *   Float32Array for 8- and 16-bit tiles, Float64Array otherwise.
 */
export function fuseTiles(tiles, positions, { onProgress, signal } = {}) {
  const shapes = tiles.map((tile) => tile.shape);
  const { origin, shape } = fusedGeometry(shapes, positions);
  const [ox, oy = 1, oz = 1] = shape;
  const total = ox * oy * oz;
  const wide = tiles.some((tile) => accumulatesInFloat64(tile.data));
  const Accumulator = wide ? Float64Array : Float32Array;
  const sum = new Accumulator(total);
  const weights = new Accumulator(total);
  tiles.forEach((tile, t) => {
    signal?.throwIfAborted();
    const [nx, ny = 1, nz = 1] = tile.shape;
    const p = positions[t];
    const ax = axisSampling(p[0], origin[0], ox, nx);
    const ay = shape.length > 1 ? axisSampling(p[1], origin[1], oy, ny) : null;
    const az = shape.length > 2 ? axisSampling(p[2], origin[2], oz, nz) : { first: 0, count: 1, index: [0], fraction: [0], weight: [1] };
    const data = tile.data;
    const plane = nx * ny;
    for (let kz = 0; kz < az.count; kz++) {
      const z0 = az.index[kz];
      const fz = az.fraction[kz];
      const z1 = Math.min(nz - 1, z0 + 1);
      const outZ = (az.first + kz) * ox * oy;
      for (let ky = 0; ky < ay.count; ky++) {
        const y0 = ay.index[ky];
        const fy = ay.fraction[ky];
        const y1 = Math.min(ny - 1, y0 + 1);
        const wzy = az.weight[kz] * ay.weight[ky];
        const outRow = outZ + (ay.first + ky) * ox + ax.first;
        const r00 = z0 * plane + y0 * nx;
        const r01 = z0 * plane + y1 * nx;
        const r10 = z1 * plane + y0 * nx;
        const r11 = z1 * plane + y1 * nx;
        for (let kx = 0; kx < ax.count; kx++) {
          const x0 = ax.index[kx];
          const fx = ax.fraction[kx];
          const x1 = fx > 0 ? x0 + 1 : x0;
          const c00 = data[r00 + x0] + fx * (data[r00 + x1] - data[r00 + x0]);
          const c01 = data[r01 + x0] + fx * (data[r01 + x1] - data[r01 + x0]);
          let value = c00 + fy * (c01 - c00);
          if (fz > 0) {
            const c10 = data[r10 + x0] + fx * (data[r10 + x1] - data[r10 + x0]);
            const c11 = data[r11 + x0] + fx * (data[r11 + x1] - data[r11 + x0]);
            value += fz * (c10 + fy * (c11 - c10) - value);
          }
          const w = wzy * ax.weight[kx];
          const o = outRow + kx;
          if (wide) {
            const covered = weights[o] + w;
            weights[o] = covered;
            sum[o] += (w / covered) * (value - sum[o]);
          } else {
            sum[o] += w * value;
            weights[o] += w;
          }
        }
      }
    }
    onProgress?.(t + 1, tiles.length);
  });
  if (!wide) for (let i = 0; i < total; i++) sum[i] = weights[i] > 0 ? sum[i] / weights[i] : 0;
  // Only float64 values beyond ±9e307 can overflow the running mean's difference.
  else for (let i = 0; i < total; i++) if (!Number.isFinite(sum[i])) throw new Error('The tiles hold values too large to blend (beyond ±9e307); rescale them before stitching.');
  return { data: sum, shape, origin };
}

const RANGES = {
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
};
const TYPES = { uint8: Uint8Array, uint16: Uint16Array, uint32: Uint32Array, int8: Int8Array, int16: Int16Array, int32: Int32Array, float32: Float32Array, float64: Float64Array };

/** The fused image in the tiles' sample type: integers rounded and clamped, floats copied. */
export function toSampleType(data, dtype) {
  const Type = TYPES[dtype];
  if (!Type) throw new Error(`Unknown sample type ${dtype}.`);
  if (data instanceof Type) return data;
  const out = new Type(data.length);
  const range = RANGES[dtype];
  if (!range) {
    out.set(data);
    return out;
  }
  const [low, high] = range;
  for (let i = 0; i < data.length; i++) out[i] = Math.min(high, Math.max(low, Math.round(data[i])));
  return out;
}
