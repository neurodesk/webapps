// A small biased test series: a block of tissue whose intensity a smooth ramp multiplies from
// 0.6 to 1.4 across x, in a zero background, as a receive coil would shade it.
import { gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";

export function biasedSeries({ nx = 40, ny = 32, nz = 24, frames = 3, bvals = [0, 1000, 0] } = {}) {
  const voxels = nx * ny * nz;
  const data = new Float32Array(voxels * frames);
  const tissue = [];
  for (let z = 4; z < nz - 4; z++) {
    for (let y = 4; y < ny - 4; y++) {
      for (let x = 4; x < nx - 4; x++) tissue.push(x + nx * (y + ny * z));
    }
  }
  for (let f = 0; f < frames; f++) {
    const level = bvals[f] > 50 ? 40 : 100;
    for (const i of tissue) {
      const x = i % nx;
      data[f * voxels + i] = level * (0.6 + (0.8 * x) / (nx - 1));
    }
  }
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [4, nx, ny, nz, frames, 1, 1, 1], pixDims: [1, 4, 4, 4, 1, 1, 1, 1] } });
  const nifti = createNiftiFromData(data, header, { dims: [nx, ny, nz, frames] });
  return {
    files: [
      { name: "sub-01_dwi.nii.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(nifti)) },
      { name: "sub-01_dwi.bval", mimeType: "text/plain", buffer: Buffer.from(bvals.join(" ")) },
      { name: "sub-01_dwi.bvec", mimeType: "text/plain", buffer: Buffer.from("0 1 0\n0 0 0\n0 0 0") },
    ],
    data,
    voxels,
    tissue,
  };
}

/** The tissue block of `biasedSeries` with the same grid, as a gzipped NIfTI brain mask. */
export function tissueMask({ nx = 40, ny = 32, nz = 24 } = {}) {
  const mask = new Uint8Array(nx * ny * nz);
  for (const i of biasedSeries({ nx, ny, nz, frames: 1, bvals: [0] }).tissue) mask[i] = 1;
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, nx, ny, nz, 1, 1, 1, 1], pixDims: [1, 4, 4, 4, 1, 1, 1, 1] } });
  const nifti = createNiftiFromData(mask, header, { dims: [nx, ny, nz] });
  return { name: "sub-01_desc-brain_mask.nii.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(nifti)) };
}

/** The full 16³ ramp phantom, on the grid dcm2niix writes for dicomSeries({ slices: 16 }). */
export function dicomMask() {
  const header = createNiftiHeaderFromVolume({ hdr: {
    dims: [3, 16, 16, 16, 1, 1, 1, 1],
    pixDims: [1, 1, 1, 1, 1, 1, 1, 1],
    affine: [[-1, 0, 0, 0], [0, 1, 0, -15], [0, 0, 1, 0], [0, 0, 0, 1]],
  } });
  const nifti = createNiftiFromData(new Uint8Array(16 ** 3).fill(1), header, { dims: [16, 16, 16] });
  return { name: "dicom-mask.nii.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(nifti)) };
}

/** Coefficient of variation of the first volume over the tissue voxels. */
export function tissueVariation(data, tissue) {
  const values = tissue.map((i) => data[i]);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return sd / mean;
}
