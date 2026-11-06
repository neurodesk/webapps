// GlioMODA inference: nnU-Net 2.5.2's predict_from_files around a patch runner. Pure: no DOM and
// no ONNX Runtime import (the runner is injected).
//
// nnU-Net reads a NIfTI volume as a C-order (z, y, x) array, which is the NIfTI voxel buffer as it
// is (x fastest), and every GlioMODA plan has transpose_forward [0, 1, 2] and 1 mm spacing. On the
// 240 x 240 x 155 atlas grid nnU-Net neither reorients nor resamples, so neither do we.

export const MODALITIES = Object.freeze(['t1c', 't2f', 't1n', 't2w']);
export const ATLAS_DIMS = Object.freeze([240, 240, 155]);
export const STEP = 0.5;

const product = (shape) => shape[0] * shape[1] * shape[2];

// The nearest float16 value, ties to even, as torch stores a half tensor. Math.f16round does this
// but is missing before Node 24 and Chrome 135.
export function f16round(x) {
  const a = Math.abs(x);
  if (!Number.isFinite(x) || a === 0) return x;
  if (a >= 65520) return Math.sign(x) * Infinity;
  let e = Math.max(Math.floor(Math.log2(a)), -14);
  if (e > -14 && 2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  const quantum = 2 ** (e - 10);
  const scaled = a / quantum;
  const floor = Math.floor(scaled);
  const rest = scaled - floor;
  const steps = rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
  return Math.sign(x) * steps * quantum;
}

// The atlas grid is the model's only input contract, so a file off it is refused by name.
export function checkAtlasGrid(role, volume) {
  const dims = volume.dims.join(' × ');
  if (volume.dims.some((n, a) => n !== ATLAS_DIMS[a])) {
    throw new Error(`The ${role.toUpperCase()} image is ${dims} voxels. GlioMODA needs skull-stripped images on the BraTS/SRI24 atlas grid, 240 × 240 × 155 at 1 mm.`);
  }
  const a = volume.affine;
  if (!a || a.length !== 4 || a.some((row) => row.length !== 4 || Array.from(row).some((value) => !Number.isFinite(value)))) {
    throw new Error(`The ${role.toUpperCase()} image has an invalid spatial transform.`);
  }
  const determinant = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (Math.abs(determinant) < 1e-6) throw new Error(`The ${role.toUpperCase()} image has a degenerate spatial transform.`);
  const spacing = [0, 1, 2].map((a) => Math.hypot(volume.affine[0][a], volume.affine[1][a], volume.affine[2][a]));
  if (spacing.some((s) => Math.abs(s - 1) > 1e-3)) {
    throw new Error(`The ${role.toUpperCase()} image has ${spacing.map((s) => s.toFixed(2)).join(' × ')} mm voxels. GlioMODA needs the 1 mm BraTS/SRI24 atlas grid.`);
  }
}

// The model folder name for the supplied sequences, in GlioMODA's order (t1c, t2f, t1n, t2w).
export function modeFor(roles) {
  const mode = MODALITIES.filter((m) => roles.includes(m)).join('-');
  if (!mode) throw new Error('Add at least one of T1c, FLAIR, T1 or T2.');
  return mode;
}

// Nonzero in any channel, with enclosed holes filled: nnU-Net's create_nonzero_mask, whose
// binary_fill_holes floods the background from the border with 6-connectivity.
export function nonzeroMask(channels, shape) {
  const n = product(shape);
  const mask = new Uint8Array(n);
  for (const data of channels) {
    for (let i = 0; i < n; i++) if (data[i] !== 0) mask[i] = 1;
  }
  const [nz, ny, nx] = shape;
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  const seed = (i) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (z === 0 || z === nz - 1 || y === 0 || y === ny - 1 || x === 0 || x === nx - 1) seed((z * ny + y) * nx + x);
      }
    }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / (nx * ny));
    if (x > 0) seed(i - 1);
    if (x < nx - 1) seed(i + 1);
    if (y > 0) seed(i - nx);
    if (y < ny - 1) seed(i + nx);
    if (z > 0) seed(i - nx * ny);
    if (z < nz - 1) seed(i + nx * ny);
  }
  for (let i = 0; i < n; i++) mask[i] = outside[i] ? 0 : 1;
  return mask;
}

export function boundingBox(mask, shape) {
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
  if (hi[0] < 0) throw new Error('Every input image is empty.');
  return { lo, hi, shape: hi.map((h, a) => h - lo[a]) };
}

export function crop(data, shape, box, Type = Float32Array) {
  const out = new Type(product(box.shape));
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

// ZScoreNormalization with use_mask_for_norm, in float32 as nnU-Net computes it: inside the
// filled mask (x - mean) / max(std, 1e-8), outside zero (every channel is zero there).
export function normalize(image, inside) {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < image.length; i++) {
    if (inside[i]) {
      n++;
      sum += image[i];
    }
  }
  const mean = Math.fround(sum / n);
  let squares = 0;
  for (let i = 0; i < image.length; i++) {
    if (inside[i]) squares += Math.fround(image[i] - mean) ** 2;
  }
  const std = Math.fround(Math.max(Math.sqrt(squares / n), 1e-8));
  const out = new Float32Array(image.length);
  for (let i = 0; i < image.length; i++) out[i] = inside[i] ? Math.fround(image[i] - mean) / std : 0;
  return out;
}

// numpy's round, which rounds halves to even.
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

// compute_steps_for_sliding_window along one axis.
export function windowStarts(size, patch, step = STEP) {
  const count = Math.ceil((size - patch) / (patch * step)) + 1;
  if (count <= 1) return [0];
  const stride = (size - patch) / (count - 1);
  return Array.from({ length: count }, (_, i) => roundHalfEven(stride * i));
}

export function windows(shape, patch) {
  const list = [];
  for (const z of windowStarts(shape[0], patch[0])) {
    for (const y of windowStarts(shape[1], patch[1])) {
      for (const x of windowStarts(shape[2], patch[2])) list.push([z, y, x]);
    }
  }
  return list;
}

// compute_gaussian: a centred Gaussian with sigma an eighth of the patch, scaled to a peak of
// 10 and stored as float16, its underflowed corners raised to the smallest stored weight.
export function gaussianWeights(patch) {
  const axis = (n) => Float64Array.from({ length: n }, (_, i) => Math.exp(-((i - Math.floor(n / 2)) ** 2) / (2 * (n / 8) ** 2)));
  const [gz, gy, gx] = patch.map(axis);
  const out = new Float32Array(product(patch));
  let smallest = Infinity;
  let o = 0;
  for (let z = 0; z < patch[0]; z++) {
    for (let y = 0; y < patch[1]; y++) {
      for (let x = 0; x < patch[2]; x++, o++) {
        out[o] = f16round(gz[z] * gy[y] * gx[x] * 10);
        if (out[o] > 0) smallest = Math.min(smallest, out[o]);
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] === 0) out[i] = smallest;
  return out;
}

// The flips _internal_maybe_mirror_and_predict adds to the plain pass, in its order.
export function mirrorCombinations(axes) {
  const combos = [];
  for (let size = 1; size <= axes.length; size++) {
    const pick = (start, chosen) => {
      if (chosen.length === size) {
        combos.push(chosen);
        return;
      }
      for (let i = start; i < axes.length; i++) pick(i + 1, [...chosen, axes[i]]);
    };
    pick(0, []);
  }
  return combos;
}

// Flips a [channels, ...patch] tile along the given spatial axes; a flip is its own inverse.
export function flip(tile, channels, patch, axes) {
  if (!axes.length) return tile;
  const [d, h, w] = patch;
  const [fz, fy, fx] = [0, 1, 2].map((a) => axes.includes(a));
  const out = new Float32Array(tile.length);
  const voxels = d * h * w;
  for (let c = 0; c < channels; c++) {
    const base = c * voxels;
    for (let z = 0; z < d; z++) {
      const sz = fz ? d - 1 - z : z;
      for (let y = 0; y < h; y++) {
        const sy = fy ? h - 1 - y : y;
        const src = base + (sz * h + sy) * w;
        const dst = base + (z * h + y) * w;
        if (fx) {
          for (let x = 0; x < w; x++) out[dst + x] = tile[src + w - 1 - x];
        } else {
          out.set(tile.subarray(src, src + w), dst);
        }
      }
    }
  }
  return out;
}

// A network never scores every voxel and region alike. Some virtual GPUs complete a WebGPU run and
// return all zeros; failing here lets the caller retry on the CPU.
export function checkLogits(logits) {
  const first = logits[0];
  let varies = false;
  for (const value of logits) {
    if (!Number.isFinite(value)) throw new Error('the network returned non-finite scores');
    if (value !== first) varies = true;
  }
  if (!varies) throw new Error('the network returned the same score for every voxel');
}

function padCentered(image, channels, shape, minimum) {
  const padded = shape.map((n, a) => Math.max(n, minimum[a]));
  const before = padded.map((n, a) => Math.floor((n - shape[a]) / 2));
  if (padded.every((n, a) => n === shape[a])) return { image, shape, before };
  const out = new Float32Array(channels * product(padded));
  for (let c = 0; c < channels; c++) {
    for (let z = 0; z < shape[0]; z++) {
      for (let y = 0; y < shape[1]; y++) {
        const src = ((c * shape[0] + z) * shape[1] + y) * shape[2];
        const dst = ((c * padded[0] + z + before[0]) * padded[1] + y + before[1]) * padded[2] + before[2];
        out.set(image.subarray(src, src + shape[2]), dst);
      }
    }
  }
  return { image: out, shape: padded, before };
}

// predict_sliding_window_return_logits: Gaussian-weighted overlapping patches, each the mean of
// the plain and mirrored passes, accumulated in float16 as nnU-Net does. `image` is
// [channels, ...shape]; `runPatch(tile)` resolves to logits [regions, ...patch]. Returns the
// averaged logits [regions, ...shape].
export async function predictLogits({ image, channels, shape, patch, regions, mirrorAxes = [], runPatch, onPatch = () => {}, signal }) {
  const padded = padCentered(image, channels, shape, patch);
  const weights = gaussianWeights(patch);
  const origins = windows(padded.shape, patch);
  const flips = [[], ...mirrorCombinations(mirrorAxes)];
  const voxels = product(patch);
  const total = product(padded.shape);
  const sum = new Float32Array(regions * total);
  const count = new Float32Array(total);
  const tile = new Float32Array(channels * voxels);
  const passes = origins.length * flips.length;
  let done = 0;
  for (const [z0, y0, x0] of origins) {
    for (let c = 0; c < channels; c++) {
      let t = c * voxels;
      for (let z = 0; z < patch[0]; z++) {
        for (let y = 0; y < patch[1]; y++) {
          const start = ((c * padded.shape[0] + z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
          tile.set(padded.image.subarray(start, start + patch[2]), t);
          t += patch[2];
        }
      }
    }
    let prediction = null;
    for (const axes of flips) {
      signal?.throwIfAborted();
      const logits = await runPatch(flip(tile, channels, patch, axes));
      signal?.throwIfAborted();
      checkLogits(logits);
      const restored = flip(logits, regions, patch, axes);
      if (prediction) {
        for (let i = 0; i < prediction.length; i++) prediction[i] += restored[i];
      } else {
        prediction = Float32Array.from(restored);
      }
      onPatch(++done, passes);
    }
    for (let r = 0; r < regions; r++) {
      let t = 0;
      for (let z = 0; z < patch[0]; z++) {
        for (let y = 0; y < patch[1]; y++) {
          const row = ((z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
          for (let x = 0; x < patch[2]; x++, t++) {
            const value = Math.fround(Math.fround(prediction[r * voxels + t] / flips.length) * weights[t]);
            sum[r * total + row + x] = f16round(sum[r * total + row + x] + value);
          }
        }
      }
    }
    let t = 0;
    for (let z = 0; z < patch[0]; z++) {
      for (let y = 0; y < patch[1]; y++) {
        const row = ((z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
        for (let x = 0; x < patch[2]; x++, t++) count[row + x] = f16round(count[row + x] + weights[t]);
      }
    }
  }
  const out = new Float32Array(regions * product(shape));
  let o = 0;
  for (let r = 0; r < regions; r++) {
    for (let z = 0; z < shape[0]; z++) {
      for (let y = 0; y < shape[1]; y++) {
        const row = ((z + padded.before[0]) * padded.shape[1] + y + padded.before[1]) * padded.shape[2] + padded.before[2];
        for (let x = 0; x < shape[2]; x++, o++) out[o] = f16round(sum[r * total + row + x] / count[row + x]);
      }
    }
  }
  return { logits: out, windows: origins.length, passes };
}

// Sigmoid per region and label assignment in regions_class_order, later regions overwriting
// earlier ones: whole tumour gives 2, tumour core 1, enhancing tumour 3.
export function regionLabels(logits, voxels, classOrder) {
  const labels = new Uint8Array(voxels);
  for (const [r, label] of classOrder.entries()) {
    for (let i = 0; i < voxels; i++) {
      if (Math.fround(1 / (1 + Math.exp(-logits[r * voxels + i]))) > 0.5) labels[i] = label;
    }
  }
  return labels;
}

// Atlas-grid volumes keyed by role → BraTS labels on the same grid. `model` is a manifest entry:
// its channels, patch, mirror axes and region order.
export async function segmentGlioma({ volumes, model, runPatch, mirror = true, onPatch, signal }) {
  const roles = model.channels;
  for (const role of roles) {
    if (!volumes[role]) throw new Error(`The ${model.id} model needs a ${role.toUpperCase()} image.`);
    checkAtlasGrid(role, volumes[role]);
  }
  const reference = volumes[roles[0]].affine;
  for (const role of roles.slice(1)) {
    // NIfTI float32 header rounding is tolerated; displaced or reoriented grids are not.
    if (volumes[role].affine.some((row, i) => Array.from(row).some((value, j) => Math.abs(value - reference[i][j]) > 1e-5))) {
      throw new Error(`The ${role.toUpperCase()} image is not aligned with ${roles[0].toUpperCase()}. Register all sequences to the same atlas grid before segmentation.`);
    }
  }
  const dims = volumes[roles[0]].dims;
  const shape = [dims[2], dims[1], dims[0]];
  const mask = nonzeroMask(roles.map((role) => volumes[role].data), shape);
  const box = boundingBox(mask, shape);
  const inside = crop(mask, shape, box, Uint8Array);
  const voxels = product(box.shape);
  const image = new Float32Array(roles.length * voxels);
  for (const [c, role] of roles.entries()) image.set(normalize(crop(volumes[role].data, shape, box), inside), c * voxels);
  const regions = model.regions_class_order.length;
  const { logits, windows: count, passes } = await predictLogits({
    image,
    channels: roles.length,
    shape: box.shape,
    patch: model.patch,
    regions,
    mirrorAxes: mirror ? model.mirror_axes : [],
    runPatch,
    onPatch,
    signal,
  });
  const cropped = regionLabels(logits, voxels, model.regions_class_order);
  const labels = new Uint8Array(product(shape));
  let o = 0;
  for (let z = box.lo[0]; z < box.hi[0]; z++) {
    for (let y = box.lo[1]; y < box.hi[1]; y++) {
      labels.set(cropped.subarray(o, o + box.shape[2]), (z * shape[1] + y) * shape[2] + box.lo[2]);
      o += box.shape[2];
    }
  }
  return { labels, dims, affine: volumes[roles[0]].affine, box, windows: count, passes };
}
