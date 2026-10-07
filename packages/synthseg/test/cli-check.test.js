// Every release-check gate in validation/compare.mjs passes a FreeSurfer golden against itself and fails
// on a golden with one defect.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { summarizeLabels } from '@neurodesk/webapp-components/automation';
import freesurferLut from '@neurodesk/webapp-components/automation/freesurfer-lut' with { type: 'json' };
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { compareLabels, compareVolumes, gates } from '../validation/compare.mjs';

const golden = gunzipSync(await readFile(new URL('../../../exes/synthseg/test/fixtures/small_default.nii.gz', import.meta.url)));
const limit = gates.maxMismatchFraction.fixture;
const offset = new DataView(golden.buffer, golden.byteOffset).getFloat32(108, true);

async function report(bytes) {
  return { measurements: summarizeLabels(await readNifti(bytes), freesurferLut) };
}

function failed(checks) {
  return checks.filter(([passed]) => !passed).map(([, line]) => line);
}

function mutate(change) {
  const bytes = Buffer.from(golden);
  change(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes);
  return bytes;
}

// The first labelled voxels, so changing them changes a label's count and leaves the label set alone.
function labelled(view, count) {
  const voxels = [];
  for (let index = 0; voxels.length < count; index++) if (view.getInt32(offset + 4 * index, true) === 2) voxels.push(index);
  return voxels;
}

test('the golden passes every gate against itself', async () => {
  const compared = compareLabels('golden', golden, golden, limit);
  assert.deepEqual(failed(compared.checks), []);
  assert.deepEqual(failed(compareVolumes('golden', await report(golden), compared)), []);
});

test('each gate fails on the defect it guards against', async () => {
  const total = golden.length;
  const cases = [
    ['int32', (view) => view.setInt16(70, 4, true)],
    ['shape', (view) => view.setInt16(42, view.getInt16(42, true) - 1, true)],
    ['sform', (view) => view.setFloat32(280 + 12, view.getFloat32(280 + 12, true) + 0.5, true)],
    ['codes', (view, bytes) => { bytes[254] = 0; }],
    ['xyzt_units', (view, bytes) => { bytes[123] = 1; }],
    ['quaternion', (view) => view.setFloat32(260, view.getFloat32(260, true) + 0.01, true)],
    ['labels', (view) => view.setInt32(offset + 4 * labelled(view, 1)[0], 99, true)],
    ['voxels differ', (view) => { for (const index of labelled(view, 20)) view.setInt32(offset + 4 * index, 3, true); }],
  ];
  for (const [defect, change] of cases) {
    const bytes = mutate(change);
    assert.equal(bytes.length, total);
    const failures = failed(compareLabels('mutated', bytes, golden, limit).checks);
    assert.ok(failures.length > 0, `${defect}: no gate failed`);
    assert.ok(failures.some((line) => line.includes(defect)), `${defect}: failed ${failures.join('; ')}`);
  }
});

test('the report gates fail when its volumes do not describe the label map', async () => {
  const compared = compareLabels('golden', golden, golden, limit);
  const scaled = await report(golden);
  scaled.measurements.voxelVolumeMl *= 8;
  for (const label of scaled.measurements.labels) label.volumeMl *= 8;
  assert.deepEqual(failed(compareVolumes('scaled', scaled, compared)).length, 3, 'unit, per-label and total volume all fail');
  const shifted = await report(golden);
  shifted.measurements.labels[1].volumeMl += 0.01;
  assert.match(failed(compareVolumes('shifted', shifted, compared)).join(';'), /label volumes differ/);
  const dropped = await report(golden);
  dropped.measurements.labels.pop();
  assert.match(failed(compareVolumes('dropped', dropped, compared)).join(';'), /report lists/);
});
