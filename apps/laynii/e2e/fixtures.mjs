import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
export const primaryExample = examples[0];
export const primaryRimFile = primaryExample.files.find((file) => file.role === "image");
export const primarySignalFile = primaryExample.files.find((file) => file.role === "signal");
export const motorExample = examples[1];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const inflate = (bytes) => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
export const niftiFile = (name, buffer) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(buffer) });

export function makeNifti3D({
  dims = [16, 16, 16],
  pixdim = [0.5, 0.5, 0.5],
  datatype = 4,
  sclSlope = 1.0,
  sclInter = 0.0,
  offset = [0, 0, 0],
  fill,
}) {
  const [nx, ny, nz] = dims;
  const nvox = nx * ny * nz;
  const bpe = datatype === 4 ? 2 : 4;
  const voxOffset = 352;
  const buf = new Uint8Array(voxOffset + nvox * bpe);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, nx, true);
  dv.setInt16(44, ny, true);
  dv.setInt16(46, nz, true);
  dv.setInt16(48, 1, true);
  dv.setInt16(70, datatype, true);
  dv.setInt16(72, bpe * 8, true);
  dv.setFloat32(76, 1.0, true);
  dv.setFloat32(80, pixdim[0], true);
  dv.setFloat32(84, pixdim[1], true);
  dv.setFloat32(88, pixdim[2], true);
  dv.setFloat32(108, voxOffset, true);
  dv.setFloat32(112, sclSlope, true);
  dv.setFloat32(116, sclInter, true);
  dv.setInt16(252, 1, true);
  dv.setInt16(254, 1, true);
  dv.setFloat32(268, offset[0], true);
  dv.setFloat32(272, offset[1], true);
  dv.setFloat32(276, offset[2], true);
  dv.setFloat32(280, pixdim[0], true);
  dv.setFloat32(292, offset[0], true);
  dv.setFloat32(300, pixdim[1], true);
  dv.setFloat32(308, offset[1], true);
  dv.setFloat32(320, pixdim[2], true);
  dv.setFloat32(324, offset[2], true);
  buf.set([0x6e, 0x2b, 0x31, 0x00], 344);
  const arr = datatype === 4
    ? new Int16Array(buf.buffer, voxOffset, nvox)
    : new Float32Array(buf.buffer, voxOffset, nvox);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        arr[x + y * nx + z * nx * ny] = fill(x, y, z);
      }
    }
  }
  return buf;
}

export function makeCorticalSlabRim(dims = [16, 16, 16], extra = {}) {
  return makeNifti3D({
    dims,
    datatype: 4,
    ...extra,
    fill: (x, y, z) => {
      if (y < 2 || y >= dims[1] - 2 || z < 2 || z >= dims[2] - 2) return 0;
      if (x === 3) return 2;
      if (x >= 4 && x <= 11) return 3;
      if (x === 12) return 1;
      return 0;
    },
  });
}

export function makeDepthGradientSignal(dims = [16, 16, 16], extra = {}) {
  return makeNifti3D({ dims, datatype: 16, ...extra, fill: (x) => x * 10.0 });
}

export function makeInvalidRim(dims = [12, 12, 12]) {
  return makeNifti3D({ dims, datatype: 4, fill: (x) => x + 10 });
}

export function makeOversizedHeaderNifti() {
  const buf = new Uint8Array(352 + 8);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, 300, true);
  dv.setInt16(44, 300, true);
  dv.setInt16(46, 100, true);
  dv.setInt16(48, 1, true);
  dv.setInt16(70, 4, true);
  dv.setInt16(72, 16, true);
  dv.setFloat32(80, 0.2, true);
  dv.setFloat32(84, 0.2, true);
  dv.setFloat32(88, 0.2, true);
  dv.setFloat32(108, 352, true);
  buf.set([0x6e, 0x2b, 0x31, 0x00], 344);
  return buf;
}
