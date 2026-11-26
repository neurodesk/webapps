// BrainLes AURORA v0.2.7 inference pipeline around an injected ONNX patch runner.
// Pure module: no DOM and no ONNX Runtime import so unit tests stay fast and network-free.
//
// Upstream MONAI LoadImageD reads NIfTI via nibabel in (X, Y, Z) axis order, so the network sees
// NCDHW = (1, 1, X=240, Y=240, Z=155) with roi_size = (192, 192, 32). NIfTI voxel buffers store X
// fastest (flat index x + nx * (y + ny * z)), so we reorder into C-order (X, Y, Z) before sliding
// window inference and map the 2-region segmentation back to NIfTI order afterwards.

export const ATLAS_DIMS = Object.freeze([240, 240, 155]);
export const DEFAULT_PATCH = Object.freeze([192, 192, 32]);
export const DEFAULT_OVERLAP = 0.5;
export const DEFAULT_SIGMA_SCALE = 0.125;
export const DEFAULT_THRESHOLD = 0.5;

const FLOAT32_MAX = 3.4028234663852886e38;

const product = (shape) => shape[0] * shape[1] * shape[2];

/** Validate the prepared SRI24 / BraTS atlas grid expected by AURORA (240 x 240 x 155 at 1 mm). */
export function checkPreparedGrid(volume, role = 'T1c') {
  if (!volume || !Array.isArray(volume.dims) || volume.dims.length !== 3) {
    throw new Error(`The ${role} image must be a 3D NIfTI volume.`);
  }
  const dimsText = volume.dims.join(' × ');
  if (volume.dims.some((n, axis) => n !== ATLAS_DIMS[axis])) {
    throw new Error(
      `The ${role} image is ${dimsText} voxels. AURORA needs a skull-stripped T1c scan on the 240 × 240 × 155 (1 mm) BraTS/SRI24 atlas grid.`,
    );
  }
  const a = volume.affine;
  if (!a || a.length !== 4 || a.some((row) => row.length !== 4 || Array.from(row).some((value) => !Number.isFinite(value)))) {
    throw new Error(`The ${role} image has an invalid spatial transform.`);
  }
  const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (Math.abs(det) < 1e-6) {
    throw new Error(`The ${role} image has a degenerate spatial transform.`);
  }
  const spacing = [0, 1, 2].map((axis) => Math.hypot(a[0][axis], a[1][axis], a[2][axis]));
  if (spacing.some((s) => Math.abs(s - 1) > 1e-3)) {
    throw new Error(
      `The ${role} image has ${spacing.map((s) => s.toFixed(2)).join(' × ')} mm voxels. AURORA needs the 1 mm BraTS/SRI24 atlas grid.`,
    );
  }
}

/** Match numpy.nan_to_num on float32 arrays. */
export function nanToNum(data) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isNaN(v)) out[i] = 0;
    else if (v === Infinity) out[i] = FLOAT32_MAX;
    else if (v === -Infinity) out[i] = -FLOAT32_MAX;
    else out[i] = v;
  }
  return out;
}

/** Exact NumPy linear-interpolation percentile on an ascending sorted array. */
export function percentileLinear(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = (p / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Match MONAI ScaleIntensityRangePercentiles(lower=0.5, upper=99.5, b_min=0, b_max=1, clip=True).
 * Applies nanToNum first as AURORA's DataHandler does. When the 0.5th and 99.5th percentiles are
 * equal (degenerate/constant volume), returns zeros so segmentMetastasis refuses the image rather
 * than feeding unclipped `img - a_min` values to the network.
 */
export function scaleIntensityPercentiles(data, lower = 0.5, upper = 99.5) {
  const clean = nanToNum(data);
  const sorted = Float32Array.from(clean);
  sorted.sort();
  const aMin = percentileLinear(sorted, lower);
  const aMax = percentileLinear(sorted, upper);
  const span = aMax - aMin;
  if (span === 0) {
    clean.fill(0);
    return clean;
  }
  for (let i = 0; i < clean.length; i++) {
    let scaled = (clean[i] - aMin) / span;
    if (scaled < 0) scaled = 0;
    else if (scaled > 1) scaled = 1;
    clean[i] = scaled;
  }
  return clean;
}

/** Reorder NIfTI x-fastest buffer [x + nx*(y + ny*z)] into C-order MONAI [((x*ny + y)*nz + z)]. */
export function niftiToMonai(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(nx * ny * nz);
  const nyNz = ny * nz;
  for (let z = 0; z < nz; z++) {
    const zBase = z * nx * ny;
    for (let y = 0; y < ny; y++) {
      const srcRow = zBase + y * nx;
      let dst = y * nz + z;
      for (let x = 0; x < nx; x++, dst += nyNz) {
        out[dst] = data[srcRow + x];
      }
    }
  }
  return out;
}

/** Reorder C-order MONAI [((x*ny + y)*nz + z)] Uint8Array back to NIfTI x-fastest order. */
export function monaiToNiftiUint8(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new Uint8Array(nx * ny * nz);
  const nyNz = ny * nz;
  for (let z = 0; z < nz; z++) {
    const zBase = z * nx * ny;
    for (let y = 0; y < ny; y++) {
      const dstRow = zBase + y * nx;
      let src = y * nz + z;
      for (let x = 0; x < nx; x++, src += nyNz) {
        out[dstRow + x] = data[src];
      }
    }
  }
  return out;
}

/** Match MONAI dense_patch_slices for 3D sliding windows. */
export function densePatchOrigins(imageSize, patchSize, overlap = DEFAULT_OVERLAP) {
  const startsPerAxis = [];
  for (let axis = 0; axis < 3; axis++) {
    const size = imageSize[axis];
    const patch = Math.min(patchSize[axis], size);
    const interval = Math.max(Math.trunc(patch * (1 - overlap)), 1);
    const maxNum = Math.ceil(size / interval);
    let scanDim = 0;
    for (let d = 0; d < maxNum; d++) {
      if (d * interval + patch >= size) {
        scanDim = d;
        break;
      }
    }
    const count = scanDim + 1;
    const axisStarts = [];
    for (let idx = 0; idx < count; idx++) {
      let s = idx * interval;
      const overshoot = s + patch - size;
      if (overshoot > 0) s -= overshoot;
      axisStarts.push(s);
    }
    startsPerAxis.push(axisStarts);
  }
  const origins = [];
  for (const x of startsPerAxis[0]) {
    for (const y of startsPerAxis[1]) {
      for (const z of startsPerAxis[2]) {
        origins.push([x, y, z]);
      }
    }
  }
  return origins;
}

/** Match MONAI compute_importance_map(patch_size, mode="gaussian", sigma_scale=0.125). */
export function monaiGaussianWeights(patchSize, sigmaScale = DEFAULT_SIGMA_SCALE) {
  const axes = patchSize.map((n) => {
    const sigma = n * sigmaScale;
    const half = (n - 1) / 2;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const dx = i - half;
      g[i] = Math.exp((dx * dx) / (-2 * sigma * sigma));
    }
    return g;
  });
  const [gx, gy, gz] = axes;
  const out = new Float32Array(product(patchSize));
  let minVal = Infinity;
  let o = 0;
  for (let x = 0; x < patchSize[0]; x++) {
    for (let y = 0; y < patchSize[1]; y++) {
      const gxy = gx[x] * gy[y];
      for (let z = 0; z < patchSize[2]; z++, o++) {
        const w = gxy * gz[z];
        out[o] = w;
        if (w < minVal) minVal = w;
      }
    }
  }
  const floor = Math.max(minVal, 1e-3);
  for (let i = 0; i < out.length; i++) {
    if (out[i] < floor) out[i] = floor;
  }
  return out;
}

/** Replicate-pad a 3D C-order tensor to at least minimum shape (matching MONAI SlidingWindowInferer). */
export function padReplicate(data, shape, minimum) {
  const padded = shape.map((n, a) => Math.max(n, minimum[a]));
  const before = padded.map((n, a) => Math.floor((n - shape[a]) / 2));
  if (padded.every((n, a) => n === shape[a])) {
    return { data, shape, before };
  }
  const [sx, sy, sz] = shape;
  const [px, py, pz] = padded;
  const out = new Float32Array(px * py * pz);
  for (let x = 0; x < px; x++) {
    const rx = Math.min(Math.max(x - before[0], 0), sx - 1);
    for (let y = 0; y < py; y++) {
      const ry = Math.min(Math.max(y - before[1], 0), sy - 1);
      const srcRow = (rx * sy + ry) * sz;
      const dstRow = (x * py + y) * pz;
      for (let z = 0; z < pz; z++) {
        const rz = Math.min(Math.max(z - before[2], 0), sz - 1);
        out[dstRow + z] = data[srcRow + rz];
      }
    }
  }
  return { data: out, shape: padded, before };
}

/** Reject constant or non-finite patch logits (catches silent zero-output broken WebGPU adapters). */
export function checkLogits(logits) {
  const first = logits[0];
  let varies = false;
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i];
    if (!Number.isFinite(v)) throw new Error('The network returned non-finite scores.');
    if (v !== first) varies = true;
  }
  if (!varies) throw new Error('The network returned the same score for every voxel.');
}

/** Run MONAI-matching Gaussian-weighted sliding window inference on a single-channel (X, Y, Z) tensor. */
export async function predictLogits({
  image,
  shape,
  patch = DEFAULT_PATCH,
  overlap = DEFAULT_OVERLAP,
  runPatch,
  onPatch = () => {},
  signal,
}) {
  const padded = padReplicate(image, shape, patch);
  const weights = monaiGaussianWeights(patch);
  const origins = densePatchOrigins(padded.shape, patch, overlap);
  const patchVoxels = product(patch);
  const totalVoxels = product(padded.shape);
  const channels = 2;
  const sum = new Float32Array(channels * totalVoxels);
  const denom = new Float32Array(totalVoxels);
  const tile = new Float32Array(patchVoxels);
  const [px, py, pz] = padded.shape;
  const [rx, ry, rz] = patch;

  for (let idx = 0; idx < origins.length; idx++) {
    signal?.throwIfAborted();
    const [x0, y0, z0] = origins[idx];
    let t = 0;
    for (let x = 0; x < rx; x++) {
      for (let y = 0; y < ry; y++) {
        const src = ((x0 + x) * py + (y0 + y)) * pz + z0;
        tile.set(padded.data.subarray(src, src + rz), t);
        t += rz;
      }
    }
    const logits = await runPatch(tile);
    signal?.throwIfAborted();
    checkLogits(logits);

    for (let c = 0; c < channels; c++) {
      const cOff = c * totalVoxels;
      const pOff = c * patchVoxels;
      let k = 0;
      for (let x = 0; x < rx; x++) {
        for (let y = 0; y < ry; y++) {
          const dst = cOff + ((x0 + x) * py + (y0 + y)) * pz + z0;
          for (let z = 0; z < rz; z++, k++) {
            sum[dst + z] += logits[pOff + k] * weights[k];
          }
        }
      }
    }
    let k = 0;
    for (let x = 0; x < rx; x++) {
      for (let y = 0; y < ry; y++) {
        const dst = ((x0 + x) * py + (y0 + y)) * pz + z0;
        for (let z = 0; z < rz; z++, k++) {
          denom[dst + z] += weights[k];
        }
      }
    }
    onPatch(idx + 1, origins.length);
  }

  const outVoxels = product(shape);
  const out = new Float32Array(channels * outVoxels);
  const [sx, sy, sz] = shape;
  const [bx, by, bz] = padded.before;
  for (let c = 0; c < channels; c++) {
    const cSrc = c * totalVoxels;
    let o = c * outVoxels;
    for (let x = 0; x < sx; x++) {
      for (let y = 0; y < sy; y++) {
        const src = ((x + bx) * py + (y + by)) * pz + bz;
        for (let z = 0; z < sz; z++, o++) {
          out[o] = sum[cSrc + src + z] / denom[src + z];
        }
      }
    }
  }
  return { logits: out, windows: origins.length };
}

/**
 * Post-process 2-channel logits identically to upstream BrainLesion/AURORA ModelHandler._post_process:
 *   activated = sigmoid(logits)
 *   whole = activated[0] >= threshold
 *   enhancing = activated[1] >= threshold
 *   labels = 0 (background), 1 (whole/edema), 2 (enhancing; overwrites 1)
 */
export function postprocessLogits(logits, voxels, threshold = DEFAULT_THRESHOLD) {
  const labels = new Uint8Array(voxels);
  const wholeMask = new Uint8Array(voxels);
  const enhancingMask = new Uint8Array(voxels);
  for (let i = 0; i < voxels; i++) {
    const pWhole = 1 / (1 + Math.exp(-logits[i]));
    const pEnh = 1 / (1 + Math.exp(-logits[voxels + i]));
    const isWhole = pWhole >= threshold ? 1 : 0;
    const isEnh = pEnh >= threshold ? 1 : 0;
    wholeMask[i] = isWhole;
    enhancingMask[i] = isEnh;
    if (isEnh) labels[i] = 2;
    else if (isWhole) labels[i] = 1;
  }
  return { labels, wholeMask, enhancingMask };
}

/** End-to-end AURORA T1c-only brain metastasis segmentation on a prepared 3D volume. */
export async function segmentMetastasis({
  volume,
  model,
  threshold = DEFAULT_THRESHOLD,
  runPatch,
  onPatch,
  signal,
  skipGridCheck = false,
}) {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new Error('Probability threshold must be between 0 and 1 (exclusive).');
  }
  if (!skipGridCheck) checkPreparedGrid(volume, 'T1c');

  const scaledNifti = scaleIntensityPercentiles(volume.data, 0.5, 99.5);
  let hasSignal = false;
  for (let i = 0; i < scaledNifti.length; i++) {
    if (scaledNifti[i] > 0) {
      hasSignal = true;
      break;
    }
  }
  if (!hasSignal) throw new Error('The T1c image is constant or empty.');

  const monaiImage = niftiToMonai(scaledNifti, volume.dims);
  const { logits, windows } = await predictLogits({
    image: monaiImage,
    shape: volume.dims,
    patch: model?.patch ?? DEFAULT_PATCH,
    overlap: model?.overlap ?? DEFAULT_OVERLAP,
    runPatch,
    onPatch,
    signal,
  });

  const voxels = product(volume.dims);
  const monaiOut = postprocessLogits(logits, voxels, threshold);
  return {
    labels: monaiToNiftiUint8(monaiOut.labels, volume.dims),
    wholeMask: monaiToNiftiUint8(monaiOut.wholeMask, volume.dims),
    enhancingMask: monaiToNiftiUint8(monaiOut.enhancingMask, volume.dims),
    dims: volume.dims,
    affine: volume.affine,
    windows,
    threshold,
  };
}
