import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadFiles } from '../src/series-text.js';

const series = { number: 2, description: 't1 mpr/tra (gk) v4', protocolName: 'ignored' };
const dcm2niix = (name) => new File(['nifti'], name, { type: 'application/octet-stream' });

test('downloads are named from the series, never from dcm2niix\'s folder and study time', async () => {
  const [{ image, sidecar }] = downloadFiles(series, [
    { image: dcm2niix('Doe_Jane_t1_mpr_tra_gk_v4_19940904084200_2.nii.gz'), sidecar: { EchoTime: 0.003 } },
  ]);
  assert.equal(image.name, 'series2_t1_mpr_tra_gk_v4.nii.gz');
  assert.equal(await image.text(), 'nifti');
  assert.equal(sidecar.name, 'series2_t1_mpr_tra_gk_v4.json');
  assert.deepEqual(JSON.parse(await sidecar.text()), { EchoTime: 0.003 });
});

test('several images of a series are numbered, and one without a sidecar downloads alone', () => {
  const files = downloadFiles({ number: null, description: '', protocolName: 'GRE' }, [
    { image: dcm2niix('session_GRE_20240102_5_e1.nii'), sidecar: {} },
    { image: dcm2niix('session_GRE_20240102_5_e2.nii'), sidecar: null },
  ]);
  assert.deepEqual(files.map(({ image, sidecar }) => [image.name, sidecar?.name ?? null]), [
    ['series_GRE_1.nii', 'series_GRE_1.json'],
    ['series_GRE_2.nii', null],
  ]);
});
