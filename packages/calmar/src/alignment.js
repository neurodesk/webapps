import { principalAxisAlign, centroidOfMask } from './prealign.js';
import { resampleAffine } from './resample.js';
import {
  foregroundMaskFromScalar,
  robustNormalizeMasked,
  fOrderToNDHWC,
} from './inference-numerics.js';
import { resampleVolume } from './volume-utils.js';
import { integrateSvf, upsampleDisplacementField, warpVolume } from './registration.js';

export function prealignVolumes(source, brainMask, reference) {
  const aligned =
    source.dims.every((value, axis) => value === reference.dims[axis]) &&
    source.affine.every((row, axis) =>
      row.every((value, column) => Math.abs(value - reference.affine[axis][column]) <= 1e-3)
    );
  if (aligned)
    return {
      samplingAffine: reference.affine,
      data: source.data,
      brainMask,
      dims: reference.dims,
      affine: reference.affine,
      eigenvalues: [0, 0, 0],
    };
  const targetMask = foregroundMaskFromIntensity(reference.data, reference.dims, 0.05);
  const { dstAffine, mniDims, eigenvalues } = principalAxisAlign(
    brainMask,
    source.dims,
    source.affine,
    {
      mniDims: reference.dims,
      mniCenterVox: centroidOfMask(targetMask, reference.dims),
      mniAffine: reference.affine,
    }
  );
  return {
    samplingAffine: dstAffine,
    eigenvalues,
    data: resampleAffine(source.data, source.dims, source.affine, mniDims, dstAffine, 'trilinear'),
    brainMask: Uint8Array.from(
      resampleAffine(brainMask, source.dims, source.affine, mniDims, dstAffine, 'nearest'),
      (value) => (value > 0.5 ? 1 : 0)
    ),
    dims: mniDims,
    affine: reference.affine,
  };
}

export async function registerVolumes(source, sourceMask, reference, modelDims, runForward) {
  const sourceNormalized = robustNormalizeMasked(source, sourceMask, { zeroOutside: true }).data;
  const targetNormalized = robustNormalizeMasked(
    reference.data,
    foregroundMaskFromScalar(reference.data, 0.05).mask,
    { zeroOutside: true }
  ).data;
  const downsample = (data) =>
    resampleVolume(
      data,
      reference.dims,
      [1, 1, 1],
      reference.dims.map((value, axis) => value / modelDims[axis])
    ).data;
  const { data, dims } = await runForward(
    fOrderToNDHWC(downsample(sourceNormalized), modelDims),
    fOrderToNDHWC(downsample(targetNormalized), modelDims),
    modelDims
  );
  return upsampleDisplacementField(integrateSvf(data, dims, 7), dims, reference.dims);
}

export function warpReviewedMask(mask, dims, displacement) {
  return Uint8Array.from(warpVolume(mask, dims, displacement, dims), (value) =>
    value > 0.5 ? 1 : 0
  );
}

export function foregroundMaskFromIntensity(data, dims = null, fractionOfMax = 0.05) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i]);
    if (v > max) max = v;
  }
  const threshold = (Number.isFinite(max) ? max : 0) * fractionOfMax;
  const mask = new Uint8Array(data.length);
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (Number(data[i]) > threshold) {
      mask[i] = 1;
      count++;
    }
  }
  if (count === 0) {
    let fallback = Math.floor(data.length / 2);
    if (Array.isArray(dims) && dims.length === 3) {
      const x = Math.min(Math.floor(dims[0] / 2), dims[0] - 1);
      const y = Math.min(Math.floor(dims[1] / 2), dims[1] - 1);
      const z = Math.min(Math.floor(dims[2] / 2), dims[2] - 1);
      fallback = x + y * dims[0] + z * dims[0] * dims[1];
    }
    if (fallback >= 0 && fallback < mask.length) mask[fallback] = 1;
  }
  return mask;
}
