// Builds `createJob` specs from the web app's example files (the flat directory with
// lh_uBars1-6.gii, aps_Bars.mat, lh.V123.label, lh.V1_seed.label, lh_benson.gii, lh.white,
// lh.area): shared by the parity script, the timing script and the package tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as samsrf from '../src/node.js';

export const TOTAL_VERTICES = 134260;

/** Reads the runs once (ROI and seed vertices kept) and every other input. */
export function loadExample(dir, { runs = 6 } = {}) {
  const read = (name) => readFileSync(join(dir, name));
  const roi = samsrf.readFreeSurferLabel(read('lh.V123.label')).vertices;
  const seed = samsrf.readFreeSurferLabel(read('lh.V1_seed.label')).vertices;
  const kept = Uint32Array.from(new Set([...roi, ...seed])).sort();
  const paths = Array.from({ length: runs }, (_, index) => join(dir, `lh_uBars${index + 1}.gii`));
  const data = samsrf.preprocessRuns(paths, { keep: kept, normalise: 'zscore', combine: 'average', noiseCeiling: true, globalSignal: true });
  const apertures = samsrf.readAperturesFile(join(dir, 'aps_Bars.mat'));
  const serialised = apertures.serialize();
  apertures.free();
  const white = samsrf.readFreeSurferSurface(read('lh.white'));
  return {
    roi,
    seed,
    kept: data.kept,
    data: { volumes: data.volumes, vertices: data.kept, courses: data.data },
    noiseCeiling: data.noiseCeiling,
    globalSignal: data.globalSignal,
    apertures: serialised,
    template: samsrf.readBensonTemplate(read('lh_benson.gii'), 'lh'),
    area: samsrf.readFreeSurferCurv(read('lh.area')),
    surface: { vertices: white.vertices, faces: white.faces },
  };
}

/** A `createJob` spec for `kind` on the example, with `roi` (default the V123 label). */
export function jobSpec(example, kind, model, { roi = example.roi } = {}) {
  return {
    kind,
    model: typeof model === 'string' ? model : JSON.stringify(model),
    apertures: example.apertures,
    data: example.data,
    roi,
    noiseCeiling: example.noiseCeiling,
    globalSignal: example.globalSignal,
    seed: { vertices: example.seed, template: example.template },
    surface: example.surface,
    area: example.area,
    totalVertices: TOTAL_VERTICES,
  };
}

export const MODELS = {
  prf: {
    Name: 'pRF_Gaussian',
    Prf_Function: '@(P,ApWidth) prf_gaussian_rf(P(1), P(2), P(3), ApWidth)',
    Param_Names: ['x0', 'y0', 'Sigma'],
    Scaled_Param: [1, 1, 1],
    Only_Positive: [0, 0, 1],
    Scaling_Factor: 9.5,
    TR: 1,
    Hrf: 0,
    Aperture_File: 'aps_Bars',
    Polar_Search_Space: true,
    Param1: colon(0, 10, 350),
    Param2: colon(0.5, 0.5, 15),
    Param3: colon(0.5, 0.5, 12),
  },
  rc: { Name: 'pRF', Scaling_Factor: 9.5, TR: 1, Hrf: 0, Aperture_File: 'aps_Bars' },
  cf: { Name: 'CF_Rcp', SeedRoi: 'lh.V1_seed', Template: 'lh_benson' },
};

function colon(start, step, end) {
  const count = Math.floor((end - start) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, index) => Number((start + index * step).toPrecision(12)));
}

/** Runs a job over `[0, vertexCount)` in `shards` pieces and merges, as the app does. */
export function runWhole(job, shards = 1, onProgress) {
  const total = job.vertexCount;
  const partials = [];
  for (let index = 0; index < shards; index += 1) {
    const start = Math.floor((index * total) / shards);
    const end = Math.floor(((index + 1) * total) / shards);
    partials.push(job.run(start, end, onProgress ? (done) => onProgress(start + done, total) : undefined));
  }
  return job.merge(partials.reverse());
}
