/*! Light-sheet atlas cell detection: a port of cellfinder 1.10.1 (BSD-3-Clause, Copyright (c) 2020 Adam Tyson, University College London). See THIRD_PARTY_NOTICES.txt. */
// Cell candidate detection: a port of cellfinder's classical detection (cellfinder 1.10.1,
// cellfinder/core/detect, BSD-3-Clause, Copyright (c) 2020 Adam Tyson, University College London;
// see NOTICE). It follows the CPU path that `cellfinder.core.detect.detect.main` takes with
// torch_device="cpu": per plane, clip -> bright tiles -> median 3x3 -> Gaussian -> Laplacian ->
// flip and normalise -> threshold at mean + n SD; then the 3D ball filter, 6-connected structure
// detection, and iterative ball-filter erosion to split clusters. Float32 steps are rounded with
// Math.fround where cellfinder computes in float32, so per-plane masks match bit for bit.
//
// Planes are Float32Array or integer typed arrays of height*width, row-major (x fastest).

const f32 = Math.fround;

/** cellfinder's DetectionSettings, in microns, and the derived voxel sizes. */
export const DEFAULT_SETTINGS = Object.freeze({
  somaDiameterUm: 16,
  maxClusterSizeUm3: 100000,
  ballXyUm: 6,
  ballZUm: 15,
  ballOverlapFraction: 0.6,
  somaSpreadFactor: 1.4,
  logSigmaSize: 0.2,
  nSdsAboveMeanThresh: 10,
  splitBallXyUm: 6,
  splitBallZUm: 15,
  splitBallOverlapFraction: 0.8,
  nSplittingIter: 10,
});

const UINT16_MAX = 65535;
const FLOAT32_MAX_INT = 2 ** 24;

function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's round() on a float, as cellfinder's int(round(x)) uses. */
const pyRound = roundHalfEven;

/**
 * The voxel parameters cellfinder derives from microns. `voxelSizesUm` is [z, y, x].
 * Throws as cellfinder does when the ball is zero planes deep.
 */
export function deriveSettings(voxelSizesUm, options = {}) {
  const s = { ...DEFAULT_SETTINGS, ...options };
  const [z, y, x] = voxelSizesUm.map(Number);
  if (![z, y, x].every((v) => Number.isFinite(v) && v > 0)) throw new Error('Voxel sizes must be positive numbers.');
  const inPlane = (x + y) / 2;
  const somaDiameter = pyRound(s.somaDiameterUm / inPlane);
  const ball = (xyUm, zUm) => {
    const xy = pyRound(xyUm / inPlane);
    const depth = pyRound(zUm / z);
    if (!depth) throw new Error(`The ball filter is 0 planes deep at ${z} µm per plane: cell detection needs finer z sampling.`);
    if (!xy) throw new Error(`The ball filter is 0 pixels wide at ${inPlane} µm per pixel: cell detection needs finer sampling.`);
    return { xy, z: depth };
  };
  if (somaDiameter < 2) throw new Error(`A ${s.somaDiameterUm} µm soma spans ${somaDiameter} pixels at ${inPlane} µm: cells are not resolved.`);
  const radius = (s.somaSpreadFactor * somaDiameter) / 2;
  return {
    ...s,
    voxelSizesUm: [z, y, x],
    somaDiameter,
    ball: ball(s.ballXyUm, s.ballZUm),
    splitBall: ball(s.splitBallXyUm, s.splitBallZUm),
    maxClusterSize: pyRound(s.maxClusterSizeUm3 / (x * y * z)),
    maxCellVolume: (4 / 3) * Math.PI * radius ** 3,
  };
}

// numpy's pairwise sum for fewer than 128 float64 values (8 interleaved accumulators).
function numpySum(values) {
  const n = values.length;
  if (n < 8) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[i];
    return s;
  }
  const r = values.slice(0, 8);
  let i = 8;
  for (; i < n - (n % 8); i += 8) for (let k = 0; k < 8; k++) r[k] += values[i + k];
  let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
  for (; i < n; i++) res += values[i];
  return res;
}

/** scipy.ndimage._gaussian_kernel1d(sigma, 0, radius) with truncate 4.0. */
export function gaussianKernel(sigma) {
  const radius = Math.trunc(4 * sigma + 0.5);
  const factor = -0.5 / (sigma * sigma);
  const phi = [];
  for (let x = -radius; x <= radius; x++) phi.push(Math.exp(factor * x * x));
  const sum = numpySum(phi);
  return phi.map((v) => v / sum);
}

// scipy 'reflect' boundary (d c b a | a b c d | d c b a).
function reflect(index, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  let i = index % period;
  if (i < 0) i += period;
  return i < n ? i : period - 1 - i;
}

// scipy.ndimage.correlate1d with symmetric float64 weights, float32 output, along rows (axis 1)
// or columns (axis 0).
function correlateSymmetric(src, out, height, width, weights, axis) {
  const r = (weights.length - 1) >> 1;
  const n = axis === 0 ? height : width;
  const count = axis === 0 ? width : height;
  const line = new Float64Array(n + 2 * r);
  for (let c = 0; c < count; c++) {
    for (let i = -r; i < n + r; i++) {
      const j = reflect(i, n);
      line[i + r] = axis === 0 ? src[j * width + c] : src[c * width + j];
    }
    for (let i = 0; i < n; i++) {
      const centre = i + r;
      let tmp = line[centre] * weights[r];
      for (let jj = -r; jj < 0; jj++) tmp += (line[centre + jj] + line[centre - jj]) * weights[r + jj];
      out[axis === 0 ? i * width + c : c * width + i] = tmp;
    }
  }
}

function median9(v) {
  // insertion sort of 9 values; the middle one is the median.
  for (let i = 1; i < 9; i++) {
    const x = v[i];
    let j = i - 1;
    while (j >= 0 && v[j] > x) {
      v[j + 1] = v[j];
      j--;
    }
    v[j + 1] = x;
  }
  return v[4];
}

/** scipy.signal.medfilt2d(image), 3x3 with zero padding. */
export function median3x3(src, height, width) {
  const out = new Float32Array(height * width);
  const v = new Float64Array(9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          v[k++] = yy < 0 || yy >= height || xx < 0 || xx >= width ? 0 : src[yy * width + xx];
        }
      }
      out[y * width + x] = median9(v);
    }
  }
  return out;
}

/** The thresholded plane (threshold value or 0) and the in-brain tile mask of one plane. */
export function filterPlane(rawPlane, height, width, settings, { clippingValue = UINT16_MAX - 2, thresholdValue = UINT16_MAX - 1 } = {}) {
  const n = height * width;
  const plane = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = rawPlane[i];
    plane[i] = v < 0 ? 0 : v > clippingValue ? clippingValue : v;
  }
  const tile = settings.somaDiameter * 2;
  const tiles = brightTiles(plane, height, width, tile);

  const median = median3x3(plane, height, width);
  const weights = gaussianKernel(settings.logSigmaSize * settings.somaDiameter);
  const blurredRows = new Float32Array(n);
  correlateSymmetric(median, blurredRows, height, width, weights, 0);
  const blurred = new Float32Array(n);
  correlateSymmetric(blurredRows, blurred, height, width, weights, 1);
  const lap = new Float32Array(n);
  correlateSymmetric(blurred, lap, height, width, [1, -2, 1], 0);
  const lapX = new Float32Array(n);
  correlateSymmetric(blurred, lapX, height, width, [1, -2, 1], 1);
  for (let i = 0; i < n; i++) lap[i] = f32(lap[i] + lapX[i]);

  // normalise(flip=True, max_value=clipping): -x, - min, / max, * clipping (float32 steps)
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    lap[i] = -lap[i];
    if (lap[i] < min) min = lap[i];
  }
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    lap[i] = f32(lap[i] - min);
    if (lap[i] > max) max = lap[i];
  }
  if (max === 0) max = 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    lap[i] = f32(f32(lap[i] / max) * clippingValue);
    sum += lap[i];
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (lap[i] - mean) ** 2;
  const std = f32(Math.sqrt(ss / (n - 1)));
  const threshold = f32(f32(mean) + f32(settings.nSdsAboveMeanThresh * std));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) if (lap[i] > threshold) out[i] = thresholdValue;
  return { plane: out, tiles };
}

/** cellfinder's TileWalker: tiles of 2 soma diameters brighter than the corner tile's mean + 2 SD + 1. */
export function brightTiles(plane, height, width, tile) {
  const ny = Math.ceil(height / tile);
  const nx = Math.ceil(width / tile);
  const mask = new Uint8Array(ny * nx);
  if (height < tile || width < tile) return { mask, ny, nx, tile };
  let sum = 0;
  for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) sum += plane[y * width + x];
  const count = tile * tile;
  const mean = sum / count;
  let ss = 0;
  for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) ss += (plane[y * width + x] - mean) ** 2;
  const sd = f32(Math.sqrt(ss / count));
  const threshold = f32(f32(f32(mean) + f32(2 * sd)) + 1);
  const fy = Math.floor(height / tile);
  const fx = Math.floor(width / tile);
  for (let ty = 0; ty < fy; ty++) {
    for (let tx = 0; tx < fx; tx++) {
      let s = 0;
      for (let y = ty * tile; y < (ty + 1) * tile; y++) for (let x = tx * tile; x < (tx + 1) * tile; x++) s += plane[y * width + x];
      if (f32(s / count) >= threshold) mask[ty * nx + tx] = 1;
    }
  }
  return { mask, ny, nx, tile };
}

/**
 * cellfinder's get_kernel: a sphere sampled 7x finer and averaged into bins, indexed [z][a][b].
 * The fraction sums are float32 as in cellfinder (bin_mean_3d on a float32 sphere).
 */
export function ballKernel(xy, z) {
  const up = 7;
  const shape = [up * xy, up * xy, up * z];
  const centre = shape.map((u) => (u - 1) / 2);
  const radius = shape.map((u) => u / 2);
  const kernel = new Float32Array(z * xy * xy);
  for (let a = 0; a < xy; a++) {
    for (let b = 0; b < xy; b++) {
      for (let c = 0; c < z; c++) {
        // bin_mean_3d: per z sub-plane the 2D bin mean (float32), then the mean of 7 sub-planes.
        let depthSum = 0;
        for (let k = c * up; k < (c + 1) * up; k++) {
          let inside = 0;
          for (let i = a * up; i < (a + 1) * up; i++) {
            for (let j = b * up; j < (b + 1) * up; j++) {
              const d = ((i - centre[0]) / radius[0]) ** 2 + ((j - centre[1]) / radius[1]) ** 2 + ((k - centre[2]) / radius[2]) ** 2;
              if (d <= 1) inside++;
            }
          }
          depthSum += f32(inside / (up * up));
        }
        kernel[(c * xy + a) * xy + b] = f32(depthSum / up);
      }
    }
  }
  return kernel;
}

/** Connected structures over consecutive planes, as cellfinder's CellDetector (6-connectivity). */
export class StructureDetector {
  constructor(height, width, startZ) {
    this.height = height;
    this.width = width;
    this.z = startZ;
    this.nextId = 1;
    this.obsolete = new Map();
    this.structures = new Map();
    this.previous = null;
  }

  resolve(id) {
    let value = id;
    while (this.obsolete.has(value)) value = this.obsolete.get(value);
    return value;
  }

  /** `isSoma(i)` says whether pixel i of this plane is a soma voxel. */
  process(isSoma) {
    const { height, width } = this;
    const ids = new Float64Array(height * width);
    const neighbours = [0, 0, 0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!isSoma(i)) continue;
        neighbours[0] = y > 0 ? ids[i - width] : 0;
        neighbours[1] = x > 0 ? ids[i - 1] : 0;
        neighbours[2] = this.previous ? this.previous[i] : 0;
        if (neighbours[0] === 0 && neighbours[1] === 0 && neighbours[2] === 0) neighbours[0] = this.nextId++;
        let updated = Infinity;
        for (let k = 0; k < 3; k++) {
          neighbours[k] = this.resolve(neighbours[k]);
          if (neighbours[k] !== 0 && neighbours[k] < updated) updated = neighbours[k];
        }
        if (!this.structures.has(updated)) this.structures.set(updated, []);
        const target = this.structures.get(updated);
        for (const id of [...new Set(neighbours)].sort((p, q) => p - q)) {
          if (id > updated) {
            for (const point of this.structures.get(id)) target.push(point);
            this.structures.delete(id);
            this.obsolete.set(id, updated);
          }
        }
        target.push([x, y, this.z]);
        ids[i] = updated;
      }
    }
    this.previous = ids;
    this.z += 1;
  }

  /** split_cells' get_cell_centres: the per-point running mean (a / n summed), rounded half to even. */
  centres() {
    const result = [];
    for (const points of this.structures.values()) {
      const n = points.length;
      let a = 0;
      let b = 0;
      let c = 0;
      for (const [x, y, z] of points) {
        a += x / n;
        b += y / n;
        c += z / n;
      }
      result.push([roundHalfEven(a), roundHalfEven(b), roundHalfEven(c)]);
    }
    return result;
  }
}

/** get_structure_centre without intensity: sum / n, rounded half to even. */
function structureCentre(points) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const [x, y, z] of points) {
    a += x;
    b += y;
    c += z;
  }
  const n = points.length;
  return [roundHalfEven(a / n), roundHalfEven(b / n), roundHalfEven(c / n)];
}

/**
 * cellfinder's BallFilter over a stream of thresholded planes. `push(plane, tiles)` returns the
 * centre plane once the ball is full (values >= threshold count as foreground; retained voxels
 * become `somaValue`), else null.
 */
export class BallFilter {
  constructor(height, width, ball, overlapFraction, thresholdValue, somaValue) {
    if (height < ball.xy || width < ball.xy) {
      throw new RangeError(`Invalid plane size ${height}x${width}. Needs to be at least ${ball.xy} in each dimension`);
    }
    this.height = height;
    this.width = width;
    this.kz = ball.z;
    this.kxy = ball.xy;
    this.kernel = ballKernel(ball.xy, ball.z);
    let threshold = 0;
    const scaled = Array.from(this.kernel, (k) => f32(overlapFraction * k));
    // np.sum of a float32 array: pairwise in float32.
    threshold = f32sum(scaled);
    this.overlapThreshold = threshold;
    this.middle = Math.floor(ball.z / 2);
    this.thresholdValue = thresholdValue;
    this.somaValue = somaValue;
    this.planes = [];
    this.tiles = [];
  }

  get firstValidPlane() {
    return this.middle;
  }

  push(plane, tiles = null) {
    this.planes.push(plane);
    this.tiles.push(tiles);
    if (this.planes.length < this.kz) return null;
    if (this.planes.length > this.kz) {
      this.planes.shift();
      this.tiles.shift();
    }
    return this.walk();
  }

  walk() {
    const { height, width, kz, kxy, kernel, thresholdValue } = this;
    const hv = height - kxy + 1;
    const wv = width - kxy + 1;
    const oy = (height - hv) >> 1;
    const ox = (width - wv) >> 1;
    const binary = this.planes.map((p) => {
      const b = new Uint8Array(p.length);
      for (let i = 0; i < p.length; i++) b[i] = p[i] >= thresholdValue ? 1 : 0;
      return b;
    });
    const centre = this.planes[this.middle];
    const tiles = this.tiles[this.middle];
    const hits = [];
    for (let y = 0; y < hv; y++) {
      for (let x = 0; x < wv; x++) {
        let overlap = 0;
        for (let c = 0; c < kz; c++) {
          const b = binary[c];
          for (let a = 0; a < kxy; a++) {
            const row = (y + a) * width + x;
            const krow = (c * kxy + a) * kxy;
            for (let d = 0; d < kxy; d++) if (b[row + d]) overlap += kernel[krow + d];
          }
        }
        if (f32(overlap) > this.overlapThreshold) hits.push((y + oy) * width + (x + ox));
      }
    }
    for (const i of hits) {
      if (tiles) {
        const ty = Math.floor(Math.floor(i / width) / tiles.tile);
        const tx = Math.floor((i % width) / tiles.tile);
        if (!tiles.mask[ty * tiles.nx + tx]) continue;
      }
      centre[i] = this.somaValue;
    }
    return centre;
  }
}

// numpy float32 pairwise sum for arrays shorter than 128 (as used for the overlap threshold).
function f32sum(values) {
  const n = values.length;
  if (n < 8) {
    let s = 0;
    for (const v of values) s = f32(s + v);
    return s;
  }
  if (n <= 128) {
    const r = values.slice(0, 8);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let k = 0; k < 8; k++) r[k] = f32(r[k] + values[i + k]);
    let res = f32(f32(f32(r[0] + r[1]) + f32(r[2] + r[3])) + f32(f32(r[4] + r[5]) + f32(r[6] + r[7])));
    for (; i < n; i++) res = f32(res + values[i]);
    return res;
  }
  const half = (n >> 1) - ((n >> 1) % 8);
  return f32(f32sum(values.slice(0, half)) + f32sum(values.slice(half)));
}

function splitCluster(points, settings) {
  const ball = settings.splitBall;
  const pad = [(ball.xy - 1) >> 1, ball.xy - 1 - ((ball.xy - 1) >> 1)];
  const padZ = [(ball.z - 1) >> 1, ball.z - 1 - ((ball.z - 1) >> 1)];
  let [minX, minY, minZ] = [Infinity, Infinity, Infinity];
  let [maxX, maxY, maxZ] = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const shape = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
  const X = shape[0] + pad[0] + pad[1];
  const Y = shape[1] + pad[0] + pad[1];
  const Z = shape[2] + padZ[0] + padZ[1];
  const threshold = FLOAT32_MAX_INT - 1;
  const soma = FLOAT32_MAX_INT;
  const volume = Array.from({ length: Z }, () => new Float32Array(X * Y));
  for (const [x, y, z] of points) volume[z - minZ + padZ[0]][(y - minY + pad[0]) * X + (x - minX + pad[0])] = threshold;
  const original = structureCentre(points);
  const detectors = [];
  for (let iter = 0; iter < settings.nSplittingIter; iter++) {
    let detector;
    try {
      const filter = new BallFilter(Y, X, ball, settings.splitBallOverlapFraction, threshold, soma);
      detector = new StructureDetector(Y, X, filter.firstValidPlane);
      let z = filter.firstValidPlane;
      for (let k = 0; k < Z; k++) {
        const centre = filter.push(Float32Array.from(volume[k]));
        if (centre) {
          volume[z].set(centre);
          detector.process((i) => centre[i] === soma);
          z++;
        }
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      detector = new StructureDetector(Y, X, 0);
    }
    for (const plane of volume) for (let i = 0; i < plane.length; i++) plane[i] = f32(plane[i] - 1);
    detectors.push(detector);
    if (!detector.structures.size) break;
  }
  const counts = detectors.map((d) => d.structures.size);
  const best = Math.max(0, ...counts);
  if (best <= 1) return [original];
  const detector = detectors[counts.indexOf(best)];
  return detector.centres().map(([x, y, z]) => [
    Math.min(Math.max(x - pad[0], 0), shape[0] - 1) + minX,
    Math.min(Math.max(y - pad[0], 0), shape[1] - 1) + minY,
    Math.min(Math.max(z - padZ[0], 0), shape[2] - 1) + minZ,
  ]);
}

/**
 * Streaming detector. Feed planes in z order with `push(plane)`; `finish()` returns
 * { cells: [[x, y, z], ...], artifacts: [...] } in voxel indices of the input stack.
 */
export function createDetector({ height, width, voxelSizesUm, options = {} }) {
  const settings = deriveSettings(voxelSizesUm, options);
  const threshold = UINT16_MAX - 1;
  const soma = UINT16_MAX;
  const filter = new BallFilter(height, width, settings.ball, settings.ballOverlapFraction, threshold, soma);
  const detector = new StructureDetector(height, width, filter.firstValidPlane);
  let planes = 0;
  return {
    settings,
    push(rawPlane) {
      if (rawPlane.length !== height * width) throw new Error(`Plane ${planes} has ${rawPlane.length} pixels; expected ${height * width}.`);
      const { plane, tiles } = filterPlane(rawPlane, height, width, settings);
      planes++;
      const centre = filter.push(plane, tiles);
      if (centre) detector.process((i) => centre[i] === soma);
    },
    finish() {
      const cells = [];
      const artifacts = [];
      for (const points of detector.structures.values()) {
        const volume = points.length;
        if (volume < settings.maxCellVolume) cells.push(structureCentre(points));
        else if (volume < settings.maxClusterSize) cells.push(...splitCluster(points, settings));
        else artifacts.push(structureCentre(points));
      }
      return { cells, artifacts, planes };
    },
  };
}
