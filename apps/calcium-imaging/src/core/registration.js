// Rigid and piecewise-rigid motion correction of a 2D movie, written from the papers:
//
// - Sub-pixel translation: Guizar-Sicairos, Thurman & Fienup (2008) Opt Lett 33:156. The
//   integer peak of the Fourier cross-correlation is refined by a matrix-multiply DFT of the
//   cross-power spectrum on a 1/upsample grid in a 1.5-pixel neighbourhood of that peak.
// - Piecewise rigid: Pnevmatikakis & Giovannucci (2017) J Neurosci Methods 291:83
//   (NoRMCorre). Overlapping patches are registered to the template's patches, each patch
//   shift is limited to `maxDeviation` pixels from the rigid shift, and the patch-centre
//   shifts are interpolated bilinearly to every pixel before the frame is resampled.
//
// Shifts are [dy, dx] in pixels, the translation applied to a frame to register it:
// registered(y, x) = frame(y - dy, x - dx). Resampling is bilinear with replicated borders.
import { fft2d } from './fft.js';

/** The template's spectrum, prepared once per template (and per patch). */
export function templateSpectrum(template, height, width) {
  const re = Float64Array.from(template);
  const im = new Float64Array(height * width);
  fft2d(re, im, height, width);
  return { re, im, height, width };
}

function signedFrequency(k, n) {
  return k > n / 2 ? k - n : k;
}

/**
 * The translation that registers `frame` to the template whose spectrum is given.
 * normalization 'none' is the plain cross-correlation (NoRMCorre, CaImAn); 'phase' whitens
 * the cross-power spectrum (phase correlation).
 * @returns {{ shift: [number, number], peak: number }}
 */
export function registerTranslation(spectrum, frame, { upsample = 10, maxShift = Infinity, normalization = 'none', center = [0, 0], radius = Infinity } = {}) {
  const { height, width } = spectrum;
  const n = height * width;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  fft2d(re, im, height, width);
  // Cross-power R = T · conj(F).
  for (let i = 0; i < n; i++) {
    const tr = spectrum.re[i];
    const ti = spectrum.im[i];
    const fr = re[i];
    const fi = -im[i];
    let r = tr * fr - ti * fi;
    let c = tr * fi + ti * fr;
    if (normalization === 'phase') {
      const magnitude = Math.hypot(r, c) || 1;
      r /= magnitude;
      c /= magnitude;
    }
    re[i] = r;
    im[i] = c;
  }
  const powerRe = Float64Array.from(re);
  const powerIm = Float64Array.from(im);
  fft2d(re, im, height, width, true);
  // Integer peak within |shift| ≤ maxShift and within `radius` of `center`.
  const limitY = Math.min(maxShift, Math.floor(height / 2));
  const limitX = Math.min(maxShift, Math.floor(width / 2));
  let best = -Infinity;
  let peak = [0, 0];
  for (let y = 0; y < height; y++) {
    const sy = signedFrequency(y, height);
    if (Math.abs(sy) > limitY || Math.abs(sy - center[0]) > radius) continue;
    for (let x = 0; x < width; x++) {
      const sx = signedFrequency(x, width);
      if (Math.abs(sx) > limitX || Math.abs(sx - center[1]) > radius) continue;
      const i = y * width + x;
      const value = re[i] * re[i] + im[i] * im[i];
      if (value > best) {
        best = value;
        peak = [sy, sx];
      }
    }
  }
  if (upsample <= 1) return { shift: peak, peak: Math.sqrt(best) / n };
  // Refine on a (1.5 · upsample)-point grid centred on the integer peak, keeping only the
  // points inside the same bounds as the integer search (the peak itself always is).
  const size = Math.ceil(upsample * 1.5);
  const offset = Math.floor(size / 2);
  const permitted = (value, limit, middle) => Math.abs(value) <= limit && Math.abs(value - middle) <= radius;
  const ys = Array.from({ length: size }, (_, j) => peak[0] + (j - offset) / upsample).filter((y) => permitted(y, limitY, center[0]));
  const xs = Array.from({ length: size }, (_, j) => peak[1] + (j - offset) / upsample).filter((x) => permitted(x, limitX, center[1]));
  // Columns first: G(ky, x) = Σ_kx R(ky, kx) e^{2πi kx x / W}.
  const kernelX = dftKernel(xs, width);
  const columns = xs.length;
  const partRe = new Float64Array(height * columns);
  const partIm = new Float64Array(height * columns);
  for (let ky = 0; ky < height; ky++) {
    const row = ky * width;
    for (let j = 0; j < columns; j++) {
      let sr = 0;
      let si = 0;
      const kernel = j * width;
      for (let kx = 0; kx < width; kx++) {
        const ar = powerRe[row + kx];
        const ai = powerIm[row + kx];
        const br = kernelX.re[kernel + kx];
        const bi = kernelX.im[kernel + kx];
        sr += ar * br - ai * bi;
        si += ar * bi + ai * br;
      }
      partRe[ky * columns + j] = sr;
      partIm[ky * columns + j] = si;
    }
  }
  const kernelY = dftKernel(ys, height);
  let refined = -Infinity;
  let shift = peak;
  for (let i = 0; i < ys.length; i++) {
    for (let j = 0; j < columns; j++) {
      let sr = 0;
      let si = 0;
      for (let ky = 0; ky < height; ky++) {
        const ar = partRe[ky * columns + j];
        const ai = partIm[ky * columns + j];
        const br = kernelY.re[i * height + ky];
        const bi = kernelY.im[i * height + ky];
        sr += ar * br - ai * bi;
        si += ar * bi + ai * br;
      }
      const value = sr * sr + si * si;
      if (value > refined) {
        refined = value;
        shift = [ys[i], xs[j]];
      }
    }
  }
  return { shift: [round(shift[0], upsample), round(shift[1], upsample)], peak: Math.sqrt(refined) / n };
}

function round(value, upsample) {
  return Math.round(value * upsample) / upsample;
}

function dftKernel(positions, n) {
  const re = new Float64Array(positions.length * n);
  const im = new Float64Array(positions.length * n);
  positions.forEach((position, j) => {
    for (let k = 0; k < n; k++) {
      const angle = (2 * Math.PI * signedFrequency(k, n) * position) / n;
      re[j * n + k] = Math.cos(angle);
      im[j * n + k] = Math.sin(angle);
    }
  });
  return { re, im };
}

function sample(frame, height, width, y, x) {
  const cy = Math.min(Math.max(y, 0), height - 1);
  const cx = Math.min(Math.max(x, 0), width - 1);
  const y0 = Math.min(Math.floor(cy), height - 2 < 0 ? 0 : height - 2);
  const x0 = Math.min(Math.floor(cx), width - 2 < 0 ? 0 : width - 2);
  const fy = height > 1 ? cy - y0 : 0;
  const fx = width > 1 ? cx - x0 : 0;
  const y1 = Math.min(y0 + 1, height - 1);
  const x1 = Math.min(x0 + 1, width - 1);
  const top = frame[y0 * width + x0] * (1 - fx) + frame[y0 * width + x1] * fx;
  const bottom = frame[y1 * width + x0] * (1 - fx) + frame[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** registered(y, x) = frame(y - dy, x - dx), bilinear, borders replicated. */
export function shiftFrame(frame, height, width, [dy, dx], out = new Float32Array(height * width)) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = sample(frame, height, width, y - dy, x - dx);
  }
  return out;
}

/** registered(y, x) = frame(y - dy(y, x), x - dx(y, x)) for per-pixel fields. */
export function warpFrame(frame, height, width, fieldY, fieldX, out = new Float32Array(height * width)) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      out[i] = sample(frame, height, width, y - fieldY[i], x - fieldX[i]);
    }
  }
  return out;
}

/** The median over time of the means of consecutive `bin`-frame groups. */
export function initialTemplate(movie, frames, height, width, bin = 10) {
  const plane = height * width;
  const bins = Math.max(1, Math.floor(frames / bin));
  const size = frames < bin ? frames : bin;
  const means = new Float64Array(bins * plane);
  for (let b = 0; b < bins; b++) {
    for (let f = b * size; f < (b + 1) * size; f++) {
      const offset = f * plane;
      for (let i = 0; i < plane; i++) means[b * plane + i] += movie[offset + i];
    }
  }
  const template = new Float64Array(plane);
  const column = new Float64Array(bins);
  for (let i = 0; i < plane; i++) {
    for (let b = 0; b < bins; b++) column[b] = means[b * plane + i] / size;
    template[i] = median(column);
  }
  return template;
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Patch origins along one axis: every `stride` pixels, the last flush with the edge. */
export function patchStarts(length, size, stride) {
  if (size >= length) return [0];
  const starts = [];
  for (let start = 0; start + size < length; start += stride) starts.push(start);
  starts.push(length - size);
  return [...new Set(starts)];
}

/** The patch grid of a piecewise-rigid run. */
export function patchGrid(height, width, size, overlap) {
  const stride = Math.max(1, size - overlap);
  const sizeY = Math.min(size, height);
  const sizeX = Math.min(size, width);
  const ys = patchStarts(height, sizeY, stride);
  const xs = patchStarts(width, sizeX, stride);
  return { ys, xs, sizeY, sizeX, centresY: ys.map((y) => y + (sizeY - 1) / 2), centresX: xs.map((x) => x + (sizeX - 1) / 2) };
}

function crop(image, width, y0, x0, sizeY, sizeX) {
  const out = new Float64Array(sizeY * sizeX);
  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < sizeX; x++) out[y * sizeX + x] = image[(y0 + y) * width + x0 + x];
  }
  return out;
}

function interpolateAxis(centres, position) {
  if (centres.length === 1 || position <= centres[0]) return [0, 0, 0];
  const last = centres.length - 1;
  if (position >= centres[last]) return [last, last, 0];
  let i = 0;
  while (centres[i + 1] < position) i++;
  return [i, i + 1, (position - centres[i]) / (centres[i + 1] - centres[i])];
}

/** Bilinear interpolation of patch-centre shifts to every pixel (constant beyond the outer centres). */
export function shiftField(grid, patchShifts, height, width) {
  const nx = grid.xs.length;
  const fieldY = new Float32Array(height * width);
  const fieldX = new Float32Array(height * width);
  const columns = Array.from({ length: width }, (_, x) => interpolateAxis(grid.centresX, x));
  for (let y = 0; y < height; y++) {
    const [r0, r1, fy] = interpolateAxis(grid.centresY, y);
    for (let x = 0; x < width; x++) {
      const [c0, c1, fx] = columns[x];
      for (const axis of [0, 1]) {
        const a = patchShifts[r0 * nx + c0][axis];
        const b = patchShifts[r0 * nx + c1][axis];
        const c = patchShifts[r1 * nx + c0][axis];
        const d = patchShifts[r1 * nx + c1][axis];
        const value = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        (axis ? fieldX : fieldY)[y * width + x] = value;
      }
    }
  }
  return { fieldY, fieldX };
}

/** Bytes one registration holds for its patch template spectra (float64 real and imaginary). */
export function patchSpectraBytes(height, width, size, overlap) {
  const grid = patchGrid(height, width, size, overlap);
  return grid.ys.length * grid.xs.length * grid.sizeY * grid.sizeX * 16;
}

/** Limit on one registration's patch spectra; each worker holds its own. */
export const PATCH_SPECTRA_BUDGET = 256 * 1024 ** 2;

/**
 * A motion-correction plan for one template: registers and resamples frames one at a time,
 * so a caller can shard frames across workers.
 */
export function createRegistration(template, height, width, options = {}) {
  const { mode = 'rigid', maxShift = 10, upsample = 10, normalization = 'none', patchSize = 64, patchOverlap = 32, maxDeviation = 3 } = options;
  const whole = templateSpectrum(template, height, width);
  const grid = mode === 'piecewise' ? patchGrid(height, width, patchSize, patchOverlap) : null;
  if (grid && patchSpectraBytes(height, width, patchSize, patchOverlap) > PATCH_SPECTRA_BUDGET) {
    throw new Error(`Patches of ${patchSize} px overlapping by ${patchOverlap} px need too much memory for a ${width} × ${height} movie; use a larger patch size or less overlap.`);
  }
  const patches = grid
    ? grid.ys.flatMap((y0) => grid.xs.map((x0) => ({ y0, x0, spectrum: templateSpectrum(crop(template, width, y0, x0, grid.sizeY, grid.sizeX), grid.sizeY, grid.sizeX) })))
    : [];
  return {
    grid,
    /** Registers one frame; returns its rigid shift, patch shifts and resampled frame. */
    correct(frame, out) {
      const rigid = registerTranslation(whole, frame, { upsample, maxShift, normalization }).shift;
      if (!grid) return { rigid, patches: null, frame: shiftFrame(frame, height, width, rigid, out) };
      // Each patch is registered after the rigid shift, within maxDeviation of zero.
      const rigidFrame = shiftFrame(frame, height, width, rigid);
      const patchShifts = patches.map(({ y0, x0, spectrum }) => {
        const residual = registerTranslation(spectrum, crop(rigidFrame, width, y0, x0, grid.sizeY, grid.sizeX), { upsample, normalization, maxShift: maxDeviation }).shift;
        return [rigid[0] + residual[0], rigid[1] + residual[1]];
      });
      const { fieldY, fieldX } = shiftField(grid, patchShifts, height, width);
      return { rigid, patches: patchShifts, frame: warpFrame(frame, height, width, fieldY, fieldX, out) };
    },
  };
}
