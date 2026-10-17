import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadFiles } from '../src/series-text.js';

const series = { uid: '1.2.3', number: 2, description: 't1 mpr/tra (gk) v4', protocolName: 'ignored' };
const dcm2niix = (name) => new File(['nifti'], name, { type: 'application/octet-stream' });

test('downloads are named from the series, never from dcm2niix\'s folder and study time', async () => {
  const [{ image, sidecar }] = downloadFiles(series, [
    { image: dcm2niix('Doe_Jane_t1_mpr_tra_gk_v4_19940904084200_2.nii.gz'), sidecar: { EchoTime: 0.003 } },
  ], [series]);
  assert.equal(image.name, 'series2_t1_mpr_tra_gk_v4.nii.gz');
  assert.equal(await image.text(), 'nifti');
  assert.equal(sidecar.name, 'series2_t1_mpr_tra_gk_v4.json');
  assert.deepEqual(JSON.parse(await sidecar.text()), { EchoTime: 0.003 });
});

test('series that would share a name are kept apart in index order; a unique name stays as it is', () => {
  // These two UIDs share a six-digit FNV-1a prefix, so a hash suffix could not keep them apart.
  const first = { uid: '1.2.826.0.1.3680043.2.1125.741', number: 2, description: 'T1 MPR' };
  const second = { uid: '1.2.826.0.1.3680043.2.1125.18131', number: 2, description: 'T1 MPR' };
  const third = { uid: '1.2.826.0.1.3680043.2.1125.20240315.1', number: 2, description: 'T1 MPR' };
  const other = { uid: '1.2.3', number: 3, description: 'T1 MPR' };
  const all = [first, second, third, other];
  const name = (series) => downloadFiles(series, [{ image: dcm2niix('x.nii'), sidecar: {} }], all)[0];
  const files = all.map(name);
  assert.deepEqual(files.map(({ image }) => image.name), [
    'series2_T1_MPR.nii',
    'series2_T1_MPR_dup2.nii',
    'series2_T1_MPR_dup3.nii',
    'series3_T1_MPR.nii',
  ]);
  assert.equal(files[1].sidecar.name, 'series2_T1_MPR_dup2.json');
  assert.equal(name(second).image.name, files[1].image.name, 'stable across calls');
  for (const { image } of files) assert.doesNotMatch(image.name, /2024|1125/);
});

test('several images of a series are numbered, and one without a sidecar downloads alone', () => {
  const gre = { uid: '1.2.3', number: null, description: '', protocolName: 'GRE' };
  const files = downloadFiles(gre, [
    { image: dcm2niix('session_GRE_20240102_5_e1.nii'), sidecar: {} },
    { image: dcm2niix('session_GRE_20240102_5_e2.nii'), sidecar: null },
  ], [gre]);
  assert.deepEqual(files.map(({ image, sidecar }) => [image.name, sidecar?.name ?? null]), [
    ['series_GRE_1.nii', 'series_GRE_1.json'],
    ['series_GRE_2.nii', null],
  ]);
});
