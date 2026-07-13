#!/usr/bin/env node --no-warnings

// Asserts the NiiVue label LUT builder emits a step LUT — each label index
// gets a stop at the integer plus a second stop just below the next index,
// holding the color flat across (i, i+1). Without the second stop, NiiVue
// linearly interpolates between adjacent label colors and smears one
// vertebra into its neighbour at sub-voxel boundaries.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { generateNiivueColormap } = await import(pathToFileURL(path.join(ROOT, 'web/js/app/labels.js')));

const lut = generateNiivueColormap('vertebrae');

// 12 labels (background + 11 vertebrae). Step LUT adds a held stop between
// every consecutive pair of indices, so we expect 12 + 11 = 23 entries.
assert.equal(lut.I.length, 23, `expected 23 LUT stops, got ${lut.I.length}`);
assert.equal(lut.R.length, lut.I.length, 'R/I length mismatch');
assert.equal(lut.G.length, lut.I.length, 'G/I length mismatch');
assert.equal(lut.B.length, lut.I.length, 'B/I length mismatch');
assert.equal(lut.A.length, lut.I.length, 'A/I length mismatch');

assert.equal(lut.min, 0);
assert.equal(lut.max, 11);
assert.equal(lut.I.at(0), 0);
assert.equal(lut.I.at(-1), 255);

// Each label index is followed by a held stop just below the next index,
// painted with the same color. That keeps NiiVue from interpolating across
// vertebrae.
for (let i = 0; i < lut.I.length - 1; i += 2) {
  const labelIndex = i / 2;
  const indexAtStart = lut.I[i];
  const indexBeforeNext = lut.I[i + 1];
  const expectedStart = (labelIndex / 11) * 255;
  const expectedNext = ((labelIndex + 1) / 11) * 255;
  assert.ok(Math.abs(indexAtStart - expectedStart) < 1e-9, `LUT[${i}] should scale label ${labelIndex} to ${expectedStart}, got ${indexAtStart}`);
  assert.ok(indexBeforeNext > indexAtStart, `held stop must come after label ${labelIndex} start`);
  assert.ok(indexBeforeNext < expectedNext, `held stop must come before next label ${labelIndex + 1}`);
  assert.equal(lut.R[i], lut.R[i + 1], `R held flat across label ${indexAtStart}`);
  assert.equal(lut.G[i], lut.G[i + 1], `G held flat across label ${indexAtStart}`);
  assert.equal(lut.B[i], lut.B[i + 1], `B held flat across label ${indexAtStart}`);
}

// The spinalcord label set has only 2 labels (background + cord). Step LUT
// rule still applies: 2 + 1 held stop = 3 entries.
const cordLut = generateNiivueColormap('spinalcord');
assert.equal(cordLut.I.length, 3, 'spinalcord step LUT: 2 labels + 1 held stop');
assert.equal(cordLut.max, 1);
assert.equal(cordLut.I.at(0), 0);
assert.equal(cordLut.I.at(-1), 255);

// Regression: NiiVue's `makeLut()` rounds `I` through `Uint8ClampedArray`
// before painting the GPU LUT. If the held stop and the next label start
// round to the same Uint8 bucket, the resulting LUT segment has zero range
// and produces NaN (divide-by-zero) clamped to 0, leaving the binary
// spinalcord overlay entirely transparent. The held stop and the label start
// MUST therefore land on distinct integer buckets after Uint8 rounding.
// (Vertebrae 12-label LUT silently masks this bug — its later iterations
// overwrite the corrupted bucket — so spinalcord is the canary.)
for (let i = 0; i < cordLut.I.length - 1; i++) {
  const lo = Math.round(cordLut.I[i]);
  const hi = Math.round(cordLut.I[i + 1]);
  assert.notEqual(lo, hi,
    `spinalcord LUT stops ${cordLut.I[i]} and ${cordLut.I[i + 1]} both round to Uint8 ${lo}; ` +
    `held stop must round to a distinct bucket from the next label start, otherwise NiiVue ` +
    `produces an all-transparent LUT and the segmentation overlay disappears.`);
}

// Stronger end-to-end check: simulate `Uint8ClampedArray.from(I)` and walk
// the same segment-fill loop NiiVue's `makeLut` runs. If any LUT bucket up
// to the highest label index ends with non-zero alpha equal to the cord's
// labelled colour, the overlay is visible.
const Is = Array.from(Uint8ClampedArray.from(cordLut.I));
let cordVisible = false;
for (let i = 0; i < Is.length - 1; i++) {
  const idxLo = Is[i];
  const idxHi = Is[i + 1];
  const range = idxHi - idxLo;
  if (range <= 0) continue;
  for (let j = idxLo; j <= idxHi; j++) {
    const f = (j - idxLo) / range;
    const r = cordLut.R[i] + f * (cordLut.R[i + 1] - cordLut.R[i]);
    const g = cordLut.G[i] + f * (cordLut.G[i + 1] - cordLut.G[i]);
    const b = cordLut.B[i] + f * (cordLut.B[i + 1] - cordLut.B[i]);
    const a = cordLut.A[i] + f * (cordLut.A[i + 1] - cordLut.A[i]);
    if (j === 255 && a > 0 && (r > 0 || g > 0 || b > 0)) cordVisible = true;
  }
}
assert.ok(cordVisible,
  'spinalcord LUT must paint a visible (non-transparent, non-black) colour at LUT[255]; ' +
  'a binary mask voxel value of 1 maps to LUT[255] and an invisible bucket there means ' +
  'the segmentation overlay is silently hidden.');

console.log(`Label LUT step encoding OK: vertebrae=${lut.I.length} stops, spinalcord=${cordLut.I.length} stops`);
