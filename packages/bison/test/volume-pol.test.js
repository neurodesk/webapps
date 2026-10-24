import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVolumePol, fitVolumePol, formatG } from '../src/volume-pol.js';

const DIMS = [24, 20, 16];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Background, CSF-, GM- and WM-like classes with Gaussian noise, scaled and offset.
function phantom(seed, scale, offset) {
  const random = rng(seed);
  const means = [0, 30, 60, 90];
  const out = new Float32Array(DIMS[0] * DIMS[1] * DIMS[2]);
  for (let i = 0; i < out.length; i++) {
    const u = random();
    const cls = u < 0.4 ? 0 : u < 0.55 ? 1 : u < 0.8 ? 2 : 3;
    const g = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    out[i] = cls === 0 ? Math.abs(g) * scale : (means[cls] + 4 * g) * scale + offset;
  }
  return out;
}

const source = phantom(1, 1.7, 5);
const target = phantom(2, 1, 0);
const sourceMask = Uint8Array.from(source, (v) => (v > 20 ? 1 : 0));
const targetMask = new Uint8Array(target.length);
for (let z = 2; z < DIMS[2] - 2; z++) {
  for (let y = 3; y < DIMS[1] - 3; y++) {
    for (let x = 4; x < DIMS[0] - 4; x++) targetMask[(z * DIMS[1] + y) * DIMS[0] + x] = 1;
  }
}

function summary(output) {
  let sum = 0;
  for (const v of output) sum += v;
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(output.buffer, output.byteOffset, output.byteLength)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return { sum, hash };
}

// Recorded from minc-toolkit-v2 EZminc volume_pol 1.1 (GSL 2.8) on the phantom written as float
// MINC with rawtominc: coefficients read from GSL's solution vector under gdb, output read back
// with minctoraw -float. FNV-1a covers every output voxel's float32 bytes.
const BINARY = [
  { name: 'order 1, --noclamp', options: { order: 1 }, clamp: false, coefficients: [0.5561261181811776], expression: '0.556126*A[0]', sum: 287246.28614590113, hash: 1254299403 },
  { name: 'order 1, clamped', options: { order: 1, clamp: true }, clamp: true, coefficients: [0.5561261181811776], expression: 'clamp(0.556126*A[0],0.000532196,105.149)', sum: 287246.2867682, hash: 1193413680 },
  { name: 'order 1, --source_mask and --target_mask', options: { order: 1, sourceMask, targetMask }, clamp: false, coefficients: [0.38563392351573533], expression: '0.385634*A[0]', sum: 199184.8767888874, hash: 2584769556 },
  { name: 'order 2, --noclamp', options: { order: 2 }, clamp: false, coefficients: [0.564483769429779, -1.0371277213817545], expression: '0.564484*A[0]+-1.03713', sum: 283597.97958806093, hash: 1910622636 },
];

for (const expected of BINARY) {
  test(`matches the volume_pol binary: ${expected.name}`, () => {
    const fit = fitVolumePol({ source, target, ...expected.options });
    if (expected.coefficients.length === 1) {
      assert.deepEqual(fit.coefficients, expected.coefficients);
    } else {
      fit.coefficients.forEach((c, i) => assert.ok(Math.abs(c - expected.coefficients[i]) <= 1e-12 * Math.abs(expected.coefficients[i]), `coefficient ${i}: ${c}`));
    }
    assert.equal(fit.expression, expected.expression);
    const output = applyVolumePol(source, fit.coefficients, { clamp: expected.clamp, min: fit.targetMin, max: fit.targetMax });
    assert.deepEqual(summary(output), { sum: expected.sum, hash: expected.hash });
  });
}

test('order 1 is a slope through the origin', () => {
  const fit = fitVolumePol({ source, target: Float32Array.from(source, (v) => 2 * v) });
  assert.equal(fit.coefficients.length, 1);
  assert.ok(Math.abs(fit.coefficients[0] - 2) < 1e-9, String(fit.coefficients[0]));
  const out = applyVolumePol(Float32Array.of(0, 1.5, Number.NaN, -2), fit.coefficients);
  assert.equal(out[0], 0);
  assert.equal(out[1], Math.fround(1.5 * fit.coefficients[0]));
  assert.ok(Number.isNaN(out[2]));
  assert.equal(out[3], Math.fround(-2 * fit.coefficients[0]));
});

test('non-finite voxels are left out of the histograms', () => {
  const withNaN = Float32Array.from(source);
  withNaN[5] = Number.NaN;
  withNaN[6] = Number.POSITIVE_INFINITY;
  const fit = fitVolumePol({ source: withNaN, target });
  assert.ok(Number.isFinite(fit.coefficients[0]));
});

test('the masked range keeps upstream volume_min_max quirk', () => {
  // The first in-mask voxel sets the maximum through `else if`, never the minimum.
  const values = Float32Array.of(1, 5, 3, 9);
  const fit = fitVolumePol({ source: values, target: values, targetMask: Uint8Array.of(1, 1, 1, 1) });
  assert.equal(fit.targetMin, 3);
  assert.equal(fit.targetMax, 9);
  const unmasked = fitVolumePol({ source: values, target: values });
  assert.equal(unmasked.targetMin, 1);
});

test('clamping limits the output to the target range', () => {
  const out = applyVolumePol(Float32Array.of(-10, 10, 1000), [1], { clamp: true, min: 0, max: 100 });
  assert.deepEqual([...out], [0, 10, 100]);
  assert.throws(() => applyVolumePol(Float32Array.of(1), [1], { clamp: true }), /target min and max/);
});

test('refuses inputs the binary would turn into NaN', () => {
  assert.throws(() => fitVolumePol({ source: new Float32Array(8).fill(3), target }), /source image has no intensity range/);
  assert.throws(() => fitVolumePol({ source, target, targetMask: new Uint8Array(target.length) }), /target image has no intensity range inside its mask/);
  assert.throws(() => fitVolumePol({ source, target, sourceMask: new Uint8Array(3) }), /source mask does not match/);
  assert.throws(() => fitVolumePol({ source, target, order: 0 }), /positive integer/);
});

test('formatG writes C++ ostream default precision', () => {
  assert.equal(formatG(0.3835113102994042), '0.383511');
  assert.equal(formatG(1.3309027659174468), '1.3309');
  assert.equal(formatG(24.01291342520927), '24.0129');
  assert.equal(formatG(-0.0021404859315902348), '-0.00214049');
  assert.equal(formatG(0.0000324086), '3.24086e-05');
  assert.equal(formatG(1234567), '1.23457e+06');
  assert.equal(formatG(100000), '100000');
  assert.equal(formatG(0), '0');
});
