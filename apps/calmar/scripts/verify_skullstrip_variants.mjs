// Compare normalization/masking strategies for lesion seg on a skull-stripped
// brain. Uses the real SynthStrip mask + the app inference pipeline + the
// production lnm-stroke-lesion.onnx (onnxruntime-node).
//
// Variants:
//   A full-head, whole-volume z-score            (current behavior)
//   B skull-strip, whole-volume z-score          (naive "feed stripped")
//   C skull-strip, BRAIN-masked z-score          (normalize within brain)
//   D full-head, whole-vol z-score, OUTPUT masked by brain mask
//   E skull-strip, brain-masked z-score, OUTPUT masked by brain mask
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T1_PATH = process.argv[2] ||
  '/Users/uqsbollm/Downloads/sub-M2121_ses-258_acq-tfl3p2_run-3_T1w.nii.gz';
const STROKE_ONNX = path.join(ROOT, 'web/models/_dev_cache/lnm-stroke-lesion.onnx');
const SYNTHSTRIP_ONNX = path.join(ROOT, 'web/models/_dev_cache/synthstrip.onnx');
const PATCH = [128, 128, 128];
const OPTS = { overlap: 0.25, threshold: 0.4, minComponentSize: 30, testTimeAugmentation: false, onLog: () => {} };

async function loadNifti(filePath) {
  const mod = await import('nifti-reader-js');
  const nifti = mod.default || mod;
  const bytes = await fs.readFile(filePath);
  let buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buf = nifti.decompress(buf);
  const header = nifti.readHeader(buf);
  const image = nifti.readImage(header, buf);
  const ctor = { 2: Uint8Array, 4: Int16Array, 8: Int32Array, 16: Float32Array, 64: Float64Array, 256: Int8Array, 512: Uint16Array, 768: Uint32Array }[header.datatypeCode];
  const raw = new ctor(image, image.byteOffset || 0);
  return {
    data: raw instanceof Float32Array ? raw : Float32Array.from(raw),
    dims: [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])],
    spacing: [Number(header.pixDims[1]), Number(header.pixDims[2]), Number(header.pixDims[3])]
  };
}

function brainMaskedZScore(data, mask) {
  let n = 0, sum = 0;
  for (let i = 0; i < data.length; i++) if (mask[i] > 0) { sum += data[i]; n++; }
  const mean = n ? sum / n : 0;
  let sq = 0;
  for (let i = 0; i < data.length; i++) if (mask[i] > 0) { const d = data[i] - mean; sq += d * d; }
  const std = Math.sqrt(n ? sq / n : 1) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = mask[i] > 0 ? (data[i] - mean) / std : 0;
  return out;
}

function dice(a, b) { let inter = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { if (a[i]) sa++; if (b[i]) sb++; if (a[i] && b[i]) inter++; } return (sa + sb) ? 2 * inter / (sa + sb) : 1; }

(async () => {
  const { data: rasData, dims: rasDims, spacing: rasSpacing } = await loadNifti(T1_PATH);
  const ssBuf = await fs.readFile(SYNTHSTRIP_ONNX);
  const { runSynthStrip } = await import('../web/js/modules/brain-extraction.js');
  const ss = await runSynthStrip({ rasData, rasDims, rasSpacing, modelArrayBuffer: ssBuf.buffer.slice(ssBuf.byteOffset, ssBuf.byteOffset + ssBuf.byteLength), ort, executionProviders: ['cpu'], fast: true, dilate: false, onLog: () => {} });
  const mask = ss.mask;
  console.log(`brain mask: ${ss.voxelCount.toLocaleString()} voxels (${(100 * ss.voxelCount / rasData.length).toFixed(1)}% of FOV)\n`);

  const stripped = new Float32Array(rasData.length);
  for (let i = 0; i < rasData.length; i++) if (mask[i] > 0) stripped[i] = rasData[i];
  const strippedBrainZ = brainMaskedZScore(rasData, mask);

  const { runInferencePipeline } = await import('../web/js/inference-pipeline.js');
  const session = await ort.InferenceSession.create(STROKE_ONNX, { executionProviders: ['cpu'] });
  const iname = session.inputNames[0], oname = session.outputNames[0];
  const runPatch = async (patch, [p0, p1, p2]) => {
    const v = p0 * p1 * p2;
    const out = await session.run({ [iname]: new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]) });
    const raw = out[oname].data; const c = new Float32Array(v);
    for (let i = 0; i < v; i++) c[i] = raw[v + i] - raw[i];
    return c;
  };
  const run = (data, normalizeInput) => runInferencePipeline({ data, dims: rasDims, patchSize: PATCH }, runPatch, { ...OPTS, normalizeInput });

  console.log('A full-head, whole-vol z-score...');
  const A = (await run(rasData, true)).labels;
  console.log('B skull-strip, whole-vol z-score...');
  const B = (await run(stripped, true)).labels;
  console.log('C skull-strip, brain-masked z-score...');
  const C = (await run(strippedBrainZ, false)).labels;

  const applyOut = (labels) => { const o = new Uint8Array(labels.length); for (let i = 0; i < labels.length; i++) o[i] = labels[i] && mask[i] > 0 ? 1 : 0; return o; };
  const D = applyOut(A);
  const E = applyOut(C);

  const refInBrain = applyOut(A); // in-brain part of the full-head baseline
  const report = (name, labels) => {
    let total = 0, out = 0; for (let i = 0; i < labels.length; i++) if (labels[i]) { total++; if (!(mask[i] > 0)) out++; }
    const inb = applyOut(labels);
    console.log(`${name}: total=${String(total).padStart(7)}  out-of-brain=${String(out).padStart(7)} (${(100 * out / Math.max(total, 1)).toFixed(0)}%)  in-brain-Dice-vs-A=${dice(inb, refInBrain).toFixed(3)}`);
  };
  console.log('\n================== RESULT ==================');
  report('A full-head whole-z          ', A);
  report('B strip   whole-z   (naive)  ', B);
  report('C strip   brain-z            ', C);
  report('D full-head whole-z + outmask', D);
  report('E strip   brain-z   + outmask', E);
  console.log('===========================================');
})();
