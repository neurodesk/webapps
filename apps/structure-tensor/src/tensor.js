// Structure-tensor orientation analysis (the OrientationJ method: Rezakhaniha et al. 2012,
// Püspöki et al. 2016), written from the papers. Pure and DOM-free: it runs in the worker,
// under Node for the unit tests, and every sum is accumulated in float64.
//
// An image is { data, dims: [nx, ny, nz], spacing: [dx, dy, dz] } with x fastest and the row
// index y increasing downwards, as in a TIFF. nz = 1 is the 2D analysis.
//
// Gradients are Gaussian derivatives at scale sigma, the tensor window a Gaussian at scale rho,
// both in pixels of x. Kernels and borders follow scipy.ndimage.gaussian_filter (sampled,
// normalised kernels truncated at 4 sigma, 'reflect' borders), so scipy is an exact reference.

export const TRUNCATE = 4;
const DEGREES = 180 / Math.PI;

/** The sampled Gaussian (order 0) or its derivative (order 1), centred, as scipy builds it. */
export function gaussianKernel(sigma, order = 0) {
  if (!(sigma > 0)) throw new Error("Gaussian scales must be positive.");
  const radius = Math.floor(TRUNCATE * sigma + 0.5);
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-0.5 * i * i / (sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] /= sum;
    if (order === 1) kernel[i + radius] *= -i / (sigma * sigma);
  }
  return kernel;
}

/** The index a 'reflect' border (d c b a | a b c d | d c b a) reads for position p of n. */
function reflect(p, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  let m = p % period;
  if (m < 0) m += period;
  return m < n ? m : period - 1 - m;
}

/**
 * Convolves `input` with `kernel` along one axis (0 = x, 1 = y, 2 = z) into `output`.
 * output[i] = sum_j kernel[r + j] * input[i - j], as scipy.ndimage.convolve1d.
 */
export function convolveAxis(input, output, dims, axis, kernel) {
  const [nx, ny, nz] = dims;
  const n = dims[axis];
  const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
  const radius = (kernel.length - 1) / 2;
  const line = new Float64Array(n + 2 * radius);
  const lines = (nx * ny * nz) / n;
  for (let l = 0; l < lines; l++) {
    let start;
    if (axis === 0) start = l * nx;
    else if (axis === 1) start = (l % nx) + Math.floor(l / nx) * nx * ny;
    else start = l;
    for (let p = -radius; p < n + radius; p++) line[p + radius] = input[start + reflect(p, n) * stride];
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += kernel[radius + j] * line[i - j + radius];
      output[start + i * stride] = sum;
    }
  }
  return output;
}

/** Applies one kernel per axis (null skips the axis), separably, returning a new Float64Array. */
function separable(input, dims, kernels) {
  let current = Float64Array.from(input);
  let scratch = new Float64Array(current.length);
  for (let axis = 0; axis < 3; axis++) {
    if (!kernels[axis] || dims[axis] === 1 && kernels[axis].length === 1) continue;
    convolveAxis(current, scratch, dims, axis, kernels[axis]);
    [current, scratch] = [scratch, current];
  }
  return current;
}

/** Per-axis scales in voxels for a scale given in pixels of x, so kernels are isotropic in space. */
export function axisScales(scale, spacing, is3d) {
  const [dx, dy, dz] = spacing;
  return [scale, scale * dx / dy, is3d ? scale * dx / dz : 0];
}

function checkImage({ data, dims, spacing }) {
  if (dims.length !== 3 || dims.some((n) => !Number.isInteger(n) || n < 1)) throw new Error("Image dimensions must be three positive integers.");
  if (data.length !== dims[0] * dims[1] * dims[2]) throw new Error("Image data do not match its dimensions.");
  if (spacing.some((s) => !(s > 0))) throw new Error("Voxel spacing must be positive.");
  if (dims[0] < 2 || dims[1] < 2) throw new Error("The image must be at least 2 pixels wide and high.");
}

/**
 * The smoothed structure tensor. Returns { components, names } where components are Float64Arrays
 * Jxx, Jxy, Jyy (2D) or Jxx, Jxy, Jxz, Jyy, Jyz, Jzz (3D), gradients in units of x spacing.
 * `onProgress(fraction)` is called between passes; `signal` aborts between passes.
 */
export function structureTensor(image, { sigma, rho, onProgress, signal } = {}) {
  checkImage(image);
  const { data, dims, spacing } = image;
  const is3d = dims[2] > 1;
  const nd = is3d ? 3 : 2;
  const sig = axisScales(sigma, spacing, is3d);
  const win = axisScales(rho, spacing, is3d);
  const smooth = sig.map((s, axis) => (axis < nd ? gaussianKernel(s, 0) : null));
  const window = win.map((s, axis) => (axis < nd ? gaussianKernel(s, 0) : null));
  const passes = nd + (nd * (nd + 1)) / 2;
  let done = 0;
  const step = () => {
    signal?.throwIfAborted();
    onProgress?.(++done / passes);
  };
  const gradients = [];
  for (let axis = 0; axis < nd; axis++) {
    const kernels = smooth.slice();
    kernels[axis] = gaussianKernel(sig[axis], 1);
    const gradient = separable(data, dims, kernels);
    // A derivative per voxel along this axis, rescaled to a derivative per x pixel.
    const scale = spacing[0] / spacing[axis];
    if (scale !== 1) for (let i = 0; i < gradient.length; i++) gradient[i] *= scale;
    gradients.push(gradient);
    step();
  }
  const names = [];
  const components = [];
  const axes = ["x", "y", "z"];
  for (let a = 0; a < nd; a++) {
    for (let b = a; b < nd; b++) {
      const ga = gradients[a];
      const gb = gradients[b];
      const product = new Float64Array(ga.length);
      for (let i = 0; i < ga.length; i++) product[i] = ga[i] * gb[i];
      components.push(separable(product, dims, window));
      names.push(`J${axes[a]}${axes[b]}`);
      step();
    }
  }
  return { components, names };
}

/** The 2D maps: orientation in degrees (-90, 90], counterclockwise from x with y downwards; coherency; energy. */
export function maps2d([jxx, jxy, jyy]) {
  const n = jxx.length;
  const orientation = new Float64Array(n);
  const coherency = new Float64Array(n);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const trace = jxx[i] + jyy[i];
    orientation[i] = 0.5 * Math.atan2(2 * jxy[i], jyy[i] - jxx[i]) * DEGREES;
    if (orientation[i] <= -90) orientation[i] += 180;
    energy[i] = trace;
    coherency[i] = trace > 0 ? Math.min(1, Math.hypot(jyy[i] - jxx[i], 2 * jxy[i]) / trace) : 0;
  }
  return { orientation, coherency, energy };
}

/**
 * Eigen-decomposition of the symmetric 3x3 [[a, b, c], [b, d, e], [c, e, f]] by cyclic Jacobi
 * rotations. Returns eigenvalues descending and the unit eigenvectors as rows of `vectors`.
 */
export function eigenSymmetric3(a, b, c, d, e, f) {
  const m = [[a, b, c], [b, d, e], [c, e, f]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = m[0][1] * m[0][1] + m[0][2] * m[0][2] + m[1][2] * m[1][2];
    const scale = m[0][0] * m[0][0] + m[1][1] * m[1][1] + m[2][2] * m[2][2];
    if (off <= 1e-36 * scale || off === 0) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (m[p][q] === 0) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1);
      const sn = t * cs;
      for (let k = 0; k < 3; k++) {
        const mkp = m[k][p];
        const mkq = m[k][q];
        m[k][p] = cs * mkp - sn * mkq;
        m[k][q] = sn * mkp + cs * mkq;
      }
      for (let k = 0; k < 3; k++) {
        const mpk = m[p][k];
        const mqk = m[q][k];
        m[p][k] = cs * mpk - sn * mqk;
        m[q][k] = sn * mpk + cs * mqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = cs * vkp - sn * vkq;
        v[k][q] = sn * vkp + cs * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => m[j][j] - m[i][i]);
  return {
    values: order.map((i) => m[i][i]),
    vectors: order.map((i) => [v[0][i], v[1][i], v[2][i]]),
  };
}

/**
 * The 3D maps. The fibre direction is the eigenvector of the smallest eigenvalue, signed so its
 * azimuth lies in (-90, 90]; azimuth is the 2D orientation of its xy projection and elevation
 * its signed angle from the xy plane. Fibre coherency is (l2 - l3) / (l2 + l3) with
 * l1 >= l2 >= l3: 1 for a fibre, 0 for a sheet or isotropic texture. Energy is the trace.
 */
export function maps3d([jxx, jxy, jxz, jyy, jyz, jzz]) {
  const n = jxx.length;
  const azimuth = new Float64Array(n);
  const elevation = new Float64Array(n);
  const coherency = new Float64Array(n);
  const energy = new Float64Array(n);
  const vectors = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const { values, vectors: eig } = eigenSymmetric3(jxx[i], jxy[i], jxz[i], jyy[i], jyz[i], jzz[i]);
    let [x, y, z] = eig[2];
    // Visual up is -y: canonical vectors point right, or straight up when vertical in-plane.
    if (x < 0 || (x === 0 && (-y < 0 || (y === 0 && z < 0)))) {
      x = -x;
      y = -y;
      z = -z;
    }
    vectors[3 * i] = x;
    vectors[3 * i + 1] = y;
    vectors[3 * i + 2] = z;
    azimuth[i] = x === 0 && y === 0 ? 0 : Math.atan2(-y, x) * DEGREES;
    if (azimuth[i] <= -90) azimuth[i] += 180;
    elevation[i] = Math.asin(Math.max(-1, Math.min(1, z))) * DEGREES;
    const l2 = Math.max(0, values[1]);
    const l3 = Math.max(0, values[2]);
    coherency[i] = l2 + l3 > 0 ? (l2 - l3) / (l2 + l3) : 0;
    energy[i] = jxx[i] + jyy[i] + jzz[i];
  }
  return { azimuth, elevation, coherency, energy, vectors };
}

/** Orientation and coherency of the whole image: the tensor summed over every voxel (OrientationJ's dominant direction). */
export function dominantDirection(components) {
  const sums = components.map((component) => {
    let sum = 0;
    for (const value of component) sum += value;
    return sum;
  });
  if (sums.length === 3) {
    const { orientation, coherency } = maps2d(sums.map((s) => [s]));
    return { orientation: orientation[0], coherency: coherency[0] };
  }
  const maps = maps3d(sums.map((s) => [s]));
  return { azimuth: maps.azimuth[0], elevation: maps.elevation[0], coherency: maps.coherency[0] };
}

/**
 * Which voxels the distribution counts: coherency at least `minCoherency` and energy at least
 * `minEnergy` (a fraction of the largest energy), as OrientationJ's distribution options.
 */
export function selection({ coherency, energy }, { minCoherency = 0, minEnergy = 0 } = {}) {
  let max = 0;
  for (const value of energy) if (value > max) max = value;
  const floor = minEnergy * max;
  const selected = new Uint8Array(coherency.length);
  for (let i = 0; i < selected.length; i++) selected[i] = coherency[i] >= minCoherency && energy[i] >= floor && energy[i] > 0 ? 1 : 0;
  return selected;
}

/** Counts of `angles` in [low, high) bins of `width` degrees, for selected voxels; the bin of `high` holds high itself. */
export function histogram(angles, selected, { low = -90, high = 90, width = 1 } = {}) {
  const bins = Math.round((high - low) / width);
  const counts = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < angles.length; i++) {
    if (!selected[i]) continue;
    const bin = Math.min(bins - 1, Math.max(0, Math.floor((angles[i] - low) / width)));
    counts[bin]++;
    total++;
  }
  return { low, width, counts, total };
}

/** HSB to 8-bit RGB, h in [0, 1), s and b in [0, 1], as java.awt.Color.HSBtoRGB. */
export function hsbToRgb(h, s, b) {
  if (s === 0) {
    const v = Math.floor(b * 255 + 0.5);
    return [v, v, v];
  }
  const sector = (h - Math.floor(h)) * 6;
  const f = sector - Math.floor(sector);
  const p = b * (1 - s);
  const q = b * (1 - s * f);
  const t = b * (1 - s * (1 - f));
  const [r, g, bl] = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][Math.floor(sector)];
  return [r, g, bl].map((value) => Math.floor(value * 255 + 0.5));
}

/** Min-max normalisation to [0, 1]; a constant image becomes 0. */
export function normalise(data) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of data) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const out = new Float64Array(data.length);
  if (max > min) for (let i = 0; i < data.length; i++) out[i] = (data[i] - min) / (max - min);
  return out;
}

/** OrientationJ's colour survey: hue = orientation, saturation = coherency, brightness = the image. */
export function hsbComposite(orientation, coherency, image) {
  const brightness = normalise(image);
  const rgb = new Uint8Array(3 * orientation.length);
  for (let i = 0; i < orientation.length; i++) {
    rgb.set(hsbToRgb((orientation[i] + 90) / 180, coherency[i], brightness[i]), 3 * i);
  }
  return rgb;
}

/** The 3D direction map: |x|, |y|, |z| of the fibre direction scaled by fibre coherency, as DTI colour maps. */
export function directionColours(vectors, coherency) {
  const rgb = new Uint8Array(vectors.length);
  for (let i = 0; i < coherency.length; i++) {
    for (let k = 0; k < 3; k++) rgb[3 * i + k] = Math.round(255 * Math.min(1, Math.abs(vectors[3 * i + k]) * coherency[i]));
  }
  return rgb;
}

/**
 * The whole analysis of one image. Returns the maps, the selection-based distributions and the
 * dominant direction; `settings` is { sigma, rho, minCoherency, minEnergy }.
 */
export function analyse(image, settings, { onProgress, signal } = {}) {
  const tensor = structureTensor(image, { sigma: settings.sigma, rho: settings.rho, onProgress, signal });
  const dominant = dominantDirection(tensor.components);
  if (image.dims[2] === 1) {
    const maps = maps2d(tensor.components);
    const selected = selection(maps, settings);
    return {
      dimensions: 2,
      maps,
      dominant,
      distributions: { orientation: histogram(maps.orientation, selected) },
      colour: hsbComposite(maps.orientation, maps.coherency, image.data),
    };
  }
  const maps = maps3d(tensor.components);
  const selected = selection(maps, settings);
  return {
    dimensions: 3,
    maps,
    dominant,
    distributions: {
      azimuth: histogram(maps.azimuth, selected),
      elevation: histogram(maps.elevation, selected),
    },
    colour: directionColours(maps.vectors, maps.coherency),
  };
}

/** The distribution table, one row per bin: quantity, bin edges in degrees, count, fraction of counted voxels. */
export function distributionCsv(distributions) {
  const rows = ["quantity,bin_low_deg,bin_high_deg,count,fraction"];
  for (const [quantity, { low, width, counts, total }] of Object.entries(distributions)) {
    counts.forEach((count, bin) => {
      const lower = low + bin * width;
      rows.push(`${quantity},${lower},${lower + width},${count},${total ? (count / total).toPrecision(8) : 0}`);
    });
  }
  return `${rows.join("\n")}\n`;
}
