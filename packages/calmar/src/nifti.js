import * as nifti from 'nifti-reader-js';
import { affineFromHeader } from './resample.js';

export function decodeVolume(bytes) {
  let buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (nifti.isCompressed(buffer)) buffer = nifti.decompress(buffer);
  if (!nifti.isNIFTI(buffer)) throw new Error('Input must be a NIfTI image.');
  const header = nifti.readHeader(buffer);
  if (header.dims[0] !== 3 && !(header.dims[0] === 4 && header.dims[4] === 1))
    throw new Error('Input must be a single 3D volume.');
  const dims = header.dims.slice(1, 4);
  if (dims.some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error('Invalid NIfTI dimensions.');
  const affine = affineFromHeader(header);
  if (affine.flat().some((value) => !Number.isFinite(value)))
    throw new Error('Invalid NIfTI affine.');
  const readers = {
    2: ['getUint8', 1],
    4: ['getInt16', 2],
    8: ['getInt32', 4],
    16: ['getFloat32', 4],
    64: ['getFloat64', 8],
    256: ['getInt8', 1],
    512: ['getUint16', 2],
    768: ['getUint32', 4],
  };
  const reader = readers[header.datatypeCode];
  if (!reader) throw new Error(`Unsupported NIfTI datatype ${header.datatypeCode}.`);
  const image = nifti.readImage(header, buffer);
  const [method, stride] = reader;
  if (image.byteLength % stride !== 0) throw new Error('Invalid image byte length.');
  const view = new DataView(image);
  const data = Float32Array.from({ length: image.byteLength / stride }, (_, index) =>
    view[method](index * stride, header.littleEndian) * (header.scl_slope || 1) + (header.scl_inter || 0)
  );
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
