import * as nifti from 'nifti-reader-js';
import { parseNiftiHeader, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';

export function decodeVolume(bytes) {
  let buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (nifti.isCompressed(buffer)) buffer = nifti.decompress(buffer);
  if (!nifti.isNIFTI1(buffer)) throw new Error('Input must be a NIfTI-1 image.');
  const header = parseNiftiHeader(buffer);
  if (header.dims[0] !== 3 && !(header.dims[0] === 4 && header.dims[4] === 1))
    throw new Error('Input must be a single 3D volume.');
  const dims = header.dims.slice(1, 4);
  if (dims.some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error('Invalid NIfTI dimensions.');
  const affine = header.affine.map(row => Array.from(row));
  if (affine.flat().some((value) => !Number.isFinite(value)))
    throw new Error('Invalid NIfTI affine.');
  const { data } = readNiftiImageData(buffer);
  const spacing = header.pixDims.slice(1, 4);
  if (spacing.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid NIfTI spacing.');
  if (
    data.length !== dims.reduce((a, b) => a * b, 1) ||
    data.some((value) => !Number.isFinite(value))
  )
    throw new Error('Invalid image size or non-finite values.');
  return { data, dims, header, spacing, affine };
}

export function assertAtlasGrid(lesion, atlas) {
  if (
    lesion.dims.some((value, axis) => value !== atlas.dims[axis]) ||
    lesion.affine.some((row, axis) =>
      row.some(
        (value, column) =>
          !Number.isFinite(value) || Math.abs(value - atlas.affine[axis][column]) > 1e-3
      )
    )
  ) {
    throw new Error(
      'Lesion must match the selected atlas grid and affine. Register and review the mask before mapping.'
    );
  }
}
