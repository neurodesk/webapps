// One case per process: node estimator-limits.mjs CACHE zScale frameScale [pinned|all|frac:F]
// (CACHE from `benchmark.mjs --data full --provision`). Measured the limits in src/limits.js (#452).
// Builds a synthetic series from the full ds005577 input (z slices and frames repeated) and runs
// the GP estimator's init and one prediction in hmc.wasm, reporting success and linear-memory size.
import { readFile } from "node:fs/promises";
import { decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { readSeries } from "../src/pipeline.js";
import { loadHmc } from "../src/wasm.js";

const [cache, zs, fs, maskMode = "pinned"] = process.argv.slice(2);
const zScale = Number(zs), frameScale = Number(fs);
let memory;
const original = WebAssembly.instantiate;
WebAssembly.instantiate = async (...args) => { const r = await original(...args); memory = (r.instance ?? r).exports.memory; return r; };
const hmc = await loadHmc(readFile(new URL("../src/hmc.wasm", import.meta.url)));
const base = await readSeries(await readFile(`${cache}/full-image.gz`));
const maskIn = readNiftiFrames(await decodeNiftiBuffer(await readFile(`${cache}/full-mask.gz`))).data;
const [nx, ny, nz] = base.dims;
const nz2 = Math.round(nz * zScale), slice = nx * ny, vox = slice * nz2, frames = base.frames * frameScale;
const src = z => Math.min(nz - 1, Math.floor(z / zScale));
const data = new Float32Array(vox * frames);
for (let f = 0; f < frames; f++) for (let z = 0; z < nz2; z++) {
  const from = (f % base.frames) * nx * ny * nz + src(z) * slice;
  data.set(base.data.subarray(from, from + slice), f * vox + z * slice);
}
const mask = new Uint8Array(vox);
for (let z = 0; z < nz2; z++) for (let i = 0; i < slice; i++) mask[z * slice + i] = maskMode === "all" ? 1 : maskMode.startsWith("frac:") ? (z * slice + i < Number(maskMode.slice(5)) * vox ? 1 : 0) : maskIn[src(z) * slice + i] ? 1 : 0;
const bvals0 = (await readFile(`${cache}/full-bval.bval`, "utf8")).trim().split(/\s+/).map(Number);
const bvecs0 = (await readFile(`${cache}/full-bvec.bvec`, "utf8")).trim().split("\n").map(r => r.trim().split(/\s+/).map(Number));
const tile = a => Array.from({ length: frameScale }, () => a).flat();
const bvals = tile(bvals0), bvecs = bvecs0.map(tile);
const out = { zScale, frameScale, maskMode, dims: [nx, ny, nz2], frames, dwi: bvals.filter(b => b > 50).length, decodedFloat32Bytes: data.byteLength, maskVoxels: mask.reduce((a, b) => a + b, 0) };
const t = performance.now();
try {
  const model = hmc.createNifreezeModel({ data, dims: [nx, ny, nz2], frames, bvals, bvecs, mask, model: "gp" });
  out.effectiveMaskVoxels = model.mask.reduce((a, b) => a + b, 0);
  out.afterInitHeap = memory.buffer.byteLength;
  model.predict(0);
  out.afterPredictHeap = memory.buffer.byteLength;
  model.release();
  out.ok = true;
} catch (e) { out.ok = false; out.error = String(e.message ?? e).slice(0, 200); out.heap = memory.buffer.byteLength; }
out.seconds = (performance.now() - t) / 1000;
console.log(JSON.stringify(out));
