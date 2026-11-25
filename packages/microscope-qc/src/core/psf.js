// PSF and resolution from a z-stack of sub-resolution beads, following MetroloJ_QC's
// definitions (Faklaris et al. 2022; clean implementation from the paper and the plugin's
// documented behaviour):
//
// 1. Beads are maxima of the maximum-intensity projection that stand out from their
//    surroundings by at least the prominence (topographic prominence: the peak minus the
//    highest level at which it joins a brighter peak).
// 2. A bead is rejected when its crop box leaves the image, another detected maximum lies in
//    its box, a voxel in its box is saturated, or its focus is the first or last plane.
// 3. In the box, the centre is the brightest pixel of the projection and the brightest plane
//    there; the x and y profiles run through that voxel across the box, the z profile through
//    the whole stack.
// 4. Each profile is fitted with ImageJ's Gaussian (fit.js); FWHM = 2·sqrt(2 ln 2)·σ. A bead
//    is listed but left out of the summary if any axis fit has an adjusted R² below the
//    threshold (0.95 by default).
//
// Stacks are plane, row, column order: index = (z · ny + y) · nx + x.
import { fitGaussian } from './fit.js';

/** Maximum-intensity projection along z. */
export function maxProjection(data, nx, ny, nz) {
  const plane = nx * ny;
  const out = new Float64Array(plane);
  out.set(data.subarray(0, plane));
  for (let z = 1; z < nz; z++) {
    const offset = z * plane;
    for (let i = 0; i < plane; i++) if (data[offset + i] > out[i]) out[i] = data[offset + i];
  }
  return out;
}

/** Median and 1.4826 · median absolute deviation of an image: its background level and noise. */
function robustNoise(image) {
  const step = Math.max(1, Math.floor(image.length / 200000));
  const sample = [];
  for (let i = 0; i < image.length; i += step) sample.push(image[i]);
  sample.sort((a, b) => a - b);
  const median = sample[Math.floor(sample.length / 2)];
  const deviations = sample.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  return { median, sd: 1.4826 * deviations[Math.floor(deviations.length / 2)] };
}

/**
 * Local maxima of a 2D image with their topographic prominence (8-connected flooding from the
 * highest pixel down). The highest peak's prominence is its height above the image minimum.
 * Plateaus count once, at their first pixel in raster order.
 * @returns {{ x: number, y: number, value: number, prominence: number }[]} sorted by value, highest first
 */
export function prominentMaxima(image, nx, ny, minProminence) {
  const n = nx * ny;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => image[b] - image[a] || a - b);
  const parent = new Int32Array(n).fill(-1);
  const peak = new Int32Array(n);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const maxima = [];
  for (const i of order) {
    parent[i] = i;
    peak[i] = i;
    const x = i % nx;
    const y = (i - x) / nx;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
        const j = yy * nx + xx;
        if (parent[j] < 0) continue;
        const a = find(i);
        const b = find(j);
        if (a === b) continue;
        // The region with the lower peak ends here; its prominence is its height above this level.
        const [high, low] = image[peak[a]] > image[peak[b]] || (image[peak[a]] === image[peak[b]] && peak[a] < peak[b]) ? [a, b] : [b, a];
        if (peak[low] !== i) maxima.push({ index: peak[low], prominence: image[peak[low]] - image[i] });
        parent[low] = high;
      }
    }
  }
  const root = find(order[0]);
  maxima.push({ index: peak[root], prominence: image[peak[root]] - image[order[n - 1]] });
  return maxima
    .filter((m) => m.prominence >= minProminence && m.prominence > 0)
    .map(({ index, prominence }) => ({ x: index % nx, y: Math.floor(index / nx), value: image[index], prominence }))
    .sort((a, b) => b.value - a.value || a.y - b.y || a.x - b.x);
}

export const REJECTIONS = Object.freeze({
  edge: 'box leaves the image',
  neighbour: 'another bead in its box',
  saturated: 'saturated voxel in its box',
  focus: 'focus at the first or last plane',
  fit: 'a profile could not be fitted',
});

function profileFit(positions, values) {
  try {
    return fitGaussian(positions, values);
  } catch {
    return null;
  }
}

/**
 * Detects beads and fits their x, y and z profiles.
 * @param {ArrayLike<number>} data stack in plane, row, column order
 * @param {{ nx: number, ny: number, nz: number, spacing: { x: number, y: number, z: number } }} dims spacing in µm
 * @param {{ halfBox: number, prominence?: number | null, autoProminence?: number, minR2: number, saturation: number | null }} options halfBox in pixels;
 *   prominence in grey levels, or null for autoProminence (default 10) background SDs of the projection;
 *   saturation is the value counted as saturated (null for none)
 * @param {(done: number, total: number) => void} [onProgress]
 */
export function analyseBeads(data, { nx, ny, nz, spacing }, { halfBox, prominence = null, autoProminence = 10, minR2, saturation }, onProgress) {
  if (nz < 3) throw new Error(`A PSF needs a z-stack; this image has ${nz} plane${nz === 1 ? '' : 's'}.`);
  if (!(halfBox >= 2)) throw new Error('The bead box must be at least 2 pixels from centre to edge.');
  if (2 * halfBox + 1 > nx || 2 * halfBox + 1 > ny) throw new Error(`A bead box of ${2 * halfBox + 1} pixels does not fit in a ${nx} × ${ny} image.`);
  const plane = nx * ny;
  const projection = maxProjection(data, nx, ny, nz);
  const noise = robustNoise(projection);
  const threshold = prominence ?? autoProminence * noise.sd;
  if (!(threshold > 0)) throw new Error('The projection has no background noise to set an automatic prominence; enter one.');
  const maxima = prominentMaxima(projection, nx, ny, threshold);
  const beads = [];
  for (const [k, maximum] of maxima.entries()) {
    const bead = { id: k + 1, peakX: maximum.x, peakY: maximum.y, prominence: maximum.prominence, rejection: null };
    beads.push(bead);
    const { x: px, y: py } = maximum;
    if (px < halfBox || py < halfBox || px >= nx - halfBox || py >= ny - halfBox) bead.rejection = 'edge';
    else if (maxima.some((other) => other !== maximum && Math.abs(other.x - px) <= halfBox && Math.abs(other.y - py) <= halfBox)) bead.rejection = 'neighbour';
    if (bead.rejection) continue;
    let cx = px;
    let cy = py;
    let best = -Infinity;
    let saturated = false;
    for (let y = py - halfBox; y <= py + halfBox; y++) {
      for (let x = px - halfBox; x <= px + halfBox; x++) {
        const value = projection[y * nx + x];
        if (saturation !== null && value >= saturation) saturated = true;
        if (value > best) {
          best = value;
          cx = x;
          cy = y;
        }
      }
    }
    if (saturated) {
      bead.rejection = 'saturated';
      continue;
    }
    let cz = 0;
    for (let z = 1; z < nz; z++) if (data[z * plane + cy * nx + cx] > data[cz * plane + cy * nx + cx]) cz = z;
    Object.assign(bead, { x: cx, y: cy, z: cz, peak: best });
    if (cz === 0 || cz === nz - 1) {
      bead.rejection = 'focus';
      continue;
    }
    const lateral = 2 * halfBox + 1;
    const xs = new Float64Array(lateral);
    const xv = new Float64Array(lateral);
    const ys = new Float64Array(lateral);
    const yv = new Float64Array(lateral);
    for (let i = 0; i < lateral; i++) {
      xs[i] = i * spacing.x;
      ys[i] = i * spacing.y;
      xv[i] = data[cz * plane + cy * nx + (px - halfBox + i)];
      yv[i] = data[cz * plane + (py - halfBox + i) * nx + cx];
    }
    const zs = new Float64Array(nz);
    const zv = new Float64Array(nz);
    for (let z = 0; z < nz; z++) {
      zs[z] = z * spacing.z;
      zv[z] = data[z * plane + cy * nx + cx];
    }
    const fits = { x: profileFit(xs, xv), y: profileFit(ys, yv), z: profileFit(zs, zv) };
    bead.profiles = { x: Array.from(xv), y: Array.from(yv), z: Array.from(zv), origin: { x: px - halfBox, y: py - halfBox } };
    bead.fits = fits;
    if (!fits.x || !fits.y || !fits.z) {
      bead.rejection = 'fit';
      continue;
    }
    bead.fwhm = { x: fits.x.fwhm, y: fits.y.fwhm, z: fits.z.fwhm };
    bead.r2 = { x: fits.x.r2, y: fits.y.r2, z: fits.z.r2 };
    bead.lar = Math.min(bead.fwhm.x, bead.fwhm.y) / Math.max(bead.fwhm.x, bead.fwhm.y);
    bead.goodFit = bead.r2.x >= minR2 && bead.r2.y >= minR2 && bead.r2.z >= minR2;
    onProgress?.(k + 1, maxima.length);
  }
  onProgress?.(maxima.length, maxima.length);
  return { beads, background: noise, prominence: threshold, maximaCount: maxima.length };
}

function stats(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, sd: null, median: null, min: null, max: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { n, mean, sd, median, min: sorted[0], max: sorted[n - 1] };
}

/**
 * Summary over the beads with good fits: FWHM statistics per axis, the lateral asymmetry ratio
 * and the ratio of the mean FWHM to the theoretical resolution (MetroloJ_QC flags above 1.5).
 */
export function summariseBeads(beads, theory) {
  const good = beads.filter((bead) => !bead.rejection && bead.goodFit);
  const axis = (key) => stats(good.map((bead) => bead.fwhm[key]));
  const summary = { beads: beads.length, measured: beads.filter((bead) => !bead.rejection).length, used: good.length, x: axis('x'), y: axis('y'), z: axis('z'), lar: stats(good.map((bead) => bead.lar)) };
  if (theory) {
    for (const key of ['x', 'y', 'z']) {
      const reference = key === 'z' ? theory.axial : theory.lateral;
      summary[key].theoretical = reference;
      summary[key].ratio = summary[key].mean === null ? null : summary[key].mean / reference;
    }
  }
  return summary;
}
