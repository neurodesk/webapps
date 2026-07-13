import { resampleAffine } from './resample.js';
import { writeNifti1 } from './nifti-writer.js';

export function flattenAffine3Rows(affine) {
  return [
    affine[0][0], affine[0][1], affine[0][2], affine[0][3],
    affine[1][0], affine[1][1], affine[1][2], affine[1][3],
    affine[2][0], affine[2][1], affine[2][2], affine[2][3]
  ];
}

export function binarizeMaskData(data) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] > 0 ? 1 : 0;
  return out;
}

export function resampleBinaryMask({ data, srcDims, srcAffine, dstDims, dstAffine }) {
  if (!data || !srcDims || !srcAffine || !dstDims || !dstAffine) {
    throw new Error('resampleBinaryMask: data, dims, and affines are required');
  }
  const binary = binarizeMaskData(data);
  const resampled = resampleAffine(
    binary,
    srcDims,
    srcAffine,
    dstDims,
    dstAffine,
    'nearest'
  );
  return binarizeMaskData(resampled);
}

export function writeBinaryMaskNifti(mask, {
  dims,
  affine,
  spacing = [1, 1, 1],
  description = 'binary mask'
}) {
  return writeNifti1(binarizeMaskData(mask), {
    dims,
    spacing,
    affine: flattenAffine3Rows(affine),
    description
  });
}
