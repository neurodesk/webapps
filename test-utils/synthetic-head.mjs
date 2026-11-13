/**
 * An uncompressed NIfTI-1 volume of a head-like phantom: a bright scalp shell, a dark
 * skull, and a brain of grey matter around white matter with dark ventricles. It gives a
 * segmentation model anatomy to label without downloading an example.
 */
export function syntheticHeadNifti({ size = 64, voxelMm = 3 } = {}) {
  const header = new DataView(new ArrayBuffer(352));
  header.setInt32(0, 348, true);
  for (const [index, value] of [3, size, size, size, 1, 1, 1, 1].entries()) header.setInt16(40 + index * 2, value, true);
  header.setInt16(70, 2, true);
  header.setInt16(72, 8, true);
  for (const [index, value] of [1, voxelMm, voxelMm, voxelMm, 1, 1, 1, 1].entries()) header.setFloat32(76 + index * 4, value, true);
  header.setFloat32(108, 352, true);
  header.setFloat32(112, 1, true);
  header.setUint8(123, 2);
  header.setInt16(254, 1, true);
  const origin = -voxelMm * (size - 1) / 2;
  for (let axis = 0; axis < 3; axis++) {
    header.setFloat32(280 + axis * 16 + axis * 4, voxelMm, true);
    header.setFloat32(280 + axis * 16 + 12, origin, true);
  }
  for (const [index, char] of [...'n+1'].entries()) header.setUint8(344 + index, char.charCodeAt(0));
  const voxels = new Uint8Array(size ** 3);
  const centre = (size - 1) / 2;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Radius in millimetres on a head 150 mm wide, 185 mm long and 165 mm tall.
        const radius = Math.hypot((x - centre) * voxelMm / 75, (y - centre) * voxelMm / 92, (z - centre) * voxelMm / 82);
        const ventricle = Math.hypot((Math.abs(x - centre) * voxelMm - 12) / 9, (y - centre) * voxelMm / 30, (z - centre) * voxelMm / 12) < 1;
        let value = 0;
        if (radius < 1) value = 190;
        if (radius < 0.93) value = 25;
        if (radius < 0.86) value = 40;
        if (radius < 0.83) value = 95;
        if (radius < 0.7) value = 150;
        if (ventricle) value = 35;
        voxels[x + size * (y + size * z)] = value;
      }
    }
  }
  const file = new Uint8Array(352 + voxels.length);
  file.set(new Uint8Array(header.buffer));
  file.set(voxels, 352);
  return file;
}
