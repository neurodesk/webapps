import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as samsrf from '../src/node.js';
import { MODELS, TOTAL_VERTICES, jobSpec, loadExample, runWhole } from '../validation/example-inputs.mjs';
import { giftiRun } from './fixtures.js';

// The web app's example files (apps/samsrf/examples.json, downloaded flat into one folder).
const dir = process.env.SAMSRF_WEBAPP_EXAMPLE_DIR;
const exampleTest = dir ? test : test.skip;

function tiny() {
  const volumes = 8;
  const courses = new Float64Array(volumes * 2);
  for (let t = 0; t < volumes; t += 1) {
    courses[t] = Math.sin(t);
    courses[volumes + t] = Math.cos(t);
  }
  return { volumes, vertices: Uint32Array.of(3, 7), courses };
}

test('createJob validates its spec before touching the module', () => {
  const data = tiny();
  const base = { kind: 'rc', model: JSON.stringify(MODELS.rc), data, totalVertices: 10 };
  assert.throws(() => samsrf.createJob({ ...base, kind: 'xyz' }), /kind must be one of/);
  assert.throws(() => samsrf.createJob({ ...base, model: '{}' }), /Analysis name is undefined/);
  assert.throws(() => samsrf.createJob({ ...base, data: { ...data, courses: new Float64Array(3) } }), /volumes x vertices/);
  assert.throws(() => samsrf.createJob({ ...base, roi: [1] }), /roi must be a Uint32Array/);
  assert.throws(() => samsrf.createJob({ ...base, totalVertices: 5 }), /below totalVertices/);
  // A valid spec without apertures fails inside the module with SamSrf's wording.
  assert.throws(() => samsrf.createJob(base), /needs apertures/);
});

test('single precision averages the global signal in single and refuses CF Gaussian fits', () => {
  const globalSignal = (precision) => {
    const run = samsrf.readGiftiRun(giftiRun([[1, 2], [1e-8, 0], [1e-8, 0]]));
    const accumulator = new samsrf.RunAccumulator(run.vertices, null, { normalise: 'none', globalSignal: true, precision });
    try {
      accumulator.pushRun(run);
      return accumulator.finish().globalSignal;
    } finally {
      accumulator.free();
      run.free();
    }
  };
  // f32 input values, summed vertex by vertex as nanmean(Srf.Data, 2) does.
  const small = Math.fround(1e-8);
  assert.equal(globalSignal('double')[0], (1 + small + small) / 3);
  assert.equal(globalSignal('single')[0], Math.fround(1 / 3));
  assert.throws(() => new samsrf.RunAccumulator(3, null, { precision: 'half' }), /precision "half"/);
  const cf = { Name: 'CF', SeedRoi: 'seed', Template: 'template', Data_Precision: 'single' };
  assert.equal(samsrf.parseModel('cf', JSON.stringify({ ...cf, Fit_pRF: -1 })).dataPrecision, 'single');
  assert.equal(samsrf.parseModel('rc', JSON.stringify({ ...MODELS.rc, Data_Precision: 'single' })).dataPrecision, 'single');
  assert.equal(samsrf.parseModel('cf', JSON.stringify({ ...cf, Fit_pRF: 1 })).dataPrecision, 'single');
});

let example;
function loaded() {
  example ??= loadExample(dir);
  return example;
}

exampleTest('the reverse-correlation job runs in shards and merges into every vertex', () => {
  const roi = loaded().roi.slice(0, 64);
  const job = samsrf.createJob(jobSpec(loaded(), 'rc', MODELS.rc, { roi }));
  try {
    assert.equal(job.vertexCount, 64);
    assert.deepEqual(job.values, ['R^2', 'x0', 'y0', 'Fwhm', 'Beta']);
    assert.equal(job.outSuffix, '_Rcp');
    const progress = [];
    const { maps, raw, analysed } = runWhole(job, 3, (done) => progress.push(done));
    assert.equal(progress.at(-1), 64);
    assert.deepEqual(maps.values, ['R^2', 'x0', 'y0', 'Fwhm', 'Beta', 'Noise Ceiling']);
    assert.equal(maps.vertices, TOTAL_VERTICES);
    assert.deepEqual(raw.values, ['R^2', 'x0', 'y0', 'Fwhm', 'Beta']);
    assert.deepEqual(Array.from(analysed), Array.from(roi).sort((a, b) => a - b));
    const r2 = maps.data.subarray(0, TOTAL_VERTICES);
    const fitted = Array.from(roi).filter((vertex) => r2[vertex] > 0);
    assert.ok(fitted.length > 32, `${fitted.length} vertices with R^2 > 0`);
    assert.equal(r2[TOTAL_VERTICES - 1], 0, 'vertices outside the ROI stay zero');
    const files = samsrf.exportGiis(maps, `lh_${job.modelName}${job.outSuffix}`);
    assert.deepEqual(files.map((file) => file.name).slice(0, 3), ['lh_pRF_Rcp_pol.gii', 'lh_pRF_Rcp_ecc.gii', 'lh_pRF_Rcp_r^2.gii']);
    assert.throws(() => job.merge([job.run(0, 10)]), /cover 10 of 64/);
  } finally {
    job.free();
  }
});

exampleTest('the pRF fit and connective-field jobs produce SamSrf rows', () => {
  const roi = loaded().roi.slice(0, 12);
  const prf = samsrf.createJob(jobSpec(loaded(), 'prf', MODELS.prf, { roi }));
  try {
    assert.deepEqual(prf.values, ['R^2', 'x0', 'y0', 'Sigma', 'Beta', 'Baseline']);
    const { maps } = runWhole(prf, 2);
    assert.deepEqual(maps.values, ['nR^2', 'x0', 'y0', 'Sigma', 'Beta', 'Baseline', 'Noise Ceiling', 'R^2']);
    const r2 = maps.data.subarray(7 * TOTAL_VERTICES, 8 * TOTAL_VERTICES);
    assert.ok(Array.from(roi).some((vertex) => r2[vertex] > 0.1));
  } finally {
    prf.free();
  }
  const cf = samsrf.createJob(jobSpec(loaded(), 'cf', MODELS.cf, { roi }));
  try {
    assert.deepEqual(cf.values, ['R^2', 'x0', 'y0', 'Centre', 'Surround', 'Beta', 'Suppression', 'Fwhm', 'Vx']);
    const { maps } = runWhole(cf, 1);
    const vx = maps.data.subarray(8 * TOTAL_VERTICES, 9 * TOTAL_VERTICES);
    assert.ok(Array.from(roi).every((vertex) => vx[vertex] >= 1), 'Vx is SamSrf\'s 1-based seed vertex');
  } finally {
    cf.free();
  }
});
