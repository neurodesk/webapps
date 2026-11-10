// Complex FFT on split real/imaginary Float64Arrays: iterative radix-2 for powers of two,
// Bluestein's chirp-z transform for every other length. Forward uses e^{-2πikn/N}; the
// inverse is unscaled (callers divide by N where they need to).

const plans = new Map();

function radix2Plan(n) {
  const bits = Math.log2(n);
  const reverse = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return { kind: 'radix2', n, reverse, cos, sin };
}

function radix2(plan, re, im, inverse) {
  const { n, reverse, cos, sin } = plan;
  for (let i = 0; i < n; i++) {
    const j = reverse[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function bluesteinPlan(n) {
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const inner = radix2Plan(m);
  const chirpRe = new Float64Array(n);
  const chirpIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const angle = (Math.PI * ((k * k) % (2 * n))) / n;
    chirpRe[k] = Math.cos(angle);
    chirpIm[k] = Math.sin(angle);
  }
  // The convolution kernel b_k = conj(chirp) on ±k, transformed once.
  const kernelRe = new Float64Array(m);
  const kernelIm = new Float64Array(m);
  kernelRe[0] = chirpRe[0];
  kernelIm[0] = chirpIm[0];
  for (let k = 1; k < n; k++) {
    kernelRe[k] = kernelRe[m - k] = chirpRe[k];
    kernelIm[k] = kernelIm[m - k] = chirpIm[k];
  }
  radix2(inner, kernelRe, kernelIm, false);
  return { kind: 'bluestein', n, m, inner, chirpRe, chirpIm, kernelRe, kernelIm, workRe: new Float64Array(m), workIm: new Float64Array(m) };
}

function bluestein(plan, re, im, inverse) {
  const { n, m, inner, chirpRe, chirpIm, kernelRe, kernelIm, workRe, workIm } = plan;
  const sign = inverse ? -1 : 1;
  workRe.fill(0);
  workIm.fill(0);
  // a_k = x_k · e^{∓iπk²/n}
  for (let k = 0; k < n; k++) {
    const cr = chirpRe[k];
    const ci = -sign * chirpIm[k];
    workRe[k] = re[k] * cr - im[k] * ci;
    workIm[k] = re[k] * ci + im[k] * cr;
  }
  radix2(inner, workRe, workIm, false);
  for (let k = 0; k < m; k++) {
    const kr = kernelRe[k];
    const ki = sign * kernelIm[k];
    const r = workRe[k] * kr - workIm[k] * ki;
    workIm[k] = workRe[k] * ki + workIm[k] * kr;
    workRe[k] = r;
  }
  radix2(inner, workRe, workIm, true);
  for (let k = 0; k < n; k++) {
    const r = workRe[k] / m;
    const i = workIm[k] / m;
    const cr = chirpRe[k];
    const ci = -sign * chirpIm[k];
    re[k] = r * cr - i * ci;
    im[k] = r * ci + i * cr;
  }
}

function plan(n) {
  let entry = plans.get(n);
  if (!entry) {
    entry = (n & (n - 1)) === 0 ? radix2Plan(n) : bluesteinPlan(n);
    plans.set(n, entry);
  }
  return entry;
}

/** In-place 1D transform of `re`/`im` (length n). */
export function fft1d(re, im, inverse = false) {
  const p = plan(re.length);
  if (p.kind === 'radix2') radix2(p, re, im, inverse);
  else bluestein(p, re, im, inverse);
}

/** In-place 2D transform of row-major `re`/`im` (height × width). */
export function fft2d(re, im, height, width, inverse = false) {
  const rowRe = new Float64Array(width);
  const rowIm = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    rowRe.set(re.subarray(offset, offset + width));
    rowIm.set(im.subarray(offset, offset + width));
    fft1d(rowRe, rowIm, inverse);
    re.set(rowRe, offset);
    im.set(rowIm, offset);
  }
  const colRe = new Float64Array(height);
  const colIm = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colRe[y] = re[y * width + x];
      colIm[y] = im[y * width + x];
    }
    fft1d(colRe, colIm, inverse);
    for (let y = 0; y < height; y++) {
      re[y * width + x] = colRe[y];
      im[y * width + x] = colIm[y];
    }
  }
}
