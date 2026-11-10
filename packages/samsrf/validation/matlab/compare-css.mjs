// Full double CSS replay with narrow, explicit gates for the corrected failures.
// Every other numerical difference is retained in the report, not tolerated away.
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
  });
} finally {
  apertures.free();
}
let maps;
try {
  ({ maps } = samsrf.runJob(job));
} finally {
  job.free();
}
assert.deepEqual(maps.values, recorded.values);
const expected = array(recorded.maps);
const selectedVertices = [46, 59, 68, 80, 87];
const exactParameters = new Set(['x0', 'y0', 'Sigma', 'Exponent', 'Noise Ceiling']);
const number = value => Number.isFinite(value) ? value : String(value);
const mask = value => Number.isNaN(value) ? 'NaN' : Number.isFinite(value) ? 'finite' : String(value);
const results = [];
const failures = [];
for (const [row, name] of maps.values.entries()) {
  let maximumAbsolute = 0;
  const differences = [];
  for (let vertex = 0; vertex < vertices; vertex++) {
    const actual = maps.data[row * vertices + vertex];
    const target = expected[vertex * recorded.maps.shape[0] + row];
    const equal = actual === target || Number.isNaN(actual) && Number.isNaN(target);
    const difference = Math.abs(actual - target);
    if (Number.isFinite(difference)) maximumAbsolute = Math.max(maximumAbsolute, difference);
    if (!equal) differences.push({ vertex, actual: number(actual), expected: number(target), absolute: number(difference) });
    // Preserve every acceptance, zero-column and nonfinite decision across
    // the complete ROI, including vertices outside the focused value gates.
    if (mask(actual) !== mask(target) || (actual === 0) !== (target === 0)) {
      failures.push({ vertex, name, reason: 'nonfinite or zero decision' });
    }
    if (selectedVertices.includes(vertex)) {
      let tolerance = 0;
      if (!exactParameters.has(name) && target !== 0) {
        // R² and the near-zero intercepts have an absolute roundoff bound.
        // Amplitudes retain a relative bound even at extremely small scales.
        tolerance = 16 * Number.EPSILON * (name === 'Beta' ? Math.abs(target) : 1);
      }
      if (!equal && (!Number.isFinite(difference) || difference > tolerance)) {
        failures.push({ vertex, name, reason: 'focused value gate', tolerance, actual: number(actual), expected: number(target) });
      }
    }
  }
  results.push({ name, maximumAbsolute, differences });
}
fs.writeFileSync(reportFile, JSON.stringify({
  pipeline: recorded.id,
  execution: 'committed WebAssembly',
  vertices,
  vertexIndexBase: 0,
  required: { valueVertices: selectedVertices, decisions: 'all 96 vertices, every map row' },
  completeDoubleCssParityAsserted: false,
  failures,
  results,
}, null, 2) + '\n');
assert.equal(failures.length, 0, `CSS regression gates failed: ${JSON.stringify(failures)}`);
console.log(`CSS gates passed for vertices ${selectedVertices.join(', ')} and all ${vertices} decision masks. Remaining differences: ${reportFile}`);
