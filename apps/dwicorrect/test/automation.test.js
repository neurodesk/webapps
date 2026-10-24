import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionSidecar, correctionFiles } from '../src/automation.js';
import { readDiffusionSeries } from '../../../packages/runtime-support/src/dcm2niix-client/index.ts';
import { describeSeries, preprocSidecar, meanB0Data } from '../src/pipeline.js';

const file = (name, value) => new File([value], name);
const inputs = () => ({
  dwi: [file('corrected_dwi.nii', 'image')], bval: [file('first.bval', '0 1000')], bvec: [file('second.bvec', '0 1\n0 0\n0 0')],
});

test('automation never obtains missing acquisition values from interface defaults', async () => {
  await assert.rejects(correctionFiles(inputs()), /phaseEncodingDirection parameter/);
  await assert.rejects(correctionFiles(inputs(), {}, { phaseEncodingDirection: 'j' }), /totalReadoutTime parameter/);
  assert.throws(() => acquisitionSidecar({ PhaseEncodingDirection: 'j', TotalReadoutTime: 0 }), /finite positive/);
  for (const invalid of [null, [], 'metadata', 1, false]) {
    assert.throws(() => acquisitionSidecar(invalid, { phaseEncodingDirection: 'j', totalReadoutTime: 0.05 }), /JSON object/);
  }
  assert.throws(() => acquisitionSidecar({ PhaseEncodingDirection: 'j', TotalReadoutTime: 0.05 }, { sliceToVolume: true }), /SliceTiming/);
});

test('split image, gradient and acquisition roles feed the existing reader and derivative provenance', async () => {
  const split = { ...inputs(), sidecar: [file('from_denoise.json', JSON.stringify({ PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.05, SliceTiming: [0, 0.01], EchoTime: 0.09 }))] };
  const files = await correctionFiles(split, {}, { totalReadoutTime: 0.08, multiband: 2 });
  const [series] = await readDiffusionSeries(files, { anonymizeSidecar: true });
  assert.equal(series.image.name, 'corrected_dwi.nii');
  assert.equal(await series.bval.text(), '0 1000');
  assert.equal(await series.bvec.text(), '0 1\n0 0\n0 0');
  assert.deepEqual(series.sidecar, { PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.08, SliceTiming: [0, 0.01], EchoTime: 0.09, MultibandAccelerationFactor: 2 });
  const description = describeSeries({ sidecar: series.sidecar, bvals: [0, 1000], dims: [2, 2, 2] });
  assert.equal(description.phaseEncodingDirection, 'j-');
  assert.equal(description.totalReadoutTime, 0.08);
  const derivative = preprocSidecar({ input: series.sidecar, settings: {}, args: [], field: 'none', seconds: 1, threads: 1, mask: 'test', version: 'test' });
  assert.equal(derivative.PhaseEncodingDirection, 'j-');
  assert.equal(derivative.TotalReadoutTime, 0.08);
  assert.deepEqual(derivative.SliceTiming, [0, 0.01]);
  assert.equal(derivative.DwicorrectSettings.MeanB0Threshold, 50);
});

test('explicit acquisition parameters work without a sidecar and preserve DICOM gradients', async () => {
  const split = { dwi: inputs().dwi };
  const files = await correctionFiles(split, { dwi: { sidecars: [file('scan.bval', '0'), file('scan.bvec', '0\n0\n0')] } }, { phaseEncodingDirection: 'i-', totalReadoutTime: 0.04 });
  const [series] = await readDiffusionSeries(files);
  assert.deepEqual(series.sidecar, { PhaseEncodingDirection: 'i-', TotalReadoutTime: 0.04 });
  assert.equal(await series.bval.text(), '0');
  assert.equal(await series.bvec.text(), '0\n0\n0');
});

test('corrected mean b0 includes only corrected frames at or below the declared threshold', () => {
  assert.deepEqual([...meanB0Data(new Float64Array([10, 20, 1000, 2000, 30, 40]), 2, 3, [0, 1000, 50])], [20, 30]);
  assert.throws(() => meanB0Data(new Float64Array([1, 2]), 1, 2, [1000, 2000]), /no volume/);
});

test('reverse and fieldmap roles retain their meanings under unrelated filenames', async () => {
  const split = {
    ...inputs(),
    sidecar: [file('acquisition.json', '{"PhaseEncodingDirection":"j-","TotalReadoutTime":0.05}')],
    reverse: [file('corrected_dwi.nii', 'reverse')],
    reverseSidecar: [file('another_step.json', '{"PhaseEncodingDirection":"j","TotalReadoutTime":0.05}')],
    fieldmap: [file('result.nii', 'hz')],
  };
  const series = await readDiffusionSeries(await correctionFiles(split));
  assert.deepEqual(series.map(entry => [entry.image.name, entry.sidecar?.PhaseEncodingDirection, Boolean(entry.bval)]), [
    ['corrected_dwi.nii', 'j-', true], ['reverse_corrected_dwi.nii', 'j', false], ['automation_fieldmap.nii', undefined, false],
  ]);
});
