// FAITHFUL reproduction: run the lesion-seg normalization/masking variants on
// the ACTUAL input the auto pipeline feeds the model — the prealigned MNI160
// T1 (160x160x192), built here with the app's own prealign + resample modules.
//
// Pipeline mirrored from web/js/lnm-app.js prealignToMni160():
//   SynthStrip native mask -> principalAxisAlign -> resampleAffine(T1 trilinear,
//   mask nearest) onto the fixed lnm-mni160 grid -> lesion inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T1_PATH = process.argv[2] ||
  '/Users/uqsbollm/Downloads/sub-M2121_ses-258_acq-tfl3p2_run-3_T1w.nii.gz';
const STROKE_ONNX = path.join(ROOT, 'web/models/_dev_cache/lnm-stroke-lesion.onnx');
const SYNTHSTRIP_ONNX = path.join(ROOT, 'web/models/_dev_cache/synthstrip.onnx');
const MNI160 = path.join(ROOT, 'web/models/_dev_cache/lnm-mni160.nii.gz');
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
    spacing: [Number(header.pixDims[1]), Number(header.pixDims[2]), Number(header.pixDims[3])],
    affine: header.affine
  };
}

function foregroundMaskFromIntensity(data, fractionOfMax = 0.05) {
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  const thr = (Number.isFinite(max) ? max : 0) * fractionOfMax;
  const m = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) if (data[i] > thr) m[i] = 1;
  return m;
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
  const { centroidOfMask, principalAxisAlign } = await import('../web/js/modules/prealign.js');
  const { resampleAffine } = await import('../web/js/modules/resample.js');
  const { runSynthStrip } = await import('../web/js/modules/brain-extraction.js');
  const { runInferencePipeline } = await import('../web/js/inference-pipeline.js');

  const t1 = await loadNifti(T1_PATH);
  console.log(`native T1 ${t1.dims.join('x')} @ ${t1.spacing.map(s => s.toFixed(2)).join('x')}mm`);

  const ssBuf = await fs.readFile(SYNTHSTRIP_ONNX);
  const ss = await runSynthStrip({ rasData: t1.data, rasDims: t1.dims, rasSpacing: t1.spacing, modelArrayBuffer: ssBuf.buffer.slice(ssBuf.byteOffset, ssBuf.byteOffset + ssBuf.byteLength), ort, executionProviders: ['cpu'], fast: true, dilate: false, onLog: () => {} });
  console.log(`native brain mask: ${ss.voxelCount.toLocaleString()} voxels`);

  const mni = await loadNifti(MNI160);
  const mniFg = foregroundMaskFromIntensity(mni.data, 0.05);
  const mniCenterVox = centroidOfMask(mniFg, mni.dims);
  const { dstAffine, mniDims } = principalAxisAlign(ss.mask, t1.dims, t1.affine, { mniDims: mni.dims, mniCenterVox, mniAffine: mni.affine });

  const t1Pre = resampleAffine(t1.data, t1.dims, t1.affine, mniDims, dstAffine, 'trilinear');
  const maskPreRaw = resampleAffine(ss.mask, t1.dims, t1.affine, mniDims, dstAffine, 'nearest');
  const maskPre = new Uint8Array(maskPreRaw.length);
  let brainPre = 0;
  for (let i = 0; i < maskPreRaw.length; i++) { maskPre[i] = maskPreRaw[i] > 0.5 ? 1 : 0; if (maskPre[i]) brainPre++; }
  console.log(`prealigned MNI160 grid ${mniDims.join('x')} (${maskPre.length.toLocaleString()} vox); brain=${brainPre.toLocaleString()} (${(100 * brainPre / maskPre.length).toFixed(1)}% of grid)\n`);

  const stripped = new Float32Array(t1Pre.length);
  for (let i = 0; i < t1Pre.length; i++) if (maskPre[i] > 0) stripped[i] = t1Pre[i];
  const strippedBrainZ = brainMaskedZScore(t1Pre, maskPre);

  const session = await ort.InferenceSession.create(STROKE_ONNX, { executionProviders: ['cpu'] });
  const iname = session.inputNames[0], oname = session.outputNames[0];
  const runPatch = async (patch, [p0, p1, p2]) => {
    const v = p0 * p1 * p2;
    const out = await session.run({ [iname]: new ort.Tensor('float32', patch, [1, 1, p0, p1, p2]) });
    const raw = out[oname].data; const c = new Float32Array(v);
    for (let i = 0; i < v; i++) c[i] = raw[v + i] - raw[i];
    return c;
  };
  const run = (data, normalizeInput) => runInferencePipeline({ data, dims: mniDims, patchSize: PATCH }, runPatch, { ...OPTS, normalizeInput });

  console.log('A full-head, whole-vol z-score...'); const A = (await run(t1Pre, true)).labels;
  console.log('B skull-strip, whole-vol z-score...'); const B = (await run(stripped, true)).labels;
  console.log('C skull-strip, brain-masked z-score...'); const C = (await run(strippedBrainZ, false)).labels;

  const applyOut = (labels) => { const o = new Uint8Array(labels.length); for (let i = 0; i < labels.length; i++) o[i] = labels[i] && maskPre[i] > 0 ? 1 : 0; return o; };
  const D = applyOut(A), E = applyOut(C);

  // Save volumes (prealigned MNI160 grid) for visual cerebellum inspection.
  const { writeNifti1 } = await import('../web/js/modules/nifti-writer.js');
  const flat = [dstAffine[0][0], dstAffine[0][1], dstAffine[0][2], dstAffine[0][3], dstAffine[1][0], dstAffine[1][1], dstAffine[1][2], dstAffine[1][3], dstAffine[2][0], dstAffine[2][1], dstAffine[2][2], dstAffine[2][3]];
  const outDir = path.join(ROOT, '.tmp_weights', 'cerebellum_fp');
  await fs.mkdir(outDir, { recursive: true });
  const save = async (name, data) => { await fs.writeFile(path.join(outDir, name), Buffer.from(writeNifti1(data, { dims: mniDims, spacing: [1, 1, 1], affine: flat }))); };
  await save('mni_t1pre.nii', t1Pre);
  await save('mni_brainmask.nii', maskPre);
  await save('mni_A_fullhead.nii', A);
  await save('mni_B_strip.nii', B);
  await save('mni_D_outmask.nii', D);
  console.log(`saved MNI160 volumes to ${outDir}`);
  const refInBrain = applyOut(A);
  const report = (name, labels) => {
    let total = 0, out = 0; for (let i = 0; i < labels.length; i++) if (labels[i]) { total++; if (!(maskPre[i] > 0)) out++; }
    console.log(`${name}: total=${String(total).padStart(7)}  out-of-brain=${String(out).padStart(7)} (${(100 * out / Math.max(total, 1)).toFixed(0)}%)  in-brain-Dice-vs-A=${dice(applyOut(labels), refInBrain).toFixed(3)}`);
  };
  console.log('\n============== MNI160 PREALIGNED RESULT ==============');
  report('A full-head whole-z           ', A);
  report('B strip   whole-z   (naive)   ', B);
  report('C strip   brain-z             ', C);
  report('D full-head whole-z + outmask ', D);
  report('E strip   brain-z   + outmask ', E);
  console.log('=====================================================');
})();
