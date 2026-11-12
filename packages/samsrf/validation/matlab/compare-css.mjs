// Full double CSS replays on the committed WebAssembly through the public API,
// with the port's own HRF and, as a control, MATLAB's recorded HRF kernel:
// reference.json's pipeline_double_css and, with PIPELINES_DIR, both pipelines of
// css-pipelines-reference.json on its AMD host. Every difference is reported.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as samsrf from '../../src/node.js';

const [reference, reportFile, pipelinesDir] = process.argv.slice(2);
assert.ok(reference && reportFile, 'Usage: compare-css.mjs REFERENCE_DIR REPORT_JSON [CSS_PIPELINES_DIR]');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function verify(root, files) {
  for (const [name, checksum] of Object.entries(files)) {
    assert.equal(path.normalize(name).startsWith('..'), false, name);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), checksum, name);
  }
}
const array = (dir, descriptor) => {
  assert.equal(path.basename(descriptor.file), descriptor.file);
  const bytes = fs.readFileSync(path.join(dir, descriptor.file));
  assert.equal(bytes.byteLength, descriptor.shape.reduce((a, b) => a * b, 1) * 8, descriptor.file);
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const number = value => Number.isFinite(value) ? value : String(value);
const mask = value => Number.isNaN(value) ? 'NaN' : value === 0 ? 'zero' : Number.isFinite(value) ? 'finite' : String(value);
const same = (a, b) => Object.is(a, b) || Number.isNaN(a) && Number.isNaN(b);
const coefficients = new Set(['Beta', 'Baseline']);
const failures = [];
const reports = {};

// Runs the double CSS pipeline, with the port's HRF or with a given kernel.
function run(dir, model, courses, noiseCeiling, hrf) {
  const apertures = samsrf.readAperturesFile(path.join(dir, `${model.Aperture_File}.mat`));
  let job;
  try {
    job = samsrf.createJob({
      kind: 'prf',
      model: JSON.stringify(model),
      apertures: apertures.serialize(),
      data: { volumes: courses.shape[0], vertices: Uint32Array.from({ length: courses.shape[1] }, (_, i) => i), courses: array(dir, courses) },
      totalVertices: courses.shape[1],
      ...(noiseCeiling ? { noiseCeiling: array(dir, noiseCeiling) } : {}),
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

// With the port's own HRF and with the recorded kernel: the port's de Haas kernel
// equals MATLAB's; every fitted parameter, R², nR² and noise ceiling is
// bit-identical at every vertex; every map row keeps MATLAB's NaN, infinity and
// zero masks; and the two runs agree in every bit, coefficients included. Beta and
// Baseline are checked in exes/samsrf/core/tests/css_pipeline.rs, which requires
// these bits from the native port.
function check(label, dir, recorded, courses, noiseCeiling) {
  assert.equal(recorded.precision, 'double', label);
  assert.equal(courses.class, 'double', label);
  const model = { ...recorded.model, Data_Precision: 'double', Css_Convention: 'samsrf' };
  const kernel = array(dir, recorded.hrf);
  const portKernel = samsrf.hrf.deHaas(model.TR);
  const hrf = [...kernel].flatMap((value, i) => Object.is(portKernel[i], value) ? [] : [{ index: i, actual: portKernel[i], expected: value }]);
  if (portKernel.length !== kernel.length || hrf.length) failures.push({ label, name: 'HRF', reason: "the port's de Haas HRF must equal MATLAB's bit for bit", differences: hrf });
  const expected = array(dir, recorded.maps);
  const rows = recorded.maps.shape[0];
  const vertices = courses.shape[1];
  const runs = { portHrf: run(dir, model, courses, noiseCeiling), recordedHrf: run(dir, model, courses, noiseCeiling, kernel) };
  const results = {};
  for (const [kind, maps] of Object.entries(runs)) {
    assert.deepEqual(maps.values, recorded.values, `${label}: map names`);
    results[kind] = [];
    for (const [row, name] of maps.values.entries()) {
      let maximumAbsolute = 0;
      const differences = [];
      for (let vertex = 0; vertex < vertices; vertex++) {
        const actual = maps.data[row * vertices + vertex];
        const target = expected[vertex * rows + row];
        if (kind === 'recordedHrf' && !same(actual, runs.portHrf.data[row * vertices + vertex])) {
          failures.push({ label, vertex, name, reason: "the recorded-kernel run differs from the port's HRF run", actual: number(actual), production: number(runs.portHrf.data[row * vertices + vertex]) });
        }
        if (same(actual, target)) continue;
        const difference = Math.abs(actual - target);
        if (Number.isFinite(difference)) maximumAbsolute = Math.max(maximumAbsolute, difference);
        differences.push({ vertex, actual: number(actual), expected: number(target) });
        if (mask(actual) !== mask(target)) failures.push({ label, kind, vertex, name, reason: 'nonfinite, zero or acceptance decision', actual: number(actual), expected: number(target) });
        else if (!coefficients.has(name)) failures.push({ label, kind, vertex, name, reason: 'exact gate', actual: number(actual), expected: number(target) });
      }
      results[kind].push({ name, gated: coefficients.has(name) ? 'mask; accuracy in css_pipeline.rs' : 'exact', maximumAbsolute, differences });
    }
  }
  const bits = name => {
    const row = runs.portHrf.values.indexOf(name);
    const view = new DataView(new ArrayBuffer(8));
    return Array.from(runs.portHrf.data.subarray(row * vertices, (row + 1) * vertices), value => {
      view.setFloat64(0, value);
      return view.getBigUint64(0).toString(16).padStart(16, '0');
    });
  };
  reports[label] = { vertices, results, coefficientBits: { Beta: bits('Beta'), Baseline: bits('Baseline') } };
  console.log(`${label}: ${vertices} vertices replayed with the port's HRF and the recorded kernel`);
}

verify(reference, readJson(path.join(reference, 'manifest.json')).files);
const cases = readJson(path.join(reference, 'reference.json')).cases;
assert.equal(cases.length, 741);
const recorded = cases.find(item => item.id === 'pipeline_double_css');
assert.ok(recorded, 'Missing double CSS pipeline');
const preprocessing = cases.find(item => item.id === recorded.preprocessing);
assert.equal(preprocessing.courses.shape[1], 96);
check('reference.json pipeline_double_css', reference, recorded, preprocessing.courses, preprocessing.noiseCeiling);

if (pipelinesDir) {
  const manifest = readJson(path.join(pipelinesDir, 'manifest.json'));
  verify(pipelinesDir, manifest.files);
  // MKL selects other kernels on Intel hosts whatever MKL_CBWR requests, so the
  // AMD host is the reference the port models.
  const amd = Object.entries(manifest.hosts).filter(([, info]) => info.cpu.startsWith('AMD EPYC')).map(([host]) => host);
  assert.equal(amd.length, 1, 'one AMD host');
  const dir = path.join(pipelinesDir, amd[0], 'compatible');
  const recording = readJson(path.join(dir, 'pipelines.json'));
  assert.deepEqual(recording.cases.map(item => item.id), ['pipeline_double_css', 'pipeline_double_css_nonnegative']);
  for (const item of recording.cases) {
    assert.equal(item.nonnegativeApertures, item.id.endsWith('_nonnegative'), item.id);
    check(`${amd[0]} ${item.id}`, dir, item, item.courses, item.noiseCeiling);
  }
}

fs.writeFileSync(reportFile, JSON.stringify({
  execution: 'committed WebAssembly',
  vertexIndexBase: 0,
  required: {
    portHrf: 'bit-identical to the recorded kernel',
    exact: "every vertex and map row except Beta and Baseline, with the port's HRF and with the recorded kernel",
    decisions: 'NaN, infinity and zero masks at every vertex and map row',
    runs: "the recorded-kernel run equals the port's HRF run in every bit",
    coefficients: 'checked in exes/samsrf/core/tests/css_pipeline.rs against these bits',
  },
  cases: reports,
  failures,
}, null, 2) + '\n');
assert.equal(failures.length, 0, `CSS regression gates failed: ${JSON.stringify(failures.slice(0, 20))}`);
console.log(`CSS gates passed for ${Object.keys(reports).length} pipelines. Coefficient differences: ${reportFile}`);
