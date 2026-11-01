// One case per process: node init-limits.mjs NX NY NZ DWI MASK. Measured src/limits.js on large
// grids with few volumes (#452, plan section 6): one b0, DWI noisy volumes in random directions and
// a brain mask of the first MASK voxels, so nifreeze_init's whole-grid arrays and the prediction's
// float64 volumes, not the GP matrices, fill hmc.wasm's heap. Reports the heap after init and after
// one prediction, or the stage that failed.
import { readFile } from "node:fs/promises";
import { loadHmc } from "../src/wasm.js";
import { estimatorBytes, nifreezeInputProblem } from "../src/limits.js";

const [nx, ny, nz, dwiVolumes, maskVoxels] = process.argv.slice(2).map(Number);
let memory;
const original = WebAssembly.instantiate;
WebAssembly.instantiate = async (...args) => { const r = await original(...args); memory = (r.instance ?? r).exports.memory; return r; };
const hmc = await loadHmc(readFile(new URL("../src/hmc.wasm", import.meta.url)));
const dims = [nx, ny, nz], voxels = nx * ny * nz, frames = dwiVolumes + 1;
let state = 1234;
const random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32 - 0.5;
// Noise keeps each prediction from being constant, which the intensity clip refuses.
const data = Float32Array.from({ length: voxels * frames }, () => 500 + 200 * random());
const mask = new Uint8Array(voxels).fill(1, 0, maskVoxels);
const bvals = Array.from({ length: frames }, (_, i) => i ? 1000 : 0);
const directions = bvals.map(() => { const v = [random(), random(), random()]; const n = Math.hypot(...v); return v.map(x => x / n); });
const bvecs = [0, 1, 2].map(axis => directions.map((v, i) => i ? v[axis] : 0));
const input = { voxels, frames, dwiVolumes, maskVoxels };
const out = { dims, frames, dwiVolumes, maskVoxels, estimate: estimatorBytes(input), refused: nifreezeInputProblem(input) !== null };
const t = performance.now();
let stage = "init";
try {
  const model = hmc.createNifreezeModel({ data, dims, frames, bvals, bvecs, mask, model: "gp" });
  out.afterInitHeap = memory.buffer.byteLength;
  stage = "predict";
  model.predict(0);
  out.afterPredictHeap = memory.buffer.byteLength;
  model.release();
  out.ok = true;
} catch (e) { out.ok = false; out.failed = stage; out.error = String(e.message ?? e).slice(0, 200); out.heap = memory.buffer.byteLength; }
out.seconds = (performance.now() - t) / 1000;
console.log(JSON.stringify(out));
