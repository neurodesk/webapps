// FLAMeS inference around a patch runner. Pure: no DOM, no ONNX Runtime import (sessions are injected).
//
// Arrays use nnU-Net's axis order. nnU-Net reads a NIfTI volume as a C-order (z, y, x) array
// and then applies the FLAMeS plans' transpose_forward [2, 0, 1], so the network sees (x, z, y):
// the 1 mm target spacing and the 112-voxel patch side run along x. It never reorients, so
// neither do we.

export const PLAN = Object.freeze({
  patch: Object.freeze([112, 128, 160]),
  spacing: Object.freeze([1, 0.9, 0.9]),
  step: 0.5,
});

const product = (shape) => shape[0] * shape[1] * shape[2];

export function networkGrid(volume) {
  const [nx, ny, nz] = volume.dims;
  const [sx, sy, sz] = [0, 1, 2].map((axis) => Math.hypot(volume.affine[0][axis], volume.affine[1][axis], volume.affine[2][axis]));
  return { shape: [nx, nz, ny], spacing: [sx, sz, sy] };
}

// NIfTI voxel order (x fastest) to the network's C-order (x, z, y), and back.
export function toNetworkOrder(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new data.constructor(data.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) out[(x * nz + z) * ny + y] = data[(z * ny + y) * nx + x];
    }
  }
  return out;
}

export function fromNetworkOrder(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new data.constructor(data.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) out[(z * ny + y) * nx + x] = data[(x * nz + z) * ny + y];
    }
  }
  return out;
}

// Bounding box of the brain mask, as nnU-Net's crop_to_nonzero.
export function brainBox(mask, shape) {
  const lo = [...shape];
  const hi = [-1, -1, -1];
  let i = 0;
  for (let z = 0; z < shape[0]; z++) {
    for (let y = 0; y < shape[1]; y++) {
      for (let x = 0; x < shape[2]; x++, i++) {
        if (!mask[i]) continue;
        const c = [z, y, x];
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], c[a]);
          hi[a] = Math.max(hi[a], c[a] + 1);
        }
      }
    }
  }
  if (hi[0] < 0) throw new Error('The brain mask is empty.');
  return { lo, hi, shape: hi.map((h, a) => h - lo[a]) };
}

export function cropVolume(data, shape, box) {
  const out = new Float32Array(product(box.shape));
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

// Z-score inside the brain, zero outside: nnU-Net's ZScoreNormalization with use_mask_for_norm.
export function normalizeInBrain(image, inside) {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < image.length; i++) {
    if (inside[i]) {
      n++;
      sum += image[i];
    }
  }
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < image.length; i++) {
    if (inside[i]) squares += (image[i] - mean) ** 2;
  }
  const std = Math.max(Math.sqrt(squares / n), 1e-8);
  const out = new Float32Array(image.length);
  for (let i = 0; i < image.length; i++) out[i] = inside[i] ? (image[i] - mean) / std : 0;
  return out;
}

export function targetShape(shape, spacing, target = PLAN.spacing) {
  return shape.map((n, a) => Math.round(n * spacing[a] / target[a]));
}

// nnU-Net resampling (default_resampling.py): skimage.transform.resize, which is
// scipy.ndimage.zoom with grid_mode=True and mode='nearest', clipped to the input range.
// When one axis is more than three times coarser than another it resamples each slice in-plane
// and takes the nearest slice along that axis.

const POLE = Math.sqrt(3) - 2;
const PAD = 12;

// Cubic B-spline coefficients of a line, as scipy's spline_filter1d after edge padding by 12.
function splineCoefficients(line) {
  const n = line.length + 2 * PAD;
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = 6 * line[Math.min(Math.max(i - PAD, 0), line.length - 1)];
  const zn = POLE ** (n - 1);
  let z = POLE;
  let first = c[0] + zn * c[n - 1];
  for (let i = 1; i < n - 1; i++) {
    first += z * (c[i] + zn * c[n - 1 - i]);
    z *= POLE;
  }
  c[0] = first / (1 - zn * zn);
  for (let i = 1; i < n; i++) c[i] += POLE * c[i - 1];
  c[n - 1] = (POLE * c[n - 2] + c[n - 1]) * POLE / (POLE * POLE - 1);
  for (let i = n - 2; i >= 0; i--) c[i] = POLE * (c[i + 1] - c[i]);
  return c;
}

const lineKernels = {
  cubic: (line, out) => {
    const c = splineCoefficients(line);
    const scale = line.length / out.length;
    for (let o = 0; o < out.length; o++) {
      const x = (o + 0.5) * scale - 0.5 + PAD;
      const f = Math.floor(x);
      const t = x - f;
      const w = [(1 - t) ** 3 / 6, (4 - 6 * t * t + 3 * t ** 3) / 6, (1 + 3 * t + 3 * t * t - 3 * t ** 3) / 6, t ** 3 / 6];
      let v = 0;
      for (let k = 0; k < 4; k++) v += w[k] * c[Math.min(Math.max(f - 1 + k, 0), c.length - 1)];
      out[o] = v;
    }
  },
  linear: (line, out) => {
    const scale = line.length / out.length;
    for (let o = 0; o < out.length; o++) {
      const x = Math.min(Math.max((o + 0.5) * scale - 0.5, 0), line.length - 1);
      const f = Math.floor(x);
      const t = x - f;
      out[o] = line[f] * (1 - t) + line[Math.min(f + 1, line.length - 1)] * t;
    }
  },
  nearest: (line, out) => {
    const scale = line.length / out.length;
    for (let o = 0; o < out.length; o++) out[o] = line[Math.min(Math.max(Math.floor((o + 0.5) * scale), 0), line.length - 1)];
  },
};

// Resamples one axis of a C-order volume with a 1D kernel.
function resampleAxis(data, shape, axis, size, kernel) {
  if (shape[axis] === size) return { data, shape };
  const next = [...shape];
  next[axis] = size;
  const out = new Float32Array(product(next));
  const stride = (dims) => [dims[1] * dims[2], dims[2], 1][axis];
  const inStride = stride(shape);
  const outStride = stride(next);
  const [p, q] = [0, 1, 2].filter((a) => a !== axis);
  const line = new Float64Array(shape[axis]);
  const result = new Float64Array(size);
  for (let i = 0; i < shape[p]; i++) {
    for (let j = 0; j < shape[q]; j++) {
      const at = (dims) => i * [dims[1] * dims[2], dims[2], 1][p] + j * [dims[1] * dims[2], dims[2], 1][q];
      const inBase = at(shape);
      const outBase = at(next);
      for (let k = 0; k < shape[axis]; k++) line[k] = data[inBase + k * inStride];
      kernel(line, result);
      for (let k = 0; k < size; k++) out[outBase + k * outStride] = result[k];
    }
  }
  return { data: out, shape: next };
}

function sliceIndices(shape, axis, index) {
  const [p, q] = [0, 1, 2].filter((a) => a !== axis);
  const strides = [shape[1] * shape[2], shape[2], 1];
  const list = new Int32Array(shape[p] * shape[q]);
  let n = 0;
  for (let i = 0; i < shape[p]; i++) {
    for (let j = 0; j < shape[q]; j++) list[n++] = index * strides[axis] + i * strides[p] + j * strides[q];
  }
  return list;
}

export function anisotropicAxis(spacing) {
  const max = Math.max(...spacing);
  if (max / Math.min(...spacing) <= 3) return null;
  const axes = [0, 1, 2].filter((a) => spacing[a] === max);
  return axes.length === 1 ? axes[0] : null;
}

// order 3 for images, 1 for probabilities, as nnU-Net's plans for FLAMeS.
export function resample(data, shape, newShape, spacing, newSpacing, order) {
  if (shape.every((n, a) => n === newShape[a])) return data;
  const kernel = order === 3 ? lineKernels.cubic : lineKernels.linear;
  const axis = anisotropicAxis(spacing) ?? anisotropicAxis(newSpacing);
  let volume = { data, shape };
  for (const a of [0, 1, 2]) {
    if (a !== axis) volume = resampleAxis(volume.data, volume.shape, a, newShape[a], kernel);
  }
  const range = (values, indices) => {
    let min = Infinity;
    let max = -Infinity;
    for (const i of indices) {
      min = Math.min(min, values[i]);
      max = Math.max(max, values[i]);
    }
    return [min, max];
  };
  if (axis === null) {
    const [min, max] = range(data, data.keys());
    for (let i = 0; i < volume.data.length; i++) volume.data[i] = Math.min(Math.max(volume.data[i], min), max);
    return volume.data;
  }
  for (let k = 0; k < shape[axis]; k++) {
    const [min, max] = range(data, sliceIndices(shape, axis, k));
    for (const i of sliceIndices(volume.shape, axis, k)) volume.data[i] = Math.min(Math.max(volume.data[i], min), max);
  }
  return resampleAxis(volume.data, volume.shape, axis, newShape[axis], lineKernels.nearest).data;
}

// Sliding-window origins along one axis, as nnU-Net's compute_steps_for_sliding_window.
export function windowStarts(size, patch, step = PLAN.step) {
  if (size <= patch) return [0];
  const count = Math.ceil((size - patch) / (patch * step)) + 1;
  const stride = (size - patch) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(stride * i));
}

export function windows(shape, patch = PLAN.patch) {
  const list = [];
  for (const z of windowStarts(shape[0], patch[0])) {
    for (const y of windowStarts(shape[1], patch[1])) {
      for (const x of windowStarts(shape[2], patch[2])) list.push([z, y, x]);
    }
  }
  return list;
}

// nnU-Net's Gaussian importance map: sigma is an eighth of the patch, peak at the centre.
export function gaussianWeights(patch = PLAN.patch) {
  const axis = (n) => Float32Array.from({ length: n }, (_, i) => Math.exp(-((i - Math.floor(n / 2)) ** 2) / (2 * (n / 8) ** 2)));
  const [gz, gy, gx] = patch.map(axis);
  const out = new Float32Array(product(patch));
  let o = 0;
  for (let z = 0; z < patch[0]; z++) {
    for (let y = 0; y < patch[1]; y++) {
      for (let x = 0; x < patch[2]; x++, o++) out[o] = gz[z] * gy[y] * gx[x];
    }
  }
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

// A network never scores every voxel and class alike. Some virtual GPUs (GitHub's macOS runners)
// complete a WebGPU run and return all zeros; failing here lets the worker retry on the CPU.
export function checkLogits(logits) {
  const first = logits[0];
  let varies = false;
  for (const value of logits) {
    if (!Number.isFinite(value)) throw new Error("the network returned non-finite scores");
    if (value !== first) varies = true;
  }
  if (!varies) throw new Error("the network returned the same score for every voxel");
}

// Runs the network over overlapping patches and returns the lesion probability on the
// brain-cropped input grid. `runPatch(tile, fold)` resolves to logits [2, ...patch]. Folds run
// one after another, so a caller holds one model at a time; their logits are averaged, as in nnU-Net.
export async function predictLesions({ image, shape, runPatch, folds = 1, onPatch = () => {}, signal }) {
  const patch = PLAN.patch;
  const padded = padCentered(image, shape, patch);
  const weights = gaussianWeights(patch);
  const origins = windows(padded.shape);
  const sum = new Float32Array(product(padded.shape));
  const weight = new Float32Array(sum.length);
  const tile = new Float32Array(product(patch));
  const voxels = product(patch);
  const passes = [];
  for (let fold = 0; fold < folds; fold++) {
    for (const origin of origins) passes.push([fold, origin]);
  }
  for (const [n, [fold, [z0, y0, x0]]] of passes.entries()) {
    signal?.throwIfAborted();
    let t = 0;
    for (let z = 0; z < patch[0]; z++) {
      for (let y = 0; y < patch[1]; y++) {
        const start = ((z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
        tile.set(padded.image.subarray(start, start + patch[2]), t);
        t += patch[2];
      }
    }
    const logits = await runPatch(tile, fold);
    signal?.throwIfAborted();
    checkLogits(logits);
    t = 0;
    for (let z = 0; z < patch[0]; z++) {
      for (let y = 0; y < patch[1]; y++) {
        const row = ((z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
        for (let x = 0; x < patch[2]; x++, t++) {
          // Averaging logits then taking a two-class softmax needs only their difference.
          sum[row + x] += (logits[voxels + t] - logits[t]) * weights[t];
          weight[row + x] += weights[t];
        }
      }
    }
    onPatch(n + 1, passes.length);
  }
  const probability = new Float32Array(product(shape));
  let o = 0;
  for (let z = 0; z < shape[0]; z++) {
    for (let y = 0; y < shape[1]; y++) {
      const row = ((z + padded.before[0]) * padded.shape[1] + y + padded.before[1]) * padded.shape[2] + padded.before[2];
      for (let x = 0; x < shape[2]; x++, o++) probability[o] = 1 / (1 + Math.exp(-sum[row + x] / weight[row + x]));
    }
  }
  return probability;
}

// FLAIR volume + brain mask → lesion probability on the input grid.
export async function segmentFlair({ volume, brainMask, runPatch, folds, onPatch, signal }) {
  const { shape, spacing } = networkGrid(volume);
  const data = toNetworkOrder(volume.data, volume.dims);
  const mask = toNetworkOrder(Uint8Array.from(brainMask), volume.dims);
  const box = brainBox(mask, shape);
  const inside = new Uint8Array(cropVolume(Float32Array.from(mask), shape, box));
  const image = normalizeInBrain(cropVolume(data, shape, box), inside);
  const resampledShape = targetShape(box.shape, spacing);
  const resampled = resample(image, box.shape, resampledShape, spacing, PLAN.spacing, 3);
  const predicted = await predictLesions({ image: resampled, shape: resampledShape, runPatch, folds, onPatch, signal });
  const cropped = resample(predicted, resampledShape, box.shape, PLAN.spacing, spacing, 1);
  const probability = new Float32Array(product(shape));
  let o = 0;
  for (let a = box.lo[0]; a < box.hi[0]; a++) {
    for (let b = box.lo[1]; b < box.hi[1]; b++) {
      probability.set(cropped.subarray(o, o + box.shape[2]), (a * shape[1] + b) * shape[2] + box.lo[2]);
      o += box.shape[2];
    }
  }
  return {
    probability: fromNetworkOrder(probability, volume.dims),
    windows: windows(resampledShape.map((n, a) => Math.max(n, PLAN.patch[a]))).length,
    resampledShape,
  };
}

// The brain mask of an image that is already skull-stripped.
export function nonzeroMask(volume) {
  return Uint8Array.from(volume.data, (v) => (v !== 0 ? 1 : 0));
}

// segmentFlair over one ONNX session per fold, opened when its first patch arrives and released
// before the next, so one model is in memory at a time. `models` holds each fold's graph bytes.
export async function runFolds({ volume, brainMask, models, createSession, Tensor, onPatch, signal }) {
  let session = null;
  let loaded = -1;
  const open = async (fold) => {
    if (fold === loaded) return;
    await session?.release();
    session = null;
    session = await createSession(models[fold]);
    loaded = fold;
  };
  await open(0);
  try {
    return await segmentFlair({
      volume,
      brainMask,
      folds: models.length,
      runPatch: async (tile, fold) => {
        await open(fold);
        const input = new Tensor('float32', tile, [1, 1, ...PLAN.patch]);
        const outputs = await session.run({ [session.inputNames[0]]: input });
        const logits = outputs[session.outputNames[0]];
        const data = await logits.getData();
        input.dispose();
        logits.dispose();
        return data;
      },
      onPatch,
      signal,
    });
  } finally {
    await session?.release();
  }
}

export function threshold(probability, cutoff = 0.5) {
  return Uint8Array.from(probability, (p) => (p > cutoff ? 1 : 0));
}

// 26-connected lesions with voxel counts and centroids (voxel coordinates, x fastest).
export function labelLesions(mask, dims) {
  const [nx, ny, nz] = dims;
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const lesions = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed]) continue;
    const id = lesions.length + 1;
    let head = 0;
    let tail = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    queue[tail++] = seed;
    labels[seed] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      sx += x;
      sy += y;
      sz += z;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            const j = (zz * ny + yy) * nx + xx;
            if (mask[j] && !labels[j]) {
              labels[j] = id;
              queue[tail++] = j;
            }
          }
        }
      }
    }
    lesions.push({ id, voxels: tail, centroid: [sx / tail, sy / tail, sz / tail] });
  }
  return { labels, lesions };
}

export function voxelVolumeMl(affine) {
  const [a, b, c] = [0, 1, 2].map((col) => [0, 1, 2].map((row) => affine[row][col]));
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.abs(det) / 1000;
}

export function lesionTable(lesions, affine) {
  const ml = voxelVolumeMl(affine);
  const world = ([x, y, z]) => [0, 1, 2].map((r) => affine[r][0] * x + affine[r][1] * y + affine[r][2] * z + affine[r][3]);
  const rows = lesions
    .map((lesion) => ({ ...lesion, ml: lesion.voxels * ml, world: world(lesion.centroid) }))
    .sort((p, q) => q.voxels - p.voxels);
  const lines = ['lesion\tvoxels\tvolume_ml\tx_mm\ty_mm\tz_mm'];
  for (const [n, r] of rows.entries()) {
    lines.push([n + 1, r.voxels, r.ml.toFixed(4), ...r.world.map((v) => v.toFixed(1))].join('\t'));
  }
  return { rows, tsv: `${lines.join('\n')}\n`, totalMl: rows.reduce((s, r) => s + r.ml, 0) };
}
