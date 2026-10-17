// SEALS (DeepISLES' nnU-Net v1, ISLES'22 winner) inference around an ONNX
// patch runner. apps/calmar/scripts/run_seals_onnx.py is the reference: it
// matches nnU-Net's own inference, and these functions reproduce it.
//
// Volumes are x-fastest (NIfTI voxel order) in the file's own axis order,
// which is the order nnU-Net sees through SimpleITK, so a [X, Y, Z] volume is
// the model's [Z, Y, X] tensor without a transpose.

import { invertAffine, resampleAffine } from './resample.js';

export const SEALS_PATCH = 128;
const MIRRORS = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];

// DeepISLES resamples DWI/TRACE to 1 mm, keeping origin and axis directions.
export function grid1mm(dims, affine) {
  const columns = [0, 1, 2].map(c => Math.hypot(affine[0][c], affine[1][c], affine[2][c]));
  return {
    dims: dims.map((n, i) => Math.round(n * columns[i])),
    affine: affine.map((row, r) => r === 3 ? [...row] : [row[0] / columns[0], row[1] / columns[1], row[2] / columns[2], row[3]])
  };
}

// SimpleITK's linear resampling (ITK LinearInterpolateImageFunction): a
// point is inside when its continuous index lies in [-0.5, n - 0.5); there
// the index is clamped to [0, n - 1] before interpolating, outside it is 0.
// DeepISLES resamples with SimpleITK, so SEALS must see the same edges.
export function resampleLinearItk(src, srcDims, srcAffine, dstDims, dstAffine) {
  const inv = invertAffine(srcAffine);
  const M = [0, 1, 2].map(r => [0, 1, 2, 3].map(c => inv[r][0] * dstAffine[0][c] + inv[r][1] * dstAffine[1][c] + inv[r][2] * dstAffine[2][c] + inv[r][3] * dstAffine[3][c]));
  const [SX, SY, SZ] = srcDims;
  const [DX, DY, DZ] = dstDims;
  const out = new Float32Array(DX * DY * DZ);
  const axis = (c, n) => {
    if (!(c >= -0.5 && c < n - 0.5)) return null;
    const clamped = Math.min(Math.max(c, 0), n - 1);
    const i0 = Math.floor(clamped);
    return [i0, Math.min(i0 + 1, n - 1), clamped - i0];
  };
  for (let dz = 0; dz < DZ; dz++) {
    for (let dy = 0; dy < DY; dy++) {
      for (let dx = 0; dx < DX; dx++) {
        const ax = axis(M[0][0] * dx + M[0][1] * dy + M[0][2] * dz + M[0][3], SX);
        const ay = axis(M[1][0] * dx + M[1][1] * dy + M[1][2] * dz + M[1][3], SY);
        const az = axis(M[2][0] * dx + M[2][1] * dy + M[2][2] * dz + M[2][3], SZ);
        if (!ax || !ay || !az) continue;
        const at = (x, y, z) => src[x + SX * (y + SY * z)];
        const [x0, x1, fx] = ax;
        const [y0, y1, fy] = ay;
        const [z0, z1, fz] = az;
        const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
        const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
        const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
        const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
        out[dx + DX * (dy + DY * dz)] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
      }
    }
  }
  return out;
}

// ADC = ln(b0 / TRACE) / b. SEALS z-scores each channel, so b cancels.
export function adcFromB0(b0, trace, bValue = 1000) {
  const adc = new Float32Array(trace.length);
  for (let i = 0; i < trace.length; i++) {
    if (b0[i] > 0 && trace[i] > 0) adc[i] = Math.max(0, Math.log(b0[i] / trace[i]) / bValue);
  }
  return adc;
}

// scipy.ndimage.binary_fill_holes with its default 6-connected structure:
// background not reachable from the border becomes foreground.
export function fillHoles(mask, dims) {
  const [X, Y, Z] = dims;
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;
  const seed = (i) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        if (x === 0 || y === 0 || z === 0 || x === X - 1 || y === Y - 1 || z === Z - 1) seed(x + X * (y + Y * z));
      }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % X;
    const y = Math.floor(i / X) % Y;
    const z = Math.floor(i / (X * Y));
    if (x > 0) seed(i - 1);
    if (x < X - 1) seed(i + 1);
    if (y > 0) seed(i - X);
    if (y < Y - 1) seed(i + X);
    if (z > 0) seed(i - X * Y);
    if (z < Z - 1) seed(i + X * Y);
  }
  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < filled.length; i++) filled[i] = outside[i] ? 0 : 1;
  return filled;
}

// nnU-Net v1 crop_to_nonzero + nonCT normalisation with use_mask_for_norm:
// crop to the hole-filled nonzero mask of all channels, z-score each channel
// inside it, zero outside.
export function cropAndNormalize(channels, dims) {
  const [X, Y, Z] = dims;
  const nonzero = new Uint8Array(X * Y * Z);
  for (const channel of channels) {
    for (let i = 0; i < nonzero.length; i++) if (channel[i] !== 0) nonzero[i] = 1;
  }
  const mask = fillHoles(nonzero, dims);
  const lo = [X, Y, Z];
  const hi = [-1, -1, -1];
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        if (!mask[x + X * (y + Y * z)]) continue;
        const p = [x, y, z];
        for (let a = 0; a < 3; a++) {
          if (p[a] < lo[a]) lo[a] = p[a];
          if (p[a] > hi[a]) hi[a] = p[a];
        }
      }
    }
  }
  if (hi[0] < 0) throw new Error('SEALS input is empty: no nonzero DWI/ADC voxels.');
  const cropDims = [0, 1, 2].map(a => hi[a] - lo[a] + 1);
  const [cx, cy, cz] = cropDims;
  const cropMask = new Uint8Array(cx * cy * cz);
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        cropMask[x + cx * (y + cy * z)] = mask[(x + lo[0]) + X * ((y + lo[1]) + Y * (z + lo[2]))];
      }
    }
  }
  const data = channels.map((channel) => {
    const out = new Float32Array(cx * cy * cz);
    let sum = 0;
    let count = 0;
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          const v = channel[(x + lo[0]) + X * ((y + lo[1]) + Y * (z + lo[2]))];
          const i = x + cx * (y + cy * z);
          out[i] = v;
          if (cropMask[i]) {
            sum += v;
            count++;
          }
        }
      }
    }
    const mean = sum / count;
    let ss = 0;
    for (let i = 0; i < out.length; i++) if (cropMask[i]) ss += (out[i] - mean) ** 2;
    const std = Math.sqrt(ss / count);
    for (let i = 0; i < out.length; i++) out[i] = cropMask[i] ? (out[i] - mean) / (std + 1e-8) : 0;
    return out;
  });
  return { data, dims: cropDims, offset: lo };
}

// nnU-Net v1 _compute_steps_for_sliding_window for one axis.
export function slidingWindowSteps(size, patch = SEALS_PATCH, step = 0.5) {
  const n = Math.ceil((size - patch) / (patch * step)) + 1;
  if (n <= 1) return [0];
  const stride = (size - patch) / (n - 1);
  return Array.from({ length: n }, (_, i) => roundHalfEven(stride * i));
}

// numpy.round: halves go to the even neighbour.
function roundHalfEven(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// nnU-Net v1 _get_gaussian(patch, 1/8): separable, normalised to a peak of 1.
export function gaussianImportance(patch = SEALS_PATCH) {
  const sigma = patch / 8;
  const centre = Math.floor(patch / 2);
  const g = Float64Array.from({ length: patch }, (_, i) => Math.exp(-((i - centre) ** 2) / (2 * sigma * sigma)));
  const out = new Float32Array(patch ** 3);
  for (let z = 0; z < patch; z++) {
    for (let y = 0; y < patch; y++) {
      for (let x = 0; x < patch; x++) out[x + patch * (y + patch * z)] = g[x] * g[y] * g[z];
    }
  }
  return out;
}

function flipPatch(src, axes, p) {
  if (!axes.length) return src;
  const out = new Float32Array(src.length);
  const fx = axes.includes(0);
  const fy = axes.includes(1);
  const fz = axes.includes(2);
  const per = p * p * p;
  for (let c = 0; c < src.length / per; c++) {
    const base = c * per;
    for (let z = 0; z < p; z++) {
      const sz = fz ? p - 1 - z : z;
      for (let y = 0; y < p; y++) {
        const sy = fy ? p - 1 - y : y;
        for (let x = 0; x < p; x++) {
          out[base + x + p * (y + p * z)] = src[base + (fx ? p - 1 - x : x) + p * (sy + p * sz)];
        }
      }
    }
  }
  return out;
}

// Lesion probability by nnU-Net v1's sliding window: centred zero padding up
// to the patch, step 0.5, Gaussian weighting, softmax averaged over the 8
// mirrorings. runPatch(Float32Array [2, p, p, p], p) resolves to the raw
// [2, p, p, p] logits (background, lesion).
export async function predictLesionProbability(channels, dims, runPatch, { mirror = true, onProgress = () => {} } = {}) {
  const p = SEALS_PATCH;
  const pad = dims.map(n => Math.max(0, p - n));
  const before = pad.map(n => Math.floor(n / 2));
  const shape = dims.map((n, a) => n + pad[a]);
  const [SX, SY, SZ] = shape;
  const padded = channels.map((channel) => {
    const out = new Float32Array(SX * SY * SZ);
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        const src = dims[0] * (y + dims[1] * z);
        const dst = before[0] + SX * ((y + before[1]) + SY * (z + before[2]));
        out.set(channel.subarray(src, src + dims[0]), dst);
      }
    }
    return out;
  });
  const weights = gaussianImportance(p);
  const lesion = new Float32Array(SX * SY * SZ);
  const count = new Float32Array(SX * SY * SZ);
  const positions = [];
  for (const x of slidingWindowSteps(SX, p)) {
    for (const y of slidingWindowSteps(SY, p)) {
      for (const z of slidingWindowSteps(SZ, p)) positions.push([x, y, z]);
    }
  }
  const flips = mirror ? MIRRORS : [[]];
  const per = p * p * p;
  let done = 0;
  for (const [ox, oy, oz] of positions) {
    const patch = new Float32Array(2 * per);
    for (let c = 0; c < 2; c++) {
      for (let z = 0; z < p; z++) {
        for (let y = 0; y < p; y++) {
          const src = ox + SX * ((oy + y) + SY * (oz + z));
          patch.set(padded[c].subarray(src, src + p), c * per + p * (y + p * z));
        }
      }
    }
    const prob = new Float32Array(per);
    for (const axes of flips) {
      const logits = flipPatch(await runPatch(flipPatch(patch, axes, p), p), axes, p);
      for (let i = 0; i < per; i++) {
        prob[i] += 1 / (1 + Math.exp(logits[i] - logits[per + i])) / flips.length;
      }
      onProgress(++done, positions.length * flips.length);
    }
    for (let z = 0; z < p; z++) {
      for (let y = 0; y < p; y++) {
        for (let x = 0; x < p; x++) {
          const i = x + p * (y + p * z);
          const o = (ox + x) + SX * ((oy + y) + SY * (oz + z));
          lesion[o] += prob[i] * weights[i];
          count[o] += weights[i];
        }
      }
    }
  }
  const out = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        const o = (x + before[0]) + SX * ((y + before[1]) + SY * (z + before[2]));
        out[x + dims[0] * (y + dims[1] * z)] = lesion[o] / count[o];
      }
    }
  }
  return out;
}

// The whole SEALS seed: DWI/TRACE with its brain mask, and ADC on its own
// grid, in; a binary lesion mask on the DWI/TRACE grid out. Each image is
// masked on its own grid and sampled once onto the 1 mm grid, as DeepISLES'
// Task500 conversion does with skull-stripped inputs.
export async function segmentSeals({ dwi, adc, brainMask = null, dims, affine }, runPatch, options = {}) {
  const applyMask = (data, mask) => {
    if (!mask) return data;
    const out = new Float32Array(data.length);
    for (let i = 0; i < out.length; i++) out[i] = mask[i] ? data[i] : 0;
    return out;
  };
  const adcMask = brainMask && resampleAffine(brainMask, dims, affine, adc.dims, adc.affine, 'nearest');
  const grid = grid1mm(dims, affine);
  const onGrid = [
    resampleLinearItk(applyMask(dwi, brainMask), dims, affine, grid.dims, grid.affine),
    resampleLinearItk(applyMask(adc.data, adcMask), adc.dims, adc.affine, grid.dims, grid.affine)
  ];
  const crop = cropAndNormalize(onGrid, grid.dims);
  const probability = await predictLesionProbability(crop.data, crop.dims, runPatch, options);
  const [GX, GY] = grid.dims;
  const [cx, cy, cz] = crop.dims;
  const labels = new Uint8Array(grid.dims[0] * grid.dims[1] * grid.dims[2]);
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        if (probability[x + cx * (y + cy * z)] > 0.5) {
          labels[(x + crop.offset[0]) + GX * ((y + crop.offset[1]) + GY * (z + crop.offset[2]))] = 1;
        }
      }
    }
  }
  return resampleAffine(labels, grid.dims, grid.affine, dims, affine, 'nearest');
}
