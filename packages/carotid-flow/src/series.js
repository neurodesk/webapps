// Reading a phase-contrast series, shared by the web app and the command line so both hand
// detectCarotids the same numbers. Inputs are File-like: a name and arrayBuffer().
import { decodeNiftiBuffer, extractNiftiHeader, readNiftiFrames, sameVoxelGrid } from '@neurodesk/webapp-components/file-io';
import { splitSeries } from './carotid.js';

/** One stored NIfTI, every frame, checked to be a single slice. */
export async function readVolume(file) {
  const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
  const volume = readNiftiFrames(buffer);
  if (volume.dims[2] !== 1) {
    throw new Error(`${file.name} has ${volume.dims[2]} slices; Carotid Flow reads one gated slice.`);
  }
  return { ...volume, headerBytes: extractNiftiHeader(buffer) };
}

/**
 * The series detectCarotids takes, from `{ combined }` (amplitude frames followed by phase
 * frames) or `{ amplitude, phase }`. Outputs are written on the grid and header of the
 * combined or amplitude file, and named after it.
 */
export async function readSeries(chosen) {
  if (chosen.error) throw new Error(chosen.error);
  let volume;
  let split;
  if (chosen.combined) {
    volume = await readVolume(chosen.combined);
    split = splitSeries(volume.data, volume.dims[0] * volume.dims[1], volume.frames);
  } else {
    volume = await readVolume(chosen.amplitude);
    const phase = await readVolume(chosen.phase);
    const sameSpacing = phase.header.voxelSize.every((size, axis) => Math.abs(size - volume.header.voxelSize[axis]) <= 1e-5);
    if (!sameVoxelGrid(volume.header, phase.header) || !sameSpacing) {
      throw new Error(`${chosen.amplitude.name} and ${chosen.phase.name} are on different voxel grids (size, orientation, origin or spacing).`);
    }
    if (phase.frames !== volume.frames) {
      throw new Error(`${chosen.amplitude.name} has ${volume.frames} frames and ${chosen.phase.name} has ${phase.frames}.`);
    }
    split = { phases: volume.frames, amplitude: volume.data, phase: phase.data };
  }
  return {
    ...split,
    name: (chosen.combined ?? chosen.amplitude).name,
    nx: volume.dims[0],
    ny: volume.dims[1],
    affine: volume.header.affine.map((row) => Array.from(row)),
    voxelSize: volume.header.voxelSize,
    headerBytes: volume.headerBytes,
  };
}
