import { resolveWorldAffine } from '@neurodesk/topofit';

function affineDiffers(actual, expected) {
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      if (!(Math.abs(actual[row][column] - expected[row][column]) <= 1e-12)) return true;
    }
  }
  return false;
}

function pixDimsDiffer(pixDims, spacing) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!(Math.abs(pixDims[axis + 1] - spacing[axis]) <= 1e-6 * Math.max(1, spacing[axis]))) return true;
  }
  return false;
}

// Re-aligns every loaded NiiVue volume onto TopoFit's millimetre world grid
// without copying voxel arrays. Updating pixDims and xyzt_units before
// setVolumeAffine keeps NiiVue's orthogonal extents and oblique basis in
// millimetres, and marking the volume dirty forces a full GPU texture
// re-orientation when the resolved affine changes permRAS or overlay framing.
export async function alignViewerVolumes(nv, isCurrent = () => true) {
  let aligned = false;
  for (let index = 0; index < nv.volumes.length; index += 1) {
    if (!isCurrent()) return false;
    const volume = nv.volumes[index];
    if (!volume?.hdr) continue;
    const affine = resolveWorldAffine(volume.hdr);
    const spacing = [0, 1, 2].map((column) => Math.hypot(affine[0][column], affine[1][column], affine[2][column]));
    const unit = volume.hdr.xyzt_units & 7;
    if (!affineDiffers(volume.hdr.affine, affine) && !pixDimsDiffer(volume.hdr.pixDims, spacing) && (unit === 0 || unit === 2)) continue;
    volume.hdr.pixDims[1] = spacing[0];
    volume.hdr.pixDims[2] = spacing[1];
    volume.hdr.pixDims[3] = spacing[2];
    volume.hdr.xyzt_units = (volume.hdr.xyzt_units & ~7) | 2;
    volume.originalAffine = affine.map((row) => [...row]);
    volume.isDirty = true;
    await nv.setVolumeAffine(index, affine);
    if (!isCurrent()) return false;
    aligned = true;
  }
  if (aligned) nv.createOnLocationChange?.();
  return true;
}
