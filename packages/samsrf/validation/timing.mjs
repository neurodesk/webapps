#!/usr/bin/env node
// Wall time of each analysis on the example's V123 ROI (6587 vertices) in Node, single
// thread, on the committed WebAssembly module.
//
//   SAMSRF_WEBAPP_EXAMPLE_DIR=/storage/scratch/samsrf-work/example node validation/timing.mjs [--roi N]
import { performance } from 'node:perf_hooks';
import * as samsrf from '../src/node.js';
import { MODELS, jobSpec, loadExample, runWhole } from '../validation/example-inputs.mjs';

const dir = process.env.SAMSRF_WEBAPP_EXAMPLE_DIR ?? '/storage/scratch/samsrf-work/example';
const limit = process.argv.includes('--roi') ? Number(process.argv[process.argv.indexOf('--roi') + 1]) : null;

const started = performance.now();
const example = loadExample(dir);
console.log(`inputs read and preprocessed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
const roi = limit ? example.roi.slice(0, limit) : example.roi;

const cases = [
  ['prf (Nelder-Mead)', 'prf', MODELS.prf],
  ['prf (Hooke-Jeeves)', 'prf', { ...MODELS.prf, Hooke_Jeeves_Steps: [0.01, 0.01, 0.01] }],
  ['prf (coarse fit only)', 'prf', { ...MODELS.prf, Coarse_Fit_Only: 1 }],
  ['rc (convex hull)', 'rc', MODELS.rc],
  ['cf (convex hull)', 'cf', MODELS.cf],
];
for (const [label, kind, model] of cases) {
  const t0 = performance.now();
  const job = samsrf.createJob(jobSpec(example, kind, model, { roi }));
  const t1 = performance.now();
  runWhole(job, 1);
  const t2 = performance.now();
  job.free();
  console.log(`${label}: prepare ${((t1 - t0) / 1000).toFixed(1)} s, ${roi.length} vertices in ${((t2 - t1) / 1000).toFixed(1)} s (${((t2 - t1) / roi.length).toFixed(2)} ms per vertex)`);
}
