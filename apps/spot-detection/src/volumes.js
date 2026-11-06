// The NIfTI files the page shows and downloads, built from (z, y, x) or (y, x) arrays.
import { createNiftiFromVolume } from "@neurodesk/webapp-components/file-io";

// The stack as NIfTI for NiiVue: x fastest as in the TIFF, row 0 at the top. The shared
// writer records millimetres (xyzt_units 10), so the nm voxel sizes are divided by 1e6.
export function niftiFile(image, voxelNm, name) {
  const [nz, ny, nx] = image.shape.length === 3 ? image.shape : [1, ...image.shape];
  const [dz, dy, dx] = voxelNm.map((nm) => nm / 1e6);
  const affine = [[dx, 0, 0, 0], [0, -dy, 0, (ny - 1) * dy], [0, 0, dz, 0], [0, 0, 0, 1]];
  const buffer = createNiftiFromVolume({ hdr: { dims: [3, nx, ny, nz, 1, 1, 1, 1], pixDims: [1, dx, dy, dz, 1, 1, 1, 1], affine }, img: image.data });
  return new File([buffer], name, { type: "application/octet-stream" });
}

// Rings of radius 3 voxels around each spot, in its xy plane: the spot itself stays visible.
export function overlayVolume(shape, spots) {
  const [nz, ny, nx] = shape.length === 3 ? shape : [1, ...shape];
  const data = new Uint8Array(nz * ny * nx);
  for (const spot of spots) {
    const [z, y, x] = spot.length === 3 ? spot : [0, ...spot];
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const r2 = dx * dx + dy * dy;
        if (r2 < 5 || r2 > 10) continue;
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && yy < ny && xx >= 0 && xx < nx) data[(z * ny + yy) * nx + xx] = 1;
      }
    }
  }
  return { data, shape };
}
