import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as samsrf from '../src/node.js';
import { freeSurferCurv, freeSurferSurface, gifti, giftiRun, giftiSurface, matFile } from './fixtures.js';

const MODELS = new URL('../../../exes/samsrf/core/tests/data/', import.meta.url);

function close(actual, expected, tolerance = 1e-12) {
  assert.equal(actual.length, expected.length, 'length');
  for (let i = 0; i < expected.length; i += 1) {
    const scale = Math.max(1, Math.abs(expected[i]));
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance * scale, `[${i}] ${actual[i]} != ${expected[i]}`);
  }
}

function f32(values) {
  return Array.from(Float32Array.from(values));
}

function mean(x) {
  return x.reduce((sum, value) => sum + value, 0) / x.length;
}

function detrended(x) {
  const n = x.length;
  const t = x.map((_, i) => i + 1 - (n + 1) / 2);
  const slope = t.reduce((sum, ti, i) => sum + ti * x[i], 0) / t.reduce((sum, ti) => sum + ti * ti, 0);
  const intercept = mean(x);
  return x.map((value, i) => value - intercept - slope * t[i]);
}

function zscored(x) {
  const mu = mean(x);
  const sigma = Math.sqrt(x.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (x.length - 1)) || 1;
  return x.map((value) => (value - mu) / sigma);
}

function correlation(x, y) {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  x.forEach((value, i) => {
    sxy += (value - mx) * (y[i] - my);
    sxx += (value - mx) ** 2;
    syy += (y[i] - my) ** 2;
  });
  return sxy / Math.sqrt(sxx * syy);
}

test('version is the crate version', () => {
  assert.match(samsrf.version(), /^\d+\.\d+\.\d+$/);
});

test('writeGiftiMap round-trips through readGifti at float32 precision', () => {
  const values = [0.1, -2.5, 3e7, 0];
  const file = samsrf.readGifti(samsrf.writeGiftiMap(Float64Array.from(values)));
  assert.equal(file.arrays.length, 1);
  const [array] = file.arrays;
  assert.equal(array.dataType, 'float32');
  assert.deepEqual(array.dims, [4]);
  assert.ok(array.data instanceof Float64Array);
  assert.deepEqual(Array.from(array.data), f32(values));
});

test('readGiftiRun stores each vertex course and rejects vertices past the end', () => {
  const run = samsrf.readGiftiRun(giftiRun([[1, 2, 3], [4.5, 5, -6]]));
  try {
    assert.equal(run.volumes, 3);
    assert.equal(run.vertices, 2);
    assert.ok(run.course(1) instanceof Float32Array);
    assert.deepEqual(Array.from(run.course(1)), [4.5, 5, -6]);
    assert.throws(() => run.course(2), /vertex 2 is outside the 2 vertices/);
  } finally {
    run.free();
  }
});

test('readers turn malformed bytes into errors naming the format', () => {
  assert.throws(() => samsrf.readGiftiRun(Uint8Array.of(1, 2, 3)), (error) => error instanceof Error && /GIFTI/.test(error.message));
  assert.throws(() => samsrf.readMat(new Uint8Array(10)), /MAT/);
});

const MESH_VERTICES = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const MESH_FACES = [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3];

test('readGiftiSurface and readFreeSurferSurface give the same mesh', () => {
  for (const surface of [
    samsrf.readGiftiSurface(giftiSurface(MESH_VERTICES, MESH_FACES)),
    samsrf.readFreeSurferSurface(freeSurferSurface(MESH_VERTICES, MESH_FACES)),
  ]) {
    assert.equal(surface.faceSize, 3);
    assert.ok(surface.vertices instanceof Float64Array);
    assert.ok(surface.faces instanceof Uint32Array);
    assert.deepEqual(Array.from(surface.vertices), MESH_VERTICES);
    assert.deepEqual(Array.from(surface.faces), MESH_FACES);
  }
});

test('readFreeSurferCurv and readFreeSurferLabel', () => {
  assert.deepEqual(Array.from(samsrf.readFreeSurferCurv(freeSurferCurv([0.5, -1.25, 2]))), [0.5, -1.25, 2]);
  const text = '#!ascii label\n2\n57  -14.5  -90.25  11.0 0.75\n3 1 2 3 0\n';
  const label = samsrf.readFreeSurferLabel(new TextEncoder().encode(text));
  assert.deepEqual(Array.from(label.vertices), [57, 3]);
  assert.deepEqual(Array.from(label.coordinates), [-14.5, -90.25, 11, 1, 2, 3]);
  assert.deepEqual(Array.from(label.values), [0.75, 0]);
});

test('readAnatomy reads a surf folder and derives normals from pial minus white', () => {
  const pial = MESH_VERTICES.map((value) => value * 2);
  const files = {
    white: freeSurferSurface(MESH_VERTICES, MESH_FACES),
    pial: freeSurferSurface(pial, MESH_FACES),
    inflated: freeSurferSurface(MESH_VERTICES, MESH_FACES),
    sphere: freeSurferSurface(MESH_VERTICES, MESH_FACES),
    curv: freeSurferCurv([1, 2, 3, 4]),
    area: freeSurferCurv([0.5, 0.5, 0.5, 0.5]),
  };
  const anatomy = samsrf.readAnatomy(files);
  assert.deepEqual(Array.from(anatomy.white.vertices), MESH_VERTICES);
  assert.deepEqual(Array.from(anatomy.pial), pial);
  assert.deepEqual(Array.from(anatomy.curvature), [1, 2, 3, 4]);
  assert.equal(anatomy.thickness, null);
  assert.deepEqual(Array.from(anatomy.normals), MESH_VERTICES);
  const withThickness = samsrf.readAnatomy({ ...files, thickness: freeSurferCurv([2, 2, 2, 2]) });
  assert.deepEqual(Array.from(withThickness.thickness), [2, 2, 2, 2]);
  assert.throws(() => samsrf.readAnatomy({ ...files, area: freeSurferCurv([1]) }), /area has 1 vertices but white has 4/);
});

test('readMat and readOldSchoolHrf', () => {
  const bytes = matFile({ fP: { dims: [1, 4], data: [8, 13, 2, 1] }, other: { dims: [2, 1], data: [1, 2] } });
  const file = samsrf.readMat(bytes);
  assert.deepEqual(Object.keys(file).sort(), ['fP', 'other']);
  assert.equal(file.fP.class, 'double');
  assert.deepEqual(file.fP.dims, [1, 4]);
  assert.deepEqual(Array.from(file.other.data), [1, 2]);
  assert.deepEqual(Array.from(samsrf.readOldSchoolHrf(bytes)), [8, 13, 2, 1]);
  assert.throws(() => samsrf.readOldSchoolHrf(matFile({ fP: { dims: [1, 3], data: [1, 2, 3] } })), /fP has 3 values/);
});

// 2 rows x 4 columns x 3 volumes, column-major.
const MOVIE = { height: 2, width: 4, volumes: 3 };
const MOVIE_DATA = Array.from({ length: 24 }, (_, i) => (i % 5 === 0 ? 1 : 0));

function movieApertures() {
  const bytes = matFile({ ApFrm: { dims: [MOVIE.height, MOVIE.width, MOVIE.volumes], data: MOVIE_DATA } });
  return samsrf.readApertures(bytes, 'mat');
}

test('readApertures vectorises a movie as VectoriseApertures does', () => {
  const apertures = movieApertures();
  try {
    assert.deepEqual([apertures.width, apertures.height, apertures.volumes], [4, 2, 3]);
    assert.deepEqual(Array.from(apertures.toDense()), MOVIE_DATA);
    // Column x = [-2 -1 1 2] / 2, rows y = [1 -1] / 1, shrunk by height / width on y.
    const xy = Array.from(apertures.scaledXy(1));
    assert.deepEqual(xy.slice(0, 4), [-1, 0.5, -1, -0.5]);
    assert.deepEqual(Array.from(apertures.scaledXy(10)).slice(0, 2), [-10, 5]);
  } finally {
    apertures.free();
  }
  assert.throws(() => samsrf.readApertures(new Uint8Array(4), 'png'), /'mat', 'nii' or 'gif'/);
});

test('Apertures.serialize round-trips and deserialize refuses damaged bytes', () => {
  const apertures = movieApertures();
  const bytes = apertures.serialize();
  const copy = samsrf.Apertures.deserialize(bytes);
  assert.deepEqual([copy.width, copy.height, copy.volumes], [4, 2, 3]);
  assert.deepEqual(Array.from(copy.toDense()), Array.from(apertures.toDense()));
  assert.deepEqual(Array.from(copy.scaledXy(2)), Array.from(apertures.scaledXy(2)));
  assert.deepEqual(copy.serialize(), bytes);
  assert.throws(() => samsrf.Apertures.deserialize(bytes.subarray(0, bytes.length - 1)), /truncated/);
  assert.throws(() => samsrf.Apertures.deserialize(new Uint8Array(40)), /not serialised SamSrf apertures/);
  copy.free();
  apertures.free();
});

test('parseModel returns the typed model of each analysis with defaults applied', () => {
  const prf = samsrf.parseModel('prf', readFileSync(new URL('Example_2D_Gaussian_pRF.json', MODELS), 'utf8'));
  assert.equal(prf.kind, 'prf');
  assert.equal(prf.name, 'pRF_Gaussian');
  assert.deepEqual(prf.prfFunction, { source: '@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)', params: ['P', 'ApWidth'] });
  assert.deepEqual(prf.paramNames, ['x0', 'y0', 'Sigma']);
  assert.deepEqual(prf.scaledParam, [true, true, true]);
  assert.deepEqual(prf.onlyPositive, [0, 0, 1]);
  assert.equal(prf.scalingFactor, 9.5);
  assert.equal(prf.tr, 1);
  assert.deepEqual(prf.hrf, { type: 'spmCanonical' });
  assert.equal(prf.apertureFile, 'aps_Bars');
  assert.deepEqual(prf.fineFit, { type: 'nelderMead', tolerance: null });
  const rc = samsrf.parseModel('rc', readFileSync(new URL('Example_Reverse_Correlation_pRF.json', MODELS), 'utf8'));
  assert.equal(rc.kind, 'rc');
  assert.equal(rc.prfFunction, null);
  const cf = samsrf.parseModel('cf', readFileSync(new URL('Example_Reverse_Correlation_CF.json', MODELS), 'utf8'));
  assert.equal(cf.kind, 'cf');
  assert.equal(cf.fitPrf, 'convexHull');
  assert.equal(cf.template, '../benson/bi_benson');
});

test('parseModel writes file-backed and vector HRFs with their payload', () => {
  const base = { Name: 'm', Prf_Function: '@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)', Param_Names: ['x0', 'y0', 'Sigma'], Scaled_Param: [1, 1, 1], Only_Positive: [0, 0, 1], Scaling_Factor: 1, TR: 1, Aperture_File: 'aps', Param1: [0], Param2: [0], Param3: [1] };
  const parse = (hrf) => samsrf.parseModel('prf', JSON.stringify({ ...base, Hrf: hrf })).hrf;
  assert.deepEqual(parse(1), { type: 'none' });
  assert.deepEqual(parse('Inf'), { type: 'fit' });
  assert.deepEqual(parse([0.1, 0.5, 0.2]), { type: 'vector', values: [0.1, 0.5, 0.2] });
  assert.deepEqual(parse('hrf_subject'), { type: 'oldSchoolFile', file: 'hrf_subject' });
  assert.deepEqual(parse('lh_hrf_fits'), { type: 'vertexWiseFile', file: 'lh_hrf_fits' });
  assert.throws(() => samsrf.parseModel('prf', '{}'), (error) => error instanceof Error && /^model: /.test(error.message));
  assert.throws(() => samsrf.parseModel('xx', '{}'), /'prf', 'rc' or 'cf'/);
});

test('evaluateExpression takes numbers, arrays and matrices', () => {
  const seed = samsrf.evaluateExpression('@(V) [V(2:3); V(4)/(2*sqrt(2*log(2)))]', [[1, 2, 3, 4]]);
  assert.equal(seed.rows, 3);
  assert.equal(seed.cols, 1);
  close(seed.data, [2, 3, 4 / (2 * Math.sqrt(2 * Math.log(2)))]);
  const scaled = samsrf.evaluateExpression('@(a, M) a * M', [2, { rows: 1, cols: 2, data: Float64Array.of(3, 4) }]);
  assert.deepEqual([scaled.rows, scaled.cols, Array.from(scaled.data)], [1, 2, [6, 8]]);
  assert.throws(() => samsrf.evaluateExpression('@(x) nope(x)', [1]), /unknown function `nope`/);
  assert.throws(() => samsrf.evaluateExpression('@(x) x', [{ rows: 2, cols: 2, data: [1] }]), /rows \* cols values/);
});

const XY = Float64Array.of(0, 0, 1, 0, 0, 2);

test('prfProfile evaluates a function name or anonymous source, at coordinates or on a grid', () => {
  const gaussian = (x0, y0, sigma) => Array.from({ length: 3 }, (_, i) => Math.exp(-((XY[2 * i] - x0) ** 2 + (XY[2 * i + 1] - y0) ** 2) / (2 * sigma ** 2)));
  close(samsrf.prfProfile('prf_gaussian_rf', [1, 0, 2], XY), gaussian(1, 0, 2));
  close(samsrf.prfProfile('@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)', Float64Array.of(0, 1, 0.5), XY), gaussian(0, 1, 0.5));
  const grid = samsrf.prfProfile('prf_gaussian_rf', [0, 0, 1], 20);
  assert.equal(grid.length, 400);
  assert.throws(() => samsrf.prfProfile('prf_gaussian_rf', [0, 0, 1], Float64Array.of(1, 2, 3)), /x and a y per point/);
});

test('predictTimecourse is the percent overlap of the profile with each frame', () => {
  const apertures = movieApertures();
  const rfp = Float64Array.from({ length: 8 }, (_, i) => i + 1);
  const predicted = samsrf.predictTimecourse(rfp, apertures);
  const dense = apertures.toDense();
  const meanAbs = mean(Array.from(rfp));
  const expected = [0, 1, 2].map((volume) => {
    const overlap = Array.from(rfp).reduce((sum, value, pixel) => sum + value * dense[volume * 8 + pixel], 0) / 8;
    return (overlap / meanAbs) * 100;
  });
  close(predicted, expected);
  apertures.free();
});

test('pearson matches the textbook correlation and is NaN for a constant input', () => {
  const x = [1, 2, 3, 5];
  const y = [2, 1, 4, 3];
  close([samsrf.pearson(x, y)], [correlation(x, y)]);
  assert.ok(Number.isNaN(samsrf.pearson([1, 1, 1], [1, 2, 3])));
});

test('errfun is 1 - r^2 between the convolved prediction and the observed course', () => {
  const apertures = movieApertures();
  const xy = apertures.scaledXy(1);
  const prfFunction = '@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)';
  const params = [0.2, 0.1, 0.8];
  const kernel = Float64Array.of(0, 1, 0.5);
  const rfp = samsrf.prfProfile(prfFunction, params, xy);
  const prediction = samsrf.hrf.convolve(samsrf.predictTimecourse(rfp, apertures), kernel);
  close([samsrf.errfun({ prfFunction, apertures, xy, hrf: kernel, params, observed: prediction })], [0], 1e-12);
  const noisy = prediction.map((value, i) => value + [0.3, -0.2, 0.1][i]);
  const r = correlation(Array.from(prediction), Array.from(noisy));
  close([samsrf.errfun({ prfFunction: { source: prfFunction }, apertures, xy, hrf: kernel, params, observed: noisy })], [1 - r * r]);
  const outOfBounds = samsrf.errfun({ prfFunction, apertures, xy, hrf: { fit: 1 }, params: [...params, 2, 16, 1, 1, 6], observed: noisy });
  assert.equal(outOfBounds, 1);
  apertures.free();
});

test('HRF kernels have SamSrf lengths', () => {
  assert.equal(samsrf.hrf.spmCanonical(1).length, 33);
  assert.equal(samsrf.hrf.spmCanonical(2.55).length, 13);
  assert.equal(samsrf.hrf.deHaas(1).length, 33);
  assert.equal(samsrf.hrf.deHaas(2.55).length, 13);
  assert.equal(samsrf.hrf.oldSchool(1, [8, 13, 2, 1]).length, 33);
  assert.deepEqual(samsrf.hrf.doublegamma(1), samsrf.hrf.spmCanonical(1));
  assert.equal(samsrf.hrf.doublegamma(1, [5, 15, 1.2, 0.9, 5, 1, 30]).length, 30);
  assert.equal(samsrf.hrf.spmCanonical(1)[0], 0);
  assert.throws(() => samsrf.hrf.oldSchool(1, [1, 2]), /fP has 2 values/);
});

test('hrf.convolve keeps the input length and downsamples', () => {
  close(samsrf.hrf.convolve(Float64Array.of(1, 0, 0, 2), Float64Array.of(1, 0.5)), [1, 0.5, 0, 2]);
  close(samsrf.hrf.convolve(Float64Array.of(1, 0, 0, 2), Float64Array.of(1, 0.5), 2), [1, 0]);
});

test('hrf.resolve builds kernels and names the file a file-backed spec needs', () => {
  assert.deepEqual(samsrf.hrf.resolve({ type: 'spmCanonical' }, 2.55), { type: 'kernel', values: samsrf.hrf.spmCanonical(2.55) });
  assert.deepEqual(samsrf.hrf.resolve({ type: 'deHaas' }, 1), { type: 'kernel', values: samsrf.hrf.deHaas(1) });
  assert.deepEqual(samsrf.hrf.resolve({ type: 'none' }, 1), { type: 'none' });
  assert.deepEqual(samsrf.hrf.resolve({ type: 'fit' }, 1), { type: 'fit' });
  assert.deepEqual(Array.from(samsrf.hrf.resolve({ type: 'vector', values: [0.2, 1] }, 1).values), [0.2, 1]);
  assert.throws(() => samsrf.hrf.resolve({ type: 'oldSchoolFile', file: 'hrf_subject' }, 1), /hrf_subject/);
  assert.throws(() => samsrf.hrf.resolve({ type: 'vertexWiseFile', file: 'lh_hrf_fits' }, 1), /lh_hrf_fits/);
});

test('detrend, zscore and noiseCeiling', () => {
  close(samsrf.detrend([1, 2, 3, 4]), [0, 0, 0, 0]);
  close(samsrf.detrend([1, 3, 2, 6]), detrended([1, 3, 2, 6]));
  close(samsrf.zscore([1, 2, 3]), [-1, 0, 1]);
  assert.deepEqual(Array.from(samsrf.zscore([4, 4, 4])), [0, 0, 0]);
  const odd = [1, 2, 4, 3];
  const even = [1, 3, 3, 4];
  const rho = correlation(odd, even);
  close([samsrf.noiseCeiling(Float64Array.from(odd), Float64Array.from(even))], [(2 * rho) / (1 + rho)]);
});

const RUNS = [
  [[1, 4, 2, 8, 5, 7], [3, 3, 3, 3, 3, 3], [9, 1, 4, 2, 6, 5], [2, 5, 3, 7, 4, 9]],
  [[2, 3, 6, 4, 8, 6], [3, 3, 3, 3, 3, 3], [8, 2, 3, 3, 7, 4], [1, 6, 2, 8, 5, 7]],
  [[0, 5, 3, 9, 4, 8], [3, 3, 3, 3, 3, 3], [7, 3, 5, 1, 5, 6], [3, 4, 4, 6, 3, 8]],
];

function accumulate(keep, options) {
  const accumulator = new samsrf.RunAccumulator(4, keep, options);
  for (const courses of RUNS) {
    const run = samsrf.readGiftiRun(giftiRun(courses));
    accumulator.pushRun(run);
    run.free();
  }
  const result = accumulator.finish();
  accumulator.free();
  return result;
}

const normalised = RUNS.map((courses) => courses.map((course) => zscored(detrended(course))));

test('RunAccumulator averages z-scored runs with the odd/even noise ceiling', () => {
  const result = accumulate(Uint32Array.of(3, 0), { normalise: 'zscore', combine: 'average', noiseCeiling: true, globalSignal: true });
  assert.deepEqual(Array.from(result.kept), [0, 3]);
  assert.deepEqual([result.totalVertices, result.runs, result.volumes, result.vertices], [4, 3, 6, 2]);
  const average = (vertex, runs) => normalised[0][vertex].map((_, t) => mean(runs.map((run) => normalised[run][vertex][t])));
  close(result.data, [...average(0, [0, 1, 2]), ...average(3, [0, 1, 2])]);
  const ceiling = [0, 3].map((vertex) => {
    const rho = correlation(average(vertex, [0, 2]), average(vertex, [1]));
    return (2 * rho) / (1 + rho);
  });
  close(result.noiseCeiling, ceiling);
  const everyVertex = [0, 1, 2, 3].map((vertex) => average(vertex, [0, 1, 2]));
  close(result.globalSignal, everyVertex[0].map((_, t) => mean(everyVertex.map((course) => course[t]))));
});

test('RunAccumulator concatenates detrended runs; defaults follow samsrf_gii2srf', () => {
  const result = accumulate(null, { normalise: 'detrend', combine: 'concatenate', noiseCeiling: false });
  assert.equal(result.kept, null);
  assert.deepEqual([result.volumes, result.vertices], [18, 4]);
  const expected = [0, 1, 2, 3].flatMap((vertex) => RUNS.flatMap((courses) => detrended(courses[vertex])));
  close(result.data, expected);
  assert.equal(result.noiseCeiling, null);
  assert.equal(result.globalSignal, null);
  assert.deepEqual(accumulate(null), accumulate(null, { normalise: 'zscore', combine: 'average', noiseCeiling: true, globalSignal: false }));
  assert.throws(() => new samsrf.RunAccumulator(4, null, { normalise: 'scale' }), /'none', 'detrend' or 'zscore'/);
});

test('RunAccumulator refuses runs of another size and a second finish', () => {
  const accumulator = new samsrf.RunAccumulator(3, null);
  const run = samsrf.readGiftiRun(giftiRun(RUNS[0]));
  assert.throws(() => accumulator.pushRun(run), /run 1 has 4 vertices, expected 3/);
  run.free();
  assert.throws(() => accumulator.finish(), /no runs to combine/);
  assert.throws(() => accumulator.finish(), /already finished/);
  accumulator.free();
});

test('removeNoise regresses the covariates and an intercept out of every course', () => {
  const covariate = Float64Array.of(1, 3, 2, 5, 4);
  const residual = Float64Array.of(0.3, -0.1, 0.2, -0.3, -0.1);
  const course = Array.from(covariate, (value, t) => 2 * value + 7 + residual[t]);
  const result = samsrf.removeNoise({ volumes: 5, vertices: 2, data: Float64Array.from([...course, NaN, 1, 2, 3, 4]) }, covariate, 1);
  const zc = zscored(Array.from(covariate));
  const beta = zc.reduce((sum, value, t) => sum + value * residual[t], 0) / zc.reduce((sum, value) => sum + value * value, 0);
  const meanResidual = mean(Array.from(residual));
  close(result.subarray(0, 5), Array.from(residual, (value, t) => value - meanResidual - beta * zc[t]));
  assert.deepEqual(Array.from(result.subarray(5)), [0, 0, 0, 0, 0]);
});

const PRF_MAPS = {
  values: ['R^2', 'x0', 'y0', 'Sigma', 'Noise Ceiling'],
  vertices: 2,
  data: Float64Array.of(0.5, 0, 3, 1, 4, -1, 0.1, 0.2, 0.9, 0.8),
};

test('exportGiis names one file per row plus polar angle and eccentricity', () => {
  const files = samsrf.exportGiis(PRF_MAPS, 'lh_pRF_Gaussian');
  assert.deepEqual(files.map(({ name }) => name), [
    'lh_pRF_Gaussian_pol.gii',
    'lh_pRF_Gaussian_ecc.gii',
    'lh_pRF_Gaussian_r^2.gii',
    'lh_pRF_Gaussian_x0.gii',
    'lh_pRF_Gaussian_y0.gii',
    'lh_pRF_Gaussian_sigma.gii',
    'lh_pRF_Gaussian_noise_ceiling.gii',
  ]);
  assert.ok(files[0].bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(samsrf.readGifti(files[6].bytes).arrays[0].data), f32([0.9, 0.8]));
  const selected = samsrf.exportGiis(PRF_MAPS, 'rh', ['eccentricity', 'SIGMA']);
  assert.deepEqual(selected.map(({ name }) => name), ['rh_ecc.gii', 'rh_sigma.gii']);
  assert.throws(() => samsrf.exportGiis({ ...PRF_MAPS, vertices: 3 }, 'lh'), /not 5 rows x 3 vertices/);
});

test('polarAndEccentricity derives the maps from x0 and y0, masked by R^2', () => {
  const { polar, eccentricity } = samsrf.polarAndEccentricity(PRF_MAPS);
  close(polar, [(Math.atan2(4, 3) / Math.PI) * 180, (Math.atan2(-1, 1) / Math.PI) * 180]);
  close(eccentricity, [5, 0]);
  assert.equal(samsrf.polarAndEccentricity({ values: ['R^2', 'Beta', 'Sigma'], vertices: 1, data: Float64Array.of(1, 2, 3) }), null);
});

function jobSpec() {
  const apertures = movieApertures();
  const bytes = apertures.serialize();
  apertures.free();
  return {
    kind: 'prf',
    model: readFileSync(new URL('Example_2D_Gaussian_pRF.json', MODELS), 'utf8'),
    apertures: bytes,
    hrf: 'none',
    data: { volumes: 3, vertices: Uint32Array.of(0, 2), courses: new Float64Array(6) },
    totalVertices: 4,
  };
}

test('createJob validates its spec and then reports phase 2', () => {
  assert.throws(() => samsrf.createJob(jobSpec()), /^Error: createJob is not implemented yet \(phase 2\)$/);
  assert.throws(() => samsrf.createJob({ ...jobSpec(), kind: 'glm' }), /kind must be one of prf, rc, cf/);
  assert.throws(() => samsrf.createJob({ ...jobSpec(), model: '{}' }), /Analysis name is undefined/);
  assert.throws(() => samsrf.createJob({ ...jobSpec(), apertures: new Uint8Array(8) }), /apertures/);
  const short = jobSpec();
  short.data.courses = new Float64Array(5);
  assert.throws(() => samsrf.createJob(short), /data.courses/);
});

test('mergePartials reports phase 2', () => {
  assert.throws(() => samsrf.mergePartials([new Uint8Array(1)]), /^Error: mergePartials is not implemented yet \(phase 2\)$/);
  assert.throws(() => samsrf.mergePartials('x'), /array of the Uint8Arrays/);
});
