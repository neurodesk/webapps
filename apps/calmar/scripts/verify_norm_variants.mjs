// Normalization sweep on the ALREADY-prealigned MNI160 volumes (saved by
// verify_skullstrip_mni160.mjs). No SynthStrip/prealign re-run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = path.join(ROOT, '.tmp_weights', 'cerebellum_fp');
const STROKE_ONNX = path.join(ROOT, 'web/models/_dev_cache/lnm-stroke-lesion.onnx');
const PATCH = [128, 128, 128];
const OPTS = { overlap: 0.25, threshold: 0.4, minComponentSize: 30, testTimeAugmentation: false, onLog: () => {} };

async function load(name) {
  const mod = await import('nifti-reader-js'); const nifti = mod.default || mod;
  const bytes = await fs.readFile(path.join(D, name));
  let buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buf = nifti.decompress(buf);
  const h = nifti.readHeader(buf); const img = nifti.readImage(h, buf);
  const ctor = { 2: Uint8Array, 16: Float32Array }[h.datatypeCode];
  const raw = new ctor(img, img.byteOffset || 0);
  return { data: raw instanceof Float32Array ? raw : Float32Array.from(raw), dims: [h.dims[1], h.dims[2], h.dims[3]] };
}

(async () => {
  const t1 = await load('mni_t1pre.nii');
  const bmV = await load('mni_brainmask.nii');
  const mask = bmV.data; const dims = t1.dims;
  const bz = []; for (let i = 0; i < mask.length; i++) if (mask[i] > 0) bz.push(i);
  let mean = 0; for (const i of bz) mean += t1.data[i]; mean /= bz.length;
  let sq = 0; for (const i of bz) { const d = t1.data[i] - mean; sq += d * d; } const std = Math.sqrt(sq / bz.length) || 1;

  // brain-mean/std z-score, background pushed to natural (strongly negative) value
  const F = new Float32Array(t1.data.length);
  for (let i = 0; i < F.length; i++) F[i] = mask[i] > 0 ? (t1.data[i] - mean) / std : (0 - mean) / std;
  // brain-mean/std z-score, background clamped to a fixed floor (-1)
  const G = new Float32Array(t1.data.length);
  for (let i = 0; i < G.length; i++) G[i] = mask[i] > 0 ? (t1.data[i] - mean) / std : -1;

  const session = await ort.InferenceSession.create(STROKE_ONNX, { executionProviders: ['cpu'] });
  const iname = session.inputNames[0], oname = session.outputNames[0];
  const runPatch = async (patch, [p0, p1, p2]) => {
    const v = p0 * p1 * p2;
    const out = await session.run({ [iname]: new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]) });
    const raw = out[oname].data; const c = new Float32Array(v);
    for (let i = 0; i < v; i++) c[i] = raw[v + i] - raw[i];
    return c;
  };
  const { runInferencePipeline } = await import('../web/js/inference-pipeline.js');
  const run = (data) => runInferencePipeline({ data, dims, patchSize: PATCH }, runPatch, { ...OPTS, normalizeInput: false });

  // cerebellar octant (post+inf) in-brain, from brain bbox
  let zmin = 1e9, zmax = -1, ymin = 1e9, ymax = -1;
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    if (mask[x + y * dims[0] + z * dims[0] * dims[1]] > 0) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  }
  const zc = (zmin + zmax) / 2, yc = (ymin + ymax) / 2;
  const stats = (labels, name) => {
    let total = 0, cb = 0;
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
      const idx = x + y * dims[0] + z * dims[0] * dims[1];
      if (labels[idx]) { total++; if (z < zc && y < yc && mask[idx] > 0) cb++; }
    }
    console.log(`${name}: total=${String(total).padStart(6)}  cerebellar-octant=${String(cb).padStart(5)}`);
  };

  console.log(`brain mean=${mean.toFixed(1)} std=${std.toFixed(1)}; background z (F)=${((0 - mean) / std).toFixed(2)}\n`);
  console.log('F strip brain-z, bg=natural-negative...'); stats((await run(F)).labels, 'F brain-z bg=neg ');
  console.log('G strip brain-z, bg=-1 floor...'); stats((await run(G)).labels, 'G brain-z bg=-1   ');
  console.log('\n(reference: A full-head=30537 total / ~3130 cerebellar; B naive-strip=4037 / 0 cerebellar)');
})();
