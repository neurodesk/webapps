// Evidence from two hosts' single-kernel recordings (record_single_kernels.m):
// MATLAB's single exp against correctly rounded exp and the fdlibm candidate,
// the logged fit models those kernels reproduce, and how far MATLAB's own
// single CF Gaussian fits move between the hosts.
// Usage: analyse-single-kernels.mjs HOST_A HOST_B [--check]
// --check holds the recordings to the conclusions in the README.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateKernelRecording } from './validate-kernel-recording.mjs';

const read = (root) => JSON.parse(fs.readFileSync(path.join(root, 'kernels.json'), 'utf8'));

function array(root, descriptor) {
  const bytes = fs.readFileSync(path.join(root, descriptor.file));
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
}

// MATLAB writes column-major; element (row, column) of an m-by-n array.
const at = (values, shape, row, column) => values[column * shape[0] + row];

const roundedExp = (x) => Math.fround(Math.exp(x));

const f32 = Math.fround;
const fromBits = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];
const bitsOf = (value) => new Uint32Array(new Float32Array([value]).buffer)[0];

/*
 * Float algorithm translated from FreeBSD release/5.0.0, lib/msun/src/e_expf.c:
 * https://github.com/freebsd/freebsd-src/blob/47227ef0ef663b7abb81ab5a60a450da9a93d24b/lib/msun/src/e_expf.c
 * SHA-256: 816fb76717184af193fc8506a96a3f927b4bb4e9f9c05647f49f1464b927a359
 * e_expf.c -- float version of e_exp.c.
 * Conversion to float by Ian Lance Taylor, Cygnus Support, ian@cygnus.com.
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunPro, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 * This translation changes the ln2 split and overflow/underflow thresholds.
 * It preserves this historical degree-five rational, unlike later expf revisions.
 */
// The candidate for MATLAB's single exp: Sun fdlibm's e_expf.c (degree-5
// rational, k = trunc(x / ln2 +- 1/2), every operation in single, no FMA), with
// ln2 split as hi = 0x3f317000 and lo = single(ln2 - hi), and 0 below ln(2^-149).
// It is the hypothesis the recording is checked against, not a port.
const LN2_HI = fromBits(0x3f317000);
const LN2_LO = f32(Math.LN2 - LN2_HI);
const INV_LN2 = fromBits(0x3fb8aa3b);
const UNDERFLOW = f32(-149 * Math.LN2);
const P = [1.6666667163e-1, -2.777777845e-3, 6.613755977e-5, -1.6533901999e-6, 4.1381369442e-8].map(f32);

export function fdlibmExpf(input) {
  const x = f32(input);
  if (Number.isNaN(x)) return x;
  if (x > 88.72283172607422) return Infinity;
  // MATLAB returns 0 below ln(2^-149), where fdlibm still rounds up to 2^-149.
  if (x < UNDERFLOW) return 0;
  const magnitude = bitsOf(x) & 0x7fffffff;
  const negative = x < 0;
  let k = 0;
  let hi = x;
  let lo = 0;
  let r = x;
  if (magnitude > 0x3eb17218) {
    if (magnitude < 0x3f851592) {
      k = negative ? -1 : 1;
      hi = f32(x - k * LN2_HI);
      lo = k * LN2_LO;
    } else {
      k = Math.trunc(f32(f32(INV_LN2 * x) + (negative ? -0.5 : 0.5)));
      hi = f32(x - f32(k * LN2_HI));
      lo = f32(k * LN2_LO);
    }
    r = f32(hi - lo);
  } else if (magnitude < 0x31800000) {
    return f32(1 + x);
  }
  const t = f32(r * r);
  let p = P[4];
  for (let index = 3; index >= 0; index -= 1) p = f32(P[index] + f32(t * p));
  const c = f32(r - f32(t * p));
  const rc = f32(r * c);
  const y = k === 0 ? f32(1 - f32(f32(rc / f32(c - 2)) - r)) : f32(1 - f32(f32(lo - f32(rc / f32(2 - c))) - hi));
  if (k === 0) return y;
  if (k >= -125) return f32(y * 2 ** k);
  return f32(y * 2 ** (k + 100) * 2 ** -100);
}

function expEvidence(root) {
  const item = read(root).cases.find((entry) => entry.id === 'exp_single');
  const input = array(root, item.input);
  const whole = array(root, item.whole);
  let below = 0;
  let above = 0;
  let fdlibm = 0;
  for (const [index, x] of input.entries()) {
    if (Object.is(fdlibmExpf(x), whole[index])) fdlibm += 1;
    const expected = roundedExp(x);
    if (Object.is(expected, whole[index]) || expected === whole[index]) continue;
    if (Number.isNaN(expected) && Number.isNaN(whole[index])) continue;
    if (whole[index] < expected) below += 1;
    else above += 1;
  }
  const shapes = ['chunk1', 'chunk9', 'chunk81', 'chunk400'].map((key) => {
    const chunk = array(root, item[key]);
    return chunk.every((value, index) => Object.is(value, whole[index]));
  });
  return { inputs: input.length, belowCorrectlyRounded: below, aboveCorrectlyRounded: above, fdlibmEqual: fdlibm, callShapesEqual: shapes.every(Boolean), whole };
}

// The replica logs ModelRfp = exp(exponent) * Beta + Baseline: single times a
// double scalar. MATLAB computes each mixed operation in double and rounds the
// result to single, so the model is single(single(e * Beta) + Baseline).
function modelEvidence(root, item, kernel) {
  const exponents = array(root, item.exponents);
  const models = array(root, item.models);
  const parameters = array(root, item.evaluations);
  const vertex = array(root, item.evaluationVertex);
  const [evaluations, width] = item.models.shape;
  let values = 0;
  const first = new Map();
  for (let row = 0; row < evaluations; row += 1) {
    const beta = at(parameters, item.evaluations.shape, row, 3);
    const baseline = at(parameters, item.evaluations.shape, row, 4);
    for (let column = 0; column < width; column += 1) {
      const model = f32(f32(kernel(at(exponents, item.exponents.shape, row, column)) * beta) + baseline);
      if (Object.is(model, at(models, item.models.shape, row, column))) continue;
      values += 1;
      if (!first.has(vertex[row])) first.set(vertex[row], row + 1);
    }
  }
  return {
    evaluations,
    values: evaluations * width,
    valuesDiffering: values,
    vertices: new Set(vertex).size,
    verticesDiffering: first.size,
    firstEvaluation: first.size ? Math.min(...first.values()) : null,
  };
}

// R2023b single sum: sequential below 44 elements, otherwise four lanes.
// This independently replays the recorded objective, including the unsmoothed
// row/column implicit expansion. It does not use the candidate exp kernel.
function sumSingle(values) {
  const lanes = [0, 0, 0, 0];
  for (const [i, value] of values.entries()) {
    const lane = values.length < 44 ? 0 : i % 4;
    lanes[lane] = f32(lanes[lane] + value);
  }
  return lanes.reduce((sum, value) => f32(sum + value), 0);
}

export function validateGaussianEvidence(root, item) {
  const data = Object.fromEntries(Object.entries(item).filter(([, value]) => value?.file)
    .map(([key, descriptor]) => [key, array(root, descriptor)]));
  const columns = item.profiles.shape[1];
  const width = item.profiles.shape[0];
  const rows = item.models.shape[0];
  const profiles = [];
  const fitted = [];
  const variance = [];
  const selected = new Set();
  const starts = Array.from({ length: columns }, () => new Set());
  for (let v = 0; v < columns; v += 1) {
    const profile = Array.from({ length: width }, (_, j) => at(data.profiles, item.profiles.shape, j, v));
    const peak = Math.max(...profile.filter(value => !Number.isNaN(value)));
    fitted[v] = peak > 0;
    const values = profile.map(value => Math.max(0, f32(value - f32(peak / 2))));
    profiles.push(values);
    const mean = f32(sumSingle(values) / width);
    variance.push(sumSingle(values.map(value => f32(f32(value - mean) ** 2))));
    const r2 = data.replicaR2[v];
    assert.equal(Number.isFinite(r2), fitted[v], `${item.id}: fitted mask at ${v + 1}`);
    for (let row = 0; row < 6; row += 1) {
      const replica = row === 0 ? r2 : at(data.replicaParameters, item.replicaParameters.shape, row - 1, v);
      const saved = at(data.savedMaps, item.savedMaps.shape, row, v);
      if (fitted[v]) {
        assert.ok(Number.isFinite(replica), `${item.id}: nonfinite fitted result`);
        assert.equal(saved, f32(replica), `${item.id}: replica/export at ${v + 1}, row ${row}`);
      } else {
        assert.ok(Number.isNaN(replica), `${item.id}: unfitted replica must be missing`);
        assert.equal(saved, 0, `${item.id}: unfitted export must be zero`);
      }
    }
  }
  for (let i = 0; i < rows; i += 1) {
    const v = data.evaluationVertex[i] - 1;
    assert.ok(Number.isInteger(v) && v >= 0 && v < columns && fitted[v], `${item.id}: evaluation vertex`);
    const start = data.evaluationStart[i];
    assert.ok([0.01, 0.1, 1, 10, 100].includes(start), `${item.id}: evaluation start`);
    starts[v].add(start);
    const model = Array.from({ length: width }, (_, j) => at(data.models, item.models.shape, i, j));
    // MATLAB Ds(:) traverses model rows within each observation column.
    const squares = item.smoothing
      ? model.map((value, j) => f32(f32(profiles[v][j] - value) ** 2))
      : profiles[v].flatMap(observation => model.map(value => f32(f32(observation - value) ** 2)));
    const objective = sumSingle(squares);
    assert.equal(data.objectives[i], objective, `${item.id}: objective at evaluation ${i + 1}`);
    const isSelected = Array.from({ length: 5 }, (_, j) => j).every(j =>
      at(data.evaluations, item.evaluations.shape, i, j) === at(data.replicaParameters, item.replicaParameters.shape, j, v));
    if (isSelected) {
      const r2 = f32(1 - f32(objective / variance[v]));
      assert.equal(data.replicaR2[v], r2, `${item.id}: selected objective/R^2 at ${v + 1}`);
      selected.add(v);
    }
  }
  for (let v = 0; v < columns; v += 1) {
    if (!fitted[v]) continue;
    assert.equal(starts[v].size, 5, `${item.id}: missing optimizer start at ${v + 1}`);
    assert.ok(selected.has(v), `${item.id}: fitted parameters absent from trace at ${v + 1}`);
  }
  return { fitted: fitted.filter(Boolean).length, objectives: rows };
}

function fitEvidence(root, item) {
  const results = validateGaussianEvidence(root, item);
  return { results, correctlyRounded: modelEvidence(root, item, roundedExp), fdlibm: modelEvidence(root, item, fdlibmExpf) };
}

function mapSpread(a, b, itemA, itemB) {
  const mapsA = array(a, itemA.savedMaps);
  const mapsB = array(b, itemB.savedMaps);
  const [rows, columns] = itemA.savedMaps.shape;
  const result = {};
  for (let row = 0; row < rows; row += 1) {
    const relative = [];
    let unequal = 0;
    for (let column = 0; column < columns; column += 1) {
      const x = at(mapsA, itemA.savedMaps.shape, row, column);
      const y = at(mapsB, itemB.savedMaps.shape, row, column);
      if (x !== y) unequal += 1;
      relative.push(Math.abs(x - y) / Math.max(Math.abs(x), 1e-30));
    }
    relative.sort((p, q) => p - q);
    result[itemA.values[row]] = { unequal, vertices: columns, maxRelative: relative.at(-1), medianRelative: relative[columns >> 1] };
  }
  return result;
}

export function analyseSingleKernels(a, b) {
  const recordingA = validateKernelRecording(a);
  const recordingB = validateKernelRecording(b);
  const expA = expEvidence(a);
  const expB = expEvidence(b);
  const hostsEqual = expA.whole.every((value, index) => Object.is(value, expB.whole[index]));
  const fits = {};
  for (const item of recordingA.cases.filter((entry) => entry.kind === 'gaussian')) {
    const other = recordingB.cases.find((entry) => entry.id === item.id);
    fits[item.id] = {
      exp: [fitEvidence(a, item), fitEvidence(b, other)],
      hosts: mapSpread(a, b, item, other),
    };
  }
  delete expA.whole;
  delete expB.whole;
  return {
    hosts: [recordingA, recordingB].map(({ environment }) => ({
      cpu: environment.cpu.match(/Model name:\s*(.+)/)?.[1].trim(),
      blas: environment.observed.blas,
      run: environment.githubRun,
    })),
    exp: { ...expA, callShapesEqual: expA.callShapesEqual && expB.callShapesEqual, hostsEqual },
    fits,
  };
}

export function checkSingleKernels(evidence) {
  assert.ok(evidence.exp.hostsEqual, 'MATLAB single exp differs between hosts');
  assert.ok(evidence.exp.callShapesEqual, 'MATLAB single exp depends on the call shape');
  assert.equal(evidence.exp.belowCorrectlyRounded + evidence.exp.aboveCorrectlyRounded, 47147, 'Values where MATLAB single exp is not correctly rounded');
  assert.equal(evidence.exp.fdlibmEqual, 711289, 'Values the fdlibm candidate reproduces');
  for (const [id, fit] of Object.entries(evidence.fits)) {
    const expectedFitted = id.includes('_lh_') ? (id.endsWith('0') ? 19 : 18) : (id.endsWith('0') ? 21 : 20);
    for (const host of fit.exp) {
      assert.equal(host.results.fitted, expectedFitted, `${id}: fitted vertices`);
      assert.ok(host.correctlyRounded.verticesDiffering === host.correctlyRounded.vertices, `${id}: correctly rounded exp reproduces a whole vertex`);
      assert.ok(host.fdlibm.valuesDiffering > 0 && host.fdlibm.valuesDiffering <= 8, `${id}: fdlibm candidate differences ${host.fdlibm.valuesDiffering}`);
    }
    // Rounded-up ceilings for the documented spread of this pinned evidence,
    // not acceptance tolerances for a port or for another MATLAB recording.
    for (const [name, ceiling] of Object.entries({ Sigma: 388, Beta: 3211, x0: 29, 'R^2': 0.31 })) {
      assert.ok(Number.isFinite(fit.hosts[name].maxRelative) && fit.hosts[name].maxRelative <= ceiling, `${id}: ${name} host spread`);
    }
    for (const name of ['Fwhm', 'Vx', 'Noise Ceiling']) {
      if (fit.hosts[name]) assert.equal(fit.hosts[name].unequal, 0, `${id}: ${name} differs between hosts`);
    }
    const moved = Object.entries(fit.hosts).filter(([name, spread]) => !['R^2', 'Fwhm', 'Vx', 'Noise Ceiling'].includes(name) && spread.unequal > 0);
    assert.ok(moved.length > 0, `${id}: MATLAB's fitted parameters agree between hosts`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b] = process.argv.slice(2).filter((arg) => arg !== '--check');
  assert.ok(a && b, 'Usage: analyse-single-kernels.mjs HOST_A HOST_B [--check]');
  const evidence = analyseSingleKernels(a, b);
  console.log(JSON.stringify(evidence, null, 2));
  if (process.argv.includes('--check')) {
    checkSingleKernels(evidence);
    console.error('Single-kernel evidence holds.');
  }
}
