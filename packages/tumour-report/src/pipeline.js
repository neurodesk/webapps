// Raidionics v1.3 segmentation pipeline around injected ONNX patch runners.
// Pure: no DOM and no ONNX Runtime import so browser workers and Node CLI share
// identical preprocessing, tiling, sigmoid, back-resampling and refinement.
import {
  brainOverlapRefinement,
  clipAndNormalize,
  cropBackgroundMinimum,
  product,
  resampleFromTo,
  resampleToOutput,
  resizeLinear3d,
  uncropMask,
  validateVolume,
  voxelVolumeMl,
} from './preprocess.js';

export const BRAIN_INPUT_DIMS = Object.freeze([128, 128, 144]);
export const BRAIN_THRESHOLD = 0.9;
export const TUMOUR_PATCH_DIMS = Object.freeze([160, 160, 160]);
export const TUMOUR_THRESHOLD = 0.5;
export const SMALL_BRAIN_WARNING_ML = 600;

export function checkLogits(logits) {
  if (!logits || !logits.length) {
    throw new Error('The network returned an empty output.');
  }
  const first = logits[0];
  let varies = false;
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i];
    if (!Number.isFinite(v)) {
      throw new Error('The network returned non-finite scores.');
    }
    if (v !== first) varies = true;
  }
  if (!varies) {
    throw new Error('The network returned the same score for every voxel.');
  }
}

// NIfTI Fortran order (x fastest) -> ONNX [1, 1, X, Y, Z] C-order (z fastest).
export function toModelTensor(niftiData, dims) {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(nx * ny * nz);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      const dstBase = (x * ny + y) * nz;
      const srcCol = x + nx * y;
      for (let z = 0; z < nz; z++) {
        out[dstBase + z] = niftiData[srcCol + nx * ny * z];
      }
    }
  }
  return out;
}

// ONNX [1, 1, X, Y, Z] C-order -> NIfTI Fortran order (x fastest).
export function fromModelTensor(tensorData, dims) {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const dstRow = nx * (y + ny * z);
      for (let x = 0; x < nx; x++) {
        out[dstRow + x] = tensorData[(x * ny + y) * nz + z];
      }
    }
  }
  return out;
}

function sigmoidInPlace(arr) {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    arr[i] = v >= 0 ? 1 / (1 + Math.exp(-v)) : Math.exp(v) / (1 + Math.exp(v));
  }
  return arr;
}

// Reproduces raidionics_seg_lib padding_for_inference_both_ends_patchwise:
// when d < patchDim, pads BOTH ends by ceil((patchDim - d) / 2) using edge replication.
export function padForPatches(data, dims, patchDims = TUMOUR_PATCH_DIMS) {
  const before = dims.map((d, a) => (d < patchDims[a] ? Math.ceil((patchDims[a] - d) / 2) : 0));
  const paddedDims = dims.map((d, a) => d + 2 * before[a]);
  if (before.every((b) => b === 0)) {
    return { data, dims: [...dims], before, extra: [0, 0, 0] };
  }
  const [nx, ny, nz] = dims;
  const [px, py, pz] = paddedDims;
  const out = new Float32Array(px * py * pz);
  const clamp = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  for (let z = 0; z < pz; z++) {
    const sz = clamp(z - before[2], nz);
    for (let y = 0; y < py; y++) {
      const sy = clamp(y - before[1], ny);
      const dstRow = px * (y + py * z);
      const srcRow = nx * (sy + ny * sz);
      for (let x = 0; x < px; x++) {
        out[dstRow + x] = data[srcRow + clamp(x - before[0], nx)];
      }
    }
  }
  return { data: out, dims: paddedDims, before, extra: before.map((b) => 2 * b) };
}

export function patchBoundaries(dims, patchDims = TUMOUR_PATCH_DIMS) {
  const axes = dims.map((size, a) => {
    const p = patchDims[a];
    const count = Math.ceil(size / p);
    const list = [];
    for (let k = 0; k < count; k++) {
      let start = k * p;
      let end = start + p;
      if (end >= size) {
        start = size - p;
        end = size;
      }
      if (start >= 0) list.push([start, end]);
    }
    return list;
  });
  const patches = [];
  for (const bx of axes[0]) {
    for (const by of axes[1]) {
      for (const bz of axes[2]) {
        patches.push([bx, by, bz]);
      }
    }
  }
  return patches;
}

export function extractPatchCOrder(paddedData, paddedDims, bounds) {
  const [[x0, x1], [y0, y1], [z0, z1]] = bounds;
  const px = x1 - x0;
  const py = y1 - y0;
  const pz = z1 - z0;
  const [nx, ny] = paddedDims;
  const xy = nx * ny;
  const tile = new Float32Array(px * py * pz);
  for (let x = 0; x < px; x++) {
    const gx = x0 + x;
    for (let y = 0; y < py; y++) {
      const gy = y0 + y;
      const srcCol = gx + nx * gy;
      const dstBase = (x * py + y) * pz;
      for (let z = 0; z < pz; z++) {
        tile[dstBase + z] = paddedData[srcCol + xy * (z0 + z)];
      }
    }
  }
  return tile;
}

export function mergePatchMaxCOrder(acc, paddedDims, patchOut, bounds) {
  const [[x0, x1], [y0, y1], [z0, z1]] = bounds;
  const px = x1 - x0;
  const py = y1 - y0;
  const pz = z1 - z0;
  const [nx, ny] = paddedDims;
  const xy = nx * ny;
  for (let x = 0; x < px; x++) {
    const gx = x0 + x;
    for (let y = 0; y < py; y++) {
      const gy = y0 + y;
      const dstCol = gx + nx * gy;
      const srcBase = (x * py + y) * pz;
      for (let z = 0; z < pz; z++) {
        const idx = dstCol + xy * (z0 + z);
        const val = patchOut[srcBase + z];
        if (val > acc[idx]) acc[idx] = val;
      }
    }
  }
}

function unpadFloat(paddedData, paddedDims, before, dims) {
  if (paddedDims[0] === dims[0] && paddedDims[1] === dims[1] && paddedDims[2] === dims[2]) {
    return paddedData;
  }
  const [nx, ny, nz] = dims;
  const [px, py] = paddedDims;
  const out = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const srcBase = before[0] + px * (before[1] + y + py * (before[2] + z));
      const dstBase = nx * (y + ny * z);
      out.set(paddedData.subarray(srcBase, srcBase + nx), dstBase);
    }
  }
  return out;
}

function thresholdMask(prob, threshold) {
  const mask = new Uint8Array(prob.length);
  for (let i = 0; i < prob.length; i++) {
    if (prob[i] >= threshold) mask[i] = 1;
  }
  return mask;
}

// Shared Raidionics v1.3 MRI_Brain extraction path used by both full segmentation
// and supplied-mask MNI registration: skimage-style input resize (mode='reflect')
// and SciPy-zoom endpoint-aligned probability upsampling.
export async function extractBrainMask({
  volume,
  cropped = null,
  resampled = null,
  cropBbox = null,
  runBrain,
  onProgress = () => {},
  signal,
}) {
  validateVolume(volume, 'T1c');
  signal?.throwIfAborted();
  if (typeof runBrain !== 'function') {
    throw new Error('Brain segmentation runner is required for skull-intact scans.');
  }
  let fg = cropped;
  let bbox = cropBbox;
  if (!fg || !bbox) {
    const out = cropBackgroundMinimum(volume);
    fg = out.volume;
    bbox = out.cropBbox;
  }
  const vol1mm = resampled ?? resampleToOutput(fg, [1, 1, 1], 1);
  signal?.throwIfAborted();

  onProgress({ stage: 'brain', message: 'Segmenting brain mask' });
  const resized = resizeLinear3d(vol1mm.data, vol1mm.dims, BRAIN_INPUT_DIMS, { antiAliasing: true, alignCorners: false });
  const brainInput = toModelTensor(clipAndNormalize(resized), BRAIN_INPUT_DIMS);
  const brainLogitsC = await runBrain(brainInput, [1, 1, ...BRAIN_INPUT_DIMS]);
  signal?.throwIfAborted();
  checkLogits(brainLogitsC);
  const brainProbSmall = sigmoidInPlace(fromModelTensor(brainLogitsC, BRAIN_INPUT_DIMS));
  const brainProb1mm = resizeLinear3d(brainProbSmall, BRAIN_INPUT_DIMS, vol1mm.dims, { antiAliasing: false, alignCorners: true });
  const brainProbFg = resampleFromTo(
    { data: brainProb1mm, dims: vol1mm.dims, affine: vol1mm.affine },
    fg.dims,
    fg.affine,
    1,
  );
  const brainMask = uncropMask(thresholdMask(brainProbFg.data, BRAIN_THRESHOLD), bbox, volume.dims);
  let brainVoxels = 0;
  for (let i = 0; i < brainMask.length; i++) brainVoxels += brainMask[i];
  const brainMl = brainVoxels * voxelVolumeMl(volume.affine);
  const warnings = [];
  if (brainMl < SMALL_BRAIN_WARNING_ML) {
    warnings.push(
      `Brain mask is unusually small (${brainMl.toFixed(0)} mL). If this scan is already skull-stripped, enable "Input is already skull-stripped" in Advanced settings.`,
    );
  }
  return { brainMask, warnings };
}

export async function segmentTumour({
  volume,
  skullStripped = false,
  runBrain,
  runTumorCore,
  onProgress = () => {},
  signal,
}) {
  validateVolume(volume, 'T1c');
  signal?.throwIfAborted();
  const warnings = [];

  onProgress({ stage: 'preprocess', message: 'Cropping and resampling to 1 mm RAS' });
  const { volume: cropped, cropBbox } = cropBackgroundMinimum(volume);
  const resampled = resampleToOutput(cropped, [1, 1, 1], 1);
  signal?.throwIfAborted();

  let brainMask;
  if (skullStripped) {
    brainMask = new Uint8Array(volume.data.length);
    for (let i = 0; i < volume.data.length; i++) {
      if (volume.data[i] > 0) brainMask[i] = 1;
    }
  } else {
    const brainOut = await extractBrainMask({
      volume,
      cropped,
      resampled,
      cropBbox,
      runBrain,
      onProgress,
      signal,
    });
    brainMask = brainOut.brainMask;
    warnings.push(...brainOut.warnings);
  }

  if (typeof runTumorCore !== 'function') {
    throw new Error('Tumour segmentation runner is required.');
  }
  const tumourNorm = clipAndNormalize(resampled.data);
  const padded = padForPatches(tumourNorm, resampled.dims, TUMOUR_PATCH_DIMS);
  const patches = patchBoundaries(padded.dims, TUMOUR_PATCH_DIMS);
  const acc = new Float32Array(product(padded.dims)).fill(-100);

  for (let idx = 0; idx < patches.length; idx++) {
    signal?.throwIfAborted();
    onProgress({
      stage: 'tumour',
      message: `Segmenting tumour (patch ${idx + 1}/${patches.length})`,
      patch: idx + 1,
      totalPatches: patches.length,
    });
    const tile = extractPatchCOrder(padded.data, padded.dims, patches[idx]);
    const logits = await runTumorCore(tile, [1, 1, ...TUMOUR_PATCH_DIMS]);
    signal?.throwIfAborted();
    checkLogits(logits);
    mergePatchMaxCOrder(acc, padded.dims, logits, patches[idx]);
  }

  onProgress({ stage: 'reconstruct', message: 'Reconstructing native-space mask' });
  const logits1mm = unpadFloat(acc, padded.dims, padded.before, resampled.dims);
  const prob1mm = sigmoidInPlace(logits1mm);
  const probFg = resampleFromTo(
    { data: prob1mm, dims: resampled.dims, affine: resampled.affine },
    cropped.dims,
    cropped.affine,
    1,
  );
  const rawTumourMask = uncropMask(thresholdMask(probFg.data, TUMOUR_THRESHOLD), cropBbox, volume.dims);
  const refined = brainOverlapRefinement(rawTumourMask, brainMask, volume.dims);

  return {
    brainMask,
    tumourMask: refined.mask,
    dims: [...volume.dims],
    affine: volume.affine.map((r) => [...r]),
    patches: patches.length,
    rawComponents: refined.raw,
    keptComponents: refined.kept,
    warnings,
  };
}
