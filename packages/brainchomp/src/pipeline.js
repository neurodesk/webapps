// Shared DOM-free rodent brain extraction preprocessing and masking pipeline.
// Used by both the Brainchomp web worker and the @neurodesk/brainchomp Node CLI.
import {
  createFloat32Nifti,
  createNiftiHeaderFromVolume,
  createUint8Nifti,
  parseNiftiVolume,
} from '@neurodesk/webapp-components/file-io/nifti';
import { applyWorldRemap, INPUT_WORLD_REMAP } from './orient.js';

export const UPSTREAM_REVISION = '51a90203f497cea6b3cf01e34bd113f8c2a6292c';
export const BRAINCHOMP_LIB_REVISION = '95c8b9bd186f0fcffabb797e1fe770c26659750e';
export const DEFAULT_OPENING_RADIUS = 4;
export const MAX_OPENING_RADIUS = 64;

const SPATIAL_UNIT_MM = { 1: 1000, 2: 1, 3: 0.001 };

function affineDeterminant3(affine) {
  const [[a, b, c], [d, e, f], [g, h, i]] = affine;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function voxelVolumeMm3(affine) {
  return Math.abs(affineDeterminant3(affine));
}

export function readNifti3d(bytes, { decompress, maxVoxels = 128 * 1024 * 1024 } = {}) {
  const parsed = parseNiftiVolume(bytes, { decompress, OutputCtor: Float32Array });
  const header = parsed.header;
  if (header.dims.slice(4, header.dims[0] + 1).some((d) => d > 1)) {
    throw new Error('Brainchomp requires a single 3D NIfTI volume (got 4D or higher).');
  }
  const dims = [parsed.dims[0], parsed.dims[1], parsed.dims[2]];
  const totalVoxels = dims[0] * dims[1] * dims[2];
  if (dims.some((d) => !Number.isInteger(d) || d < 2) || totalVoxels > maxVoxels) {
    throw new Error(`Unsupported NIfTI dimensions: ${dims.join('x')}.`);
  }
  for (let i = 0; i < parsed.imageData.length; i += 1) {
    if (!Number.isFinite(parsed.imageData[i])) {
      throw new Error('The image contains non-finite intensities. Clean NaN/Infinity values first.');
    }
  }
  const scale = SPATIAL_UNIT_MM[header.xyztUnits & 7] ?? 1;
  const affine = header.affine.map((row, r) =>
    Array.from(row, (value) => (r < 3 ? value * scale : value)),
  );
  if (affine.flat().some((value) => !Number.isFinite(value)) || Math.abs(affineDeterminant3(affine)) < 1e-12) {
    throw new Error('Invalid or singular NIfTI affine.');
  }
  return { data: parsed.imageData, dims, affine };
}

export function writeNifti3d({ data, dims, affine }, description = 'Brainchomp output') {
  const pixDims = [
    1,
    Math.hypot(affine[0][0], affine[1][0], affine[2][0]),
    Math.hypot(affine[0][1], affine[1][1], affine[2][1]),
    Math.hypot(affine[0][2], affine[1][2], affine[2][2]),
    1,
    1,
    1,
    1,
  ];
  const headerBuffer = createNiftiHeaderFromVolume({
    dims: [3, dims[0], dims[1], dims[2], 1, 1, 1, 1],
    pixDims,
    hdr: { affine, scl_slope: 1, scl_inter: 0, sform_code: 1 },
  });
  const view = new DataView(headerBuffer);
  // Keep sform-only geometry in millimetres, matching the Brainchomp worker contract.
  view.setInt16(252, 0, true);
  view.setInt16(254, 1, true);
  view.setUint8(123, 2);
  new Uint8Array(headerBuffer, 148, 80).fill(0);
  new Uint8Array(headerBuffer, 148, 80).set(new TextEncoder().encode(description).slice(0, 79));
  if (data instanceof Uint8Array) {
    return createUint8Nifti(data, headerBuffer, dims);
  }
  return createFloat32Nifti(data, headerBuffer, dims);
}

export function validateOptions({
  opening = DEFAULT_OPENING_RADIUS,
  fillHoles = true,
} = {}) {
  if (!Number.isInteger(opening) || opening < 0 || opening > MAX_OPENING_RADIUS) {
    throw new Error(`opening must be an integer from 0 to ${MAX_OPENING_RADIUS}, got ${opening}`);
  }
  if (typeof fillHoles !== 'boolean') {
    throw new Error(`fillHoles must be a boolean, got ${String(fillHoles)}`);
  }
  return { opening, fillHoles };
}

/**
 * Prepare the temporary remapped NIfTI buffer expected by brainchomp-lib.
 */
export function prepareModelInput(volume) {
  const remappedAffine = applyWorldRemap(volume.affine, INPUT_WORLD_REMAP);
  return writeNifti3d(
    { data: volume.data, dims: volume.dims, affine: remappedAffine },
    'Brainchomp model input',
  );
}

/**
 * Apply the predicted mask back onto the original input volume and affine.
 */
export function applyBrainMask(volume, maskVolume) {
  const nvox = volume.data.length;
  if (maskVolume.data.length < nvox) {
    throw new Error(`The returned mask has ${maskVolume.data.length} voxels; expected ${nvox}.`);
  }
  const maskData = new Uint8Array(nvox);
  const brainData = new Float32Array(nvox);
  let maskVoxels = 0;
  for (let i = 0; i < nvox; i += 1) {
    if (maskVolume.data[i] > 0) {
      maskData[i] = 1;
      brainData[i] = volume.data[i];
      maskVoxels += 1;
    }
  }
  const brain = writeNifti3d(
    { data: brainData, dims: volume.dims, affine: volume.affine },
    'Brainchomp skull-stripped brain',
  );
  const mask = writeNifti3d(
    { data: maskData, dims: volume.dims, affine: volume.affine },
    'Brainchomp brain mask',
  );
  return { brain, mask, maskVoxels };
}
