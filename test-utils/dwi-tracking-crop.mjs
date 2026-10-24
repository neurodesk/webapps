import { allocateNifti, createNiftiHeaderFromVolume, decodeNiftiBuffer, readNiftiFrames } from '../packages/components/src/file-io/NiftiUtils.js';
import { cropVolume } from '../packages/components/src/volume/geometry.js';

// A central crop of the geometry reported in #598. All frames and scaled voxel
// values survive; this fixture does not establish support for the full source grid.
export async function cropTrackingDwi(bytes, {
  sourceShape = [128, 128, 69],
  shape = [72, 72, 39],
  frames = 136,
} = {}) {
  const decoded = readNiftiFrames(await decodeNiftiBuffer(bytes));
  if (decoded.frames !== frames || decoded.dims.some((n, axis) => n !== sourceShape[axis])) {
    throw new Error(`Unexpected tracking fixture geometry: ${decoded.dims.join('×')}×${decoded.frames}`);
  }
  if (shape.length !== 3 || shape.some((n, axis) => !Number.isInteger(n) || n < 1 || n > sourceShape[axis])) {
    throw new Error('The tracking crop must fit the source grid.');
  }
  const origin = shape.map((n, axis) => Math.floor((sourceShape[axis] - n) / 2));
  const end = shape.map((n, axis) => origin[axis] + n);
  const affine = decoded.header.affine.map(row => [...row]);
  for (let row = 0; row < 3; row++) {
    affine[row][3] += origin.reduce((sum, value, col) => sum + value * affine[row][col], 0);
  }
  const header = createNiftiHeaderFromVolume({ hdr: {
    dims: [4, ...shape, frames, 1, 1, 1],
    pixDims: decoded.header.pixDims,
    affine,
  } });
  // The sform above describes the translated oblique grid. There is no newly
  // computed quaternion, so do not advertise the writer's identity qform.
  new DataView(header).setInt16(252, 0, true);
  const voxels = sourceShape.reduce((a, b) => a * b, 1);
  const croppedVoxels = shape.reduce((a, b) => a * b, 1);
  const output = allocateNifti(header, Float32Array, croppedVoxels * frames, { dims: [...shape, frames] });
  for (let frame = 0; frame < frames; frame++) {
    const volume = decoded.data.subarray(frame * voxels, (frame + 1) * voxels);
    output.data.set(cropVolume(volume, sourceShape, { origin, end }).data, frame * croppedVoxels);
  }
  return { bytes: new Uint8Array(output.finish()), origin, shape, frames, affine };
}
