// Shared DOM-free rodent brain extraction preprocessing and masking pipeline.
// Used by both the Brainchomp web worker and the @neurodesk/brainchomp Node CLI.
import {
  affineDeterminant3,
  readNiftiVolume,
  readNiftiVolumeAsync,
  writeNiftiVolume,
} from '@neurodesk/webapp-components/file-io/nifti-volume';
import { applyWorldRemap, INPUT_WORLD_REMAP } from './orient.js';

export const UPSTREAM_REVISION = '51a90203f497cea6b3cf01e34bd113f8c2a6292c';
export const BRAINCHOMP_LIB_REVISION = '95c8b9bd186f0fcffabb797e1fe770c26659750e';
export const DEFAULT_OPENING_RADIUS = 4;
export const MAX_OPENING_RADIUS = 64;

export function voxelVolumeMm3(affine) {
  return Math.abs(affineDeterminant3(affine));
}

export function readNifti3d(bytes, options = {}) {
  return readNiftiVolume(bytes, options);
}

export function readNifti3dAsync(bytes, options = {}) {
  return readNiftiVolumeAsync(bytes, options);
}

export function writeNifti3d(volume, description = 'Brainchomp output') {
  return writeNiftiVolume(volume, description);
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
 * Prepare the temporary remapped NIfTI-1 buffer expected by brainchomp-lib.
 */
export function prepareModelInput(volume) {
  const remappedAffine = applyWorldRemap(volume.affine, INPUT_WORLD_REMAP);
  return writeNiftiVolume(
    { data: volume.data, dims: volume.dims, affine: remappedAffine, version: 1 },
    'Brainchomp model input',
  );
}

/**
 * Apply the predicted mask back onto the original input volume, preserving
 * both qform and sform transforms (and NIfTI-2 when applicable) verbatim.
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
  const brain = writeNiftiVolume(
    {
      data: brainData,
      dims: volume.dims,
      affine: volume.affine,
      transforms: volume.transforms ?? null,
      version: volume.version ?? null,
    },
    'Brainchomp skull-stripped brain',
  );
  const mask = writeNiftiVolume(
    {
      data: maskData,
      dims: volume.dims,
      affine: volume.affine,
      transforms: volume.transforms ?? null,
      version: volume.version ?? null,
    },
    'Brainchomp brain mask',
  );
  return { brain, mask, maskVoxels };
}
