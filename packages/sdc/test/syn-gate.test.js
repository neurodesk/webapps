// The SyN-SDC pipeline against the native sdcflows reference runs of #461 and #462 (plan
// section 6.2). Data-gated: the sdc-registration-gate workflow provisions the pinned data and
// sets SDC_REQUIRE_SYN_GATE=1, so missing data fails there instead of skipping.
//
//   SDC_REFERENCE  sdc/reference/ (subsets reference-run and slab, exes/dwi/sdc/validation/fetch_reference.py)
//   SDC_GRID       sdc/reference/grid-q68/ (subset replay-1.2mm, --folder grid)
//   SDC_PRIOR      sdc/prior/ (--folder prior)
//   SDC_SLAB       the noddi slab example (validation/fetch-slab.mjs)
//   SDC_SYN_GATE_OUTPUT  where to keep the outputs and report.json (default: a temporary directory)
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMatTransform } from '@neurodesk/hmc-registration';
import { loadFieldFit } from '../src/field-fit.js';
import { flipVolume, positiveCosines } from '../src/syn/grid.js';
import { readImage } from '../src/syn/nifti.js';
import { percentileSorted } from '../src/syn/numerics.js';
import { correctFiles } from '../src/syn/node.js';
import { unwarpSeries } from '../src/syn/unwarp.js';

const { SDC_REFERENCE: reference, SDC_GRID: grid, SDC_PRIOR: prior, SDC_SLAB: slab, SDC_SYN_GATE_OUTPUT: keep } = process.env;
const required = process.env.SDC_REQUIRE_SYN_GATE === '1';
const gate = (variables) => (variables.every(Boolean) || required ? false : 'Set SDC_REFERENCE, SDC_GRID, SDC_PRIOR (and SDC_SLAB) to run the reference gates.');
const HOURS = 3600_000;
const INPUT = 'input/sub-01_dir-AP_run-001_dwi';
const REFERENCE_2MM = 'runs/full-2mm-s1234-double-affine/work';
const REFERENCE_12 = 'runs/full-1.2mm-s1234-double-affine/work/sdc_ref';

function requireData(...variables) {
  for (const [name, value] of variables) assert.ok(value, `${name} is required (SDC_REQUIRE_SYN_GATE=1)`);
}

/** median, p95 and max of |a - b| over the mask, as compare_fields.py computes them. */
function difference(a, b, mask) {
  const values = [];
  for (let i = 0; i < a.length; i++) if (mask[i] > 0) values.push(Math.abs(a[i] - b[i]));
  const sorted = Float64Array.from(values).sort();
  return { median: percentileSorted(sorted, 50), p95: percentileSorted(sorted, 95), max: sorted.at(-1) };
}

/** An ITK .mat as a RAS 4 x 4 matrix (nitransforms' fmt="itk"). */
function rasMatrix(bytes) {
  const { parameters, fixed } = readMatTransform(bytes);
  const m = [[parameters[0], parameters[1], parameters[2]], [parameters[3], parameters[4], parameters[5]], [parameters[6], parameters[7], parameters[8]]];
  const t = [0, 1, 2].map((i) => parameters[9 + i] + fixed[i] - m[i].reduce((sum, value, j) => sum + value * fixed[j], 0));
  const flip = [-1, -1, 1];
  return [0, 1, 2].map((i) => [...[0, 1, 2].map((j) => flip[i] * m[i][j] * flip[j]), flip[i] * t[i]]);
}

/** The median distance (mm) between where two affines send the mask's voxel centres. */
function affineShift(a, b, mask, affine, dims) {
  const distances = [];
  for (let i = 0; i < mask.length; i++) {
    if (!(mask[i] > 0)) continue;
    const ijk = [i % dims[0], Math.floor(i / dims[0]) % dims[1], Math.floor(i / (dims[0] * dims[1]))];
    const p = [0, 1, 2].map((r) => affine[r][0] * ijk[0] + affine[r][1] * ijk[1] + affine[r][2] * ijk[2] + affine[r][3]);
    const d = [0, 1, 2].map((r) => a[r][0] * p[0] + a[r][1] * p[1] + a[r][2] * p[2] + a[r][3] - (b[r][0] * p[0] + b[r][1] * p[1] + b[r][2] * p[2] + b[r][3]));
    distances.push(Math.hypot(...d));
  }
  return percentileSorted(Float64Array.from(distances).sort(), 50);
}

const equalVoxels = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

async function output(name) {
  const directory = keep ? join(keep, name) : await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), `sdc-${name}-`));
  await mkdir(directory, { recursive: true });
  return directory;
}

test('the DWI unwarp reproduces sdcflows ApplyCoeffsField(jacobian=True) from the reference coefficients', { skip: gate([reference]), timeout: HOURS }, async () => {
  requireData(['SDC_REFERENCE', reference]);
  const fieldFit = await loadFieldFit(await readFile(new URL('../src/sdc-field-fit.wasm', import.meta.url)));
  const dwi = await readImage(await readFile(join(reference, `${INPUT}.nii.gz`)));
  const coefficients = await readImage(await readFile(join(reference, REFERENCE_2MM, 'sdc_ref/syn_sdc_wf/bs_filter/fmap_syn0Warp_Hz_trans_coeff000.nii.gz')));
  const sidecar = JSON.parse(await readFile(join(reference, `${INPUT}.json`), 'utf8'));
  const positive = positiveCosines(dwi.dims, dwi.affine);
  const field = fieldFit.evaluate(coefficients.data, { shape: coefficients.dims, affine: coefficients.affine }, { shape: dwi.dims, affine: positive.affine });
  const expectedField = await readImage(await readFile(join(reference, REFERENCE_2MM, 'unwarp_dwi/sub-01_dir-AP_run-001_dwi_field.nii.gz')));
  assert.ok(equalVoxels(field, expectedField.data), 'the field on the positive-cosine grid is sdcflows\' field');
  const corrected = unwarpSeries({ data: dwi.data, dims: dwi.dims, frames: dwi.frames, affine: dwi.affine, field, phaseEncodingDirection: sidecar.PhaseEncodingDirection, totalReadoutTime: sidecar.TotalReadoutTime });
  const expected = await readImage(await readFile(join(reference, REFERENCE_2MM, 'unwarp_dwi/sub-01_dir-AP_run-001_dwi_sdc.nii.gz')));
  // sdcflows writes the series as int16 with a slope: its voxels are within half a step of the truth.
  const view = new DataView(expected.header);
  const halfStep = Math.abs(view.getFloat32(112, true)) / 2;
  let largest = 0;
  for (let i = 0; i < corrected.length; i++) largest = Math.max(largest, Math.abs(corrected[i] - expected.data[i]));
  console.log(JSON.stringify({ unwarp: { maxAbsDifference: largest, referenceHalfStep: halfStep } }));
  assert.ok(largest <= halfStep * 1.01, `largest difference ${largest} exceeds the reference's half quantisation step ${halfStep}`);
});

test('the full-brain pipeline meets the Q66 gate against native sdcflows on the 1.2 mm grid', { skip: gate([reference, grid, prior]), timeout: 6 * HOURS }, async () => {
  requireData(['SDC_REFERENCE', reference], ['SDC_GRID', grid], ['SDC_PRIOR', prior]);
  const directory = await output('full-brain');
  const started = performance.now();
  const stages = {};
  const result = await correctFiles({
    dwi: join(reference, `${INPUT}.nii.gz`),
    bval: join(reference, `${INPUT}.bval`),
    bvec: join(reference, `${INPUT}.bvec`),
    json: join(reference, `${INPUT}.json`),
    t1w: join(reference, 'input/sub-01_run-001_T1w.nii.gz'),
    prior,
    output: join(directory, 'derivatives'),
    seed: 1234,
    onProgress: ({ stage }) => {
      if (!(stage in stages)) stages[stage] = Math.round((performance.now() - started) / 1000);
    },
  });
  const { intermediate } = result;
  const epiMask = await readImage(await readFile(join(reference, 'mask/sub-01_dir-AP_run-001_desc-mindgrab_mask.nii.gz')));
  const anatMask = await readImage(await readFile(join(reference, 'mask/sub-01_run-001_desc-mindgrab_mask.nii.gz')));
  const meanB0 = await readImage(await readFile(join(reference, 'mask/sub-01_dir-AP_run-001_desc-meanb0_dwiref.nii')));
  const ours = {
    meanB0: await readImage(intermediate.meanB0),
    epiMask: await readImage(intermediate.epiMask),
    anatMask: await readImage(intermediate.t1wMask),
  };
  const dims = epiMask.dims;
  const positive = positiveCosines(dims, epiMask.affine);
  const nativeField = await readImage(await readFile(join(grid, REFERENCE_12, 'syn_sdc_wf/unwarp/clipped_field.nii.gz')));
  const nativePre = await readImage(await readFile(join(grid, REFERENCE_12, 'syn_sdc_wf/zooms_field/fmap_syn0Warp_Hz_trans.nii.gz')));
  const fmap = difference(result.field, flipVolume(nativeField.data, dims, positive.flips), epiMask.data);
  const pre = difference(intermediate.fieldBeforeFit, nativePre.data, epiMask.data);
  const epi2anat = await readFile(join(grid, REFERENCE_12, 'syn_preprocessing_wf/epi2anat/transform0GenericAffine.mat'));
  const anat2std = await readFile(join(reference, 'std2anat/affine/anat2std_affine_0GenericAffine.mat'));
  const report = {
    reference: 'native sdcflows 2.17.1, double, seed 1234, 1.2 mm grid (sdc/reference/grid-q68 at e773666d)',
    fmap,
    pre,
    epi2anatShiftMm: affineShift(rasMatrix(intermediate.epi2anat), rasMatrix(epi2anat), epiMask.data, epiMask.affine, dims),
    anat2stdShiftMm: affineShift(rasMatrix(intermediate.anat2std), rasMatrix(anat2std), anatMask.data, anatMask.affine, anatMask.dims),
    sameMeanB0: equalVoxels(ours.meanB0.data, meanB0.data),
    sameDwiMask: equalVoxels(ours.epiMask.data, epiMask.data),
    sameT1wMask: equalVoxels(ours.anatMask.data, anatMask.data),
    stageStartSeconds: stages,
    wallSeconds: Math.round((performance.now() - started) / 1000),
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    q66: { floorHz: 0.05, capHz: 0.5, spread: 'not measured end to end on the 1.2 mm grid: the floor decides when d <= 0.05 Hz' },
  };
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.sameMeanB0, 'the mean b0 is the reference\'s');
  assert.ok(report.sameDwiMask && report.sameT1wMask, 'the MindGrab masks are the reference\'s');
  // Q66: d <= max(spread, 0.05 Hz) and d < 0.5 Hz. Without the end-to-end double spread on this
  // grid only d <= 0.05 Hz decides the first condition, as gate.py --require does.
  assert.ok(fmap.median < 0.5, `d = ${fmap.median} Hz is not under the 0.5 Hz cap`);
  assert.ok(fmap.median <= 0.05, `d = ${fmap.median} Hz: the seed-spread condition is undecided without the 1.2 mm end-to-end spread`);
});

test('the slab with the full T1w runs end to end (report only, against the native 2 mm slab runs)', { skip: gate([reference, prior, slab]), timeout: 6 * HOURS }, async () => {
  requireData(['SDC_REFERENCE', reference], ['SDC_PRIOR', prior], ['SDC_SLAB', slab]);
  const directory = await output('slab');
  const started = performance.now();
  const stem = join(slab, 'sub-01_dir-AP_desc-slab_dwi');
  const result = await correctFiles({
    dwi: `${stem}.nii.gz`,
    bval: `${stem}.bval`,
    bvec: `${stem}.bvec`,
    json: `${stem}.json`,
    t1w: join(reference, 'input/sub-01_run-001_T1w.nii.gz'),
    t1wMask: join(reference, 'mask/sub-01_run-001_desc-mindgrab_mask.nii.gz'),
    prior,
    output: join(directory, 'derivatives'),
  });
  const mask = await readImage(await readFile(join(reference, 'mask/slab/sub-01_dir-AP_desc-slab_desc-mindgrab_mask.nii.gz')));
  const positive = positiveCosines(mask.dims, mask.affine);
  const report = { wallSeconds: Math.round((performance.now() - started) / 1000), sameDwiMask: equalVoxels((await readImage(result.intermediate.epiMask)).data, mask.data) };
  for (const run of ['slab-2mm-s1234-double-affine', 'slab-2mm-s1235-double-affine', 'slab-2mm-s1236-double-affine', 'slab-2mm-s1234-float-affine']) {
    const native = await readImage(await readFile(join(reference, 'runs', run, 'work/sdc_ref/syn_sdc_wf/unwarp/clipped_field.nii.gz')));
    report[run] = difference(result.field, flipVolume(native.data, mask.dims, positive.flips), mask.data);
  }
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ slab: report }, null, 2));
  assert.equal(result.field.length, mask.data.length);
});
