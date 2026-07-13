// One-off verification (NOT in npm test): confirm that feeding the
// skull-stripped T1 to the lesion model removes the out-of-brain false
// positives while preserving the in-brain lesion. Uses the app's OWN
// modules end to end:
//   web/js/modules/brain-extraction.js  (real SynthStrip mask)
//   web/js/inference-pipeline.js         (real sliding-window pipeline)
// and the production lnm-stroke-lesion.onnx via onnxruntime-node.
//
// Usage: node scripts/verify_skullstrip_seg.mjs [/path/to/T1.nii.gz]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T1_PATH = process.argv[2] ||
  '/Users/uqsbollm/Downloads/sub-M2121_ses-258_acq-tfl3p2_run-3_T1w.nii.gz';
const STROKE_ONNX = path.join(ROOT, 'web/models/_dev_cache/lnm-stroke-lesion.onnx');
const SYNTHSTRIP_ONNX = path.join(ROOT, 'web/models/_dev_cache/synthstrip.onnx');
const SYNTHSTRIP_URL =
  'https://huggingface.co/datasets/sbollmann/lnm-webapp-models/resolve/main/models/synthstrip.onnx';

const PATCH = [128, 128, 128];
const THRESHOLD = 0.4;
const MIN_CC = 30;

async function loadNifti(filePath) {
  const mod = await import('nifti-reader-js');
  const nifti = mod.default || mod;
  const bytes = await fs.readFile(filePath);
  let buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buf = nifti.decompress(buf);
  if (!nifti.isNIFTI(buf)) throw new Error('not a NIfTI');
  const header = nifti.readHeader(buf);
  const image = nifti.readImage(header, buf);
  const off = image.byteOffset || 0;
  const ctor = {
    2: Uint8Array, 4: Int16Array, 8: Int32Array, 16: Float32Array,
    64: Float64Array, 256: Int8Array, 512: Uint16Array, 768: Uint32Array
  }[header.datatypeCode];
  const raw = new ctor(image, off);
  const data = raw instanceof Float32Array ? raw : Float32Array.from(raw);
  const dims = [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])];
  const spacing = [Number(header.pixDims[1]), Number(header.pixDims[2]), Number(header.pixDims[3])];
  return { data, dims, spacing };
}

async function ensureSynthStrip() {
  try { await fs.access(SYNTHSTRIP_ONNX); return; } catch {}
  console.log('Downloading synthstrip.onnx...');
  const res = await fetch(SYNTHSTRIP_URL);
  await fs.mkdir(path.dirname(SYNTHSTRIP_ONNX), { recursive: true });
  await fs.writeFile(SYNTHSTRIP_ONNX, Buffer.from(await res.arrayBuffer()));
}

function strokePatchRunner(session, inputName, outputName) {
  return async (patch, patchDims) => {
    const [p0, p1, p2] = patchDims;
    const voxels = p0 * p1 * p2;
    const t = new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]);
    const out = await session.run({ [inputName]: t });
    const raw = out[outputName].data;
    // collapse 2-channel softmax logits -> stroke log-odds (worker contract)
    const collapsed = new Float32Array(voxels);
    for (let i = 0; i < voxels; i++) collapsed[i] = raw[voxels + i] - raw[i];
    return collapsed;
  };
}

function dice(a, b) {
  let inter = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { if (a[i]) sa++; if (b[i]) sb++; if (a[i] && b[i]) inter++; }
  return (sa + sb) ? (2 * inter) / (sa + sb) : 1;
}

(async () => {
  console.log(`T1: ${T1_PATH}`);
  const { data: rasData, dims: rasDims, spacing: rasSpacing } = await loadNifti(T1_PATH);
  console.log(`  ${rasDims.join('x')} @ ${rasSpacing.map(s => s.toFixed(2)).join('x')}mm`);

  await ensureSynthStrip();
  const ssBuf = await fs.readFile(SYNTHSTRIP_ONNX);
  const ssArrayBuf = ssBuf.buffer.slice(ssBuf.byteOffset, ssBuf.byteOffset + ssBuf.byteLength);
  console.log('Running real SynthStrip brain extraction...');
  const { runSynthStrip } = await import('../web/js/modules/brain-extraction.js');
  const ss = await runSynthStrip({
    rasData, rasDims, rasSpacing, modelArrayBuffer: ssArrayBuf, ort,
    executionProviders: ['cpu'], fast: true, dilate: false,
    onLog: () => {}
  });
  const mask = ss.mask;
  console.log(`  brain mask: ${ss.voxelCount.toLocaleString()} voxels (${(100*ss.voxelCount/rasData.length).toFixed(1)}% of FOV)`);

  // skull-stripped input == app's buildSkullStrippedSegmentationInput()
  const stripped = new Float32Array(rasData.length);
  for (let i = 0; i < rasData.length; i++) if (mask[i] > 0) stripped[i] = rasData[i];

  const { runInferencePipeline } = await import('../web/js/inference-pipeline.js');
  const session = await ort.InferenceSession.create(STROKE_ONNX, { executionProviders: ['cpu'] });
  const runPatch = strokePatchRunner(session, session.inputNames[0], session.outputNames[0]);
  const opts = { overlap: 0.25, threshold: THRESHOLD, minComponentSize: MIN_CC, testTimeAugmentation: false, onLog: () => {} };

  console.log('Lesion inference on FULL-HEAD T1 (old behavior)...');
  const full = await runInferencePipeline({ data: rasData, dims: rasDims, patchSize: PATCH }, runPatch, opts);
  console.log('Lesion inference on SKULL-STRIPPED T1 (the fix)...');
  const strip = await runInferencePipeline({ data: stripped, dims: rasDims, patchSize: PATCH }, runPatch, opts);

  // metrics
  const inBrainFull = new Uint8Array(rasData.length);
  const inBrainStrip = new Uint8Array(rasData.length);
  let fullVox = 0, stripVox = 0, fullOut = 0, stripOut = 0;
  for (let i = 0; i < rasData.length; i++) {
    const f = full.labels[i], s = strip.labels[i], inb = mask[i] > 0;
    if (f) { fullVox++; if (!inb) fullOut++; }
    if (s) { stripVox++; if (!inb) stripOut++; }
    inBrainFull[i] = f && inb ? 1 : 0;
    inBrainStrip[i] = s && inb ? 1 : 0;
  }

  console.log('\n================ RESULT ================');
  console.log(`FULL-HEAD     total=${fullVox.toLocaleString()}  out-of-brain=${fullOut.toLocaleString()} (${(100*fullOut/Math.max(fullVox,1)).toFixed(0)}%)`);
  console.log(`SKULL-STRIP   total=${stripVox.toLocaleString()}  out-of-brain=${stripOut.toLocaleString()} (${(100*stripOut/Math.max(stripVox,1)).toFixed(0)}%)`);
  console.log(`out-of-brain FP removed: ${(fullOut - stripOut).toLocaleString()} voxels`);
  console.log(`in-brain lesion preserved: Dice(full∩brain, strip∩brain) = ${dice(inBrainFull, inBrainStrip).toFixed(4)}`);
  console.log('========================================');
})();
