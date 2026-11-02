// SPDX-License-Identifier: Apache-2.0
// Header arithmetic of sdcflows 2.17.1 and niworkflows 1.15.3 for SyN-SDC: orientation codes,
// the positive-cosine reorientation of the unwarp, the SyN sampling grid
// (GenerateSamplingReference), the deformation weights (_warp_dir), the voxel-unit SyN
// parameters (_mm2vox) and the obliquity check of Deoblique. Affines are 4 by 4 row arrays
// mapping voxel indices to RAS millimetres.

const LETTERS = [['L', 'R'], ['P', 'A'], ['I', 'S']];

/** The voxel sizes of an affine (nibabel.affines.voxel_sizes). */
export function voxelSizes(affine) {
  return [0, 1, 2].map((j) => Math.hypot(affine[0][j], affine[1][j], affine[2][j]));
}

/**
 * nibabel.io_orientation for an affine whose axes are close to the world axes: for each array
 * axis, the world axis (0 R-L, 1 A-P, 2 S-I) it is closest to and the direction, +1 toward
 * R, A or S.
 */
export function orientation(affine) {
  const zooms = voxelSizes(affine);
  const used = new Set();
  const result = [];
  const order = [0, 1, 2]
    .map((j) => {
      const column = [0, 1, 2].map((i) => Math.abs(affine[i][j]) / zooms[j]);
      return { j, axis: column.indexOf(Math.max(...column)), weight: Math.max(...column) };
    })
    .sort((a, b) => b.weight - a.weight);
  for (const { j } of order) {
    const column = [0, 1, 2].map((i) => (used.has(i) ? -1 : Math.abs(affine[i][j])));
    const axis = column.indexOf(Math.max(...column));
    used.add(axis);
    result[j] = { axis, sign: affine[axis][j] >= 0 ? 1 : -1 };
  }
  return result;
}

/** nibabel.aff2axcodes: ['L', 'A', 'S'] for a LAS image. */
export function axisCodes(affine) {
  return orientation(affine).map(({ axis, sign }) => LETTERS[axis][sign > 0 ? 1 : 0]);
}

/** The largest angle (degrees) between an array axis and its closest world axis (nibabel.affines.obliquity). */
export function obliquity(affine) {
  const zooms = voxelSizes(affine);
  let largest = 0;
  for (let j = 0; j < 3; j++) {
    const best = Math.max(...[0, 1, 2].map((i) => Math.abs(affine[i][j]) / zooms[j]));
    largest = Math.max(largest, (Math.acos(Math.min(1, best)) * 180) / Math.PI);
  }
  return largest;
}

/** sdcflows Deoblique's threshold (interfaces/utils.py OBLIQUE_THRESHOLD_DEG). */
export const OBLIQUE_THRESHOLD_DEG = 0.5;

/**
 * ensure_positive_cosines: the axes to flip so that every array axis points toward R, A or S,
 * and the affine of the flipped grid.
 */
export function positiveCosines(dims, affine) {
  const flips = orientation(affine).map(({ sign }) => sign < 0);
  const flipped = affine.map((row) => row.slice());
  for (let j = 0; j < 3; j++) {
    if (!flips[j]) continue;
    for (let i = 0; i < 3; i++) {
      flipped[i][3] += affine[i][j] * (dims[j] - 1);
      flipped[i][j] = -affine[i][j];
    }
  }
  return { flips, affine: flipped };
}

/** A copy of an x-fastest volume (or each volume of a series) with the given axes reversed. */
export function flipVolume(data, dims, flips, frames = 1) {
  if (!flips.some(Boolean)) return data.slice();
  const [nx, ny, nz] = dims;
  const voxels = nx * ny * nz;
  const out = new data.constructor(data.length);
  for (let t = 0; t < frames; t++) {
    const base = t * voxels;
    for (let z = 0; z < nz; z++) {
      const sz = flips[2] ? nz - 1 - z : z;
      for (let y = 0; y < ny; y++) {
        const sy = flips[1] ? ny - 1 - y : y;
        for (let x = 0; x < nx; x++) {
          const sx = flips[0] ? nx - 1 - x : x;
          out[base + x + nx * (y + ny * z)] = data[base + sx + nx * (sy + ny * sz)];
        }
      }
    }
  }
  return out;
}

function multiply(a, b) {
  return a.map((row) => [0, 1, 2, 3].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j] + row[3] * b[3][j]));
}

/**
 * niworkflows `_gen_reference` with keep_native: the field of view of `fixed` on a grid of
 * `zooms` (rounded to 0.001 mm) aligned with RAS, as nilearn.resample_img bounds it with a 3 by
 * 3 target affine. `zooms` are float32 header values, as nibabel reads them.
 */
export function samplingReference(fixedDims, fixedAffine, zooms) {
  const step = zooms.map((zoom) => Math.fround(Math.round(Math.fround(zoom) * 1000) / 1000));
  const inverse = [
    [1 / step[0], 0, 0, 0],
    [0, 1 / step[1], 0, 0],
    [0, 0, 1 / step[2], 0],
    [0, 0, 0, 1],
  ];
  const transform = multiply(inverse, fixedAffine);
  const [a, b, c] = fixedDims.map((n) => n - 1);
  const corners = [[0, 0, 0], [a, 0, 0], [0, b, 0], [0, 0, c], [a, b, 0], [a, 0, c], [0, b, c], [a, b, c]];
  const bounds = [0, 1, 2].map((i) => {
    const values = corners.map(([x, y, z]) => transform[i][0] * x + transform[i][1] * y + transform[i][2] * z + transform[i][3]);
    return [Math.min(...values), Math.max(...values)];
  });
  const offset = bounds.map(([min], i) => step[i] * min);
  const affine = [
    [step[0], 0, 0, offset[0]],
    [0, step[1], 0, offset[1]],
    [0, 0, step[2], offset[2]],
    [0, 0, 0, 1],
  ];
  const dims = bounds.map(([min, max]) => Math.ceil(max - min) + 1);
  return { dims, affine };
}

/** The array axis of `affine` that lies along the world axis of the moving image's PE axis. */
function fixedPeAxis(movingAffine, fixedAffine, phaseEncodingDirection) {
  const peAxis = 'ijk'.indexOf(phaseEncodingDirection[0]);
  const worldAxis = orientation(movingAffine)[peAxis].axis;
  return orientation(fixedAffine).findIndex(({ axis }) => axis === worldAxis);
}

/** sdcflows `_warp_dir`: weight 1 on the fixed grid's PE axis and 0.1 on the others, per level. */
export function restrictDeformation(movingAffine, fixedAffine, phaseEncodingDirection) {
  const weights = [0.1, 0.1, 0.1];
  weights[fixedPeAxis(movingAffine, fixedAffine, phaseEncodingDirection)] = 1.0;
  return weights;
}

/** sdcflows `_mm2vox`: the third SyN parameter in voxels of the fixed grid's PE axis. */
export function synParameters(movingAffine, fixedAffine, phaseEncodingDirection, parameters) {
  const peResolution = voxelSizes(fixedAffine)[fixedPeAxis(movingAffine, fixedAffine, phaseEncodingDirection)];
  return parameters.map(([gradient, field, total]) => [gradient, field, total / peResolution]);
}
