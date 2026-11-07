// NIfTI files that only feed NiiVue; downloads are TIFF and OME-Zarr. NIfTI spacing is in
// millimetres, so micrometre pixel sizes are divided by 1000; an image without a pixel size is
// shown with 1 mm pixels. Row 0 of the image is drawn at the top.
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";

/** NIfTI spacing (mm) for a pixel size in micrometres, x, y and z. */
export function displaySpacing(pixelSize, dims) {
  const x = pixelSize?.x;
  const y = pixelSize?.y ?? x;
  if (!(x && y)) return [1, 1, 1];
  const z = dims > 2 ? (pixelSize?.z ?? x) : x;
  return [x / 1000, y / 1000, z / 1000];
}

/** The 1st and 99.5th percentiles of up to 100 000 evenly strided nonzero samples. */
export function displayWindow(data) {
  const step = Math.max(1, Math.floor(data.length / 100000));
  const sample = [];
  for (let i = 0; i < data.length; i += step) if (data[i] !== 0 && Number.isFinite(data[i])) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  if (!sample.length) return [0, 1];
  const low = sample[Math.floor(0.01 * (sample.length - 1))];
  const high = sample[Math.floor(0.995 * (sample.length - 1))];
  return high > low ? [low, high] : [sample[0], sample[0] + 1];
}

/** A 2D image or 3D stack (`shape` [nx, ny(, nz)]) as a NIfTI File for NiiVue. */
export function displayNifti(name, data, { shape, spacing }) {
  const [nx, ny, nz = 1] = shape;
  const [sx, sy, sz] = spacing;
  const affine = [
    [sx, 0, 0, 0],
    [0, -sy, 0, (ny - 1) * sy],
    [0, 0, sz, 0],
    [0, 0, 0, 1],
  ];
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, nx, ny, nz, 1, 1, 1, 1], pixDims: [1, sx, sy, sz, 1, 1, 1, 1], affine } });
  const [calMin, calMax] = displayWindow(data);
  const buffer = createNiftiFromData(data, header, { dims: [nx, ny, nz], preserveScaling: true, calMin, calMax, clampCalMax: false });
  return new File([buffer], name, { type: "application/octet-stream" });
}
