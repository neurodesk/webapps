// Runs src/dwidenoise.wasm on a NIfTI-1 series, times the Gram and apply passes, and compares
// the result with a reference (the dataset's dwidenoise/validation oracle).
//
//   node scripts/check-slab.mjs INPUT.nii.gz INPUT.bval REFERENCE.nii.gz

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadDwidenoise } from "../src/wasm.js";

const [input, bval, reference] = process.argv.slice(2);
if (!reference) {
  console.error("usage: node scripts/check-slab.mjs INPUT.nii.gz INPUT.bval REFERENCE.nii.gz");
  process.exit(2);
}

function readNifti(path, into) {
  const bytes = gunzipSync(readFileSync(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== 348) throw new Error(`${path} is not little-endian NIfTI-1`);
  const dims = [1, 2, 3, 4].map((d) => Math.max(1, view.getInt16(40 + 2 * d, true)));
  const datatype = view.getInt16(70, true);
  const offset = Math.max(352, view.getFloat32(108, true));
  const slope = view.getFloat32(112, true);
  const inter = view.getFloat32(116, true);
  const count = dims.reduce((a, b) => a * b, 1);
  const out = into ?? new Float32Array(count);
  const read = { 4: (i) => view.getInt16(offset + 2 * i, true), 16: (i) => view.getFloat32(offset + 4 * i, true) }[datatype];
  if (!read) throw new Error(`unsupported datatype ${datatype}`);
  const scale = slope !== 0 && Number.isFinite(slope) && (slope !== 1 || inter !== 0);
  for (let i = 0; i < count; i++) out[i] = scale ? read(i) * slope + inter : read(i);
  return { dims, data: out };
}

const p2s = await loadDwidenoise(readFileSync(new URL("../src/dwidenoise.wasm", import.meta.url)));
const bvals = readFileSync(bval, "utf8").trim().split(/\s+/).map(Number);
const header = readNifti(input);
const [nx, ny, nz, nt] = header.dims;
const nvox = nx * ny * nz;
const buffer = p2s.allocate(nvox * nt);
buffer.view().set(header.data);

let gramSeconds = 0;
let applySeconds = 0;
for (const group of p2s.fittedGroups(bvals)) {
  const gram = new Float64Array(p2s.gramLength(group.length));
  let t = performance.now();
  p2s.accumulate(buffer, nvox, group, gram);
  gramSeconds += (performance.now() - t) / 1000;
  const coefficients = p2s.solve(gram, group);
  t = performance.now();
  p2s.apply(buffer, nvox, group, coefficients);
  applySeconds += (performance.now() - t) / 1000;
}

const ours = buffer.view();
const { data: want } = readNifti(reference);
let worst = 0;
let beyond = 0;
for (let i = 0; i < want.length; i++) {
  const diff = Math.abs(ours[i] - want[i]);
  worst = Math.max(worst, diff);
  const u = Math.fround(Math.abs(want[i]) * (1 + 2 ** -23)) - Math.abs(want[i]);
  if (diff > Math.max(u, 0)) beyond += 1;
}
buffer.free();

console.log(
  JSON.stringify({
    dims: header.dims,
    gram_seconds: +gramSeconds.toFixed(3),
    apply_seconds: +applySeconds.toFixed(3),
    gram_voxels_per_second: Math.round(nvox / gramSeconds),
    apply_voxels_per_second: Math.round(nvox / applySeconds),
    max_abs_diff: worst,
    values_beyond_one_f32_ulp: beyond,
  }),
);
if (beyond > 0) process.exit(1);
