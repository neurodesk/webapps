import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { flaggedSliceMap } from '../src/pipeline.js';
import { localCsv, pyFloat, round2, roundNumpy2, subjectId, summarize, tableCsv, totCsv } from '../src/summary.js';

test('round2 is Python round(x, 2): exact ties go to even', () => {
  assert.equal(round2(0.125), 0.12);
  assert.equal(round2(0.375), 0.38);
  assert.equal(round2(0.625), 0.62);
  assert.equal(round2(0.875), 0.88);
  assert.equal(round2(1 / 3), 0.33);
  assert.equal(round2(0.665), 0.67);
  assert.equal(round2(2 / 3), 0.67);
  assert.equal(roundNumpy2(101 / 200), 0.5);
  assert.equal(round2(101 / 200), 0.51);
  assert.equal(roundNumpy2(0.125), 0.12);
  assert.equal(pyFloat(1), '1.0');
  assert.equal(pyFloat(0.07), '0.07');
});

test('subject ids follow run.py naming', () => {
  assert.equal(subjectId('sub-000103_acq-standard_T1w.nii.gz'), 'sub-000103');
  assert.equal(subjectId('scan.nii'), 'scan');
});

for (const id of ['sub-000103-standard', 'sub-000103-headmotion2']) {
  test(`${id}: the original's slice predictions give its CSV files`, async () => {
    const reference = JSON.parse(await readFile(new URL(`../validation/references/${id}.json`, import.meta.url), 'utf8'));
    const summary = summarize(reference.slices.map(({ axis, slice, pred }) => ({ axis, slice, pred })));
    const tot = reference.files['tot_df.csv'];
    const t = Number(tot.split('\n')[1].split(',')[2]);
    assert.equal(tableCsv(summary), reference.files['table.csv']);
    assert.equal(totCsv(summary, subjectId(reference.input.name), t), tot);
    for (const axis of ['x', 'y', 'z']) assert.equal(localCsv(summary, axis), reference.files[`${axis}_results_locally.csv`]);
  });
}

test('summaries follow transform_log_to_csv.py for each method and area count', () => {
  const predictions = [];
  for (const axis of ['x', 'y', 'z']) for (let slice = 0; slice < 9; slice++) predictions.push({ axis, slice, pred: slice % 3 === 0 ? 1 : 0 });
  const percentage = summarize(predictions, { method: 'percentage', areas: 3 });
  assert.equal(percentage.proba, 0.33);
  // Bins hold floor(last slice / areas) = 2 slices, so 3 areas give five bins, as upstream.
  assert.deepEqual(percentage.axes.x.areas.map((a) => [a.slice_start, a.slice_end, a.proba]), [[0, 1, 0.5], [2, 3, 0.5], [4, 5, 0], [6, 7, 0.5], [8, 8, 0]]);
  assert.equal(summarize(predictions, { method: 'median' }).proba, 0);
  assert.equal(summarize(predictions, { method: 'mean' }).axes.y.proba, 0.33);
  assert.throws(() => summarize(predictions, { areas: 5 }), /Too few slices/);
  assert.throws(() => summarize(predictions, { method: 'max' }), /Unknown method/);
});

test('the flagged-slice map counts flagged slices through each voxel on the input grid', () => {
  const map = flaggedSliceMap([3, 3, 3], { offset: [1, 1, 1], dims: [2, 2, 2] }, [
    { axis: 'x', slice: 0, pred: 1 },
    { axis: 'y', slice: 1, pred: 1 },
    { axis: 'z', slice: 1, pred: 1 },
    { axis: 'z', slice: 0, pred: 0 },
  ]);
  const at = (i, j, k) => map[i + 3 * (j + 3 * k)];
  assert.equal(at(0, 0, 0), 0);
  assert.equal(at(1, 1, 1), 1);
  assert.equal(at(1, 2, 2), 3);
  assert.equal(at(2, 2, 2), 2);
});

// validation/summary_cases.py: random predictions summarized by the original
// transform_log_to_csv.py, including 101 of 200 slices flagged on x.
test('summaries equal transform_log_to_csv.py on random predictions', async () => {
  const cases = JSON.parse(await readFile(new URL('./summary-cases.json', import.meta.url), 'utf8'));
  for (const { preds, method, areas, files } of cases) {
    const predictions = Object.entries(preds).flatMap(([axis, bits]) => [...bits].map((pred, slice) => ({ axis, slice, pred: Number(pred) })));
    const summary = summarize(predictions, { method, areas });
    const label = `${method}, ${areas} areas, ${preds.x.length}/${preds.y.length}/${preds.z.length} slices`;
    assert.equal(totCsv(summary, 'sub-01', 12.3456), files['tot_df.csv'], label);
    for (const axis of ['x', 'y', 'z']) assert.equal(localCsv(summary, axis), files[`${axis}_results_locally.csv`], `${label}, ${axis}`);
  }
});
