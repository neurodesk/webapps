// BISON's PT-mode feature matrix (BISON_L8.py, BISON_L9.py) for the voxels of the classification mask.
//
// Every image is on the T1 grid, NIfTI order. Rows follow the mask's linear voxel order, which is
// numpy's np.nonzero order on the MINC (z, y, x) array. T1 and FLAIR are clipped to [1, 255] before
// any use, the histogram row is numpy.round (half to even) of the clipped value, and the matrix is
// float32, as sklearn casts it.

export const IMAGE_RANGE = 256;

export const MODES = {
  t1: { classes: 8, features: 18, flair: false },
  't1-flair': { classes: 9, features: 33, flair: true },
};

export function modeSpec(mode) {
  const spec = MODES[mode];
  if (!spec) throw new Error(`Unknown BISON mode: ${mode}`);
  return spec;
}

export function maskVoxels(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) count++;
  }
  const voxels = new Uint32Array(count);
  let next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) voxels[next++] = i;
  }
  return voxels;
}

// The histogram JSON (`pdf[row][col]`, [256][classes]) as a flat row-major table.
export function histogramTable(json, classes) {
  const pdf = json?.pdf;
  if (!Array.isArray(pdf) || pdf.length !== IMAGE_RANGE) throw new Error(`The histogram table needs ${IMAGE_RANGE} rows.`);
  const table = new Float64Array(IMAGE_RANGE * classes);
  for (let row = 0; row < IMAGE_RANGE; row++) {
    const values = pdf[row];
    if (!Array.isArray(values) || values.length !== classes) throw new Error(`Histogram row ${row} needs ${classes} classes.`);
    for (let c = 0; c < classes; c++) {
      if (!Number.isFinite(values[c])) throw new Error(`Histogram row ${row} has a non-finite value.`);
      table[row * classes + c] = values[c];
    }
  }
  return table;
}

export function clipIntensity(value) {
  if (value < 1) return 1;
  if (value > IMAGE_RANGE - 1) return IMAGE_RANGE - 1;
  return value;
}

// numpy.round: ties go to the even integer.
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function checkImages(images, length) {
  const spec = modeSpec(images.mode);
  const volumes = [images.t1, images.avT1, ...images.priors];
  if (images.priors.length !== spec.classes) throw new Error(`${images.mode} needs ${spec.classes} spatial priors.`);
  if (spec.flair) volumes.push(images.flair, images.avFlair);
  for (const volume of volumes) {
    if (!volume || volume.length !== length) throw new Error('Every BISON input must be on the T1 grid.');
  }
  if (images.t1Histogram?.length !== IMAGE_RANGE * spec.classes) throw new Error('The T1 histogram table has the wrong size.');
  if (spec.flair && images.flairHistogram?.length !== IMAGE_RANGE * spec.classes) throw new Error('The FLAIR histogram table has the wrong size.');
  return spec;
}

function clippedAt(volume, index, name) {
  const value = volume[index];
  if (Number.isNaN(value)) throw new Error(`${name} has a NaN voxel inside the brain mask.`);
  return clipIntensity(value);
}

// Rows start..end of the matrix for `voxels`, written to `target` from its first element.
export function writeFeatures(target, images, voxels, start = 0, end = voxels.length) {
  const spec = modeSpec(images.mode);
  const n = spec.classes;
  const { priors, t1, avT1, flair, avFlair, t1Histogram, flairHistogram } = images;
  let offset = 0;
  for (let r = start; r < end; r++) {
    const v = voxels[r];
    for (let k = 0; k < n; k++) target[offset++] = priors[k][v];
    const t1c = clippedAt(t1, v, 'T1');
    target[offset++] = t1c;
    target[offset++] = avT1[v];
    const t1Row = roundHalfEven(t1c) * n;
    for (let k = 0; k < n; k++) target[offset++] = t1Histogram[t1Row + k];
    if (!spec.flair) continue;
    const flairc = clippedAt(flair, v, 'FLAIR');
    target[offset++] = flairc;
    target[offset++] = avFlair[v];
    target[offset++] = flairc / t1c;
    target[offset++] = 0;
    const flairRow = roundHalfEven(flairc) * n;
    for (let k = 0; k < n; k++) target[offset++] = flairHistogram[flairRow + k];
  }
  return target;
}

export function buildFeatures(images, voxels) {
  const spec = checkImages(images, images.t1.length);
  return writeFeatures(new Float32Array(voxels.length * spec.features), images, voxels);
}
