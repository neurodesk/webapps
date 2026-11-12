// Evidence from two hosts' single-kernel recordings (record_single_kernels.m):
// MATLAB's single exp against correctly rounded exp and the fdlibm candidate,
// the logged fit models those kernels reproduce, and how far MATLAB's own
// single CF Gaussian fits move between the hosts.
// Usage: analyse-single-kernels.mjs HOST_A HOST_B [--check]
// --check holds the recordings to the conclusions in the README.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

function fitEvidence(root, item) {
  return { correctlyRounded: modelEvidence(root, item, roundedExp), fdlibm: modelEvidence(root, item, fdlibmExpf) };
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
  const expA = expEvidence(a);
  const expB = expEvidence(b);
  const hostsEqual = expA.whole.every((value, index) => Object.is(value, expB.whole[index]));
  const recordingA = read(a);
  const recordingB = read(b);
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
    exp: { ...expA, hostsEqual },
    fits,
  };
}

export function checkSingleKernels(evidence) {
  assert.ok(evidence.exp.hostsEqual, 'MATLAB single exp differs between hosts');
  assert.ok(evidence.exp.callShapesEqual, 'MATLAB single exp depends on the call shape');
  assert.equal(evidence.exp.belowCorrectlyRounded + evidence.exp.aboveCorrectlyRounded, 47147, 'Values where MATLAB single exp is not correctly rounded');
  assert.equal(evidence.exp.fdlibmEqual, 711289, 'Values the fdlibm candidate reproduces');
  for (const [id, fit] of Object.entries(evidence.fits)) {
    for (const host of fit.exp) {
      assert.ok(host.correctlyRounded.verticesDiffering === host.correctlyRounded.vertices, `${id}: correctly rounded exp reproduces a whole vertex`);
      assert.ok(host.fdlibm.valuesDiffering > 0 && host.fdlibm.valuesDiffering <= 8, `${id}: fdlibm candidate differences ${host.fdlibm.valuesDiffering}`);
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
