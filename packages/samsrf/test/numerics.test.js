import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as s from '../src/node.js';
import { matFile } from './fixtures.js';

const model = {
  Name: 'regression', Prf_Function: '@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)',
  Param_Names: ['x0', 'y0', 'Sigma'], Scaled_Param: [1, 1, 1], Only_Positive: [0, 0, 1],
  Scaling_Factor: 1, TR: 1, Hrf: 0, Aperture_File: 'synthetic',
  Param1: [0], Param2: [0], Param3: [1], Coarse_Fit_Only: 1,
};

function apertures(frame) {
  return s.readApertures(matFile({ ApFrm: { dims: [2, 2, 64], data: Array.from({ length: 64 }, (_, t) => frame(t)).flat() } }), 'mat');
}

function predict(ap, params = [0, 0, 1]) {
  return s.predictTimecourse(s.prfProfile(model.Prf_Function, params, ap.scaledXy(1)), ap);
}

function fit(ap, observed, options) {
  const job = s.createJob({
    kind: 'prf', model: JSON.stringify({ ...model, ...options }), apertures: ap.serialize(),
    data: { volumes: observed.length, vertices: Uint32Array.of(0), courses: observed }, totalVertices: 1,
  });
  try {
    const { maps } = job.merge([job.run(0, 1)]);
    return Object.fromEntries(maps.values.map((key, i) => [key, maps.data[i]]));
  } finally {
    job.free();
  }
}

test('scalar HRF arrays produce the same fitted maps as scalar sentinels', () => {
  const ap = apertures(t => [+(t % 16 < 4), 0, 0, 0]);
  try {
    for (const Hrf of [0, 1]) {
      const raw = predict(ap);
      const observed = Hrf === 0 ? s.hrf.convolve(raw, s.hrf.spmCanonical(1)) : raw;
      const scalar = fit(ap, observed, { Hrf });
      assert.ok(Math.abs(scalar['R^2'] - 1) < 1e-12);
      assert.deepEqual(fit(ap, observed, { Hrf: [Hrf] }), scalar);
    }
  } finally {
    ap.free();
  }
});

test('small full-rank variation retains the amplitude and intercept', () => {
  const ap = apertures(t => Array(4).fill(1 + 1e-9 * ((t % 4) - 1.5)));
  try {
    const observed = Float64Array.from(predict(ap), x => 2 * x - 197);
    const result = fit(ap, observed, { Hrf: 1 });
    assert.ok(Math.abs(result.Beta - 2) < 1e-6, `Beta ${result.Beta}`);
    assert.ok(Math.abs(result.Baseline + 197) < 1e-4, `Baseline ${result.Baseline}`);
  } finally {
    ap.free();
  }
});

test('CSS with a fitted HRF uses Exponent for the exported beta', () => {
  const ap = apertures(t => [+(t % 16 < 4), +(t % 21 < 5), +(t % 11 < 4), +(t % 27 < 3)]);
  try {
    const observed = s.hrf.convolve(Float64Array.from(predict(ap, [0.2, -0.3, 0.65]), x => x ** 0.4), s.hrf.spmCanonical(1));
    const result = fit(ap, observed, { Hrf: 'Inf', Coarse_Fit_Only: 0, Compressive_Nonlinearity: 1 });
    const kernel = s.hrf.doublegamma(1, [result.RLat, result.ULat, result.RDisp, result.UDisp, result.AmpRat]);
    const predicted = s.hrf.convolve(Float64Array.from(predict(ap, [result.x0, result.y0, result.Sigma]), x => x ** result.Exponent), kernel);
    // Least-squares residuals must be orthogonal to both design columns.
    const residual = observed.map((y, i) => y - result.Beta * predicted[i] - result.Baseline);
    assert.ok(Math.abs(residual.reduce((sum, r) => sum + r, 0)) < 1e-8);
    assert.ok(Math.abs(residual.reduce((sum, r, i) => sum + r * predicted[i], 0)) < 1e-8);
    assert.ok(Math.abs(result.Exponent - result.AmpRat) > 1);
  } finally {
    ap.free();
  }
});
