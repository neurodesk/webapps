#!/usr/bin/env node
// Compares the WebAssembly package with the Octave reference that SamSrf's own .m files
// produced (validation/octave). Prints one line per check and exits non-zero on a failure.
//
//   node validation/parity.mjs [--json out.json]
//
// SAMSRF_REFERENCE_DIR: the reference outputs (reference.m's out_dir).
// SAMSRF_EXAMPLE_DIR: SamSrf's example subject X001 (func/, prf/).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as samsrf from '../src/node.js';

const REFERENCE = process.env.SAMSRF_REFERENCE_DIR ?? '/storage/scratch/samsrf-work/reference';
const EXAMPLE = process.env.SAMSRF_EXAMPLE_DIR ?? '/storage/scratch/samsrf-work/dl/X001';
const TOLERANCE = 1e-9;
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

function reference(name) {
  return JSON.parse(readFileSync(join(REFERENCE, name), 'utf8'));
}

function f64(name) {
  const bytes = readFileSync(join(REFERENCE, name));
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** `rows x 2` column-major (MATLAB) to x, y interleaved per point. */
function interleave(columnMajor) {
  const rows = columnMajor.length / 2;
  const out = new Float64Array(columnMajor.length);
  for (let row = 0; row < rows; row += 1) {
    out[2 * row] = columnMajor[row];
    out[2 * row + 1] = columnMajor[rows + row];
  }
  return out;
}

const results = [];

function check(name, actual, expected, tolerance = TOLERANCE) {
  let maxAbs = 0;
  let maxReference = 0;
  let problem = actual.length === expected.length ? null : `length ${actual.length}, expected ${expected.length}`;
  for (let i = 0; !problem && i < expected.length; i += 1) {
    const [a, e] = [actual[i], expected[i]];
    if (Number.isNaN(e) || Number.isNaN(a)) {
      if (Number.isNaN(e) !== Number.isNaN(a)) problem = `NaN mismatch at ${i} (${a} vs ${e})`;
      continue;
    }
    if (!Number.isFinite(e) || !Number.isFinite(a)) {
      if (a !== e) problem = `infinity mismatch at ${i} (${a} vs ${e})`;
      continue;
    }
    maxAbs = Math.max(maxAbs, Math.abs(a - e));
    maxReference = Math.max(maxReference, Math.abs(e));
  }
  const relative = maxReference > 0 ? maxAbs / maxReference : maxAbs;
  const pass = !problem && relative <= tolerance;
  results.push({ name, maxAbs, relative, tolerance, pass, problem });
  const detail = problem ? `  (${problem})` : '';
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} max abs ${maxAbs.toExponential(2).padStart(9)}  relative ${relative.toExponential(2).padStart(9)}  tol ${tolerance.toExponential(0)}${detail}`);
}

function giftiRuns() {
  const samples = reference('gifti_run.json');
  for (const [file, expected] of Object.entries(samples)) {
    const run = samsrf.readRunFile(join(EXAMPLE, 'func', file));
    try {
      const actual = expected.samples.map(({ volume, vertex }) => run.course(vertex)[volume]);
      check(`GIFTI ${file}: ${expected.samples.length} samples (${run.volumes} x ${run.vertices})`, actual, expected.samples.map(({ value }) => value), 0);
      if (run.volumes !== expected.arrays || run.vertices !== expected.vertices) {
        results.push({ name: `GIFTI ${file} shape`, pass: false, problem: `${run.volumes} x ${run.vertices}` });
      }
    } finally {
      run.free();
    }
  }
}

function aperturesChecks(apertures) {
  const info = reference('apertures.json');
  check('apertures ApFrm (pixels x volumes)', apertures.toDense(), f64('apertures_apfrm.f64'));
  // ApXY's largest magnitude is 1 (apertures.json apxy_max_abs), so scaledXy(1) is ApXY itself.
  if (info.apxy_max_abs !== 1) throw new Error('apertures.json apxy_max_abs is not 1');
  check('apertures ApXY', apertures.scaledXy(1), interleave(f64('apertures_apxy.f64')));
  check(`apertures ApXY scaled ${info.scaling_factor}`, apertures.scaledXy(info.scaling_factor), interleave(f64('apertures_apxy_scaled.f64')));
}

function preprocessing() {
  const { subset } = reference('preprocess_vertices.json');
  const keep = Uint32Array.from(subset);
  const paths = [1, 2, 3, 4, 5, 6].map((index) => join(EXAMPLE, 'func', `lh_uBars${index}.gii`));
  let accumulators;
  for (const [index, path] of paths.entries()) {
    const run = samsrf.readRunFile(path);
    accumulators ??= {
      average: new samsrf.RunAccumulator(run.vertices, keep, { normalise: 'zscore', combine: 'average', noiseCeiling: true, globalSignal: true }),
      concat: new samsrf.RunAccumulator(run.vertices, keep, { normalise: 'zscore', combine: 'concatenate', globalSignal: true }),
      detrend: new samsrf.RunAccumulator(run.vertices, keep, { normalise: 'detrend', combine: 'average', noiseCeiling: true }),
    };
    accumulators.average.pushRun(run);
    accumulators.concat.pushRun(run);
    if (index === 0) accumulators.detrend.pushRun(run);
    run.free();
  }
  const finished = Object.fromEntries(Object.entries(accumulators).map(([name, accumulator]) => {
    const result = accumulator.finish();
    accumulator.free();
    return [name, result];
  }));
  const { average: averaged, concat, detrend } = finished;
  check(`preprocess average, ${subset.length} vertices x ${averaged.volumes} volumes`, averaged.data, f64('preprocess_average.f64'));
  check('preprocess noise ceiling (finite entries, NaN positions)', averaged.noiseCeiling, f64('preprocess_noise_ceiling.f64'));
  check('global signal, average', averaged.globalSignal, f64('global_signal_average.f64'));
  check(`preprocess concatenate, ${concat.volumes} volumes`, concat.data, f64('preprocess_concat.f64'));
  check('global signal, concatenate', concat.globalSignal, f64('global_signal_concat.f64'));
  check('preprocess detrend only, run 1', detrend.data, f64('preprocess_detrend_run1.f64'));
  const cleaned = samsrf.removeNoise(averaged, averaged.globalSignal, 1);
  check('removenoise (global signal)', cleaned, f64('preprocess_removenoise.f64'));
  return { subset, averaged };
}

function hrfs() {
  const { fP, nondefault_parameters: nondefault, test_sequence: sequence, entries } = reference('hrf.json');
  const kernels = {
    doublegamma_default: (tr) => samsrf.hrf.doublegamma(tr),
    samsrf_hrf: (tr) => samsrf.hrf.deHaas(tr),
    old_school: (tr) => samsrf.hrf.oldSchool(tr, fP),
    doublegamma_nondefault: (tr) => samsrf.hrf.doublegamma(tr, nondefault),
  };
  const y = Float64Array.from(sequence);
  for (const entry of entries) {
    const kernel = kernels[entry.kernel](entry.tr);
    check(`HRF ${entry.kernel} TR ${entry.tr}`, kernel, entry.values);
    check(`HRF ${entry.kernel} TR ${entry.tr} convolution`, samsrf.hrf.convolve(y, kernel, 1), entry.convolve_ds1);
    check(`HRF ${entry.kernel} TR ${entry.tr} convolution, downsampled 2`, samsrf.hrf.convolve(y, kernel, 2), entry.convolve_ds2);
  }
}

function profiles() {
  const { screen_width: screenWidth, entries } = reference('prf_profiles.json');
  const xy = interleave(f64('apertures_apxy_scaled.f64'));
  for (const entry of entries) {
    const domain = entry.branch === 'xy' ? xy : screenWidth;
    const actual = samsrf.prfProfile(entry.function, entry.params, domain);
    check(`profile ${entry.function} [${entry.params.join(' ')}] ${entry.branch}`, actual, f64(entry.file));
  }
}

function expressions() {
  const { cases } = reference('expr.json');
  for (const [index, entry] of cases.entries()) {
    const parameters = entry.source.match(/^@\(([^)]*)\)/)[1].split(',');
    const { P, XY, V } = entry.inputs;
    const args = parameters.length === 2
      ? [{ rows: 1, cols: P.length, data: P }, { rows: XY.length, cols: 2, data: [...XY.map(([x]) => x), ...XY.map(([, y]) => y)] }]
      : [V];
    const result = samsrf.evaluateExpression(entry.source, args);
    const shape = `${result.rows} x ${result.cols}`;
    if (shape !== entry.shape.join(' x ')) {
      results.push({ name: `expr ${index + 1}`, pass: false, problem: `shape ${shape}, expected ${entry.shape.join(' x ')}` });
      console.log(`FAIL  expr ${index + 1}: shape ${shape}, expected ${entry.shape.join(' x ')}`);
      continue;
    }
    check(`expr ${String(index + 1).padStart(2)} ${entry.files[0]} (${entry.kind})`, result.data, entry.values);
  }
}

function errfuns(apertures, { subset, averaged }) {
  const { prf_function: prfFunction, cases, predicted_timecourse: predicted } = reference('errfun.json');
  const xy = interleave(f64('apertures_apxy_scaled.f64'));
  const observed = (vertex) => {
    const position = subset.indexOf(vertex);
    return averaged.data.subarray(position * averaged.volumes, (position + 1) * averaged.volumes);
  };
  const rfp = samsrf.prfProfile(prfFunction, predicted.P, xy);
  check(`predicted time course [${predicted.P.join(' ')}]`, samsrf.predictTimecourse(rfp, apertures), predicted.values);
  for (const entry of cases) {
    const hrf = entry.hrf === -1 ? { fit: 1 } : samsrf.hrf.doublegamma(1);
    const err = samsrf.errfun({
      prfFunction,
      apertures,
      xy,
      hrf,
      params: entry.P,
      observed: observed(entry.vertex),
      downsampling: entry.downsampling,
      cssNonlinearity: entry.css_nonlinearity,
    });
    const hrfName = entry.hrf === -1 ? 'fitted HRF' : 'canonical HRF';
    const css = entry.css_nonlinearity ? ', CSS' : '';
    check(`errfun vertex ${entry.vertex} [${entry.P.join(' ')}] ${hrfName}${css}`, [err], [entry.err]);
  }
  return { xy, observed: observed(cases[0].vertex), prfFunction };
}

function timeErrfun(apertures, { xy, observed, prfFunction }) {
  const hrf = samsrf.hrf.spmCanonical(1);
  const call = () => samsrf.errfun({ prfFunction, apertures, xy, hrf, params: [2, 1, 1.5], observed });
  for (let i = 0; i < 20; i += 1) call();
  const [blocks, calls] = [10, 200];
  let ms = Infinity;
  for (let block = 0; block < blocks; block += 1) {
    const start = performance.now();
    for (let i = 0; i < calls; i += 1) call();
    ms = Math.min(ms, (performance.now() - start) / calls);
  }
  console.log(`TIME  errfun (gaussian, ${apertures.width} x ${apertures.height} x ${apertures.volumes} apertures, canonical HRF): ${ms.toFixed(3)} ms per call in WebAssembly (fastest of ${blocks} blocks of ${calls} calls)`);
  return ms;
}

const started = performance.now();
giftiRuns();
const apertures = samsrf.readAperturesFile(join(EXAMPLE, 'prf', 'aps_Bars.mat'));
aperturesChecks(apertures);
const preprocessed = preprocessing();
hrfs();
profiles();
expressions();
const errfunInputs = errfuns(apertures, preprocessed);
const errfunMs = timeErrfun(apertures, errfunInputs);
apertures.free();

const failures = results.filter(({ pass }) => !pass);
console.log(`${results.length - failures.length} of ${results.length} checks pass in ${((performance.now() - started) / 1000).toFixed(0)} s`);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ version: samsrf.version(), errfunMs, results }, null, 1)}\n`);
process.exitCode = failures.length ? 1 : 0;
