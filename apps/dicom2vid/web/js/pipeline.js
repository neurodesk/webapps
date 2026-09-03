// Core pipeline: global min/max normalize, orientation reslice, slice-range
// selection, and 8-bit frame extraction. This mirrors process_dicom_files in
// MRI2vid.py so that the grayscale DICOM frame stack matches bit-for-bit.
//
// The orientation ops are pure array-axis transposes/flips (not anatomical); the
// frame axis is always axis 0 of the resliced array, exactly as the reference
// iterates. Given a volume V of shape [D0, D1, D2], a frame index k, and an
// output pixel (a, b) in the frame, the source voxel (i, j, l) is:
//
//   axial            i=k        j=a        l=b     nFrames=D0, fH=D1, fW=D2
//   axial_flipped    i=k        j=D1-1-a   l=b     nFrames=D0, fH=D1, fW=D2
//   sagittal         i=a        j=b        l=k     nFrames=D2, fH=D0, fW=D1
//   sagittal_flipped i=D0-1-a   j=b        l=k     nFrames=D2, fH=D0, fW=D1
//   coronal          i=a        j=k        l=b     nFrames=D1, fH=D0, fW=D2
//   coronal_flipped  i=D0-1-a   j=k        l=b     nFrames=D1, fH=D0, fW=D2

import { voxelIndex } from './volume.js';

// Round half to even, matching OpenCV cvRound (lrint, round-to-nearest-even).
// Inputs here are non-negative (normalized to [0, 255]).
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return (f % 2 === 0) ? f : f + 1;
}

// Global min/max normalization parameters, matching
// cv2.normalize(..., 0, 255, NORM_MINMAX, CV_8U). Computed over all channels.
export function normalizeParams(vol) {
  const data = vol.data;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = mx - mn;
  const scale = range > 0 ? 255 / range : 0;
  const shift = -mn * scale;
  return { min: mn, max: mx, scale, shift };
}

function normByte(value, scale, shift) {
  let out = roundHalfEven(value * scale + shift);
  if (out < 0) out = 0;
  else if (out > 255) out = 255;
  return out;
}

// Geometry of a resliced orientation.
export function orientationGeometry(dims, orientation) {
  const [D0, D1, D2] = dims;
  switch (orientation) {
    case 'axial':
    case 'axial_flipped':
      return { nFrames: D0, fH: D1, fW: D2 };
    case 'sagittal':
    case 'sagittal_flipped':
      return { nFrames: D2, fH: D0, fW: D1 };
    case 'coronal':
    case 'coronal_flipped':
      return { nFrames: D1, fH: D0, fW: D2 };
    default:
      throw new Error(`Unknown orientation: ${orientation}`);
  }
}

// Map an output pixel of a frame back to a source voxel (i0, i1, i2).
function sourceVoxel(orientation, dims, k, a, b) {
  const [D0, D1] = dims;
  switch (orientation) {
    case 'axial': return [k, a, b];
    case 'axial_flipped': return [k, D1 - 1 - a, b];
    case 'sagittal': return [a, b, k];
    case 'sagittal_flipped': return [D0 - 1 - a, b, k];
    case 'coronal': return [a, k, b];
    case 'coronal_flipped': return [D0 - 1 - a, k, b];
    default:
      throw new Error(`Unknown orientation: ${orientation}`);
  }
}

// Resolve the slice range exactly like process_dicom_files (end exclusive,
// negative indices wrap, step must be a positive integer). Returns an array of
// original slice indices into the resliced stack.
export function resolveSliceIndices(total, { start = null, end = null, step = 1 } = {}) {
  if (!Number.isInteger(step)) throw new Error('slice step must be an integer');
  if (step === 0) throw new Error('slice step must be non-zero');
  if (step < 0) throw new Error('slice step must be positive');

  const resolve = (value, def) => {
    if (value === null || value === undefined) return def;
    let v = value;
    if (v < 0) v += total;
    return v;
  };

  const startIdx = resolve(start, 0);
  let endIdx = resolve(end, total);

  if (!(startIdx >= 0 && startIdx < total)) {
    throw new Error(`start slice ${start} resolves outside available range (0..${total - 1})`);
  }
  if (endIdx < 0) {
    throw new Error(`end slice ${end} resolves outside available range`);
  }
  endIdx = Math.min(endIdx, total);
  if (startIdx >= endIdx) {
    throw new Error('start slice must point to a slice before end slice');
  }

  const indices = [];
  for (let i = startIdx; i < endIdx; i += step) indices.push(i);
  if (indices.length === 0) {
    throw new Error('Slice selection produced no frames; adjust start/end/step');
  }
  return indices;
}

// Extract a single 8-bit frame at a resliced stack index k.
// Returns a Uint8ClampedArray of length fH * fW * channels.
export function extractFrame(vol, orientation, k, norm, { colorNormalize = false } = {}) {
  const { fH, fW } = orientationGeometry(vol.dims, orientation);
  const channels = vol.channels;
  const out = new Uint8ClampedArray(fH * fW * channels);
  const data = vol.data;

  if (channels === 1) {
    const { scale, shift } = norm;
    let o = 0;
    for (let a = 0; a < fH; a++) {
      for (let b = 0; b < fW; b++) {
        const [i0, i1, i2] = sourceVoxel(orientation, vol.dims, k, a, b);
        out[o++] = normByte(data[voxelIndex(vol, i0, i1, i2, 0)], scale, shift);
      }
    }
  } else {
    // Color: pass through 8-bit RGB, or per-channel min/max normalize.
    let o = 0;
    for (let a = 0; a < fH; a++) {
      for (let b = 0; b < fW; b++) {
        const [i0, i1, i2] = sourceVoxel(orientation, vol.dims, k, a, b);
        for (let ch = 0; ch < channels; ch++) {
          const v = data[voxelIndex(vol, i0, i1, i2, ch)];
          if (colorNormalize) {
            out[o++] = normByte(v, norm.channels[ch].scale, norm.channels[ch].shift);
          } else {
            out[o++] = v;
          }
        }
      }
    }
  }
  return out;
}

// Per-channel normalization params for color when colorNormalize is on.
export function colorNormalizeParams(vol) {
  const channels = vol.channels;
  const mins = new Array(channels).fill(Infinity);
  const maxs = new Array(channels).fill(-Infinity);
  const data = vol.data;
  for (let i = 0; i < data.length; i += channels) {
    for (let ch = 0; ch < channels; ch++) {
      const v = data[i + ch];
      if (v < mins[ch]) mins[ch] = v;
      if (v > maxs[ch]) maxs[ch] = v;
    }
  }
  return {
    channels: mins.map((mn, ch) => {
      const range = maxs[ch] - mn;
      const scale = range > 0 ? 255 / range : 0;
      return { min: mn, max: maxs[ch], scale, shift: -mn * scale };
    }),
  };
}

// Intensity histogram for the windowing control, as bar heights in [0, 1].
//
// Bar heights are the square root of the counts, normalized to a high percentile
// rather than to the tallest bin. A medical image is mostly air, so the
// background bin routinely holds a couple of hundred times more voxels than any
// tissue bin. Scaling to it (or compressing the counts with log, which lifts
// every small bin toward the top) flattens the tissue detail into a solid block.
// Taking a high percentile instead lets the background spike clip off the top and
// leaves the tissue peaks legible.
//
// Large volumes are subsampled with a fixed stride: the shape of the
// distribution is what matters here, not exact counts.
export function histogramBins(vol, { min, max, nBins = 128, maxSamples = 300000, percentile = 0.99 } = {}) {
  const nb = Math.max(1, nBins);
  const mn = min;
  const mx = max > mn ? max : mn + 1;
  const bins = new Float64Array(nb);
  const data = vol.data;
  const n = data.length;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const inv = nb / (mx - mn);

  for (let i = 0; i < n; i += step) {
    let b = Math.floor((data[i] - mn) * inv);
    if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
    bins[b]++;
  }

  for (let i = 0; i < nb; i++) bins[i] = Math.sqrt(bins[i]);

  // Take the percentile over the occupied bins only. A volume with few distinct
  // values (a mask, a label map) leaves most bins empty, and including those
  // would drag the percentile down to zero and clip every real bar to full
  // height.
  const occupied = Array.from(bins).filter((b) => b > 0).sort((a, b) => a - b);
  const peak = occupied.length
    ? occupied[Math.floor((occupied.length - 1) * percentile)] || occupied[occupied.length - 1]
    : 1;

  return { bins, nb, min: mn, max: mx, peak: peak || 1 };
}

// Rotate a frame clockwise by q quarter-turns (0..3). Returns { frame, fW, fH }.
// The reference orientations are pure array ops, so some views come out on their
// side; this lets the user set the output upright without changing parity.
export function rotateFrame(frame, fW, fH, channels, q) {
  q = ((q % 4) + 4) % 4;
  if (q === 0) return { frame, fW, fH };
  let src = frame;
  let w = fW;
  let h = fH;
  for (let t = 0; t < q; t++) {
    const nw = h; // 90 degrees clockwise: new width is the old height
    const nh = w;
    const out = new Uint8ClampedArray(nw * nh * channels);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const si = ((h - 1 - x) * w + y) * channels; // in(row=h-1-x, col=y)
        const di = (y * nw + x) * channels;
        for (let k = 0; k < channels; k++) out[di + k] = src[si + k];
      }
    }
    src = out; w = nw; h = nh;
  }
  return { frame: src, fW: w, fH: h };
}

// ---- interpolation ----
// Resampling kernels used by resizeFrame. Each returns a weight for a sample at
// distance t (in source pixels) from the target position.

// Catmull-Rom cubic (a = -0.5): sharper than bilinear, no ringing worth worrying
// about at the upsample factors offered here.
function cubicWeight(t) {
  const a = -0.5;
  const x = Math.abs(t);
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return ((a * x - 5 * a) * x + 8 * a) * x - 4 * a;
  return 0;
}

// Lanczos with a = 3. Sharpest of the three, at the cost of mild overshoot.
function lanczosWeight(t) {
  const x = Math.abs(t);
  if (x < 1e-8) return 1;
  if (x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

export const INTERPOLATIONS = ['nearest', 'bilinear', 'bicubic', 'lanczos'];

// Half-width of the kernel support, in source pixels, for the separable filters.
const SUPPORT = { bicubic: 2, lanczos: 3 };
const KERNEL = { bicubic: cubicWeight, lanczos: lanczosWeight };

// Precompute, for one output axis, the source indices and weights of every
// output sample. Separable resampling: do this once per axis instead of per
// pixel. `scale` is srcLen / dstLen.
function axisTaps(srcLen, dstLen, method) {
  const scale = srcLen / dstLen;
  const kernel = KERNEL[method];
  const support = SUPPORT[method];
  // When downsampling, widen the kernel so it averages the pixels being merged
  // instead of point-sampling them (this is what keeps a shrink from aliasing).
  const filterScale = Math.max(1, scale);
  const radius = support * filterScale;
  const taps = Math.max(1, Math.ceil(radius) * 2);

  const idx = new Int32Array(dstLen * taps);
  const wts = new Float32Array(dstLen * taps);

  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) * scale - 0.5;
    const left = Math.ceil(center - radius);
    let sum = 0;
    const base = d * taps;
    for (let t = 0; t < taps; t++) {
      let s = left + t;
      const w = kernel((s - center) / filterScale);
      // Clamp to the edge so border pixels extend rather than fade to black.
      if (s < 0) s = 0; else if (s > srcLen - 1) s = srcLen - 1;
      idx[base + t] = s;
      wts[base + t] = w;
      sum += w;
    }
    if (sum !== 0) {
      for (let t = 0; t < taps; t++) wts[base + t] /= sum;
    }
  }
  return { idx, wts, taps };
}

// Resize a frame to (newW, newH) with the chosen interpolation. Used both by the
// preview stretch tool (aspect correction) and by the upscale option; the encoded
// frames go through the same path, so what you preview is what you get.
export function resizeFrame(frame, fW, fH, channels, newW, newH, method = 'bilinear') {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  if (newW === fW && newH === fH) return { frame, fW, fH };

  if (method === 'nearest') return resizeNearest(frame, fW, fH, channels, newW, newH);
  if (method === 'bicubic' || method === 'lanczos') {
    return resizeSeparable(frame, fW, fH, channels, newW, newH, method);
  }
  return resizeBilinear(frame, fW, fH, channels, newW, newH);
}

function resizeNearest(frame, fW, fH, channels, newW, newH) {
  const out = new Uint8ClampedArray(newW * newH * channels);
  const sx = fW / newW;
  const sy = fH / newH;
  for (let y = 0; y < newH; y++) {
    let syi = Math.floor((y + 0.5) * sy);
    if (syi < 0) syi = 0; else if (syi > fH - 1) syi = fH - 1;
    for (let x = 0; x < newW; x++) {
      let sxi = Math.floor((x + 0.5) * sx);
      if (sxi < 0) sxi = 0; else if (sxi > fW - 1) sxi = fW - 1;
      const si = (syi * fW + sxi) * channels;
      const o = (y * newW + x) * channels;
      for (let c = 0; c < channels; c++) out[o + c] = frame[si + c];
    }
  }
  return { frame: out, fW: newW, fH: newH };
}

function resizeBilinear(frame, fW, fH, channels, newW, newH) {
  const out = new Uint8ClampedArray(newW * newH * channels);
  const sx = fW / newW;
  const sy = fH / newH;
  for (let y = 0; y < newH; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0; else if (fy > fH - 1) fy = fH - 1;
    const y0 = Math.floor(fy);
    const y1 = Math.min(fH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < newW; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0; else if (fx > fW - 1) fx = fW - 1;
      const x0 = Math.floor(fx);
      const x1 = Math.min(fW - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * fW + x0) * channels;
      const i01 = (y0 * fW + x1) * channels;
      const i10 = (y1 * fW + x0) * channels;
      const i11 = (y1 * fW + x1) * channels;
      const o = (y * newW + x) * channels;
      for (let c = 0; c < channels; c++) {
        const top = frame[i00 + c] * (1 - wx) + frame[i01 + c] * wx;
        const bot = frame[i10 + c] * (1 - wx) + frame[i11 + c] * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { frame: out, fW: newW, fH: newH };
}

// Two-pass separable resample (horizontal, then vertical) for the wider kernels.
// The intermediate stays in Float32 so rounding happens once, at the end.
function resizeSeparable(frame, fW, fH, channels, newW, newH, method) {
  const xt = axisTaps(fW, newW, method);
  const tmp = new Float32Array(newW * fH * channels);
  for (let y = 0; y < fH; y++) {
    const rowIn = y * fW * channels;
    const rowOut = y * newW * channels;
    for (let x = 0; x < newW; x++) {
      const base = x * xt.taps;
      const o = rowOut + x * channels;
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let t = 0; t < xt.taps; t++) acc += frame[rowIn + xt.idx[base + t] * channels + c] * xt.wts[base + t];
        tmp[o + c] = acc;
      }
    }
  }

  const yt = axisTaps(fH, newH, method);
  const out = new Uint8ClampedArray(newW * newH * channels);
  for (let y = 0; y < newH; y++) {
    const base = y * yt.taps;
    const rowOut = y * newW * channels;
    for (let x = 0; x < newW; x++) {
      const o = rowOut + x * channels;
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let t = 0; t < yt.taps; t++) acc += tmp[(yt.idx[base + t] * newW + x) * channels + c] * yt.wts[base + t];
        out[o + c] = acc;
      }
    }
  }
  return { frame: out, fW: newW, fH: newH };
}

// Build the full selected frame stack. Returns:
//   { frames: Uint8ClampedArray (nSelected * fH * fW * channels),
//     nFrames, fH, fW, channels, sliceIndices, total }
export function buildFrames(vol, {
  orientation,
  start = null,
  end = null,
  step = 1,
  colorNormalize = false,
} = {}) {
  const { nFrames: total, fH, fW } = orientationGeometry(vol.dims, orientation);
  const sliceIndices = resolveSliceIndices(total, { start, end, step });
  const channels = vol.channels;

  const norm = channels === 1
    ? normalizeParams(vol)
    : (colorNormalize ? colorNormalizeParams(vol) : null);

  const frameSize = fH * fW * channels;
  const frames = new Uint8ClampedArray(sliceIndices.length * frameSize);
  for (let f = 0; f < sliceIndices.length; f++) {
    const frame = extractFrame(vol, orientation, sliceIndices[f], norm, { colorNormalize });
    frames.set(frame, f * frameSize);
  }

  return {
    frames,
    nFrames: sliceIndices.length,
    fH,
    fW,
    channels,
    sliceIndices,
    total,
  };
}
