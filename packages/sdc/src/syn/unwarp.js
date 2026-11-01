// SPDX-License-Identifier: Apache-2.0
// sdcflows 2.17.1 B0FieldTransform.apply (transform.py) without head-motion transforms: the
// series is flipped to positive direction cosines, every volume is resampled once along the
// phase-encoding axis with SciPy's cubic spline (order 3, mode 'constant', prefilter), the
// Jacobian factor 1 + d(vsm)/d(pe) is applied, negative values become 0, and the result is
// flipped back. The field must be on the flipped grid, as sdcflows evaluates it there.
import { flipVolume, orientation, positiveCosines } from './grid.js';
import { gradient, sampleCubic, splineFilter3 } from './numerics.js';

const f32 = Math.fround;

/**
 * The signed readout time sdcflows applies: negative when the PE axis of the original image
 * points to L, P or I, or when the direction ends with '-', but not both.
 */
export function signedReadout(affine, phaseEncodingDirection, totalReadoutTime) {
  const axis = 'ijk'.indexOf(phaseEncodingDirection[0]);
  const flip = (orientation(affine)[axis].sign < 0) !== phaseEncodingDirection.endsWith('-');
  return flip ? -totalReadoutTime : totalReadoutTime;
}

/**
 * Unwarps a series. `data` is volume-major float32 (frame t at t * voxels) on `dims` and
 * `affine`; `field` is the field in Hz on the positive-cosine grid (`positiveCosines`).
 * Returns the corrected series in the input orientation, as float32.
 * `onVolume(t)` runs after each volume and may throw to stop.
 */
export function unwarpSeries({ data, dims, frames, affine, field, phaseEncodingDirection, totalReadoutTime, jacobian = true, onVolume }) {
  const voxels = dims[0] * dims[1] * dims[2];
  if (field.length !== voxels) throw new Error('The field is not on the image grid.');
  const { flips } = positiveCosines(dims, affine);
  const axis = 'ijk'.indexOf(phaseEncodingDirection[0]);
  const readout = f32(signedReadout(affine, phaseEncodingDirection, totalReadoutTime));
  const vsm = new Float32Array(voxels);
  for (let i = 0; i < voxels; i++) vsm[i] = f32(field[i] * readout);
  const factor = new Float32Array(voxels);
  if (jacobian) {
    const slope = gradient(vsm, dims, axis);
    for (let i = 0; i < voxels; i++) factor[i] = f32(1 + slope[i]);
  }
  const [nx, ny] = dims;
  const coordinates = [new Float32Array(voxels), new Float32Array(voxels), new Float32Array(voxels)];
  for (let i = 0; i < voxels; i++) {
    coordinates[0][i] = i % nx;
    coordinates[1][i] = Math.floor(i / nx) % ny;
    coordinates[2][i] = Math.floor(i / (nx * ny));
    coordinates[axis][i] = f32(coordinates[axis][i] + vsm[i]);
  }
  const out = new Float32Array(voxels * frames);
  const sample = new Float32Array(voxels);
  for (let t = 0; t < frames; t++) {
    const volume = flipVolume(data.subarray(t * voxels, (t + 1) * voxels), dims, flips);
    const coefficients = splineFilter3(Float64Array.from(volume), dims);
    sampleCubic(coefficients, dims, coordinates[0], coordinates[1], coordinates[2], sample);
    if (jacobian) for (let i = 0; i < voxels; i++) sample[i] = f32(sample[i] * factor[i]);
    for (let i = 0; i < voxels; i++) if (sample[i] < 0) sample[i] = 0;
    out.set(flipVolume(sample, dims, flips), t * voxels);
    onVolume?.(t);
  }
  return out;
}
