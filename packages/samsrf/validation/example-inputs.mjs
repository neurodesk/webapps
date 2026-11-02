// Builds `createJob` specs from the web app's example files (the flat directory with
// lh_uBars1-6.gii, aps_Bars.mat, lh.V123.label, lh.V1_seed.label, lh_benson.gii, lh.white,
// lh.area): shared by the parity script, the timing script and the package tests.
import { join } from 'node:path';
import { analysisSpec, readAnalysisInputs, runJob } from '../src/node.js';

export const TOTAL_VERTICES = 134260;

/** Reads the runs once (ROI and seed vertices kept) and every other input. */
export function loadExample(dir, { runs = 6 } = {}) {
  return readAnalysisInputs({
    runs: Array.from({ length: runs }, (_, index) => join(dir, `lh_uBars${index + 1}.gii`)),
    roi: join(dir, 'lh.V123.label'),
    seed: join(dir, 'lh.V1_seed.label'),
    apertures: join(dir, 'aps_Bars.mat'),
    template: join(dir, 'lh_benson.gii'),
    white: join(dir, 'lh.white'),
    area: join(dir, 'lh.area'),
    hemisphere: 'lh',
  });
}

// jobSpec(example, kind, model, { roi }) and runWhole(job, shards, onProgress), under their old names.
export { analysisSpec as jobSpec, runJob as runWhole };

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
