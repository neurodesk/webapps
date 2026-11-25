// The NIfTI files the page shows and downloads, built from (z, y, x) or (y, x) arrays.
import { createNiftiFromVolume } from "@neurodesk/webapp-components/file-io";

const QUATERN = 256;
const QOFFSET = 268;

// Build a NIfTI-1 ArrayBuffer whose qform and sform agree (y flipped so row 0 is at the top).
export function niftiBuffer(image, voxelNm) {
  const [nz, ny, nx] = image.shape.length === 3 ? image.shape : [1, ...image.shape];
  const [dz, dy, dx] = voxelNm.map((nm) => {
    const mm = nm / 1e6;
    const f32 = Math.fround(mm);
    if (!Number.isFinite(f32) || !(f32 > 0)) {
      throw new Error(`Voxel size ${nm} nm (${mm} mm) is not representable as a positive finite float32 in NIfTI-1.`);
    }
    return mm;
  });
  const yOffset = (ny - 1) * dy;
  if (!Number.isFinite(Math.fround(yOffset))) {
    throw new Error(`NIfTI-1 y-offset (${yOffset} mm) overflows float32 for height ${ny} and spacing ${dy} mm.`);
  }
  const affine = [[dx, 0, 0, 0], [0, -dy, 0, yOffset], [0, 0, dz, 0], [0, 0, 0, 1]];
  const buffer = createNiftiFromVolume({ hdr: { dims: [3, nx, ny, nz, 1, 1, 1, 1], pixDims: [-1, dx, dy, dz, 1, 1, 1, 1], affine }, img: image.data });
  const view = new DataView(buffer);
  view.setFloat32(QUATERN, 1, true);
  view.setFloat32(QUATERN + 4, 0, true);
  view.setFloat32(QUATERN + 8, 0, true);
  view.setFloat32(QOFFSET, 0, true);
  view.setFloat32(QOFFSET + 4, yOffset, true);
  view.setFloat32(QOFFSET + 8, 0, true);
  return buffer;
}

// The stack as NIfTI for NiiVue: x fastest as in the TIFF, row 0 at the top. The shared
// writer records millimetres (xyzt_units 10), so the nm voxel sizes are divided by 1e6.
export function niftiFile(image, voxelNm, name) {
  return new File([niftiBuffer(image, voxelNm)], name, { type: "application/octet-stream" });
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
