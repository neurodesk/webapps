// Evidence from two hosts' single-kernel recordings (record_single_kernels.m):
// MATLAB's single exp against correctly rounded exp, and how far MATLAB's own
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

function expEvidence(root) {
  const item = read(root).cases.find((entry) => entry.id === 'exp_single');
  const input = array(root, item.input);
  const whole = array(root, item.whole);
  let below = 0;
  let above = 0;
  for (const [index, x] of input.entries()) {
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
  return { inputs: input.length, belowCorrectlyRounded: below, aboveCorrectlyRounded: above, callShapesEqual: shapes.every(Boolean), whole };
}

function fitEvidence(root, item) {
  const exponents = array(root, item.exponents);
  const models = array(root, item.models);
  const vertex = array(root, item.evaluationVertex);
  const [evaluations, width] = item.models.shape;
  let first = null;
  let affected = 0;
  for (let row = 0; row < evaluations; row += 1) {
    let differs = false;
    for (let column = 0; column < width; column += 1) {
      const exponent = at(exponents, item.exponents.shape, row, column);
      if (roundedExp(exponent) !== at(models, item.models.shape, row, column)) differs = true;
    }
    if (!differs) continue;
    affected += 1;
    first ??= { evaluation: row + 1, vertex: vertex[row] };
  }
  return { evaluations, affected, first };
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
  assert.ok(evidence.exp.belowCorrectlyRounded + evidence.exp.aboveCorrectlyRounded > 0, 'MATLAB single exp is correctly rounded');
  for (const [id, fit] of Object.entries(evidence.fits)) {
    for (const host of fit.exp) assert.ok(host.affected > 0, `${id}: every exp correctly rounded`);
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
