// node memory-inputs.mjs CACHE OUTDIR zScale frameScale: tiles the full ds005577 input's stored int16
// voxels (z slices repeated nearest-neighbour, frames repeated with their gradients) into a new NIfTI-1.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
const [cache, outdir, zs, fs] = process.argv.slice(2);
const zScale = Number(zs), frameScale = Number(fs);
const nii = gunzipSync(await readFile(`${cache}/full-image.gz`));
const view = new DataView(nii.buffer, nii.byteOffset);
const dim = i => view.getInt16(40 + 2 * i, true);
const [nx, ny, nz, nf] = [dim(1), dim(2), dim(3), dim(4)];
const datatype = view.getInt16(70, true), bitpix = view.getInt16(72, true), offset = Math.round(view.getFloat32(108, true));
if (datatype !== 4 || bitpix !== 16) throw new Error("expected int16");
const nz2 = Math.round(nz * zScale), frames = nf * frameScale, slice = nx * ny * 2;
const out = Buffer.alloc(offset + slice * nz2 * frames);
nii.copy(out, 0, 0, offset);
const outView = new DataView(out.buffer, out.byteOffset);
outView.setInt16(46, nz2, true);
outView.setInt16(48, frames, true);
for (let f = 0; f < frames; f++) for (let z = 0; z < nz2; z++) {
  const from = offset + ((f % nf) * nz + Math.min(nz - 1, Math.floor(z / zScale))) * slice;
  nii.copy(out, offset + (f * nz2 + z) * slice, from, from + slice);
}
const name = `z${zScale}-f${frameScale}`;
await mkdir(`${outdir}/${name}`, { recursive: true });
await writeFile(`${outdir}/${name}/dwi.nii.gz`, gzipSync(out, { level: 1 }));
const tile = line => Array.from({ length: frameScale }, () => line.trim()).join(" ");
await writeFile(`${outdir}/${name}/dwi.bval`, tile(await readFile(`${cache}/full-bval.bval`, "utf8")) + "\n");
await writeFile(`${outdir}/${name}/dwi.bvec`, (await readFile(`${cache}/full-bvec.bvec`, "utf8")).trim().split("\n").map(tile).join("\n") + "\n");
console.log(JSON.stringify({ name, dims: [nx, ny, nz2], frames, storedBytes: out.length - offset, float32Bytes: 4 * nx * ny * nz2 * frames }));
