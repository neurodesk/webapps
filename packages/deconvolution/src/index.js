// Pure helpers around the deconvolution WebAssembly module: PSF sizing, measured-PSF
// preparation, input checks and the memory plan. Nothing here touches the DOM or the module,
// so the app and Node share it unchanged.

/** Richardson-Lucy as scikit-image runs it, and RL-TV (Dey et al. 2006). */
export const METHODS = Object.freeze({
  rl: Object.freeze({ id: "rl", label: "Richardson-Lucy" }),
  rltv: Object.freeze({ id: "rltv", label: "Richardson-Lucy with total variation" }),
});
/** RL-TV weights at or above 1/6 could make the update's denominator nonpositive. */
export const MAX_TV_WEIGHT = 0.1;
export const MAX_ITERATIONS = 500;
/** The largest PSF side the app computes, in voxels. */
export const MAX_PSF_SIDE = 129;
/** WebAssembly memory a run may plan for (bytes). */
export const MEMORY_BUDGET = 2 ** 31;

function odd(n) {
  const rounded = Math.max(1, Math.round(n));
  return rounded % 2 ? rounded : rounded + 1;
}

function largestOddAtMost(n) {
  const floor = Math.max(1, Math.floor(n));
  return floor % 2 ? floor : floor - 1;
}

/** How many Airy radii (lateral) or depths of field (axial) a voxel may span before the PSF is refused. */
export const MAX_VOXEL_PER_RESOLUTION = 10;

/**
 * Refuses a computed PSF for voxels far coarser than the optics resolve: past
 * MAX_VOXEL_PER_RESOLUTION Airy radii or depths of field the PSF lies inside one voxel, there is
 * nothing to deconvolve, and the Gibson-Lanni quadrature, which grows with the PSF's physical
 * extent, can exhaust WebAssembly memory. An axis one voxel long is not checked.
 */
export function checkSampling({ na, ni, emissionUm, spacingUm, dims }) {
  const airy = (0.61 * emissionUm) / na;
  const depthOfField = (ni * emissionUm) / (na * na);
  const limits = [["lateral", spacingUm.x, airy, "Airy radius"], ["axial", dims[0] > 1 ? spacingUm.z : 0, depthOfField, "depth of field"]];
  for (const [axis, spacing, resolution, name] of limits) {
    if (spacing > MAX_VOXEL_PER_RESOLUTION * resolution) {
      const um = (value) => Number(value.toPrecision(3));
      throw new Error(`The ${axis} voxel size, ${um(spacing)} µm, is over ${MAX_VOXEL_PER_RESOLUTION} times this objective's ${name} (${um(resolution)} µm), so a computed PSF fits inside one voxel. Check the voxel size and numerical aperture.`);
    }
  }
}

/**
 * The theoretical PSF's size `{ xy, z }` in voxels (odd, so the source sits on a voxel centre).
 * Axially it spans four widefield depths of field each side (confocal) or the whole stack
 * (widefield, whose out-of-focus cone never ends); laterally six Airy radii plus, for widefield,
 * the cone's radius at that depth. Both are capped at the image's extent and MAX_PSF_SIDE.
 */
export function autoPsfSize({ modality, na, ni, emissionUm, spacingUm, dims }) {
  const [nz, ny, nx] = dims;
  const airy = (0.61 * emissionUm) / na;
  const depthOfField = (ni * emissionUm) / (na * na);
  const zHalf = modality === "widefield" ? (nz - 1) * spacingUm.z : 4 * depthOfField;
  const cone = modality === "widefield" ? zHalf * Math.tan(Math.asin(Math.min(na / ni, 0.999))) : 0;
  const xyHalf = 6 * airy + cone;
  const zCap = Math.min(MAX_PSF_SIDE, largestOddAtMost(2 * nz - 1));
  const xyCap = Math.min(MAX_PSF_SIDE, largestOddAtMost(Math.min(nx, ny)));
  return {
    xy: Math.min(xyCap, odd((2 * xyHalf) / spacingUm.x + 1)),
    z: nz === 1 ? 1 : Math.min(zCap, odd((2 * zHalf) / spacingUm.z + 1)),
  };
}

/** Scale to unit sum, as Richardson-Lucy needs to conserve flux. */
export function normaliseSum(values) {
  let sum = 0;
  for (const v of values) sum += v;
  if (!(sum > 0)) throw new Error("The PSF has no positive values.");
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] / sum;
  return out;
}

/**
 * A measured PSF (a bead stack) made usable: the median of its outermost voxels is subtracted as
 * background and negatives are set to 0, and it is cropped to the largest odd box centred on its
 * brightest voxel, so deconvolution does not shift the image. A peak on the stack's edge (along
 * an axis longer than one voxel) is refused. Returns `{ data, dims, peak,
 * background }` with `data` summing to 1.
 */
export function prepareMeasuredPsf(values, dims) {
  const [nz, ny, nx] = dims;
  if (values.length !== nz * ny * nx) throw new Error("The PSF's voxel count does not match its dimensions.");
  const border = [];
  let peakIndex = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const i = (z * ny + y) * nx + x;
        if (!Number.isFinite(values[i])) throw new Error("The PSF has non-finite values.");
        if (values[i] > values[peakIndex]) peakIndex = i;
        const edge = x === 0 || y === 0 || x === nx - 1 || y === ny - 1 || ((z === 0 || z === nz - 1) && nz > 1);
        if (edge) border.push(values[i]);
      }
    }
  }
  border.sort((a, b) => a - b);
  const background = border.length ? border[Math.floor(border.length / 2)] : 0;
  const peak = [Math.floor(peakIndex / (ny * nx)), Math.floor(peakIndex / nx) % ny, peakIndex % nx];
  const half = peak.map((p, axis) => Math.min(p, dims[axis] - 1 - p));
  // Cropped around a peak on an edge, the PSF would be one voxel thick along that axis.
  const edges = ["z", "y", "x"].filter((_, axis) => dims[axis] > 1 && half[axis] === 0);
  if (edges.length) throw new Error(`The PSF's brightest voxel is on the stack's edge (${edges.join(", ")}); use a bead stack with the bead inside it.`);
  const out = half.map((h) => 2 * h + 1);
  const cropped = new Float64Array(out[0] * out[1] * out[2]);
  for (let z = 0; z < out[0]; z += 1) {
    for (let y = 0; y < out[1]; y += 1) {
      for (let x = 0; x < out[2]; x += 1) {
        const source = ((peak[0] - half[0] + z) * ny + peak[1] - half[1] + y) * nx + peak[2] - half[2] + x;
        cropped[(z * out[1] + y) * out[2] + x] = Math.max(0, values[source] - background);
      }
    }
  }
  return { data: normaliseSum(cropped), dims: out, peak, background };
}

/**
 * The image as float64 for the module: finite values required; negative values (a subtracted
 * camera offset) are set to 0, since Richardson-Lucy needs a nonnegative image.
 */
export function prepareImage(values) {
  const out = new Float64Array(values.length);
  let negative = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) throw new Error("The image has non-finite values (NaN or infinity).");
    if (v < 0) negative += 1;
    out[i] = v < 0 ? 0 : v;
  }
  return { data: out, negative };
}

/** The 5-smooth length scipy.fft.next_fast_len gives for real transforms. */
export function nextFastLength(target) {
  for (let n = Math.max(1, target); ; n += 1) {
    let m = n;
    for (const p of [2, 3, 5]) while (m % p === 0) m /= p;
    if (m === 1) return n;
  }
}

/** The FFT grid and the module's peak memory for one run. */
export function memoryPlan(dims, psfDims, { tv = false } = {}) {
  const padded = dims.map((n, axis) => nextFastLength(n + psfDims[axis] - 1));
  const paddedVoxels = padded[0] * padded[1] * padded[2];
  const half = Math.floor(padded[2] / 2) + 1;
  const spectrum = padded[0] * padded[1] * half;
  const voxels = dims[0] * dims[1] * dims[2];
  const psfVoxels = psfDims[0] * psfDims[1] * psfDims[2];
  // Kept for the run: the real padded buffer, the OTF and work spectrum (complex f64), and the
  // image, estimate and ratio (f64).
  const resident = paddedVoxels * 8 + spectrum * 32 + voxels * 8 * 3;
  // The FFT's line buffer (one y-z plane of the half spectrum), plus its scratch and twiddles,
  // bounded by four complex values per padded length.
  const workspace = (half * Math.max(padded[0], padded[1]) + 4 * (padded[0] + padded[1] + padded[2])) * 16;
  // wasm-bindgen copies the image and PSF arguments into the module while the constructor keeps
  // its own image copy, and copies the estimate out again at the end.
  const transient = (voxels + psfVoxels) * 8;
  // RL-TV's three unit-gradient fields and the divergence, allocated each iteration.
  const regularisation = tv ? voxels * 8 * 4 : 0;
  // Measured on the module (test/helpers.test.js), the module's memory grows up to 1.02 times
  // this sum (allocator rounding and 64 KiB pages), so the plan allows 1.25 times it.
  const bytes = Math.ceil(1.25 * (resident + workspace + transient + regularisation));
  return { padded, paddedVoxels, bytes, fits: bytes <= MEMORY_BUDGET };
}

/** Validated run settings from form or automation values. */
export function runSettings({ method = "rl", iterations = 20, tvWeight = 0.002 } = {}) {
  if (!METHODS[method]) throw new Error(`Unknown method ${method}.`);
  const count = Number(iterations);
  if (!Number.isInteger(count) || count < 1 || count > MAX_ITERATIONS) throw new Error(`Iterations must be a whole number from 1 to ${MAX_ITERATIONS}.`);
  const weight = method === "rltv" ? Number(tvWeight) : 0;
  if (method === "rltv" && !(weight > 0 && weight <= MAX_TV_WEIGHT)) throw new Error(`The TV weight must be above 0 and at most ${MAX_TV_WEIGHT}.`);
  return { method, iterations: count, tvWeight: weight };
}

/** Validated optics from form or automation values (lengths in micrometres). */
export function opticsSettings({ modality = "widefield", na, immersionIndex, sampleIndex, emissionNm, excitationNm, depthUm = 0 } = {}) {
  if (modality !== "widefield" && modality !== "confocal") throw new Error(`Unknown modality ${modality}.`);
  const values = { na: Number(na), ni: Number(immersionIndex), ns: Number(sampleIndex), emission: Number(emissionNm), excitation: Number(excitationNm), depth: Number(depthUm) };
  if (!(values.ni >= 1 && values.ni <= 2)) throw new Error("The immersion refractive index must be between 1 and 2.");
  if (!(values.na > 0 && values.na < values.ni)) throw new Error("The numerical aperture must be above 0 and below the immersion index.");
  if (!(values.ns >= 1 && values.ns <= 2)) throw new Error("The sample refractive index must be between 1 and 2.");
  if (!(values.emission >= 300 && values.emission <= 1500)) throw new Error("The emission wavelength must be 300 to 1500 nm.");
  if (modality === "confocal" && !(values.excitation >= 300 && values.excitation <= 1500)) throw new Error("The excitation wavelength must be 300 to 1500 nm.");
  if (!(values.depth >= 0 && values.depth <= 200)) throw new Error("The depth below the coverslip must be 0 to 200 µm.");
  return {
    modality,
    na: values.na,
    ni: values.ni,
    ns: values.ns,
    emissionUm: values.emission / 1000,
    excitationUm: modality === "confocal" ? values.excitation / 1000 : 0,
    depthUm: values.depth,
  };
}
