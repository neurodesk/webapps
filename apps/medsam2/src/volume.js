// 3D NIfTI volume handling, RAS slicing, intensity windowing and MedSAM2 512×512 tensor
// preprocessing / bilinear logit resizing. DOM-free so Node tests can verify every step.
import {
  createUint8Nifti,
  decodeNiftiBuffer,
  parseNiftiVolume,
} from "@neurodesk/webapp-components/file-io";
import {
  getOrientationTransform,
  index3D,
  inverseOrient,
  orientToRAS,
} from "@neurodesk/webapp-components/volume";
import { MODEL, WINDOW_PRESETS } from "./config.js";

export const IMAGE_SIZE = MODEL.imageSize;
export const LOW_RES_SIZE = IMAGE_SIZE / 4; // 128
const IMG_MEAN = [0.485, 0.456, 0.406];
const IMG_STD = [0.229, 0.224, 0.225];
export const MAX_VOXELS = 512 * 512 * 512;
// NIfTI xyzt_units spatial codes: metres, millimetres, micrometres. Unspecified is read as mm.
const SPATIAL_UNIT_MM = { 1: 1000, 2: 1, 3: 0.001 };

/** 3×3 determinant of the upper-left spatial block of a 4×4 NIfTI affine. */
export function affineDet3(affine) {
  if (!Array.isArray(affine) || affine.length < 3) return NaN;
  const [[a, b, c], [d, e, f], [g, h, i]] = affine;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** Exact physical voxel volume in mm³, honouring sform/qform affine determinant and xyzt_units. */
export function computeVoxelVolumeMm3(affine, voxelSize, xyztUnits = 0) {
  const unitScaleMm = SPATIAL_UNIT_MM[xyztUnits & 7] || 1;
  const det = Math.abs(affineDet3(affine));
  if (Number.isFinite(det) && det > 0) return det * unitScaleMm ** 3;
  const [dx, dy, dz] = voxelSize;
  return (Math.abs(dx) || 1) * (Math.abs(dy) || 1) * (Math.abs(dz) || 1) * unitScaleMm ** 3;
}

/** Axis spacings in mm along native axes, from affine column norms (fallback: pixdim) × xyzt_units. */
export function computeAxisSpacingsMm(affine, voxelSize, xyztUnits = 0) {
  const unitScaleMm = SPATIAL_UNIT_MM[xyztUnits & 7] || 1;
  return [0, 1, 2].map((col) => {
    if (Array.isArray(affine) && affine.length >= 3) {
      const norm = Math.hypot(affine[0][col], affine[1][col], affine[2][col]);
      if (Number.isFinite(norm) && norm > 0) return norm * unitScaleMm;
    }
    return (Math.abs(voxelSize[col]) || 1) * unitScaleMm;
  });
}

/**
 * Reads a 3D NIfTI (.nii or .nii.gz) ArrayBuffer and orients it to canonical RAS so axial,
 * coronal and sagittal slices display right-side-up while preserving the native header/grid for
 * lossless label NIfTI export.
 */
export async function readNifti3D(name, buffer) {
  const decoded = await decodeNiftiBuffer(buffer);
  const parsed = parseNiftiVolume(decoded, { OutputCtor: Float32Array });
  const { dims, voxelSize, affine, imageData, headerBytes, header } = parsed;
  if (!Array.isArray(dims) || dims.length < 3) throw new Error(`${name} is not a 3D NIfTI volume.`);
  const [nx, ny, nz] = dims;
  if (nx * ny * nz > MAX_VOXELS) throw new Error(`${name} (${nx} × ${ny} × ${nz}) exceeds the ${MAX_VOXELS.toLocaleString()} voxel limit.`);
  const nativeDims = [nx, ny, nz];
  const { perm, flip } = getOrientationTransform(affine);
  const ras = orientToRAS(imageData, nativeDims, perm, flip, Float32Array);
  const xyztUnits = header?.xyztUnits ?? 0;
  const nativeSpacingsMm = computeAxisSpacingsMm(affine, voxelSize, xyztUnits);
  const rasPixDims = [nativeSpacingsMm[perm[0]], nativeSpacingsMm[perm[1]], nativeSpacingsMm[perm[2]]];
  const voxelVolumeMm3 = computeVoxelVolumeMm3(affine, voxelSize, xyztUnits);
  return {
    name,
    nativeDims,
    dims: ras.dims,
    pixDims: rasPixDims,
    voxelVolumeMm3,
    affine,
    xyztUnits,
    perm,
    flip,
    headerBytes,
    data: ras.data,
  };
}

/** Reorients a RAS uint8 label volume back onto the input NIfTI's native voxel grid. */
export function toNativeLabels(rasLabels, volume) {
  return inverseOrient(rasLabels, volume.dims, volume.perm, volume.flip, volume.nativeDims, Uint8Array);
}

/** Exports a RAS uint8 label volume back onto the input NIfTI's native grid and header. */
export function exportLabelsNifti(rasLabels, volume, nativeLabels = toNativeLabels(rasLabels, volume)) {
  return new Uint8Array(createUint8Nifti(nativeLabels, volume.headerBytes, volume.nativeDims));
}

/** Exact linear-interpolated percentile on a sorted Float32Array, matching numpy.percentile. */
function sortedPercentile(sorted, q) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const pos = (q / 100) * (n - 1);
  const idx = Math.floor(pos);
  const frac = pos - idx;
  if (frac === 0 || idx + 1 >= n) return sorted[idx];
  return sorted[idx] + frac * (sorted[idx + 1] - sorted[idx]);
}

/**
 * Computes [lo, hi] intensity window:
 * - "auto": exact 0.5th and 99.5th percentile over positive voxels (matching numpy.percentile),
 *   falling back to all finite voxels when none are positive
 * - "full": finite min and max
 * - CT presets: fixed Hounsfield bounds
 */
export function computeWindow(data, presetId = "auto") {
  const preset = WINDOW_PRESETS.find((item) => item.id === presetId);
  if (preset?.range) return { lo: preset.range[0], hi: preset.range[1] };

  let min = Infinity;
  let max = -Infinity;
  let finiteCount = 0;
  let positiveCount = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    finiteCount++;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v > 0) positiveCount++;
  }
  if (!finiteCount) return { lo: 0, hi: 1 };
  if (presetId === "full" || min === max) return { lo: min, hi: max === min ? min + 1 : max };

  const usePositive = positiveCount > 0;
  const sample = new Float32Array(usePositive ? positiveCount : finiteCount);
  let at = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v) || (usePositive && v <= 0)) continue;
    sample[at++] = v;
  }
  sample.sort();
  const lo = sortedPercentile(sample, 0.5);
  let hi = sortedPercentile(sample, 99.5);
  if (hi <= lo) hi = lo + 1e-6;
  return { lo, hi };
}

/** Dimensions `{ width, height, depth }` for slicing a RAS `[nx, ny, nz]` volume along `axis`. */
export function sliceGeometry(dims, axis) {
  const [nx, ny, nz] = dims;
  if (axis === "axial") return { width: nx, height: ny, depth: nz };
  if (axis === "coronal") return { width: nx, height: nz, depth: ny };
  if (axis === "sagittal") return { width: ny, height: nz, depth: nx };
  throw new Error(`Unknown slice axis "${axis}".`);
}

/** Maps a 2D slice pixel `(col, row)` (row 0 at top) on `axis` slice `sliceIndex` to RAS `[x, y, z]`. */
export function sliceToRas(col, row, sliceIndex, dims, axis) {
  const [, ny, nz] = dims;
  if (axis === "axial") return [col, ny - 1 - row, sliceIndex];
  if (axis === "coronal") return [col, sliceIndex, nz - 1 - row];
  if (axis === "sagittal") return [sliceIndex, col, nz - 1 - row];
  throw new Error(`Unknown slice axis "${axis}".`);
}

/** Extracts one 2D slice as uint8 [0..255] using intensity window `[lo, hi]`. */
export function extractSliceUint8(data, dims, axis, sliceIndex, lo, hi) {
  const { width, height } = sliceGeometry(dims, axis);
  const out = new Uint8Array(width * height);
  const scale = 255 / Math.max(hi - lo, 1e-7);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [x, y, z] = sliceToRas(col, row, sliceIndex, dims, axis);
      const raw = data[index3D(x, y, z, dims)];
      const clamped = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : lo;
      out[row * width + col] = Math.trunc((clamped - lo) * scale);
    }
  }
  return out;
}

/** Extracts one 2D slice of a RAS Uint8Array label volume. */
export function extractLabelSlice(labels, dims, axis, sliceIndex) {
  const { width, height } = sliceGeometry(dims, axis);
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [x, y, z] = sliceToRas(col, row, sliceIndex, dims, axis);
      out[row * width + col] = labels[index3D(x, y, z, dims)];
    }
  }
  return out;
}

/**
 * Bilinear resize of a single-channel array (exact PyTorch `mode="bilinear", align_corners=False`).
 * Used for both uint8 slices → 512×512 and float32 mask logits 128×128 → 512×512 or (origW, origH).
 */
export function bilinearResize2D(src, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return Float32Array.from(src);
  const out = new Float32Array(dstW * dstH);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  const xs0 = new Int32Array(dstW);
  const xs1 = new Int32Array(dstW);
  const wx = new Float32Array(dstW);
  for (let dx = 0; dx < dstW; dx++) {
    const sx = (dx + 0.5) * scaleX - 0.5;
    const x0 = Math.floor(sx);
    xs0[dx] = Math.min(srcW - 1, Math.max(0, x0));
    xs1[dx] = Math.min(srcW - 1, Math.max(0, x0 + 1));
    wx[dx] = Math.min(1, Math.max(0, sx - x0));
  }
  for (let dy = 0; dy < dstH; dy++) {
    const sy = (dy + 0.5) * scaleY - 0.5;
    const y0 = Math.floor(sy);
    const iy0 = Math.min(srcH - 1, Math.max(0, y0));
    const iy1 = Math.min(srcH - 1, Math.max(0, y0 + 1));
    const wy = Math.min(1, Math.max(0, sy - y0));
    const row0 = iy0 * srcW;
    const row1 = iy1 * srcW;
    const dstRow = dy * dstW;
    for (let dx = 0; dx < dstW; dx++) {
      const a = src[row0 + xs0[dx]];
      const b = src[row0 + xs1[dx]];
      const c = src[row1 + xs0[dx]];
      const d = src[row1 + xs1[dx]];
      const top = a + (b - a) * wx[dx];
      const bot = c + (d - c) * wx[dx];
      out[dstRow + dx] = top + (bot - top) * wy;
    }
  }
  return out;
}

/**
 * Builds the `1 × 3 × 512 × 512` ImageNet-normalized float32 encoder tensor for one 2D greyscale
 * uint8 slice using bilinear resize (rounded to integer byte steps before / 255.0) and replicated
 * across the three RGB channels.
 */
export function sliceToEncoderTensor(sliceUint8, width, height) {
  const resized = bilinearResize2D(sliceUint8, width, height, IMAGE_SIZE, IMAGE_SIZE);
  const plane = IMAGE_SIZE * IMAGE_SIZE;
  const tensor = new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) {
    const mean = IMG_MEAN[c];
    const invStd = 1 / IMG_STD[c];
    const offset = c * plane;
    for (let i = 0; i < plane; i++) {
      const v = Math.round(resized[i]) / 255.0;
      tensor[offset + i] = (v - mean) * invStd;
    }
  }
  return tensor;
}
