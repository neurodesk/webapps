import { applyAffine, inverseAffine } from './volume.js';

export function createQcVolume(volume, surfaces, thickness = 1) {
  if (!Number.isInteger(thickness) || thickness < 0 || thickness > 3) {
    throw new Error('QC overlay thickness must be an integer from 0 to 3.');
  }
  const sorted = volume.data.slice();
  sorted.sort();
  const low = percentile(sorted, 0.01);
  const high = percentile(sorted, 0.99);
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
  return writeInt16Nifti(volume, output, 'RESEARCH ONLY - NOT MOTION-CLEARED - NOT FOR PRESCRIPTION');
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

function writeInt16Nifti(volume, data, description) {
  const output = new ArrayBuffer(352 + data.length * 2);
  const bytes = new Uint8Array(output);
  bytes.set(new Uint8Array(volume.source, 0, Math.min(348, volume.source.byteLength)));
  const view = new DataView(output);
  const little = volume.header.littleEndian;
  view.setInt32(0, 348, little);
  view.setInt16(70, 4, little);
  view.setInt16(72, 16, little);
  view.setFloat32(108, 352, little);
  view.setFloat32(112, 1, little);
  view.setFloat32(116, 0, little);
  bytes.fill(0, 148, 228);
  bytes.set(new TextEncoder().encode(description).slice(0, 79), 148);
  bytes.set([110, 43, 49, 0], 344);
  bytes.fill(0, 348, 352);
  for (let i = 0; i < data.length; i += 1) view.setInt16(352 + i * 2, data[i], little);
  return output;
}

function percentile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[Math.min(sorted.length - 1, lower + 1)] - sorted[lower]);
}

function roundEven(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}
