// One case per process: node gp-quadratic.mjs DWI. Measured the GP fit's (DWI − 1)² term in
// src/limits.js (#452): a 2 × 2 × 2 grid of random voxels, one b0 and DWI random directions, so the
// fit's n × n float64 matrices, not the series or the mask, fill hmc.wasm's heap.
import { readFile } from "node:fs/promises";
import { loadHmc } from "../src/wasm.js";
import { estimatorBytes } from "../src/limits.js";

const dwiVolumes = Number(process.argv[2]);
let memory;
const original = WebAssembly.instantiate;
WebAssembly.instantiate = async (...args) => { const r = await original(...args); memory = (r.instance ?? r).exports.memory; return r; };
const hmc = await loadHmc(readFile(new URL("../src/hmc.wasm", import.meta.url)));
const dims = [2, 2, 2], voxels = 8, frames = dwiVolumes + 1;
let state = 1234;
const random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
const data = Float32Array.from({ length: voxels * frames }, () => 500 + 500 * random());
const bvals = Array.from({ length: frames }, (_, i) => i ? 1000 : 0);
const directions = bvals.map(() => { const v = [random() - 0.5, random() - 0.5, random() - 0.5]; const n = Math.hypot(...v); return v.map(x => x / n); });
const bvecs = [0, 1, 2].map(axis => directions.map((v, i) => i ? v[axis] : 0));
const out = { dwiVolumes, estimate: estimatorBytes({ voxels, frames, dwiVolumes, maskVoxels: voxels }).fit };
const t = performance.now();
try {
  const model = hmc.createNifreezeModel({ data, dims, frames, bvals, bvecs, mask: null, model: "gp" });
  out.afterInitHeap = memory.buffer.byteLength;
  model.predict(0);
  out.afterPredictHeap = memory.buffer.byteLength;
  model.release();
  out.ok = true;
} catch (e) { out.ok = false; out.error = String(e.message ?? e).slice(0, 200); out.heap = memory.buffer.byteLength; }
out.seconds = (performance.now() - t) / 1000;
console.log(JSON.stringify(out));
