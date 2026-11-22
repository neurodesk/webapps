import { applyAffine, inverseAffine, selectQuantile } from './volume.js';

export function createQcVolume(volume, surfaces, thickness = 1) {
  if (!Number.isInteger(thickness) || thickness < 0 || thickness > 3) {
    throw new Error('QC overlay thickness must be an integer from 0 to 3.');
  }
  const values = volume.data.slice();
  const low = selectQuantile(values, 0.01);
  const high = selectQuantile(values, 0.99);
  const output = new Int16Array(volume.data.length);
  if (high > low) {
    for (let i = 0; i < output.length; i += 1) {
      const scaled = Math.max(0, Math.min(1, (volume.data[i] - low) / (high - low))) * 3000;
      output[i] = roundEven(scaled);
    }
  }
  const pial = surfaceMask(volume, [surfaces['lh.pial'], surfaces['rh.pial']], thickness);
  const white = surfaceMask(volume, [surfaces['lh.white'], surfaces['rh.white']], thickness);
  for (let i = 0; i < output.length; i += 1) {
    if (pial[i]) output[i] = 3500;
    if (white[i]) output[i] = 4095;
  }
  return writeInt16Nifti(volume, output, 'TopoFit cortical surface QC');
}

function surfaceMask(volume, vertexSets, thickness) {
  const mask = new Uint8Array(volume.data.length);
  const worldToVoxel = inverseAffine(volume.affine);
  for (const vertices of vertexSets) {
    const points = applyAffine(worldToVoxel, vertices);
    for (let i = 0; i < points.length; i += 3) {
      const x = roundEven(points[i]);
      const y = roundEven(points[i + 1]);
      const z = roundEven(points[i + 2]);
      if (x >= 0 && y >= 0 && z >= 0 && x < volume.dims[0] && y < volume.dims[1] && z < volume.dims[2]) {
        mask[x + volume.dims[0] * (y + volume.dims[1] * z)] = 1;
      }
    }
  }
  for (let pass = 0; pass < thickness; pass += 1) {
    const previous = mask.slice();
    for (let z = 0; z < volume.dims[2]; z += 1) {
      for (let y = 0; y < volume.dims[1]; y += 1) {
        for (let x = 0; x < volume.dims[0]; x += 1) {
          const target = x + volume.dims[0] * (y + volume.dims[1] * z);
          if (previous[target]) continue;
          if (
            (x > 0 && previous[target - 1]) ||
            (x + 1 < volume.dims[0] && previous[target + 1]) ||
            (y > 0 && previous[target - volume.dims[0]]) ||
            (y + 1 < volume.dims[1] && previous[target + volume.dims[0]])
          ) mask[target] = 1;
        }
      }
    }
  }
  return mask;
}

export function writeInt16Nifti(volume, data, description) {
  const output = writeNiftiHeader(volume, data.length, 4, 16, description);
  const view = new DataView(output);
  const little = volume.header.littleEndian;
  for (let i = 0; i < data.length; i += 1) view.setInt16(352 + i * 2, data[i], little);
  return output;
}

export function writeUint8Nifti(volume, data, description) {
  const output = writeNiftiHeader(volume, data.length, 2, 8, description);
  new Uint8Array(output, 352).set(data);
  return output;
}

// A NIfTI-1 header: a NIfTI-1 source's header bytes, or the grid read from a NIfTI-2
// source (single precision), with a new data type, unit scaling and the description.
function writeNiftiHeader(volume, length, datatype, bitpix, description) {
  const output = new ArrayBuffer(352 + length * bitpix / 8);
  const bytes = new Uint8Array(output);
  const view = new DataView(output);
  const little = volume.header.littleEndian;
  if (new DataView(volume.source).getInt32(0, little) === 540) writeNifti2Geometry(view, volume, little);
  else bytes.set(new Uint8Array(volume.source, 0, Math.min(348, volume.source.byteLength)));
  view.setInt32(0, 348, little);
  view.setInt16(70, datatype, little);
  view.setInt16(72, bitpix, little);
  view.setFloat32(108, 352, little);
  view.setFloat32(112, 1, little);
  view.setFloat32(116, 0, little);
  bytes.fill(0, 148, 228);
  bytes.set(new TextEncoder().encode(description).slice(0, 79), 148);
  bytes.set([110, 43, 49, 0], 344);
  bytes.fill(0, 348, 352);
  return output;
}

// readVolume's resolved affine of a NIfTI-2 source (in millimetres) as an active NIfTI-1
// sform, with voxel sizes from its columns, so the output decodes to the same grid.
function writeNifti2Geometry(view, volume, little) {
  const { header, affine, dims } = volume;
  if (dims.some((size) => size > 32767)) throw new Error('The image is too large for a NIfTI-1 output.');
  [3, ...dims, 1, 1, 1, 1].forEach((size, index) => view.setInt16(40 + index * 2, size, little));
  const spacing = [0, 1, 2].map((column) => Math.hypot(affine[0][column], affine[1][column], affine[2][column]));
  [1, ...spacing, ...header.pixDims.slice(4)].forEach((size, index) => view.setFloat32(76 + index * 4, size, little));
  view.setUint8(123, 2 | (header.xyzt_units & 56));
  view.setInt16(252, 0, little);
  const code = header.qform_code > 0 && header.sform_code < header.qform_code
    ? header.qform_code
    : Math.max(header.sform_code, 1);
  view.setInt16(254, code > 0 && code <= 32767 ? code : 1, little);
  affine.slice(0, 3).forEach((row, axis) => row.forEach((value, column) => view.setFloat32(280 + (axis * 4 + column) * 4, value, little)));
}

export function roundEven(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}
