import { Niimath } from '@neurodesk/runtime-support/niimath';
import { axisAlignedVoxelSpacing, readVolume } from '@neurodesk/topofit';

export async function conformImage(buffer) {
  const volume = readVolume(buffer);
  const spacing = axisAlignedVoxelSpacing(volume.affine);
  const niimath = new Niimath();
  await niimath.init();
  const blob = await niimath
    .image(new File([buffer], 'input.nii.gz', { type: 'application/gzip' }))
    .ras()
    .resize(spacing[0], spacing[1], spacing[2], 3)
    .run('conformed.nii');
  return blob.arrayBuffer();
}
