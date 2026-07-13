#!/usr/bin/env node --no-warnings
// Phase 2a.2.4: Node-side parity test for the lesion-segmentation port.
//
// Drives runInferencePipeline (web/js/inference-pipeline.js) on the same
// MNI152 anatomical template the SynthStrip parity test uses, backed by
// onnxruntime-node so we can validate the JS port end-to-end without a
// browser. Asserts plausibility:
//
//   - inference runs end-to-end without erroring
//   - output mask shape matches input dims
//   - mask coverage is low (the MNI152 template is a healthy averaged
//     brain — the model should produce close to zero stroke voxels;
//     allow up to 5% to absorb model false positives)
//
// We DO NOT assert Dice against ground truth here. The user-locked
// acceptance is Dice ≥ 0.5 vs an ATLAS-2 held-out subject, but the
// ATLAS-2 release is gated behind a 4 GB password-protected tarball
// with no per-subject direct-download URL. A future hardening commit
// can swap in a real subject when one is locally available.
//
// NOT in `npm test`. Run via `npm run test:lesion-seg-parity`.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_HEALTHY = path.join(ROOT, 'tests/fixtures/synthstrip-mini/T1.nii.gz');
const FIXTURE_STROKE_T1 = path.join(ROOT, 'tests/fixtures/ds004884-mini/T1.nii.gz');
const FIXTURE_STROKE_MASK = path.join(ROOT, 'tests/fixtures/ds004884-mini/lesion_mask.nii.gz');
const MODEL_CACHE_DIR = path.join(ROOT, 'web/models/_dev_cache');
const MODEL_CACHE = path.join(MODEL_CACHE_DIR, 'lnm-stroke-lesion.onnx');
const MODEL_URL =
  'https://huggingface.co/datasets/sbollmann/lnm-webapp-models' +
  '/resolve/main/models/lnm-stroke-lesion.onnx';

async function ensureModel() {
  try {
    const buf = await fs.readFile(MODEL_CACHE);
    if (buf.length > 10_000_000) return buf;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(MODEL_CACHE_DIR, { recursive: true });
  console.log(`Downloading lesion model from ${MODEL_URL}...`);
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 10_000_000) {
    throw new Error(`Downloaded model is unexpectedly small: ${buf.length} bytes`);
  }
  await fs.writeFile(MODEL_CACHE, buf);
  console.log(`Cached: ${MODEL_CACHE} (${buf.length} bytes)`);
  return buf;
}

async function loadNifti() {
  const mod = await import('nifti-reader-js');
  return mod.default || mod;
}

async function decodeNiftiFile(filePath, { coerceFloat32 = true } = {}) {
  const bytes = await fs.readFile(filePath);
  let buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const nifti = await loadNifti();
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    buf = nifti.decompress(buf);
  }
  if (!nifti.isNIFTI(buf)) throw new Error(`Not a valid NIfTI: ${filePath}`);
  const header = nifti.readHeader(buf);
  const imageBuffer = nifti.readImage(header, buf);
  const off = imageBuffer.byteOffset || 0;
  let raw;
  switch (header.datatypeCode) {
    case nifti.NIFTI1.TYPE_FLOAT32: raw = new Float32Array(imageBuffer, off); break;
    case nifti.NIFTI1.TYPE_INT16:   raw = new Int16Array(imageBuffer, off); break;
    case nifti.NIFTI1.TYPE_INT8:    raw = new Int8Array(imageBuffer, off); break;
    case nifti.NIFTI1.TYPE_UINT8:   raw = new Uint8Array(imageBuffer, off); break;
    case nifti.NIFTI1.TYPE_UINT16:  raw = new Uint16Array(imageBuffer, off); break;
    default: throw new Error(`Unsupported dtype ${header.datatypeCode} in ${filePath}`);
  }
  const data = coerceFloat32 && !(raw instanceof Float32Array)
    ? Float32Array.from(raw)
    : raw;
  const dims = [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])];
  const spacing = [Number(header.pixDims[1]), Number(header.pixDims[2]), Number(header.pixDims[3])];
  return { data, dims, spacing, dtype: header.datatypeCode };
}

function dice(a, b) {
  if (a.length !== b.length) throw new Error(`Dice: length mismatch ${a.length} vs ${b.length}`);
  let inter = 0, sumA = 0, sumB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] > 0 ? 1 : 0;
    const bv = b[i] > 0 ? 1 : 0;
    sumA += av;
    sumB += bv;
    if (av && bv) inter += 1;
  }
  return sumA + sumB > 0 ? (2 * inter) / (sumA + sumB) : 1.0;
}

// 2-channel softmax collapse: model emits [bg, stroke] logits; pipeline wants
// single-channel raw logits that sigmoid to P(stroke). The log-odds
// `logit_stroke - logit_bg` is exactly that under the softmax assumption.
function collapseBinaryLogits(out, voxelsPerChannel) {
  const collapsed = new Float32Array(voxelsPerChannel);
  for (let i = 0; i < voxelsPerChannel; i++) {
    collapsed[i] = out[voxelsPerChannel + i] - out[i];
  }
  return collapsed;
}

async function runPipelineOnFixture({ session, t1, runInferencePipeline, opts = {} }) {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const PATCH = [128, 128, 128];

  const t0 = Date.now();
  const result = await runInferencePipeline(
    { data: t1.data, dims: t1.dims, patchSize: PATCH },
    async (patch, patchDims) => {
      const [d0, d1, d2] = patchDims;
      const voxels = d0 * d1 * d2;
      const tensor = new ort.Tensor('float32', patch, [1, 1, d0, d1, d2]);
      const out = await session.run({ [inputName]: tensor });
      const raw = out[outputName].data;
      tensor.dispose?.();
      assert.equal(raw.length, 2 * voxels,
        `model output length ${raw.length} != 2 x ${voxels}`);
      return collapseBinaryLogits(raw, voxels);
    },
    {
      overlap: 0,
      threshold: 0.4,
      minComponentSize: 30,
      testTimeAugmentation: false,
      onLog: opts.verbose ? (msg => console.log(`  [pipeline] ${msg}`)) : (() => {}),
      ...opts.pipelineOpts
    }
  );
  return { result, elapsedSeconds: (Date.now() - t0) / 1000 };
}

(async () => {
  console.log('Loading model...');
  const modelBuf = await ensureModel();
  console.log(`Model: ${modelBuf.length} bytes`);

  console.log('Creating ONNX session (CPU EP)...');
  const session = await ort.InferenceSession.create(modelBuf, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  });
  console.log(`session ready (input=${session.inputNames[0]}, output=${session.outputNames[0]})`);

  const { runInferencePipeline } = await import('../web/js/inference-pipeline.js');

  // ---------- Case 1: healthy MNI152 template -> ~0 stroke voxels ----------
  console.log(`\n[case 1] Healthy MNI152 template: ${path.relative(ROOT, FIXTURE_HEALTHY)}`);
  {
    const t1 = await decodeNiftiFile(FIXTURE_HEALTHY);
    console.log(
      `  T1: ${t1.dims.join('x')} @ ${t1.spacing.map(s => s.toFixed(2)).join('x')}mm, ` +
      `${t1.data.length.toLocaleString()} voxels`
    );
    const { result, elapsedSeconds } =
      await runPipelineOnFixture({ session, t1, runInferencePipeline, opts: { verbose: true } });
    let positive = 0;
    for (let i = 0; i < result.labels.length; i++) if (result.labels[i] > 0) positive++;
    const coverage = positive / t1.data.length;
    console.log(`  ran in ${elapsedSeconds.toFixed(1)}s; ${positive} stroke voxels (${(coverage*100).toFixed(2)}%)`);
    assert.deepEqual(result.dims, t1.dims, 'healthy: output dims must match input');
    assert.ok(coverage < 0.05,
      `healthy template should be <5% stroke; got ${(coverage*100).toFixed(2)}%`);
  }

  // ---------- Case 2: real stroke (ds004884 sub-M2051) -> Dice gate ----------
  console.log(`\n[case 2] ds004884 sub-M2051: real chronic stroke T1 + ground-truth mask`);
  {
    const t1 = await decodeNiftiFile(FIXTURE_STROKE_T1);
    const mask = await decodeNiftiFile(FIXTURE_STROKE_MASK, { coerceFloat32: false });
    console.log(
      `  T1:   ${t1.dims.join('x')} @ ${t1.spacing.map(s => s.toFixed(2)).join('x')}mm, ` +
      `${t1.data.length.toLocaleString()} voxels`
    );
    let truth = 0;
    for (let i = 0; i < mask.data.length; i++) if (mask.data[i] > 0) truth++;
    console.log(
      `  mask: ${mask.dims.join('x')} truth voxels=${truth.toLocaleString()} ` +
      `(${(100*truth/mask.data.length).toFixed(3)}%)`
    );
    assert.deepEqual(mask.dims, t1.dims,
      `mask dims ${mask.dims} must equal T1 dims ${t1.dims} (build.py resamples)`);

    const { result, elapsedSeconds } =
      await runPipelineOnFixture({ session, t1, runInferencePipeline, opts: { verbose: false } });
    let pred = 0;
    for (let i = 0; i < result.labels.length; i++) if (result.labels[i] > 0) pred++;

    const d = dice(result.labels, mask.data);
    console.log(
      `  ran in ${elapsedSeconds.toFixed(1)}s; ` +
      `pred ${pred.toLocaleString()} voxels, truth ${truth.toLocaleString()} voxels, ` +
      `Dice = ${d.toFixed(4)}`
    );

    // Dice gate. Master-plan acceptance was Dice >= 0.5 against an
    // ATLAS-2 held-out subject; the ds004884 sub-M2051 case observed
    // Dice = 0.5325 on this checkpoint (SynthStroke baseline, MELBA
    // 2025) at gate-setting time. Setting the gate at 0.50 honours the
    // original bar with a small safety margin under the observed value.
    // If a future model swap (e.g. SynthStroke-synth+) changes this,
    // raise or lower in lockstep.
    const DICE_GATE = 0.50;
    assert.ok(
      d >= DICE_GATE,
      `Dice ${d.toFixed(4)} < gate ${DICE_GATE} on real-stroke fixture`
    );
  }

  console.log(
    '\nLesion-segmentation parity OK: healthy template stays empty; ' +
    'real stroke fixture clears the Dice gate.'
  );
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
