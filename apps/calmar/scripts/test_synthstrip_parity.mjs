#!/usr/bin/env node --no-warnings
// Phase 2a.1.4c: Node-side parity test for the SynthStrip port.
//
// Drives runSynthStrip from web/js/modules/brain-extraction.js on a real
// anatomical T1 (the MNI152NLin2009cAsym 2mm template under
// tests/fixtures/synthstrip-mini/), backed by onnxruntime-node so we can
// validate the JS port end-to-end without a browser. The test:
//
//   1. Decodes the T1 NIfTI via the same code path the browser uses
//      (web/js/modules/atlas-loader.js -> decodeNiftiBuffer).
//   2. Loads the SynthStrip ONNX model, downloading from Hugging Face on
//      first run, then caching to web/models/_dev_cache/synthstrip.onnx.
//   3. Runs runSynthStrip with executionProviders=['cpu'] and fast=true
//      (target spacing 2mm — matches input — so the resample step is a
//      no-op and the test stays well under the CI 10-minute clock).
//   4. Asserts the produced mask is *plausible*: > 1000 voxels, coverage
//      between 10% and 95% of the volume, centroid within 15 voxels of
//      the image centre per axis, exactly 1 connected component (the
//      largest-CC + fill step in runSynthStrip is supposed to enforce
//      this by construction).
//   5. Runs the same fast-mode code path used by the browser app on the
//      ds004884 1mm clinical T1 fixture and asserts the mask is not
//      overgrown. This catches the production failure where the model
//      looked successful but visibly included skull/non-brain tissue.
//
// Plausibility checks rather than byte-exact parity vs FreeSurfer's
// `mri_synthstrip` reference because we don't ship a FreeSurfer dep. The
// 2a.1.5 browser smoke test is where a user can drop their own raw T1
// for visual quality validation.
//
// NOT in `npm test`. Run via `npm run test:synthstrip-parity` after
// `npm install`.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_T1 = path.join(ROOT, 'tests/fixtures/synthstrip-mini/T1.nii.gz');
const CLINICAL_T1 = path.join(ROOT, 'tests/fixtures/ds004884-mini/T1.nii.gz');
const MODEL_CACHE_DIR = path.join(ROOT, 'web/models/_dev_cache');
const MODEL_CACHE = path.join(MODEL_CACHE_DIR, 'synthstrip.onnx');
const MODEL_URL =
  'https://huggingface.co/datasets/sbollmann/lnm-webapp-models' +
  '/resolve/main/models/synthstrip.onnx';

async function ensureModel() {
  try {
    const buf = await fs.readFile(MODEL_CACHE);
    if (buf.length > 1_000_000) return buf;
    // Otherwise fall through and re-download.
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.mkdir(MODEL_CACHE_DIR, { recursive: true });
  console.log(`Downloading SynthStrip model from ${MODEL_URL}...`);
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`Model download failed: HTTP ${response.status}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 1_000_000) {
    throw new Error(`Downloaded model is unexpectedly small: ${buf.length} bytes`);
  }
  await fs.writeFile(MODEL_CACHE, buf);
  console.log(`Cached: ${MODEL_CACHE} (${buf.length} bytes)`);
  return buf;
}

// Use nifti-reader-js directly via the npm package. The browser code path
// goes through web/js/modules/atlas-loader.js, but its dynamic
// `import('../nifti-js/index.js')` resolves relative to the *served* root
// in the browser (where it is correct) and is wrong in Node ESM where
// imports resolve relative to the source file. Bypassing.
async function loadNiftiParser() {
  const mod = await import('nifti-reader-js');
  return mod.default || mod;
}

function typedArrayForImage(nifti, header, imageBuffer) {
  const off = imageBuffer.byteOffset || 0;
  switch (header.datatypeCode) {
    case nifti.NIFTI1.TYPE_UINT8:   return new Uint8Array(imageBuffer, off);
    case nifti.NIFTI1.TYPE_INT16:   return new Int16Array(imageBuffer, off);
    case nifti.NIFTI1.TYPE_INT32:   return new Int32Array(imageBuffer, off);
    case nifti.NIFTI1.TYPE_FLOAT32: return new Float32Array(imageBuffer, off);
    case nifti.NIFTI1.TYPE_FLOAT64: return new Float64Array(imageBuffer, off);
    case nifti.NIFTI1.TYPE_INT8:    return new Int8Array(imageBuffer, off);
    case nifti.NIFTI1.TYPE_UINT16:  return new Uint16Array(imageBuffer, off);
    case nifti.NIFTI1.TYPE_UINT32:  return new Uint32Array(imageBuffer, off);
    default:
      throw new Error(`Unsupported NIfTI dtype code ${header.datatypeCode}`);
  }
}

async function decodeT1Fixture(filePath = FIXTURE_T1) {
  const t1Bytes = await fs.readFile(filePath);
  let buf = t1Bytes.buffer.slice(
    t1Bytes.byteOffset,
    t1Bytes.byteOffset + t1Bytes.byteLength
  );

  const nifti = await loadNiftiParser();
  // gzip magic
  if (t1Bytes[0] === 0x1f && t1Bytes[1] === 0x8b) {
    buf = nifti.decompress(buf);
  }
  if (!nifti.isNIFTI(buf)) {
    throw new Error('Fixture is not a valid NIfTI file');
  }
  const header = nifti.readHeader(buf);
  const imageBuffer = nifti.readImage(header, buf);
  const raw = typedArrayForImage(nifti, header, imageBuffer);

  const rasData = raw instanceof Float32Array ? raw : Float32Array.from(raw);

  const dimCount = Number(header.dims[0]);
  if (!(dimCount === 3 || (dimCount === 4 && Number(header.dims[4]) === 1))) {
    throw new Error(`Unsupported NIfTI dim layout: ${header.dims.join('x')}`);
  }
  const rasDims = [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])];
  const rasSpacing = [Number(header.pixDims[1]), Number(header.pixDims[2]), Number(header.pixDims[3])];

  return { rasData, rasDims, rasSpacing };
}

function computeCentroid(mask, dims) {
  const [nx, ny, nz] = dims;
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (mask[x + y * nx + z * nx * ny]) {
          sx += x; sy += y; sz += z; n += 1;
        }
      }
    }
  }
  return n > 0 ? [sx / n, sy / n, sz / n, n] : [0, 0, 0, 0];
}

function computeMaskStats(mask, dims) {
  const [nx, ny, nz] = dims;
  let sx = 0, sy = 0, sz = 0, n = 0;
  const min = [nx, ny, nz];
  const max = [-1, -1, -1];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!mask[x + y * nx + z * nx * ny]) continue;
        sx += x; sy += y; sz += z; n += 1;
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
  }
  return {
    voxelCount: n,
    centroid: n > 0 ? [sx / n, sy / n, sz / n] : [0, 0, 0],
    bboxMin: min,
    bboxMax: max,
    bboxSize: n > 0 ? max.map((v, i) => v - min[i] + 1) : [0, 0, 0]
  };
}

(async () => {
  console.log('Loading model...');
  const modelBuf = await ensureModel();
  const modelArrayBuffer = modelBuf.buffer.slice(
    modelBuf.byteOffset,
    modelBuf.byteOffset + modelBuf.byteLength
  );
  console.log(`Model: ${modelBuf.length} bytes`);

  console.log(`Loading T1 fixture: ${path.relative(ROOT, FIXTURE_T1)}`);
  const { rasData, rasDims, rasSpacing } = await decodeT1Fixture();
  console.log(
    `T1: ${rasDims.join('x')} @ ${rasSpacing.map(s => s.toFixed(2)).join('x')}mm, ` +
    `${rasData.length.toLocaleString()} voxels`
  );

  console.log('Running SynthStrip (onnxruntime-node, CPU EP, fast mode)...');
  const { runSynthStrip } = await import('../web/js/modules/brain-extraction.js');
  const t0 = Date.now();
  const result = await runSynthStrip({
    rasData,
    rasDims,
    rasSpacing,
    modelArrayBuffer,
    ort,
    executionProviders: ['cpu'],
    fast: true,
    dilate: false,
    onLog: (msg) => console.log(`  [synthstrip] ${msg}`)
  });
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`SynthStrip ran in ${elapsed.toFixed(1)}s`);

  const total = rasData.length;
  const coverage = result.voxelCount / total;
  const [cx, cy, cz] = computeCentroid(result.mask, rasDims);
  const imageCentre = [rasDims[0] / 2, rasDims[1] / 2, rasDims[2] / 2];

  console.log(
    `Mask: ${result.voxelCount.toLocaleString()}/${total.toLocaleString()} voxels ` +
    `(${(coverage * 100).toFixed(1)}% coverage)`
  );
  console.log(
    `Centroid: [${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)}]; ` +
    `image centre: [${imageCentre.map(c => c.toFixed(1)).join(', ')}]`
  );

  // ---- plausibility ----
  // Tightened (Phase 33 audit). Earlier 10-95% coverage + 15-voxel
  // centroid drift would silently pass a partial-hemisphere mask. The
  // MNI152 template is already mostly skull-stripped (only the
  // neurocranium remains); SynthStrip on this fixture observes:
  //   - coverage: ~24% of the conformed 192^3 volume
  //   - centroid drift: ~7 voxels on z (the template's brain sits
  //     inferior of the volume centre because the FOV includes some
  //     superior neck/cervical)
  // Gates set just outside those observations to catch real
  // regressions without being noise-sensitive.
  assert.ok(result.voxelCount > 50_000,
    `mask is implausibly small (likely model failure): ${result.voxelCount} voxels`);
  assert.ok(coverage > 0.18,
    `coverage too low: ${(coverage * 100).toFixed(1)}% (expected >18%; ` +
    `would catch a ~hemisphere or partial-cortex mask)`);
  assert.ok(coverage < 0.60,
    `coverage too high: ${(coverage * 100).toFixed(1)}% (expected <60%; ` +
    `would catch a model that failed to crop background entirely)`);

  // Centroid drift: 10 voxels on the conformed 1mm grid = 1cm. The MNI
  // template's brain centroid sits ~7 voxels inferior of the volume
  // centre on z (template FOV includes superior neck), so the gate has
  // to accommodate that. 10 voxels still catches "centroid in a
  // hemisphere" or a 2cm misalignment.
  for (const [axis, axisName] of [[0, 'x'], [1, 'y'], [2, 'z']]) {
    const observed = [cx, cy, cz][axis];
    const expected = imageCentre[axis];
    const drift = Math.abs(observed - expected);
    assert.ok(drift < 10,
      `centroid axis ${axisName} drifted too far from image centre: ` +
      `${observed.toFixed(1)} vs ${expected.toFixed(1)} (drift ${drift.toFixed(1)} voxels; gate <10)`);
  }

  const { connectedComponents3D } = await import('../web/js/modules/volume-utils.js');
  const cc = connectedComponents3D(result.mask, rasDims);
  assert.equal(cc.numComponents, 1,
    `expected exactly 1 connected component after largest-CC + fill, got ${cc.numComponents}`);

  console.log(
    'SynthStrip parity OK: end-to-end pipeline runs on a real T1; ' +
    'mask is plausible (size, coverage, centroid, single CC).'
  );

  console.log(`\n[clinical fast-mode case] ${path.relative(ROOT, CLINICAL_T1)}`);
  const clinical = await decodeT1Fixture(CLINICAL_T1);
  console.log(
    `Clinical T1: ${clinical.rasDims.join('x')} @ ` +
    `${clinical.rasSpacing.map(s => s.toFixed(2)).join('x')}mm, ` +
    `${clinical.rasData.length.toLocaleString()} voxels`
  );
  assert.deepEqual(clinical.rasDims, [160, 256, 256],
    'clinical regression fixture must stay on the 160x256x256 1mm grid');

  const clinicalResult = await runSynthStrip({
    rasData: clinical.rasData,
    rasDims: clinical.rasDims,
    rasSpacing: clinical.rasSpacing,
    modelArrayBuffer,
    ort,
    executionProviders: ['cpu'],
    fast: true,
    dilate: false,
    onLog: (msg) => console.log(`  [clinical] ${msg}`)
  });
  const clinicalStats = computeMaskStats(clinicalResult.mask, clinical.rasDims);
  const clinicalCoverage = clinicalResult.voxelCount / clinical.rasData.length;
  console.log(
    `Clinical mask: ${clinicalResult.voxelCount.toLocaleString()}/${clinical.rasData.length.toLocaleString()} ` +
    `(${(clinicalCoverage * 100).toFixed(2)}% coverage), ` +
    `centroid=[${clinicalStats.centroid.map(v => v.toFixed(1)).join(', ')}], ` +
    `bboxSize=[${clinicalStats.bboxSize.join(', ')}]`
  );

  assert.ok(clinicalResult.voxelCount < 2_000_000,
    `clinical fast-mode mask is overgrown: ${clinicalResult.voxelCount.toLocaleString()} voxels ` +
    '(expected <2,000,000 on ds004884 1mm T1)');
  assert.ok(clinicalCoverage < 0.20,
    `clinical fast-mode coverage is too high: ${(clinicalCoverage * 100).toFixed(2)}% (expected <20%)`);
  assert.ok(clinicalStats.bboxSize[1] <= 180 && clinicalStats.bboxSize[2] <= 165,
    `clinical fast-mode bbox is too large: [${clinicalStats.bboxSize.join(', ')}] ` +
    '(expected y<=180 and z<=165)');

  console.log('Clinical SynthStrip regression OK: fast-mode mask is not overgrown.');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
