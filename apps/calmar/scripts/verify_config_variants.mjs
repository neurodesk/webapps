// Does a heavier inference config remove the in-brain cerebellum FP WITHOUT
// shrinking the real parietal lesion? Runs on the saved prealigned MNI160 T1.
// Reference "real lesion" = largest connected component of the current
// full-head baseline (A). "Cerebellum FP" = inferior+posterior in-brain octant.
//
// ONNX variants use the production static-128 graph (browser-feasible).
// torch-192 uses the upstream safetensors at 192^3 (NOT browser-shippable
// as-is; tells us whether re-exporting at 192 would be worth it).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = path.join(ROOT, '.tmp_weights', 'cerebellum_fp');
const STROKE_ONNX = path.join(ROOT, 'web/models/_dev_cache/lnm-stroke-lesion.onnx');
const OPTS = { threshold: 0.4, minComponentSize: 30, onLog: () => {} };

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
  const { runInferencePipeline, connectedComponents3D } = await import('../web/js/inference-pipeline.js');
  const t1 = await load('mni_t1pre.nii');
  const bmV = await load('mni_brainmask.nii');
  const A = await load('mni_A_fullhead.nii');   // current baseline labels
  const dims = t1.dims, mask = bmV.data;

  // reference real lesion = largest CC of A
  const ccA = connectedComponents3D(Uint8Array.from(A.data, v => v > 0 ? 1 : 0), dims);
  const sizes = new Int32Array(ccA.numComponents + 1);
  for (let i = 0; i < ccA.labels.length; i++) if (ccA.labels[i]) sizes[ccA.labels[i]]++;
  let big = 1; for (let k = 2; k <= ccA.numComponents; k++) if (sizes[k] > sizes[big]) big = k;
  const lesionRef = new Uint8Array(dims[0] * dims[1] * dims[2]);
  let lesionRefN = 0;
  for (let i = 0; i < lesionRef.length; i++) if (ccA.labels[i] === big) { lesionRef[i] = 1; lesionRefN++; }

  // cerebellar octant (post+inf in-brain)
  let zmin = 1e9, zmax = -1, ymin = 1e9, ymax = -1;
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++)
    if (mask[x + y * dims[0] + z * dims[0] * dims[1]] > 0) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const zc = (zmin + zmax) / 2, yc = (ymin + ymax) / 2;

  function report(name, labels) {
    let total = 0, cb = 0, lesionKept = 0;
    for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
      const idx = x + y * dims[0] + z * dims[0] * dims[1];
      if (labels[idx]) { total++; if (z < zc && y < yc && mask[idx] > 0) cb++; if (lesionRef[idx]) lesionKept++; }
    }
    console.log(`${name.padEnd(26)} total=${String(total).padStart(6)}  cerebellumFP=${String(cb).padStart(5)}  lesion-recall=${(100 * lesionKept / lesionRefN).toFixed(0)}%`);
  }

  // ONNX static-128 patch runner
  const session = await ort.InferenceSession.create(STROKE_ONNX, { executionProviders: ['cpu'] });
  const iname = session.inputNames[0], oname = session.outputNames[0];
  const onnxPatch = async (patch, [p0, p1, p2]) => {
    const v = p0 * p1 * p2;
    const out = await session.run({ [iname]: new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]) });
    const raw = out[oname].data; const c = new Float32Array(v);
    for (let i = 0; i < v; i++) c[i] = raw[v + i] - raw[i];
    return c;
  };
  const runOnnx = (overlap, tta) => runInferencePipeline({ data: t1.data, dims, patchSize: [128, 128, 128] }, onnxPatch, { ...OPTS, overlap, testTimeAugmentation: tta });

  console.log(`grid ${dims.join('x')}; reference lesion (A largest CC) = ${lesionRefN} vox\n`);
  report('A onnx128 ov0.25 noTTA (cur)', A.data);
  console.log('running onnx128 ov0.5 noTTA...');  report('onnx128 ov0.5 noTTA', (await runOnnx(0.5, false)).labels);
  console.log('running onnx128 ov0.25 TTA...');   report('onnx128 ov0.25 TTA', (await runOnnx(0.25, true)).labels);
  console.log('running onnx128 ov0.5 TTA...');    report('onnx128 ov0.5 TTA', (await runOnnx(0.5, true)).labels);
})();
