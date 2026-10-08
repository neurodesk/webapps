// Deterministic axial slab of the pinned body MRI example. The browser test and
// scripts/make_upstream_reference.sh both build their input here, so upstream MuscleMap and the
// app segment byte-identical voxels (BODY_SLAB.sha256 guards that).
import { createHash } from 'node:crypto';
import { createNiftiFromVolume, readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';

export const BODY_SOURCE = {
  name: 'body_mri_s0175.nii.gz',
  url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/560955bf9a1a669bbf2a89709b64f3e64eefe008/examples/musclemap/body-mri/body_mri_s0175.nii.gz',
  sha256: '0f311daa4f19d8b89c1380832332db11d5f32cf406d2b591ba6800e6433eb379',
};

export const BODY_SLAB = {
  name: 'body_mri_s0175_slab.nii',
  firstSlice: 30,
  slices: 5,
  dims: [320, 240, 5],
  sha256: 'be7ee281ebbd5de796afbc33b97752d37036fa943b65fa348685780888b13573',
};

export async function cutBodySlab(sourceBytes, { verify = true } = {}) {
  if (createHash('sha256').update(sourceBytes).digest('hex') !== BODY_SOURCE.sha256) {
    throw new Error(`${BODY_SOURCE.name} failed SHA-256 verification`);
  }
  const source = await readNifti(sourceBytes);
  const [nx, ny] = source.dims;
  const sliceVoxels = nx * ny;
  const from = BODY_SLAB.firstSlice * sliceVoxels;
  const img = source.data.slice(from, from + BODY_SLAB.slices * sliceVoxels);
  const affine = source.header.affine.map(row => [...row]);
  for (let row = 0; row < 3; row++) {
    affine[row][3] += affine[row][2] * BODY_SLAB.firstSlice;
  }
  const bytes = Buffer.from(createNiftiFromVolume({ img, hdr: { dims: [nx, ny, BODY_SLAB.slices], pixDims: source.header.voxelSize, affine } }));
  // The sform carries the geometry; the header writer leaves the quaternion empty, so disable the qform.
  bytes.writeInt16LE(0, 252);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (verify && sha256 !== BODY_SLAB.sha256) throw new Error(`Body slab is ${sha256}, the upstream reference was made from ${BODY_SLAB.sha256}`);
  return bytes;
}
