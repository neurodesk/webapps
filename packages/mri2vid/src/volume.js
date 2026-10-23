// Canonical in-memory volume used by the whole pipeline.
//
// Layout matches numpy C-order of shape [d0, d1, d2] with the LAST axis fastest
// and interleaved channels innermost:
//
//   index(d0, d1, d2, ch) = ((i0 * d1 + i1) * d2 + i2) * channels + ch
//
// For a DICOM series this is [rows, cols, slices] exactly as the reference builds
// it (np.stack(frames, axis=-1)), so the orientation reslice ops mirror numpy 1:1.
// For NIfTI/MGZ this is the stored [i, j, k].
//
// Grayscale volumes store real (rescaled) values in a Float32Array. Color volumes
// store 8-bit RGB in a Uint8Array with channels === 3.

export const ORIENTATIONS = [
  'sagittal',
  'coronal',
  'axial',
  'sagittal_flipped',
  'coronal_flipped',
  'axial_flipped',
];

export function makeVolume({ dims, channels = 1, data, affine = null, photometric = 'MONOCHROME2', meta = {} }) {
  if (!Array.isArray(dims) || dims.length !== 3) {
    throw new Error('Volume dims must be [d0, d1, d2]');
  }
  const [d0, d1, d2] = dims;
  const expected = d0 * d1 * d2 * channels;
  if (data.length !== expected) {
    throw new Error(`Volume data length ${data.length} does not match dims ${dims} x ${channels} channels (${expected})`);
  }
  return {
    dims: [d0, d1, d2],
    channels,
    data,
    affine,
    photometric,
    meta,
    isColor: channels === 3,
  };
}

// Flat index for a voxel/channel in the layout above.
export function voxelIndex(vol, i0, i1, i2, ch = 0) {
  const [d1, d2] = [vol.dims[1], vol.dims[2]];
  return ((i0 * d1 + i1) * d2 + i2) * vol.channels + ch;
}
