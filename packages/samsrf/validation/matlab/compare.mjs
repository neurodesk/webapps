// Required per-vertex gates for the validated MATLAB source paths. Other
// recorded cases remain diagnostic evidence; see README.md for that boundary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as samsrf from '../../src/node.js';

const [reference, inputs, reportFile] = process.argv.slice(2);
if (!reference || !inputs) throw new Error('Usage: compare.mjs REFERENCE_DIR MATRIX_INPUT_DIR [REPORT_JSON]');
const readJson = name => JSON.parse(fs.readFileSync(path.join(reference, name), 'utf8'));
const manifest = readJson('manifest.json');
for (const [name, expected] of Object.entries(manifest.files)) {
  assert.equal(path.basename(name), name, 'Reference files must be flat');
  const bytes = fs.readFileSync(path.join(reference, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Reference checksum: ${name}`);
}
const cases = readJson('reference.json').cases;
assert.equal(cases.length, 584, 'The pinned reference must retain every recorded case');
const lookup = new Map(cases.map(item => [item.id, item]));
assert.equal(lookup.size, cases.length, 'Reference case IDs must be unique');
const required = id => {
  const value = lookup.get(id);
  assert.ok(value, `Missing required MATLAB case ${id}`);
  return value;
};
function array(descriptor) {
  assert.ok(descriptor?.file && descriptor.shape, 'Missing array descriptor');
  const bytes = fs.readFileSync(path.join(reference, descriptor.file));
  assert.equal(bytes.byteLength, descriptor.shape.reduce((a, b) => a * b, 1) * 8, descriptor.file);
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const columnRow = (values, rows, row) => Float64Array.from({ length: values.length / rows }, (_, vertex) => values[vertex * rows + row]);
const reports = [];
function compare(id, name, actual, expected, absolute = 0, relative = 0) {
  assert.equal(actual.length, expected.length, `${id}/${name}: shape`);
  let maxError = 0;
  const failures = [];
  for (let vertex = 0; vertex < actual.length; vertex++) {
    const a = actual[vertex], e = expected[vertex];
    const same = a === e || Number.isNaN(a) && Number.isNaN(e);
    const error = Math.abs(a - e);
    if (Number.isFinite(error)) maxError = Math.max(maxError, error);
    if (!same && (!Number.isFinite(a) || !Number.isFinite(e) || error > absolute + relative * Math.abs(e))) {
      failures.push({ vertex, actual: a, expected: e });
    }
  }
  reports.push({ id, name, vertices: actual.length, absolute, relative, maxError, failures });
  console.log(`${failures.length ? 'FAIL' : 'PASS'} ${id}/${name}: max error ${maxError}, ${failures.length} differing vertices`);
}
const inputManifest = JSON.parse(fs.readFileSync(path.join(inputs, 'manifest.json'), 'utf8'));
for (const kind of ['double', 'single']) {
  for (const dataset of inputManifest.datasets) {
    for (const average of dataset.id === 'x001_rh' ? [1] : [0, 1]) {
      const id = `preprocess_${kind}_${dataset.id}_average${average}`;
      const recorded = required(id);
      const data = samsrf.preprocessRuns(dataset.runs.map(run => path.join(inputs, dataset.id, run)), { combine: average ? 'average' : 'concatenate' });
      const cast = values => kind === 'single' ? Float64Array.from(values, Math.fround) : values;
      compare(id, 'courses', cast(data.data), array(recorded.courses), kind === 'single' ? 0 : 1e-12);
      if (recorded.noiseCeiling) compare(id, 'noise ceiling', cast(data.noiseCeiling), array(recorded.noiseCeiling), kind === 'single' ? 0 : 1e-12);
    }
  }
  for (const side of ['lh', 'rh']) {
    const id = `benson_${kind}_${side}`;
    const recorded = required(id);
    const dataset = inputManifest.datasets.find(item => item.id === `x001_${side}`);
    const maps = samsrf.readBensonTemplate(fs.readFileSync(path.join(inputs, dataset.id, `${side}_benson.gii`)), side);
    const expected = array(recorded.maps);
    for (let row = 0; row < maps.values.length; row++) {
      compare(id, maps.values[row], maps.data.subarray(row * maps.vertices, (row + 1) * maps.vertices), columnRow(expected, recorded.maps.shape[0], row), row === 1 || row === 2 ? 3 * 2 ** -23 : 0, row === 1 || row === 2 ? 3 * 2 ** -23 : 0);
    }
  }
}
const pipelineIds = ['pipeline_single_thresholds'];
for (const [dataset, averages] of [['x001_lh', [0, 1]], ['x001_rh', [1]], ['analyzeprf_lh', [0]]]) {
  for (const average of averages) {
    for (const coarse of [0, 1]) pipelineIds.push(`pipeline_single_${dataset}_average${average}_coarse${coarse}`);
  }
}
pipelineIds.push('pipeline_double_x001_lh_rc', 'pipeline_double_x001_rh_rc');
for (const id of pipelineIds) {
  const recorded = required(id), preprocessing = required(recorded.preprocessing);
  const model = { ...recorded.model };
  const isForward = recorded.analysis === 'prf';
  if (isForward) model.Data_Precision = 'single';
  else model.Save_Rmaps = false;
  const apertures = samsrf.readAperturesFile(path.join(reference, `${model.Aperture_File}.mat`));
  const vertices = preprocessing.courses.shape[1];
  const job = samsrf.createJob({
    kind: isForward ? 'prf' : 'rc', model: JSON.stringify(model), apertures: apertures.serialize(),
    data: { volumes: preprocessing.courses.shape[0], vertices: Uint32Array.from({ length: vertices }, (_, i) => i), courses: array(preprocessing.courses) },
    totalVertices: vertices, noiseCeiling: preprocessing.noiseCeiling ? array(preprocessing.noiseCeiling) : undefined,
  });
  apertures.free();
  let maps;
  try { ({ maps } = samsrf.runJob(job)); } finally { job.free(); }
  assert.deepEqual(maps.values, recorded.values, `${id}: map names`);
  const expected = array(recorded.maps);
  for (let row = 0; row < maps.values.length; row++) {
    const name = maps.values[row];
    const regression = name === 'Beta' || name === 'Baseline';
    const coarseScore = model.Coarse_Fit_Only && /R\^2/.test(name);
    const absolute = !isForward ? 1e-9 : regression ? 1e-6 : coarseScore ? 1e-6 : 0;
    compare(id, name, maps.data.subarray(row * vertices, (row + 1) * vertices), columnRow(expected, recorded.maps.shape[0], row), absolute, regression && isForward ? 2e-7 : 0);
  }
}
const failures = reports.filter(item => item.failures.length);
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ gates: reports.length, failed: failures.length, results: reports }, null, 2) + '\n');
assert.equal(failures.length, 0, `${failures.length} MATLAB map gates failed`);
console.log(`All ${reports.length} required MATLAB gates passed. CSS and unlisted precision paths are not asserted by this comparator.`);
