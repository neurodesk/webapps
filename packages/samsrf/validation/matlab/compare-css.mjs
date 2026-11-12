// Full double CSS replay on the committed WebAssembly, with the port's own HRF and,
// as a control, MATLAB's recorded HRF kernel. Every difference is reported.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as samsrf from '../../src/node.js';

const [reference, reportFile] = process.argv.slice(2);
assert.ok(reference && reportFile, 'Usage: compare-css.mjs REFERENCE_DIR REPORT_JSON');
const read = name => JSON.parse(fs.readFileSync(path.join(reference, name), 'utf8'));
for (const [name, checksum] of Object.entries(read('manifest.json').files)) {
  assert.equal(path.basename(name), name);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(reference, name))).digest('hex'), checksum, name);
}
const cases = read('reference.json').cases;
assert.equal(cases.length, 741);
const recorded = cases.find(item => item.id === 'pipeline_double_css');
assert.ok(recorded, 'Missing double CSS pipeline');
assert.equal(recorded.precision, 'double');
const preprocessing = cases.find(item => item.id === recorded.preprocessing);
assert.equal(preprocessing.courses.class, 'double');
const array = descriptor => {
  assert.equal(path.basename(descriptor.file), descriptor.file);
  const bytes = fs.readFileSync(path.join(reference, descriptor.file));
  assert.equal(bytes.byteLength, descriptor.shape.reduce((a, b) => a * b, 1) * 8);
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const model = { ...recorded.model, Data_Precision: 'double', Css_Convention: 'samsrf' };
const vertices = preprocessing.courses.shape[1];
assert.equal(vertices, 96);
// Run the whole double CSS pipeline, with the port's HRF or with MATLAB's kernel.
function run(hrf) {
  const apertures = samsrf.readAperturesFile(path.join(reference, `${model.Aperture_File}.mat`));
  let job;
  try {
    job = samsrf.createJob({
      kind: 'prf',
      model: JSON.stringify(model),
      apertures: apertures.serialize(),
      data: {
        volumes: preprocessing.courses.shape[0],
        vertices: Uint32Array.from({ length: vertices }, (_, i) => i),
        courses: array(preprocessing.courses),
      },
      totalVertices: vertices,
      noiseCeiling: array(preprocessing.noiseCeiling),
      ...(hrf ? { hrf } : {}),
    });
  } finally {
    apertures.free();
  }
  try {
    return samsrf.runJob(job).maps;
  } finally {
    job.free();
  }
}
const kernel = array(recorded.hrf);
const portKernel = samsrf.hrf.deHaas(model.TR);
assert.equal(portKernel.length, kernel.length, 'HRF length');
const hrfDifferences = [...kernel].flatMap((value, i) => Object.is(portKernel[i], value) ? [] : [{ index: i, actual: portKernel[i], expected: value }]);
const failures = [];
if (hrfDifferences.length) failures.push({ name: 'HRF', reason: "the port's de Haas HRF must equal MATLAB's bit for bit", differences: hrfDifferences });
const maps = run();
assert.deepEqual(maps.values, recorded.values);
const expected = array(recorded.maps);
const coefficients = new Set(['Beta', 'Baseline']);
const number = value => Number.isFinite(value) ? value : String(value);
const mask = value => Number.isNaN(value) ? 'NaN' : value === 0 ? 'zero' : Number.isFinite(value) ? 'finite' : String(value);
const same = (a, b) => Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b);
// With the port's own HRF: every fitted parameter, R², nR² and noise ceiling is
// bit-identical at every vertex, and every map row keeps MATLAB's NaN, infinity
// and zero masks (acceptance and rejection decisions). Beta and Baseline come from
// the least-squares solve; their accuracy against the exact solution is gated by
// exes/samsrf/core/tests/css_pipeline.rs, which requires these bits.
const results = [];
for (const [row, name] of maps.values.entries()) {
  let maximumAbsolute = 0;
  const differences = [];
  for (let vertex = 0; vertex < vertices; vertex++) {
    const actual = maps.data[row * vertices + vertex];
    const target = expected[vertex * recorded.maps.shape[0] + row];
    if (same(actual, target)) continue;
    const difference = Math.abs(actual - target);
    if (Number.isFinite(difference)) maximumAbsolute = Math.max(maximumAbsolute, difference);
    differences.push({ vertex, actual: number(actual), expected: number(target), absolute: number(difference) });
    if (mask(actual) !== mask(target)) failures.push({ vertex, name, reason: 'nonfinite, zero or acceptance decision', actual: number(actual), expected: number(target) });
    else if (!coefficients.has(name)) failures.push({ vertex, name, reason: "exact gate with the port's HRF", actual: number(actual), expected: number(target) });
  }
  results.push({ name, gated: coefficients.has(name) ? 'mask; accuracy in css_pipeline.rs' : 'exact', maximumAbsolute, differences });
}
// The control: MATLAB's recorded HRF kernel in place of the port's isolates the
// objective from the HRF. The same exact gates apply, and since the two kernels
// are equal the two runs must agree in every bit, coefficients included.
const kernelMaps = run(kernel);
assert.deepEqual(kernelMaps.values, recorded.values);
const kernelResults = [];
for (const [row, name] of kernelMaps.values.entries()) {
  const differences = [];
  for (let vertex = 0; vertex < vertices; vertex++) {
    const actual = kernelMaps.data[row * vertices + vertex];
    const target = expected[vertex * recorded.maps.shape[0] + row];
    if (!same(actual, maps.data[row * vertices + vertex])) {
      failures.push({ vertex, name, reason: "the recorded-kernel run differs from the port's HRF run", actual: number(actual), production: number(maps.data[row * vertices + vertex]) });
    }
    if (same(actual, target)) continue;
    differences.push({ vertex, actual: number(actual), expected: number(target) });
    if (mask(actual) !== mask(target)) failures.push({ vertex, name, reason: 'decision with the recorded HRF kernel', actual: number(actual), expected: number(target) });
    else if (!coefficients.has(name)) failures.push({ vertex, name, reason: 'exact gate with the recorded HRF kernel', actual: number(actual), expected: number(target) });
  }
  kernelResults.push({ name, gated: !coefficients.has(name), differences });
}
const bits = name => {
  const row = maps.values.indexOf(name);
  const view = new DataView(new ArrayBuffer(8));
  return Array.from(maps.data.subarray(row * vertices, (row + 1) * vertices), value => {
    view.setFloat64(0, value);
    return view.getBigUint64(0).toString(16).padStart(16, '0');
  });
};
fs.writeFileSync(reportFile, JSON.stringify({
  pipeline: recorded.id,
  execution: 'committed WebAssembly',
  vertices,
  vertexIndexBase: 0,
  required: {
    portHrf: 'bit-identical to the recorded kernel',
    exact: 'every vertex and map row except Beta and Baseline, with the port\'s HRF and with the recorded kernel',
    decisions: 'NaN, infinity and zero masks at every vertex and map row',
    coefficients: 'accuracy against the exact least-squares solution in exes/samsrf/core/tests/css_pipeline.rs',
  },
  recordedHrfKernel: { results: kernelResults },
  coefficientBits: { Beta: bits('Beta'), Baseline: bits('Baseline') },
  failures,
  results,
}, null, 2) + '\n');
assert.equal(failures.length, 0, `CSS regression gates failed: ${JSON.stringify(failures)}`);
console.log(`CSS gates passed: the port's HRF equals MATLAB's, and with it and with the recorded kernel every non-coefficient map is exact and every decision mask matches at all ${vertices} vertices. Coefficient differences: ${reportFile}`);
