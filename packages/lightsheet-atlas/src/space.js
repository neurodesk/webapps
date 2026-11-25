// Sample orientation and the atlas-resolution grid, following BrainGlobe's conventions.
//
// An orientation is three letters, one per stack axis (z, y, x = planes, rows, columns), naming
// the side each axis starts from: a/p (anterior/posterior), s/i (superior/inferior), r/l
// (right/left). BrainGlobe atlases are "asr": axis 0 runs anterior->posterior, axis 1
// superior->inferior, axis 2 right->left. Volumes on the atlas grid are stored as NIfTI does,
// axis 0 fastest: index = a + A * (s + S * r).

const AXIS_OF = { a: 0, p: 0, s: 1, i: 1, r: 2, l: 2 };
const ORIGIN = new Set(['a', 's', 'r']);

/** For each stack axis (z, y, x): the atlas axis it becomes and whether it is reversed. */
export function parseOrientation(code) {
  const letters = String(code ?? '').trim().toLowerCase();
  if (!/^[apsirl]{3}$/.test(letters)) throw new Error('Orientation must be three letters from a/p, s/i and r/l, such as psl.');
  const axes = [...letters].map((letter) => ({ atlasAxis: AXIS_OF[letter], flip: !ORIGIN.has(letter) }));
  if (new Set(axes.map((axis) => axis.atlasAxis)).size !== 3) throw new Error(`Orientation ${letters} names one anatomical axis twice.`);
  return axes;
}

/** Python 3 round(): half to even. */
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The atlas-resolution shape of each stack axis (z, y, x), as brainreg sizes its downsampled image. */
export function downsampledShape(shape, voxelSizeUm, resolutionUm) {
  return shape.map((n, i) => Math.max(1, roundHalfEven((n * voxelSizeUm[i]) / resolutionUm)));
}

// Area-weighted resampling of length n to m: for each target index, the source indices and weights.
export function areaWeights(n, m) {
  const scale = n / m;
  const result = [];
  for (let o = 0; o < m; o++) {
    const start = o * scale;
    const end = (o + 1) * scale;
    const taps = [];
    for (let i = Math.floor(start); i < Math.min(n, Math.ceil(end)); i++) {
      const overlap = Math.min(end, i + 1) - Math.max(start, i);
      if (overlap > 0) taps.push([i, overlap / scale]);
    }
    result.push(taps);
  }
  return result;
}

/**
 * Accumulates stack planes into the atlas grid. `push(z, plane)` takes plane z (rows x columns,
 * columns fastest); `finish()` returns { data: Float32Array on the asr grid, shape: [A, S, R] }.
 * Each target voxel is the area-weighted mean of the source voxels it covers.
 */
export function createDownsampler({ shape, voxelSizeUm, orientation, resolutionUm }) {
  const axes = parseOrientation(orientation);
  const target = downsampledShape(shape, voxelSizeUm, resolutionUm);
  const [, rows, cols] = shape;
  const [tz, ty, tx] = target;
  const wz = areaWeights(shape[0], tz);
  const wy = areaWeights(rows, ty);
  const wx = areaWeights(cols, tx);
  const zTaps = Array.from({ length: shape[0] }, () => []);
  wz.forEach((taps, o) => taps.forEach(([i, w]) => zTaps[i].push([o, w])));
  const accumulator = new Float64Array(tz * ty * tx);
  const rowPass = new Float64Array(rows * tx);
  return {
    targetShape: target,
    push(z, plane) {
      if (plane.length !== rows * cols) throw new Error(`Plane ${z} has ${plane.length} pixels; expected ${rows * cols}.`);
      for (let y = 0; y < rows; y++) {
        const base = y * cols;
        for (let o = 0; o < tx; o++) {
          let s = 0;
          for (const [i, w] of wx[o]) s += plane[base + i] * w;
          rowPass[y * tx + o] = s;
        }
      }
      for (const [oz, weightZ] of zTaps[z]) {
        const offset = oz * ty * tx;
        for (let oy = 0; oy < ty; oy++) {
          for (const [y, weightY] of wy[oy]) {
            const weight = weightZ * weightY;
            const from = y * tx;
            const to = offset + oy * tx;
            for (let ox = 0; ox < tx; ox++) accumulator[to + ox] += rowPass[from + ox] * weight;
          }
        }
      }
    },
    finish() {
      return toAtlasOrder(accumulator, target, axes);
    },
  };
}

/** The asr grid shape of a stack of `shape` (z, y, x) in this orientation. */
export function atlasOrderShape(shape, orientation) {
  const axes = parseOrientation(orientation);
  const out = [0, 0, 0];
  axes.forEach((axis, i) => {
    out[axis.atlasAxis] = shape[i];
  });
  return out;
}

function toAtlasOrder(values, shape, axes) {
  const out = [0, 0, 0];
  axes.forEach((axis, i) => {
    out[axis.atlasAxis] = shape[i];
  });
  const [A, S] = out;
  const data = new Float32Array(values.length);
  const [nz, ny, nx] = shape;
  const index = [0, 0, 0];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const source = [z, y, x];
        for (let k = 0; k < 3; k++) index[axes[k].atlasAxis] = axes[k].flip ? shape[k] - 1 - source[k] : source[k];
        data[index[0] + A * (index[1] + S * index[2])] = values[(z * ny + y) * nx + x];
      }
    }
  }
  return { data, shape: out };
}

/**
 * A stack voxel (z, y, x indices, may be fractional) as a continuous index on the downsampled asr
 * grid, matching createDownsampler's voxel-centre geometry.
 */
export function stackToGrid(point, shape, targetShape, orientation) {
  const axes = parseOrientation(orientation);
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const c = ((point[k] + 0.5) * targetShape[k]) / shape[k] - 0.5;
    out[axes[k].atlasAxis] = axes[k].flip ? targetShape[k] - 1 - c : c;
  }
  return out;
}
