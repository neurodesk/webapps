#!/usr/bin/env node --no-warnings
// Phase 3.6: Node-side parity test for the SynthMorph registration chain.
//
// Drives the full stack end-to-end via onnxruntime-node:
//
//   1. Load the lnm-mni160 reference target (160x160x192 1mm MNI152).
//   2. Downsample it to the manifest's browserRuntime.inputDims.
//   3. Run SynthMorph ONNX with (source = target = downsampled reference) — the
//      identity case. The model has been trained with regularisation
//      that pulls the velocity field toward zero, so a self-pair should
//      produce a near-zero SVF.
//   4. integrateSvf(svf, browserRuntime.svfDims, 7) -> low-res displacement.
//      Should be near-zero.
//   5. upsampleDisplacementField -> full-res 160x160x192x3.
//      Should be near-zero.
//   6. warpVolume(reference, fullDims, displacement, fullDims) -> warped.
//      Should be near-bit-equivalent to the reference (boundary +
//      interpolation noise gives sub-1% per-voxel error).
//
// Plausibility-only: not asserting Dice against a held-out registered
// pair. Real-T1 deformable parity needs a manually-pre-aligned T1
// fixture and a reference warp from FreeSurfer's mri_synthmorph CLI;
// that's out of scope for the offline test gate.
//
// Run: npm run test:registration-parity   (NOT in `npm test`)

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(
  await fs.readFile(path.join(ROOT, 'web/models/manifest.json'), 'utf8')
);
const MODEL_ASSET = MANIFEST.modelAssets.find(a => a.id === 'lnm-synthmorph-mni');
if (!MODEL_ASSET) throw new Error("manifest missing modelAsset 'lnm-synthmorph-mni'");
const RUNTIME = MODEL_ASSET.browserRuntime || {};
const MODEL_DIMS = RUNTIME.inputDims || MODEL_ASSET.inputShape?.slice(1, 4);
const SVF_DIMS = RUNTIME.svfDims || MODEL_ASSET.svfShape?.slice(1, 4);
if (!Array.isArray(MODEL_DIMS) || MODEL_DIMS.length !== 3) {
  throw new Error('lnm-synthmorph-mni missing browser input dims');
}
if (!Array.isArray(SVF_DIMS) || SVF_DIMS.length !== 3) {
  throw new Error('lnm-synthmorph-mni missing browser SVF dims');
}
const MODEL_CACHE_DIR = path.join(ROOT, 'web/models/_dev_cache');
const MODEL_CACHE = path.join(MODEL_CACHE_DIR, path.basename(MODEL_ASSET.filename));
const MODEL_URL = MODEL_ASSET.sourceUrl;
const REF_CACHE = path.join(MODEL_CACHE_DIR, 'lnm-mni160.nii.gz');
const REF_URL =
  'https://huggingface.co/datasets/sbollmann/lnm-webapp-models' +
  '/resolve/main/templates/lnm-mni160.nii.gz';

async function ensureFile(cachePath, url, minBytes, label) {
  try {
    const buf = await fs.readFile(cachePath);
    if (buf.length > minBytes) return buf;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  console.log(`Downloading ${label} from ${url}...`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label} download failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < minBytes) {
    throw new Error(`${label} unexpectedly small: ${buf.length} bytes`);
  }
  await fs.writeFile(cachePath, buf);
  console.log(`Cached: ${cachePath} (${buf.length} bytes)`);
  return buf;
}

async function decodeReference(bytes) {
  const niftiMod = await import('nifti-reader-js');
  const nifti = niftiMod.default || niftiMod;
  let buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buf = nifti.decompress(buf);
  if (!nifti.isNIFTI(buf)) throw new Error('Reference is not a NIfTI');
  const header = nifti.readHeader(buf);
  const image = nifti.readImage(header, buf);
  const off = image.byteOffset || 0;
  const data = new Float32Array(image, off);
  return { data: Float32Array.from(data), dims: [160, 160, 192] };
}

function fOrderToNDHWC(fdata, dims) {
  const [X, Y, Z] = dims;
  const out = new Float32Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++)
        out[(x * Y + y) * Z + z] = fdata[x + y * X + z * X * Y];
  return out;
}

(async () => {
  console.log('Loading model + reference...');
  const modelBuf = await ensureFile(MODEL_CACHE, MODEL_URL, 50_000_000, 'SynthMorph SVF model');
  const refBytes = await ensureFile(REF_CACHE, REF_URL, 5_000_000, 'lnm-mni160 reference');

  const ref = await decodeReference(refBytes);
  console.log(`Reference: ${ref.dims.join('x')}, ${ref.data.length.toLocaleString()} voxels`);
  assert.deepEqual(ref.dims, [160, 160, 192]);

  const { resampleVolume } = await import('../web/js/modules/volume-utils.js');
  const modelSpacing = ref.dims.map((dim, i) => dim / MODEL_DIMS[i]);
  const modelRef = resampleVolume(ref.data, ref.dims, [1, 1, 1], modelSpacing);
  assert.deepEqual(modelRef.dims, MODEL_DIMS);
  console.log(`Browser model grid: ${MODEL_DIMS.join('x')} -> SVF ${SVF_DIMS.join('x')}`);

  console.log('Building ONNX session (CPU EP)...');
  const session = await ort.InferenceSession.create(modelBuf, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  });
  const inputNames = session.inputNames;
  const outputName = session.outputNames[0];
  console.log(`session ready (inputs=${inputNames.join(',')}, output=${outputName})`);

  // Source = target = downsampled reference: the model should output ~zero SVF.
  const refNHWC = fOrderToNDHWC(modelRef.data, MODEL_DIMS);
  const tA = new ort.Tensor('float32', refNHWC, [1, ...MODEL_DIMS, 1]);
  const tB = new ort.Tensor('float32', refNHWC, [1, ...MODEL_DIMS, 1]);

  console.log('Running SynthMorph forward...');
  const t0 = Date.now();
  const out = await session.run({ [inputNames[0]]: tA, [inputNames[1]]: tB });
  const svfTensor = out[outputName];
  const svf = svfTensor.data;
  const elapsed = (Date.now() - t0) / 1000;
  console.log(
    `forward in ${elapsed.toFixed(1)}s; SVF length=${svf.length.toLocaleString()}; ` +
    `dims=${svfTensor.dims.join('x')}`
  );
  assert.deepEqual(svfTensor.dims.slice(1, 4), SVF_DIMS);

  let svfMax = 0, svfSumAbs = 0;
  for (let i = 0; i < svf.length; i++) {
    const a = Math.abs(svf[i]);
    if (a > svfMax) svfMax = a;
    svfSumAbs += a;
  }
  const svfMean = svfSumAbs / svf.length;
  console.log(`SVF: |max|=${svfMax.toFixed(4)} mean|.|=${svfMean.toFixed(4)}`);

  // Integrate + upsample.
  const { integrateSvf, upsampleDisplacementField, warpVolume } =
    await import('../web/js/modules/registration.js');
  console.log('Integrating SVF (scaling-and-squaring, 7 steps)...');
  const halfDisp = integrateSvf(svf, SVF_DIMS, 7);
  console.log('Upsampling to full resolution...');
  const fullDisp = upsampleDisplacementField(halfDisp, SVF_DIMS, [160, 160, 192]);

  let dispMax = 0, dispSumAbs = 0;
  for (let i = 0; i < fullDisp.length; i++) {
    const a = Math.abs(fullDisp[i]);
    if (a > dispMax) dispMax = a;
    dispSumAbs += a;
  }
  const dispMean = dispSumAbs / fullDisp.length;
  console.log(`Full displacement: |max|=${dispMax.toFixed(4)} mean|.|=${dispMean.toFixed(4)}`);

  // Warp the reference; expect near-bit-equivalent output.
  console.log('Warping reference through the integrated displacement...');
  const warped = warpVolume(ref.data, ref.dims, fullDisp, ref.dims);

  let warpDiffMax = 0, warpSse = 0, warpN = 0;
  for (let z = 8; z < 152; z++) {
    for (let y = 8; y < 152; y++) {
      for (let x = 8; x < 184; x++) {
        const i = x + y * 160 + z * 160 * 160;
        const d = warped[i] - ref.data[i];
        if (Math.abs(d) > warpDiffMax) warpDiffMax = Math.abs(d);
        warpSse += d * d;
        warpN += 1;
      }
    }
  }
  const warpRmse = Math.sqrt(warpSse / warpN);
  console.log(`Warp interior: |max diff|=${warpDiffMax.toFixed(4)} RMSE=${warpRmse.toFixed(5)}`);

  // ---- Plausibility gates ----
  // Self-pair SVF magnitudes should be small. Empirically the SynthMorph
  // brains model produces |max| ~ a few voxels of regularisation noise on
  // an identity self-pair. We assert <= 2 voxels, mean <= 0.5.
  assert.ok(svfMax < 2.0, `SVF |max| should be <2 voxels for self-pair; got ${svfMax}`);
  assert.ok(svfMean < 0.5, `SVF mean|.| should be <0.5; got ${svfMean}`);

  // Integrated displacement bounded similarly; +slight growth from
  // composition, so allow up to 4.
  assert.ok(dispMax < 4.0, `displacement |max| should be <4 voxels; got ${dispMax}`);

  // Warp interior should be within 5% of the reference dynamic range
  // (reference is normalised to [0, 1]; 5% = 0.05 RMSE upper bound).
  assert.ok(warpRmse < 0.05, `warp RMSE should be <0.05; got ${warpRmse}`);

  console.log(
    'Registration parity OK: SynthMorph self-pair produces near-zero SVF; ' +
    'integrate + upsample + warp chain reproduces the reference within tolerance.'
  );
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
