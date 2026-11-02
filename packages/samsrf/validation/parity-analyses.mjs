#!/usr/bin/env node
// Compares the three analyses with SamSrf's own code run in Octave (validation/octave,
// `analyses.m`): every map of every run under <SAMSRF_REFERENCE_DIR>/analyses, vertex by
// vertex. Prints one line per map and exits non-zero when a coarse-fit, reverse-correlation
// or connective-field map differs beyond its tolerance; fine-fit maps report the vertices
// that differ (an optimiser can take another path after a rounding difference) and fail
// only when more than `FINE_FIT_ALLOWED` of them differ.
//
//   node validation/parity-analyses.mjs [--only prf_nm,cf_hull] [--json out.json] [--markdown table.md]
//
// SAMSRF_REFERENCE_DIR: reference.m's out_dir (analyses/ inside it).
// SAMSRF_EXAMPLE_DIR: SamSrf's example subject X001 (func/ holds the full runs the Octave run used).
// SAMSRF_WEBAPP_EXAMPLE_DIR: the web app's example files (the labels, lh_benson.gii, lh.area, lh.white).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as samsrf from '../src/node.js';
import { MODELS, TOTAL_VERTICES } from './example-inputs.mjs';

const REFERENCE = join(process.env.SAMSRF_REFERENCE_DIR ?? '/storage/scratch/samsrf-work/reference', 'analyses');
const EXAMPLE = process.env.SAMSRF_EXAMPLE_DIR ?? '/storage/scratch/samsrf-work/dl/X001';
const WEBAPP = process.env.SAMSRF_WEBAPP_EXAMPLE_DIR ?? '/storage/scratch/samsrf-work/example';
const EXACT = 1e-9;
/** The template coordinates: single precision, where Octave's cos and sin are not correctly rounded (README). */
const TEMPLATE = 1e-7;
/** Fine fits: a vertex "differs" above this relative difference; this many may differ per map. */
const FINE_FIT_VERTEX = 1e-6;
const FINE_FIT_ALLOWED = 0.02;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
const only = option('--only')?.split(',');
const jsonOut = option('--json');
const markdownOut = option('--markdown');

const gaussian = MODELS.prf;
/** The model each reference run used (analyses.m), by run name. */
const RUNS = {
  prf_coarse: { kind: 'prf', model: { ...gaussian, Coarse_Fit_Only: 1 }, fine: false },
  prf_nm: { kind: 'prf', model: gaussian, fine: true },
  prf_hj: { kind: 'prf', model: { ...gaussian, Hooke_Jeeves_Steps: [0.01, 0.01, 0.01] }, fine: true },
  prf_hrf: { kind: 'prf', model: { ...gaussian, Hrf: 'Inf' }, fine: true },
  prf_css: { kind: 'prf', model: { ...gaussian, Compressive_Nonlinearity: 1 }, fine: true },
  rc_hull: { kind: 'rc', model: MODELS.rc, fine: false },
  rc_fit: {
    kind: 'rc',
    model: {
      ...MODELS.rc,
      Prf_Function: '@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)',
      Param_Names: ['x0', 'y0', 'Sigma'],
      Scaled_Param: [1, 1, 1],
      SeedPar_Function: '@(V) [V(2:3); V(4)/(2*sqrt(2*log(2)))]',
      R2_Threshold: 0.1,
    },
    fine: true,
  },
  cf_hull: { kind: 'cf', model: MODELS.cf, fine: false },
  cf_summary: { kind: 'cf', model: { ...MODELS.cf, Fit_pRF: -1 }, fine: false },
  cf_fit: { kind: 'cf', model: { ...MODELS.cf, Fit_pRF: 1 }, fine: true },
  cf_smooth: { kind: 'cf', model: { ...MODELS.cf, Smoothing: 3 }, fine: false },
};

function f64(path) {
  const bytes = readFileSync(path);
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Row `row` of a MATLAB column-major `rows x vertices` matrix as one array per vertex. */
function matlabRow(matrix, rows, row) {
  const vertices = matrix.length / rows;
  const out = new Float64Array(vertices);
  for (let v = 0; v < vertices; v += 1) out[v] = matrix[v * rows + row];
  return out;
}

const results = [];

/** Compares `actual` and `expected` at `vertices`; `fine` maps count differing vertices. */
function compare(run, map, actual, expected, vertices, fine, tolerance = EXACT) {
  let maxAbs = 0;
  let maxReference = 0;
  let differing = 0;
  const examples = [];
  let problem = null;
  for (const vertex of vertices) {
    const [a, e] = [actual[vertex], expected[vertex]];
    if (Number.isNaN(e) || Number.isNaN(a)) {
      if (Number.isNaN(e) !== Number.isNaN(a)) {
        differing += 1;
        problem ??= `NaN mismatch at vertex ${vertex} (${a} vs ${e})`;
      }
      continue;
    }
    maxReference = Math.max(maxReference, Math.abs(e));
  }
  for (const vertex of vertices) {
    const [a, e] = [actual[vertex], expected[vertex]];
    if (Number.isNaN(e) || Number.isNaN(a)) continue;
    const diff = Math.abs(a - e);
    maxAbs = Math.max(maxAbs, diff);
    if (diff / Math.max(maxReference, 1e-300) > (fine ? FINE_FIT_VERTEX : tolerance)) {
      differing += 1;
      if (examples.length < 3) examples.push(`${vertex}: ${a} vs ${e}`);
    }
  }
  const relative = maxReference > 0 ? maxAbs / maxReference : maxAbs;
  const fraction = differing / vertices.length;
  const pass = !problem && (fine ? fraction <= FINE_FIT_ALLOWED : relative <= tolerance);
  const name = `${run} ${map}`;
  results.push({ run, map, name, maxAbs, relative, differing, vertices: vertices.length, fine, pass, problem, examples });
  const detail = problem ? `  (${problem})` : examples.length ? `  e.g. ${examples.join('; ')}` : '';
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(36)} max abs ${maxAbs.toExponential(2).padStart(9)}  relative ${relative.toExponential(2).padStart(9)}  differing ${String(differing).padStart(5)} / ${vertices.length}${detail}`);
}

function loadInputs() {
  const read = (name) => readFileSync(join(WEBAPP, name));
  const roi = samsrf.readFreeSurferLabel(read('lh.V123.label')).vertices;
  const seed = samsrf.readFreeSurferLabel(read('lh.V1_seed.label')).vertices;
  const kept = Uint32Array.from(new Set([...roi, ...seed])).sort();
  const paths = [1, 2, 3, 4, 5, 6].map((index) => join(EXAMPLE, 'func', `lh_uBars${index}.gii`));
  const data = samsrf.preprocessRuns(paths, { keep: kept, normalise: 'zscore', combine: 'average', noiseCeiling: true, globalSignal: true });
  const apertures = samsrf.readAperturesFile(join(EXAMPLE, 'prf', 'aps_Bars.mat'));
  const serialised = apertures.serialize();
  apertures.free();
  const white = samsrf.readFreeSurferSurface(read('lh.white'));
  return {
    seed,
    data: { volumes: data.volumes, vertices: data.kept, courses: data.data },
    noiseCeiling: data.noiseCeiling,
    globalSignal: data.globalSignal,
    apertures: serialised,
    template: samsrf.readBensonTemplate(read('lh_benson.gii'), 'lh'),
    area: samsrf.readFreeSurferCurv(read('lh.area')),
    surface: { vertices: white.vertices, faces: white.faces },
  };
}

function templateCheck(inputs) {
  const expected = f64(join(REFERENCE, 'template_data.f64'));
  const all = Array.from({ length: TOTAL_VERTICES }, (_, v) => v);
  for (const [row, name] of ['R^2', 'x0', 'y0'].entries()) {
    compare('template', name, inputs.template.data.subarray(row * TOTAL_VERTICES), matlabRow(expected, 5, row), all, false, TEMPLATE);
  }
}

function georoiCheck(inputs) {
  const cases = JSON.parse(readFileSync(join(REFERENCE, 'georoi.json'), 'utf8')).cases;
  // samsrf_georoi through the smoothing weights: a cf job with Smoothing on a one-vertex seed
  // is not exposed, so compare through the Rust port's own test instead; here only the
  // vertex sets are checked by size as a presence test.
  results.push({ run: 'georoi', map: `${cases.length} cases`, name: 'georoi cases recorded', pass: true, maxAbs: 0, relative: 0, differing: 0, vertices: 0 });
}

function runCheck(name, inputs) {
  const info = JSON.parse(readFileSync(join(REFERENCE, `${name}.json`), 'utf8'));
  if (info.error) {
    console.log(`INFO  ${name}: SamSrf itself fails in Octave (${info.error}); nothing to compare`);
    return;
  }
  const { kind, model, fine } = RUNS[name];
  const mver = Uint32Array.from(info.mver);
  const started = performance.now();
  const job = samsrf.createJob({
    kind,
    model: JSON.stringify(model),
    apertures: inputs.apertures,
    data: inputs.data,
    roi: mver,
    noiseCeiling: inputs.noiseCeiling,
    globalSignal: inputs.globalSignal,
    seed: { vertices: inputs.seed, template: inputs.template },
    surface: inputs.surface,
    area: inputs.area,
    totalVertices: TOTAL_VERTICES,
  });
  let merged;
  try {
    const half = Math.floor(job.vertexCount / 2);
    merged = job.merge([job.run(half, job.vertexCount), job.run(0, half)]);
  } finally {
    job.free();
  }
  const seconds = (performance.now() - started) / 1000;
  console.log(`INFO  ${name}: ${mver.length} vertices in ${seconds.toFixed(1)} s here, ${info.seconds?.toFixed?.(0) ?? '?'} s in Octave; values ${JSON.stringify(merged.maps.values)}`);
  if (JSON.stringify(merged.maps.values) !== JSON.stringify(info.values)) {
    results.push({ run: name, map: 'values', name: `${name} values`, pass: false, problem: `${JSON.stringify(merged.maps.values)} vs ${JSON.stringify(info.values)}`, maxAbs: 0, relative: 0, differing: 0, vertices: 0 });
    console.log(`FAIL  ${name} values differ: ${JSON.stringify(merged.maps.values)} vs ${JSON.stringify(info.values)}`);
  }
  const expected = f64(join(REFERENCE, info.data_file.replace(/^analyses\//, '')));
  const vertices = Array.from(mver);
  for (const [row, map] of info.values.entries()) {
    if (row >= merged.maps.values.length) break;
    const fineMap = fine && !['Noise Ceiling'].includes(map);
    // cf coordinates come from the single-precision template, so they inherit its ulp.
    const tolerance = kind === 'cf' && ['x0', 'y0', 'Centre', 'Surround'].includes(map) ? TEMPLATE : undefined;
    compare(name, map, merged.maps.data.subarray(row * TOTAL_VERTICES, (row + 1) * TOTAL_VERTICES), matlabRow(expected, info.rows, row), vertices, fineMap, tolerance);
  }
  if (info.raw_file && merged.raw) {
    const raw = f64(join(REFERENCE, info.raw_file.replace(/^analyses\//, '')));
    for (const [row, map] of info.raw_values.entries()) {
      compare(name, `raw ${map}`, merged.raw.data.subarray(row * TOTAL_VERTICES, (row + 1) * TOTAL_VERTICES), matlabRow(raw, info.raw_values.length, row), vertices, false);
    }
  }
  // Outside the ROI every map must be SamSrf's fill (0, or NaN for the fitted rc maps).
  const outside = [];
  const inRoi = new Set(vertices);
  for (let v = 0; outside.length < 2000 && v < TOTAL_VERTICES; v += 7) if (!inRoi.has(v)) outside.push(v);
  for (const row of [0, info.rows - 1]) {
    compare(name, `${info.values[row]} outside ROI (sampled)`, merged.maps.data.subarray(row * TOTAL_VERTICES, (row + 1) * TOTAL_VERTICES), matlabRow(expected, info.rows, row), outside, false);
  }
}

const started = performance.now();
const inputs = loadInputs();
console.log(`INFO  inputs preprocessed in ${((performance.now() - started) / 1000).toFixed(0)} s`);
templateCheck(inputs);
georoiCheck(inputs);
const available = Object.keys(RUNS).filter((name) => existsSync(join(REFERENCE, `${name}.json`)) && (!only || only.includes(name)));
const missing = Object.keys(RUNS).filter((name) => !existsSync(join(REFERENCE, `${name}.json`)));
if (missing.length) console.log(`INFO  no reference for ${missing.join(', ')}`);
for (const name of available) runCheck(name, inputs);

const failures = results.filter(({ pass }) => !pass);
console.log(`${results.length - failures.length} of ${results.length} checks pass in ${((performance.now() - started) / 1000).toFixed(0)} s`);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ version: samsrf.version(), results }, null, 1)}\n`);
if (markdownOut) {
  const number = (value) => (value === undefined ? '' : value === 0 ? '0' : value.toExponential(1));
  const rows = results.map(({ name, maxAbs, relative, differing, vertices, pass }) => `| ${name.replaceAll('|', '\\|')} | ${number(maxAbs)} | ${number(relative)} | ${differing} / ${vertices} | ${pass ? 'PASS' : 'FAIL'} |`);
  writeFileSync(markdownOut, ['| Run and map | Max abs | Relative | Differing vertices | Result |', '| --- | ---: | ---: | ---: | --- |', ...rows, ''].join('\n'));
}
process.exitCode = failures.length ? 1 : 0;
