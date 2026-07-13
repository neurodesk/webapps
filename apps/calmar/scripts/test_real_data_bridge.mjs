#!/usr/bin/env node --no-warnings
// Phase 18: real-data integration test for the prealign + bridge chain.
//
// The unit tests cover the resample math on synthetic phantoms and the
// prealign math on synthetic centroids. This test connects the two on
// real anatomical shape (a chronic stroke lesion in the
// `ds004884-mini` fixture, dims 160x256x256 1mm) so a regression in
// either module that fires only on real-shaped data surfaces here.
//
// Pipeline exercised (no ML models needed):
//   1. Decode the ds004884 lesion NIfTI.
//   2. Compute the lesion centroid + transform to source world coords.
//   3. Build the prealign destination affine via computePrealignAffine
//      (centroid -> MNI160 voxel (80, 80, 96)).
//   4. Resample the lesion onto MNI160 1mm via resampleAffine + nearest.
//   5. Resample again onto the Yeo7 99x117x95 2mm grid with its
//      canonical FSL affine (cite of MNI152NLin2009cAsym 2mm).
//   6. Assert each step preserves a non-trivial fraction of the source
//      lesion (real strokes shouldn't vanish under resample).
//
// Note: the lesion centroid is biased toward the stroke territory (left
// hemisphere) — using it as the prealign anchor is not anatomically
// correct, but it is a deterministic, well-defined input that exercises
// the same code path as a real brain centroid.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LESION_PATH = path.join(ROOT, 'tests/fixtures/ds004884-mini/lesion_mask.nii.gz');
const YEO7_PATH = path.join(ROOT, 'tests/fixtures/yeo7-mini/atlas.nii.gz');

const { centroidOfMask, applyAffineToVoxel, computePrealignAffine } =
  await import(path.join(ROOT, 'web/js/modules/prealign.js'));
const { resampleAffine } =
  await import(path.join(ROOT, 'web/js/modules/resample.js'));
const { computeParcelOverlap, summarizeNetworkOverlap } =
  await import(path.join(ROOT, 'web/js/modules/parcel-overlap.js'));

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
    default:
      throw new Error(`Unsupported NIfTI datatype: ${header.datatypeCode}`);
  }
}

async function decodeFile(filePath) {
  const bytes = await fs.readFile(filePath);
  const nifti = await loadNiftiParser();
  // Buffer -> ArrayBuffer slice.
  let buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    buf = nifti.decompress(buf);
  }
  if (!nifti.isNIFTI(buf)) {
    throw new Error(`Not a NIfTI file: ${filePath}`);
  }
  const header = nifti.readHeader(buf);
  const imageBuffer = nifti.readImage(header, buf);
  const data = typedArrayForImage(nifti, header, imageBuffer);
  const dims = [
    Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])
  ];
  return { data, dims, affine: header.affine };
}

const lesion = await decodeFile(LESION_PATH);
console.log(
  `lesion dims=${lesion.dims.join('x')}, ` +
  `affine[0][0]=${lesion.affine[0][0].toFixed(3)}, ` +
  `dtype=${lesion.data.constructor.name}`
);
assert.deepEqual(lesion.dims, [160, 256, 256],
  'ds004884 lesion fixture must be 160x256x256 1mm — did the SOURCE.md change?');

// Force lesion to Uint8 — the SOURCE.md says it's stored as uint8, but the
// decode path produces whatever the on-disk dtype is.
const lesionU8 = lesion.data instanceof Uint8Array
  ? lesion.data
  : (() => { const u = new Uint8Array(lesion.data.length);
             for (let i = 0; i < u.length; i++) u[i] = lesion.data[i] > 0 ? 1 : 0;
             return u; })();
let srcCount = 0;
for (let i = 0; i < lesionU8.length; i++) srcCount += lesionU8[i];
console.log(`Source lesion voxels: ${srcCount.toLocaleString()}`);
// SOURCE.md cites 130,972 voxels. Fixture rebuild may shift by a few
// hundred (different resample interpolation), so accept a wide window.
assert.ok(srcCount > 100_000 && srcCount < 200_000,
  `Source lesion voxel count out of expected range: ${srcCount}`);

// ---- Step 1+2: lesion centroid -> world ----
const centroidVox = centroidOfMask(lesionU8, lesion.dims);
const centroidWorld = applyAffineToVoxel(lesion.affine, centroidVox);
console.log(
  `Lesion centroid: voxel (${centroidVox.map(v => v.toFixed(1)).join(', ')}) ` +
  `-> world (${centroidWorld.map(v => v.toFixed(1)).join(', ')}) mm`
);

// ---- Step 3: prealign affine ----
const mniDims = [160, 160, 192];
const mniAffine = computePrealignAffine(centroidWorld);

// ---- Step 4: lesion -> MNI160 1mm ----
const lesionMni = resampleAffine(
  lesionU8, lesion.dims, lesion.affine, mniDims, mniAffine, 'nearest'
);
let mniCount = 0;
for (let i = 0; i < lesionMni.length; i++) mniCount += lesionMni[i];
console.log(`MNI160 1mm lesion voxels: ${mniCount.toLocaleString()}`);
// Source is at 1mm; target is at 1mm with -x flip + centroid translation.
// Expect roughly the same count (within 10%) since we're just shifting +
// flipping. Some boundary loss is normal.
assert.ok(mniCount > srcCount * 0.85 && mniCount < srcCount * 1.15,
  `MNI160 voxel count drifted too far: ${mniCount} vs ${srcCount} ` +
  `(allowed ±15% for 1mm->1mm resample)`);
// Centroid in MNI160 voxel space should be near (80, 80, 96) by construction.
let cx = 0, cy = 0, cz = 0, n = 0;
for (let z = 0; z < mniDims[2]; z++)
  for (let y = 0; y < mniDims[1]; y++)
    for (let x = 0; x < mniDims[0]; x++) {
      if (lesionMni[x + y * mniDims[0] + z * mniDims[0] * mniDims[1]]) {
        cx += x; cy += y; cz += z; n++;
      }
    }
cx /= n; cy /= n; cz /= n;
console.log(
  `MNI160 lesion centroid: voxel (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)}) ` +
  `(target 80, 80, 96)`
);
assert.ok(Math.abs(cx - 80) < 1, `MNI160 cx ${cx}`);
assert.ok(Math.abs(cy - 80) < 1, `MNI160 cy ${cy}`);
assert.ok(Math.abs(cz - 96) < 1, `MNI160 cz ${cz}`);

// ---- Step 5: lesion MNI160 -> Yeo grid ----
// Canonical Yeo7 99x117x95 2mm affine (FSL MNI152NLin2009cAsym 2mm).
const yeoDims = [99, 117, 95];
const yeoAffine = [
  [-2, 0, 0, 98],
  [0, 2, 0, -134],
  [0, 0, 2, -72],
  [0, 0, 0, 1]
];
const lesionYeo = resampleAffine(
  lesionMni, mniDims, mniAffine, yeoDims, yeoAffine, 'nearest'
);
let yeoCount = 0;
for (let i = 0; i < lesionYeo.length; i++) yeoCount += lesionYeo[i];
console.log(`Yeo7 2mm lesion voxels: ${yeoCount.toLocaleString()}`);
// 1mm -> 2mm = 1/8 voxel-volume; expect roughly mniCount/8.
const expectedYeo = mniCount / 8;
assert.ok(yeoCount > expectedYeo * 0.5 && yeoCount < expectedYeo * 1.5,
  `Yeo voxel count out of expected window: ${yeoCount} ` +
  `(expected ~${Math.round(expectedYeo)})`);

// ---- Step 6: Yeo7 parcel overlap on the real-shaped lesion ----
// Loads the committed Yeo7 atlas fixture so this stage runs in CI
// without a network round-trip.
const atlas = await decodeFile(YEO7_PATH);
console.log(
  `\nYeo7 atlas: dims=${atlas.dims.join('x')}, ` +
  `dtype=${atlas.data.constructor.name}`
);
assert.deepEqual(atlas.dims, [99, 117, 95],
  'Yeo7 atlas fixture must be 99x117x95 (MNI152 2mm)');

// computeParcelOverlap expects a Uint8 lesion mask. lesionYeo is already
// Uint8 by construction (resampleAffine on a Uint8 source + nearest mode).
// The atlas is int16; the reducer accepts any integer-typed atlas array.
const parcelToNetwork = {
  1: 'Visual', 2: 'Somatomotor', 3: 'DorsalAttention',
  4: 'VentralAttention', 5: 'Limbic', 6: 'Frontoparietal', 7: 'Default'
};
const parcelResult = computeParcelOverlap({
  lesion: lesionYeo,
  atlas: atlas.data,
  dims: yeoDims
});
const summary = summarizeNetworkOverlap(parcelResult, parcelToNetwork);
console.log(
  `Network overlap (real ds004884 stroke). totalLesionVoxels=${summary.totalLesionVoxels}, ` +
  `outsideAtlas=${parcelResult.voxelsOutsideAtlas}:`
);
let networksHit = 0;
let networksTotal = 0;
for (const row of summary.networks) {
  console.log(
    `  ${row.network.padEnd(18)} voxels=${String(row.voxelsInLesion).padStart(6)} ` +
    `(${(row.fractionOfLesion * 100).toFixed(1)}% of lesion)`
  );
  if (row.voxelsInLesion > 0 && row.network !== 'Unassigned') networksHit++;
  networksTotal += row.voxelsInLesion;
}
// A real chronic stroke should hit at least 2 networks (most strokes
// span vascular territories that cross network boundaries).
assert.ok(networksHit >= 2,
  `Real stroke should overlap >= 2 Yeo networks; got ${networksHit}`);
// Network sums + out-of-atlas voxels must total the Yeo-grid lesion count.
assert.equal(networksTotal + parcelResult.voxelsOutsideAtlas, yeoCount,
  `network voxels (${networksTotal}) + outsideAtlas (${parcelResult.voxelsOutsideAtlas}) ` +
  `should equal yeoCount (${yeoCount})`);

// Phase 30: parity gate against the pinned JSON fixture. Catches a
// silent regression in resampleAffine / computePrealignAffine /
// computeParcelOverlap that shifts overlaps without crashing.
const expectedPath = path.join(ROOT, 'tests/fixtures/ds004884-mini/expected_yeo_overlap.json');
const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8'));
const tol = expected.tolerance;

function assertWithinAbs(name, actual, expectedVal, allowed) {
  const diff = Math.abs(actual - expectedVal);
  assert.ok(diff <= allowed,
    `${name} drifted: actual=${actual}, expected=${expectedVal}, diff=${diff} > ${allowed}`);
}

assertWithinAbs('totals.sourceLesionVoxels', srcCount, expected.totals.sourceLesionVoxels, tol.totalsAbsDiff);
assertWithinAbs('totals.mniLesionVoxels', mniCount, expected.totals.mniLesionVoxels, tol.totalsAbsDiff);
assertWithinAbs('totals.yeoLesionVoxels', yeoCount, expected.totals.yeoLesionVoxels, tol.totalsAbsDiff);
assertWithinAbs('totals.voxelsOutsideAtlas', parcelResult.voxelsOutsideAtlas,
  expected.totals.voxelsOutsideAtlas, tol.totalsAbsDiff);

const expCentroid = expected.centroidMni160Voxel;
const actCentroid = [cx, cy, cz];
for (let i = 0; i < 3; i++) {
  assertWithinAbs(`centroidMni160Voxel[${i}]`, actCentroid[i], expCentroid[i], tol.centroidAxisDiff);
}

// Per-network voxel counts. Tolerance is max(absFloor, relDiff * expected)
// — proportional rather than flat-absolute, so a small network like Visual
// (~125 voxels) doesn't get 20% slack while Limbic (~1900) gets 1.3%.
const actNetworks = Object.fromEntries(
  summary.networks.map(n => [n.network, n.voxelsInLesion])
);
for (const [name, expectedVoxels] of Object.entries(expected.networks)) {
  const actualVoxels = actNetworks[name] || 0;
  const allowed = Math.max(tol.networkAbsFloor, Math.ceil(tol.networkRelDiff * expectedVoxels));
  assertWithinAbs(`networks.${name}`, actualVoxels, expectedVoxels, allowed);
}

console.log(
  `\nreal-data bridge OK: lesion ${srcCount.toLocaleString()} src ` +
  `-> ${mniCount.toLocaleString()} MNI160 ` +
  `-> ${yeoCount.toLocaleString()} Yeo7 ` +
  `-> ${networksHit} Yeo networks hit. ` +
  `Centroid round-trip within 1 voxel. ` +
  `Phase 30 parity gate (Dice-style absolute-diff thresholds) passed.`
);
