import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareKernelRecordings, validateKernelRecording } from '../validation/matlab/validate-kernel-recording.mjs';
import { validateGaussianEvidence } from '../validation/matlab/analyse-single-kernels.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samsrf-kernels-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recording = { smoke: true, cases: [] };
  function item(id, kind, metadata = {}) {
    const value = { id, kind, ...metadata };
    recording.cases.push(value);
    return value;
  }
  function fields(value, names, shape, type = 'single') {
    for (const key of names.split(' ')) {
      const file = `${value.id}_${key}.f64`;
      value[key] = { file, shape, class: type, imaginary: '' };
      fs.writeFileSync(path.join(root, file), Buffer.alloc(shape[0] * shape[1] * 8));
    }
  }
  const exp = item('exp_single', 'exp');
  fields(exp, 'input whole chunk1 chunk9 chunk81 chunk400', [8875, 1]);
  const corr = item('kernels_x001_lh_corr', 'corr', { dataset: 'x001_lh', candidateEqual: [true, false, false] });
  fields(corr, 'roi', [1, 21], 'double');
  fields(corr, 'seed', [1, 9], 'double');
  fields(corr, 'courses', [250, 21]);
  fields(corr, 'seedCourses', [250, 9]);
  fields(corr, 'meanSeed sumSeed normSeed', [1, 9]);
  fields(corr, 'meanCourse normCourse', [21, 1]);
  fields(corr, 'corr product columnProducts', [21, 9]);
  for (const smoothing of [0, 1]) {
    const value = item(`kernels_x001_lh_gaussian_smooth${smoothing}`, 'gaussian', {
      dataset: 'x001_lh', smoothing,
      values: ['R^2', 'x0', 'y0', 'Sigma', 'Beta', 'Baseline', 'Fwhm', 'Vx', 'Noise Ceiling'],
    });
    fields(value, 'savedMaps', [9, 21]);
    fields(value, 'profiles', [9, 21]);
    fields(value, 'coordinates', [9, 2]);
    fields(value, 'replicaParameters', [5, 21], 'double');
    fields(value, 'replicaR2', [1, 21], 'double');
    fields(value, 'evaluations', [5, 5], 'double');
    fields(value, 'evaluationVertex evaluationStart', [5, 1], 'double');
    fields(value, 'models exponents', [5, 9]);
    fields(value, 'objectives', [5, 1]);
  }
  const save = () => fs.writeFileSync(path.join(root, 'kernels.json'), JSON.stringify(recording));
  save();
  return { root, recording, save };
}

test('single-kernel completeness requires scientific arrays and their types and shapes', t => {
  const { root, recording, save } = fixture(t);
  validateKernelRecording(root, { smoke: true });
  const fit = recording.cases[2];
  for (const key of ['objectives', 'replicaParameters', 'replicaR2']) {
    const descriptor = fit[key];
    delete fit[key];
    save();
    assert.throws(() => validateKernelRecording(root, { smoke: true }), /descriptor inventory/);
    fit[key] = descriptor;
  }
  fit.replicaParameters.class = 'single';
  save();
  assert.throws(() => validateKernelRecording(root, { smoke: true }), /class/);
  fit.replicaParameters.class = 'double';
  fit.replicaParameters.shape = [21, 5];
  save();
  assert.throws(() => validateKernelRecording(root, { smoke: true }), /shape/);
});

test('same-host repeats require matching metadata and array bytes', t => {
  const first = fixture(t), second = fixture(t);
  assert.equal(compareKernelRecordings(first.root, second.root), 40);
  second.recording.cases[1].candidateEqual[0] = false;
  second.save();
  assert.throws(() => compareKernelRecordings(first.root, second.root), /metadata differs/);
  second.recording.cases[1].candidateEqual[0] = true;
  second.save();
  fs.writeFileSync(path.join(second.root, second.recording.cases[2].objectives.file), Buffer.alloc(40, 1));
  assert.throws(() => compareKernelRecordings(first.root, second.root), /differs between repeats/);
});

test('fitted maps require replica, trace, objective and fitted-mask agreement', t => {
  const { root, recording } = fixture(t);
  const fit = recording.cases[3]; // Smoothed column residuals.
  const write = (key, values) => fs.writeFileSync(path.join(root, fit[key].file), Buffer.from(new Float64Array(values).buffer));
  const parameters = [0, 0, 1, 1, 0];
  const maps = Array(9 * 21).fill(0);
  maps.splice(0, 6, 1, ...parameters);
  const profiles = Array(9 * 21).fill(NaN);
  profiles.splice(0, 9, 2, ...Array(8).fill(0));
  const replica = [...parameters, ...Array(5 * 20).fill(NaN)];
  write('profiles', profiles);
  write('savedMaps', maps);
  write('replicaParameters', replica);
  write('replicaR2', [1, ...Array(20).fill(NaN)]);
  write('evaluations', parameters.flatMap(value => Array(5).fill(value)));
  write('evaluationVertex', Array(5).fill(1));
  write('evaluationStart', [0.01, 0.1, 1, 10, 100]);
  write('models', [...Array(5).fill(1), ...Array(40).fill(0)]);
  assert.deepEqual(validateGaussianEvidence(root, fit), { fitted: 1, objectives: 5 });
  maps[3] = 1e100;
  write('savedMaps', maps);
  assert.throws(() => validateGaussianEvidence(root, fit), /replica\/export/);
  maps[3] = 1;
  write('savedMaps', maps);
  write('objectives', [1, 0, 0, 0, 0]);
  assert.throws(() => validateGaussianEvidence(root, fit), /objective at evaluation/);
  write('objectives', Array(5).fill(0));
  write('replicaR2', Array(21).fill(NaN));
  assert.throws(() => validateGaussianEvidence(root, fit), /fitted mask/);
  write('replicaR2', [1, ...Array(20).fill(NaN)]);
  // Corrupt both export and replica consistently: the trace must still reject it.
  maps[3] = 2;
  replica[2] = 2;
  write('savedMaps', maps);
  write('replicaParameters', replica);
  assert.throws(() => validateGaussianEvidence(root, fit), /absent from trace/);
  // With the row/column broadcast, a zero model repeats the squared profile
  // nine times: SSE is 9, not 1. R² uses the sequential single variance.
  fit.smoothing = 0;
  maps[0] = Math.fround(1 - Math.fround(9 / 0.8888888359069824));
  maps[3] = 1;
  replica[2] = 1;
  write('savedMaps', maps);
  write('replicaParameters', replica);
  write('replicaR2', [maps[0], ...Array(20).fill(NaN)]);
  write('models', Array(45).fill(0));
  write('objectives', Array(5).fill(9));
  assert.equal(validateGaussianEvidence(root, fit).objectives, 5);
  write('objectives', Array(5).fill(1));
  assert.throws(() => validateGaussianEvidence(root, fit), /objective at evaluation/);

});
