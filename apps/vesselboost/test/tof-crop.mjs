// Deterministic sub-volume of the pinned Lausanne TOF example, around the circle of Willis.
// The browser test and scripts/make_upstream_reference.sh both build their input here, so the
// upstream reference mask and the app see byte-identical voxels (TOF_CROP.sha256 guards that).
import { createHash } from 'node:crypto';
import { createNiftiFromVolume, readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';

export const TOF_SOURCE = {
  name: 'sub-000_ses-20110101_angio.nii.gz',
  url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/0a35af062d07f36ff2935f8c1454e1ca2f80da86/examples/vesselboost/lausanne-tof/sub-000_ses-20110101_angio.nii.gz',
  sha256: '8e1e772825aafbdf898e0c06e9482640098d9722514b59566957bc3ff22cc2b2',
};

export const TOF_CROP = {
  name: 'lausanne-tof-crop-192x192x64.nii',
  start: [80, 112, 36],
  dims: [192, 192, 64],
  sha256: '80f24eb18924017208f7a5e9a50786428d8c98930cf0a3b85d6d628005aa5fd5',
};

export async function cropTof(sourceBytes) {
  if (createHash('sha256').update(sourceBytes).digest('hex') !== TOF_SOURCE.sha256) {
    throw new Error(`${TOF_SOURCE.name} failed SHA-256 verification`);
  }
  const source = await readNifti(sourceBytes);
  const [nx, ny] = source.dims;
  const [x0, y0, z0] = TOF_CROP.start;
  const [cx, cy, cz] = TOF_CROP.dims;
  const img = new Float32Array(cx * cy * cz);
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      const from = x0 + nx * (y + y0 + ny * (z + z0));
      img.set(source.data.subarray(from, from + cx), cx * (y + cy * z));
    }
  }
  const affine = source.header.affine.map(row => [...row]);
  for (let row = 0; row < 3; row++) {
    affine[row][3] += affine[row][0] * x0 + affine[row][1] * y0 + affine[row][2] * z0;
  }
  const bytes = Buffer.from(createNiftiFromVolume({ img, hdr: { dims: TOF_CROP.dims, pixDims: source.header.voxelSize, affine } }));
  // The sform carries the geometry; the header writer leaves the quaternion empty, so disable the qform.
  bytes.writeInt16LE(0, 252);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== TOF_CROP.sha256) throw new Error(`TOF crop is ${sha256}, the upstream reference was made from ${TOF_CROP.sha256}`);
  return bytes;
}
