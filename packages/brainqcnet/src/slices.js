// BrainQCNet's preprocessing, step for step, as the BIDS app runs it:
//   crop_nii.py   crop to the bounding box of voxels > 0
//   med2image     every slice along x, y and z, rotated 90 degrees, written as
//                 a PNG by matplotlib 3.3.4 imsave with cmap Greys_r
//   predict_all_axes.py  Pillow 10.3 bilinear resize to 224 x 224, ToTensor,
//                 ImageNet Normalize
// Each step reproduces the original's arithmetic so the classifier sees the
// same bytes (validation/README.md).
import { decodeNiftiBuffer, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';

export const IMG_SIZE = 224;
export const AXES = Object.freeze(['x', 'y', 'z']);

// NIfTI datatypes whose unscaled voxels nibabel 3.2 returns in a dtype that
// matplotlib's Normalize promotes to float32; every other type, and any
// scaled image (nibabel then returns float64), normalizes in float64.
const FLOAT32_NORMALIZED = new Set([2, 4, 16, 256, 512]);
const SUPPORTED = new Set([2, 4, 8, 16, 64, 256, 512, 768]);

/**
 * @typedef {{ dims: [number, number, number], data: Float64Array, precision: 'float32' | 'float64' }} Volume
 * data is in NIfTI voxel order, i fastest: voxel (i, j, k) is data[i + nx * (j + ny * k)].
 */

/** Parse one 3D T1w NIfTI (gzipped or not) as nibabel would hand it to crop_nii.py. */
export async function readVolume(bytes) {
  return volumeFromNifti(await decodeNiftiBuffer(bytes));
}

export function volumeFromNifti(buffer) {
  const { data, header } = readNiftiImageData(buffer, Float64Array);
  if (!SUPPORTED.has(header.datatype)) throw new Error(`BrainQCNet does not read NIfTI datatype ${header.datatype}.`);
  const sizes = header.dims.slice(1, header.dims[0] + 1).filter((size) => size !== 1);
  if (sizes.length !== 3) {
    throw new Error(`BrainQCNet needs one 3D T1-weighted volume; this image is ${header.dims.slice(1, header.dims[0] + 1).join(' × ')}.`);
  }
  const dims = /** @type {[number, number, number]} */ ([header.nx, header.ny, header.nz]);
  if (dims.some((size) => size === 1)) {
    throw new Error('BrainQCNet needs one 3D T1-weighted volume with more than one voxel along each axis.');
  }
  const scaled = header.sclSlope !== 1 || header.sclInter !== 0;
  const precision = !scaled && FLOAT32_NORMALIZED.has(header.datatype) ? 'float32' : 'float64';
  return { dims, data, precision };
}

/** crop_nii.py: the bounding box of voxels > 0, upper bounds exclusive. */
export function cropToForeground(volume) {
  const [nx, ny, nz] = volume.dims;
  const lo = [nx, ny, nz];
  const hi = [-1, -1, -1];
  const { data } = volume;
  for (let k = 0, v = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, v++) {
        if (!(data[v] > 0)) continue;
        if (i < lo[0]) lo[0] = i;
        if (i > hi[0]) hi[0] = i;
        if (j < lo[1]) lo[1] = j;
        if (j > hi[1]) hi[1] = j;
        if (k < lo[2]) lo[2] = k;
        if (k > hi[2]) hi[2] = k;
      }
    }
  }
  if (hi[0] < 0) throw new Error('The image has no voxels above zero, so there is nothing to crop or classify.');
  const dims = /** @type {[number, number, number]} */ ([hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1]);
  const out = new Float64Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0, v = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      const row = lo[0] + nx * (lo[1] + j + ny * (lo[2] + k));
      out.set(data.subarray(row, row + dims[0]), v);
      v += dims[0];
    }
  }
  return { dims, data: out, precision: volume.precision, offset: lo };
}

export function sliceCount(volume, axis) {
  return volume.dims[AXES.indexOf(axis)];
}

/**
 * med2image's slice `index` along `axis` after np.rot90, as row-major values.
 * x: vol[index, :, :], y: vol[:, index, :], z: vol[:, :, index]; rot90 makes
 * the last remaining axis the rows, reversed, and the first the columns.
 */
export function extractSlice(volume, axis, index) {
  const [nx, ny, nz] = volume.dims;
  const { data } = volume;
  const at = (i, j, k) => data[i + nx * (j + ny * k)];
  let rows;
  let cols;
  let read;
  if (axis === 'x') {
    rows = nz;
    cols = ny;
    read = (r, c) => at(index, c, nz - 1 - r);
  } else if (axis === 'y') {
    rows = nz;
    cols = nx;
    read = (r, c) => at(c, index, nz - 1 - r);
  } else if (axis === 'z') {
    rows = ny;
    cols = nx;
    read = (r, c) => at(c, ny - 1 - r, index);
  } else {
    throw new Error(`Unknown axis ${axis}`);
  }
  const values = new Float64Array(rows * cols);
  for (let r = 0, p = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, p++) values[p] = read(r, c);
  }
  return { rows, cols, values };
}

// matplotlib 3.3.4 cm.Greys_r(range(256), bytes=True): R = G = B.
const GREYS_R = Uint8Array.from([
  0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 29, 30, 31, 32, 33, 34, 35,
  37, 38, 40, 41, 42, 44, 45, 47, 48, 49, 51, 52, 54, 55, 56, 58, 59, 61, 62, 64, 65, 66, 68, 69, 71, 72, 73, 75, 76, 78, 79, 80,
  82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114,
  115, 116, 117, 118, 119, 120, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 145, 146, 147, 148, 149,
  150, 151, 153, 154, 155, 156, 157, 159, 160, 161, 162, 164, 165, 166, 167, 168, 170, 171, 172, 173, 175, 176, 177, 178, 179, 181, 182, 183, 184, 186, 187, 188,
  189, 190, 191, 192, 193, 193, 194, 195, 196, 197, 198, 199, 200, 200, 201, 202, 203, 204, 205, 206, 207, 207, 208, 209, 210, 211, 212, 213, 214, 215, 215, 216,
  217, 218, 218, 219, 220, 221, 221, 222, 223, 224, 224, 225, 226, 226, 227, 228, 229, 229, 230, 231, 231, 232, 233, 234, 234, 235, 236, 237, 237, 238, 239, 239,
  240, 240, 241, 241, 242, 242, 243, 243, 244, 244, 245, 245, 246, 246, 247, 247, 247, 248, 248, 249, 249, 250, 250, 251, 251, 252, 252, 253, 253, 254, 254, 255,
]);

/**
 * matplotlib 3.3.4 imsave(cmap=Greys_r) of one slice: Normalize to the
 * slice's own min and max in float32 or float64, scale by 256, truncate, then
 * the colormap's byte table. Returns the grey channel of the PNG.
 */
export function greyscale(values, precision) {
  const round = precision === 'float32' ? Math.fround : (v) => v;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    // A NaN makes NumPy's min NaN, so the whole slice normalizes to NaN and
    // maps to the colormap's under and bad colours, black.
    if (Number.isNaN(v)) return new Uint8Array(values.length);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const vmin = round(min);
  const range = round(round(max) - vmin);
  const out = new Uint8Array(values.length);
  if (range === 0) return out.fill(GREYS_R[0]);
  for (let p = 0; p < values.length; p++) {
    let x = round(round(round(values[p]) - vmin) / range) * 256;
    if (x === 256) x = 255;
    out[p] = GREYS_R[x < 0 ? 0 : Math.min(255, Math.trunc(x))];
  }
  return out;
}

const PRECISION_BITS = 32 - 8 - 2;

// Pillow's precompute_coeffs + normalize_coeffs_8bpc for the bilinear filter.
function bilinearCoefficients(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const weights = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const t = Math.abs((x + xmin - center + 0.5) * ss);
      const w = t < 1 ? 1 - t : 0;
      weights[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      const w = ww !== 0 ? weights[x] / ww : weights[x];
      const scaled = w * (1 << PRECISION_BITS);
      kk[xx * ksize + x] = Math.trunc(w < 0 ? -0.5 + scaled : 0.5 + scaled);
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

function clip8(sum) {
  const v = Math.floor(sum / (1 << PRECISION_BITS));
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Pillow 10.3 Image.resize((size, size), BILINEAR) of an 8-bit image: the
 * horizontal pass into an 8-bit buffer, then the vertical pass, each with
 * 22-bit fixed-point weights, as torchvision 0.10's Resize calls it.
 */
export function resizeBilinear(pixels, rows, cols, size = IMG_SIZE) {
  let src = pixels;
  let width = cols;
  if (cols !== size) {
    const { ksize, bounds, kk } = bilinearCoefficients(cols, size);
    const tmp = new Uint8Array(rows * size);
    for (let y = 0; y < rows; y++) {
      const row = y * cols;
      for (let xx = 0; xx < size; xx++) {
        const xmin = bounds[xx * 2];
        const xmax = bounds[xx * 2 + 1];
        let sum = 1 << (PRECISION_BITS - 1);
        for (let x = 0; x < xmax; x++) sum += src[row + xmin + x] * kk[xx * ksize + x];
        tmp[y * size + xx] = clip8(sum);
      }
    }
    src = tmp;
    width = size;
  }
  if (rows === size) return src === pixels ? Uint8Array.from(src) : src;
  const { ksize, bounds, kk } = bilinearCoefficients(rows, size);
  const out = new Uint8Array(size * width);
  for (let yy = 0; yy < size; yy++) {
    const ymin = bounds[yy * 2];
    const ymax = bounds[yy * 2 + 1];
    for (let x = 0; x < width; x++) {
      let sum = 1 << (PRECISION_BITS - 1);
      for (let y = 0; y < ymax; y++) sum += src[(ymin + y) * width + x] * kk[yy * ksize + y];
      out[yy * width + x] = clip8(sum);
    }
  }
  return out;
}

// torchvision ToTensor (byte / 255) then Normalize ((x - mean) / std), both
// in float32, for each of the 256 byte values and three channels.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const NORMALIZED = MEAN.map((mean, c) => Float32Array.from({ length: 256 }, (_, b) => {
  const f = Math.fround;
  return f(f(f(b / 255) - f(mean)) / f(STD[c]));
}));

/** Write one resized grey slice as an RGB CHW tensor at `offset` (in floats). */
export function writeInputTensor(resized, target, offset = 0) {
  const plane = resized.length;
  for (let c = 0; c < 3; c++) {
    const table = NORMALIZED[c];
    const base = offset + c * plane;
    for (let p = 0; p < plane; p++) target[base + p] = table[resized[p]];
  }
}

/** Every slice the BIDS app classifies, in axis then slice order. */
export function* slicePlan(volume) {
  for (const axis of AXES) {
    const count = sliceCount(volume, axis);
    for (let index = 0; index < count; index++) yield { axis, slice: index };
  }
}

/** The 224 x 224 grey image the network sees for one slice. */
export function modelSlice(volume, axis, index) {
  const { rows, cols, values } = extractSlice(volume, axis, index);
  return resizeBilinear(greyscale(values, volume.precision), rows, cols);
}
