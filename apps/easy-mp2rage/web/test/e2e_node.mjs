// Headless end-to-end check of the browser app's data path:
//   nifti.js read  ->  WASM core  ->  nifti.js write/read-back
// exactly as web/js/app.js + worker.js do, compared to the Python golden.
// Requires `tools/build_wasm.sh` to have staged web/wasm/.
//
// run:  node web/test/e2e_node.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');
const readNifti = (await import(resolve(here, '../js/nifti.js'))).readNifti;
const { writeNiftiGz } = await import(resolve(here, '../js/nifti.js'));
const wasm = await import(resolve(here, '../wasm/mp2rage_wasm.js'));
await wasm.default(readFileSync(resolve(here, '../wasm/mp2rage_wasm_bg.wasm')));

const ab = (p) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
function readNpy(p) {
  const buf = readFileSync(p); const h = buf.readUInt16LE(8);
  const hdr = buf.toString('latin1', 10, 10 + h);
  const shape = hdr.match(/'shape':\s*\(([^)]*)\)/)[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const off = 10 + h, n = (buf.length - off) / 8, d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = buf.readDoubleLE(off + 8 * i);
  return { d, shape };
}

const P = `${REPO}/tools/phantom`, G = `${REPO}/tools/golden`;
const uni = await readNifti(ab(`${P}/phantom_UNI.nii.gz`));
const inv2 = await readNifti(ab(`${P}/phantom_INV2.nii.gz`));
const sa = await readNifti(ab(`${P}/phantom_SA2RAGE.nii.gz`));
const [nx, ny, nz] = uni.dims, [sx, sy, sz] = sa.dims;
const MP = new Float64Array([4.3, 0.840, 2.370, 5, 6, 64, 128, 0.007, 0.96]);
const SAP = new Float64Array([2.4, 0.150, 1.500, 6, 6, 24, 24, 0.005, 1.5]);

const res = wasm.t1map_sa2rage(
  uni.data, inv2.data, sa.data,
  new Uint32Array([nx, ny, nz]), uni.affine,
  new Uint32Array([sx, sy, sz]), sa.affine, MP, SAP);

const gold = readNpy(`${G}/v_corr_T1_ms.npy`);
let worst = 0;
for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++)
  worst = Math.max(worst, Math.abs(res.t1[i + nx * (j + ny * k)] - gold.d[i * ny * nz + j * nz + k]));
console.log(`app data-path T1 vs Python golden: worst |diff| = ${worst.toExponential(3)} ms`);

// write -> read-back round-trip (download path)
const gz = await writeNiftiGz(res.t1, [nx, ny, nz], uni.affine);
const back = await readNifti(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength));
let rt = 0;
for (let i = 0; i < res.t1.length; i++) rt = Math.max(rt, Math.abs(res.t1[i] - back.data[i]));
console.log(`download round-trip worst |diff| = ${rt}`);
console.log(worst < 0.1 && rt === 0 ? 'PASS ✅' : 'FAIL ❌');
process.exit(worst < 0.1 && rt === 0 ? 0 : 1);
