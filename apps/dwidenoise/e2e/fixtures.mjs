// A small 4D DWI: one b0 and `weighted` diffusion-weighted volumes. Each volume is a smooth
// field of its own plus deterministic pseudo-noise, so the volumes of a group are linearly
// independent and Patch2Self can fit them.
import { gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";

export function dwiSeries({ nx = 24, ny = 20, nz = 4, weighted = 4 } = {}) {
  const frames = weighted + 1;
  const voxels = nx * ny * nz;
  const data = new Float32Array(voxels * frames);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let t = 0; t < frames; t++) {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const signal = t === 0 ? 400 : 150 + 60 * Math.sin((x + 3 * t) / 5) * Math.cos((y - t) / 4) + 10 * z;
          data[t * voxels + x + nx * (y + ny * z)] = signal + 20 * noise();
        }
      }
    }
  }
  const header = createNiftiHeaderFromVolume({ hdr: {
    dims: [4, nx, ny, nz, frames, 1, 1, 1],
    pixDims: [1, 2, 2, 2, 1, 1, 1, 1],
    affine: [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]],
  } });
  const nifti = createNiftiFromData(data, header, { dims: [nx, ny, nz, frames] });
  const bvals = ["0", ...Array.from({ length: weighted }, () => "1000")].join(" ");
  const axis = (row) => Array.from({ length: frames }, (_, t) => (t > 0 && (t - 1) % 3 === row ? 1 : 0)).join(" ");
  return {
    files: [
      { name: "sub-01_dwi.nii.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(nifti)) },
      { name: "sub-01_dwi.bval", mimeType: "text/plain", buffer: Buffer.from(bvals) },
      { name: "sub-01_dwi.bvec", mimeType: "text/plain", buffer: Buffer.from([axis(0), axis(1), axis(2)].join("\n")) },
    ],
    data,
    voxels,
    frames,
  };
}
