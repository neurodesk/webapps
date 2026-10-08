import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { compare, summarize } from '../validation/reference.mjs';

const SIZE = 6;
const VOXELS = SIZE ** 3;
const SIDECAR = { EchoTime: 0.003 };

// A 6^3 NIfTI-1 on a 2 mm grid: datatype 2 (uint8) or 16 (float32), voxel i holding value(i).
function volume(value, { datatype = 16, edit = () => {} } = {}) {
  const size = datatype === 2 ? 1 : 4;
  const bytes = Buffer.alloc(352 + VOXELS * size);
  bytes.writeInt32LE(348, 0);
  [3, SIZE, SIZE, SIZE, 1].forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  for (const [offset, number] of [[70, datatype], [72, size * 8], [252, 1], [254, 1]]) bytes.writeInt16LE(number, offset);
  for (const [offset, number] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1], [280, 2], [292, -6], [300, 2], [308, -6], [320, 2], [324, -6]]) bytes.writeFloatLE(number, offset);
  bytes.write('n+1\0', 344, 'latin1');
  for (let i = 0; i < VOXELS; i += 1) {
    if (datatype === 2) bytes.writeUInt8(value(i), 352 + i);
    else bytes.writeFloatLE(value(i), 352 + 4 * i);
  }
  edit(bytes);
  return bytes;
}

const input = gzipSync(volume((i) => (i % 9) * 100));
const report = (edit = (r) => r) => Buffer.from(JSON.stringify(edit({
  cjv: 0.5,
  cnr: 1.7,
  snr_total: 6,
  efc_brain: 0.58,
  vol_gm_mm3: 600000,
  vol_wm_mm3: 490000,
  fber: -1,
  provenance: { software: 'niimath --qc', air_template: 'avg152T1.nii.gz', segmentation: 'brainchop mindmap-pve (GM/WM/CSF fractions, 24ch)' },
  bids_meta: SIDECAR,
})));

function downloads(change = {}) {
  return {
    'brain-mask.nii': change.mask ?? volume((i) => (i % 4 ? 1 : 0), { datatype: 2 }),
    'gm.nii': change.gm ?? volume((i) => ((i % 5) + 0.5) / 10),
    'labels.nii': change.labels ?? volume((i) => i % 7, { datatype: 2 }),
    'qc.json': change.qc ?? report(),
  };
}

const reference = summarize(downloads(), input);
// Each failing check as "<download> <kind>", e.g. "gm.nii voxel sum".
const KIND = / (lies|header|values|voxel sum|bytes|non-zero|has the|metrics|cjv|provenance|bids_meta)/;
const failing = (files) => compare('test', summarize(files, input), reference, 'browser', SIDECAR)
  .filter(([passed]) => !passed)
  .map(([, line]) => `${line.split(' ')[1]} ${line.match(KIND)[1]}`);

test('downloads identical to the reference pass every comparison', () => {
  assert.deepEqual(failing(downloads()), []);
});

test('scaling the tissue fractions fails their bytes and voxel sum, and the domain still holds', () => {
  assert.deepEqual(failing(downloads({ gm: volume((i) => (((i % 5) + 0.5) / 10) * 1.01) })), ['gm.nii voxel sum', 'gm.nii bytes']);
});

test('fractions outside 0..1 fail the domain', () => {
  assert.deepEqual(failing(downloads({ gm: volume((i) => ((i % 5) + 0.5) / 10 + (i === 0 ? 1 : 0)) })), ['gm.nii values', 'gm.nii voxel sum', 'gm.nii bytes']);
});

test('a relabelled voxel fails the label counts, voxel sum and bytes', () => {
  assert.deepEqual(failing(downloads({ labels: volume((i) => (i === 3 ? 4 : i % 7), { datatype: 2 }) })), ['labels.nii non-zero', 'labels.nii voxel sum', 'labels.nii bytes']);
});

test('a mask with a value other than 0 and 1 fails the domain', () => {
  const failures = failing(downloads({ mask: volume((i) => (i % 4 ? 1 : i === 0 ? 2 : 0), { datatype: 2 }) }));
  assert.deepEqual(failures, ['brain-mask.nii values', 'brain-mask.nii non-zero', 'brain-mask.nii voxel sum', 'brain-mask.nii bytes']);
});

test('a shifted grid fails the input-grid check, the header and the bytes', () => {
  const shifted = volume((i) => ((i % 5) + 0.5) / 10, { edit: (bytes) => bytes.writeFloatLE(-4, 292) });
  assert.deepEqual(failing(downloads({ gm: shifted })), ['gm.nii lies', 'gm.nii header', 'gm.nii bytes']);
});

test('a changed datatype with the same values fails the header and the bytes', () => {
  const bytes = volume((i) => (i % 4 ? 1 : 0), { datatype: 16 });
  assert.deepEqual(failing(downloads({ mask: bytes })), ['brain-mask.nii header', 'brain-mask.nii bytes']);
});

test('a metric differing in its last digit fails the metrics check', () => {
  assert.deepEqual(failing(downloads({ qc: report((r) => ({ ...r, cnr: 1.7000000000000002 })) })), ['qc.json metrics']);
});

test('a missing or extra metric fails, and a non-finite headline metric fails on its own', () => {
  assert.deepEqual(failing(downloads({ qc: report((r) => ({ ...r, extra: 1 })) })), ['qc.json has the']);
  const { cjv, ...rest } = JSON.parse(report().toString());
  assert.ok(cjv);
  assert.deepEqual(failing(downloads({ qc: Buffer.from(JSON.stringify(rest)) })), ['qc.json has the', 'qc.json metrics', 'qc.json cjv']);
});

test('other provenance or a missing sidecar fails', () => {
  const provenance = report((r) => ({ ...r, provenance: { ...r.provenance, segmentation: 'brainchop 16chan18cls' } }));
  assert.deepEqual(failing(downloads({ qc: provenance })), ['qc.json provenance']);
  assert.deepEqual(failing(downloads({ qc: report(({ bids_meta, ...r }) => r) })), ['qc.json bids_meta']);
});

test('a missing image fails', () => {
  const { 'gm.nii': gm, ...rest } = downloads();
  assert.ok(gm);
  assert.deepEqual(compare('test', summarize(rest, input), reference, 'browser', SIDECAR).filter(([passed]) => !passed).map(([, line]) => line), ['test gm.nii was written']);
});
