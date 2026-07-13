#!/usr/bin/env node
// Manual lesion-mask refinement: pure native <-> MNI160 mask resampling
// helpers. The app uses the prealign sampling affine to edit on the native T1
// while writing the confirmed mask with the fixed lnm-mni160 header.

const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const niftiModule = await import('nifti-reader-js');
  const nifti = niftiModule.default || niftiModule;
  const {
    resampleBinaryMask,
    writeBinaryMaskNifti
  } = await import(path.join(root, 'web/js/modules/mask-transform.js'));

  const nativeDims = [5, 5, 5];
  const nativeAffine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const prealignSamplingAffine = [
    [1, 0, 0, -1],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  const fixedMniAffine = [
    [1, 0, 0, -4],
    [0, 1, 0, -4],
    [0, 0, 1, -4],
    [0, 0, 0, 1]
  ];

  const native = new Uint8Array(125);
  native[2 + 1 * 5 + 1 * 25] = 1;
  native[2 + 2 * 5 + 1 * 25] = 1;

  const mni = resampleBinaryMask({
    data: native,
    srcDims: nativeDims,
    srcAffine: nativeAffine,
    dstDims: nativeDims,
    dstAffine: prealignSamplingAffine
  });
  assert.equal(mni[3 + 1 * 5 + 1 * 25], 1,
    'native voxel must move through the prealign sampling affine into MNI grid coordinates');
  assert.equal(mni[2 + 1 * 5 + 1 * 25], 0,
    'mask transform must not ignore the prealign sampling affine');

  const roundtrip = resampleBinaryMask({
    data: mni,
    srcDims: nativeDims,
    srcAffine: prealignSamplingAffine,
    dstDims: nativeDims,
    dstAffine: nativeAffine
  });
  assert.deepEqual(Array.from(roundtrip), Array.from(native),
    'native -> MNI sampling grid -> native must roundtrip the binary mask');

  const niftiBuffer = writeBinaryMaskNifti(mni, {
    dims: nativeDims,
    affine: fixedMniAffine,
    spacing: [1, 1, 1],
    description: 'test confirmed mask'
  });
  const header = nifti.readHeader(niftiBuffer);
  assert.equal(header.dims[1], 5);
  assert.equal(header.dims[2], 5);
  assert.equal(header.dims[3], 5);
  assert.deepEqual(header.affine.slice(0, 3).map(row => row.slice(0, 4)), fixedMniAffine.slice(0, 3),
    'confirmed MNI mask must be written with the fixed MNI160 affine, not the sampling affine');

  console.log('mask-transform OK: native/MNI sampling-affine roundtrip + fixed-header NIfTI.');
})();
