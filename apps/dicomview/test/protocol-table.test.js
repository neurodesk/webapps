import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { acquisitionCaption, protocolRows, protocolTables } from '../src/protocol-table.js';

// The shape dicompare's analyze_dicom_files_for_ui returns for one acquisition.
const acquisition = {
  protocolName: 'acq-megre',
  totalFiles: 8,
  acquisitionFields: [
    { tag: '0018,0080', keyword: 'RepetitionTime', name: 'Repetition Time', value: 40 },
    { tag: '0008,0008', keyword: 'ImageType', value: ['ORIGINAL', 'PRIMARY'] },
  ],
  series: [
    { name: 'Series 1', fields: [{ keyword: 'EchoTime', value: 4.2 }, { keyword: 'ImageType', value: ['M'] }] },
    { name: 'Series 2', fields: [{ keyword: 'EchoTime', value: 8.4 }] },
  ],
};

test('constant fields come first, then each varying field with one value per series', () => {
  assert.deepEqual(protocolRows(acquisition), [
    { field: 'RepetitionTime', value: '40', varies: false },
    { field: 'ImageType', value: 'ORIGINAL\\PRIMARY', varies: false },
    { field: 'EchoTime', value: '4.2 / 8.4', varies: true },
    { field: 'ImageType', value: 'M / ', varies: true },
  ]);
  assert.equal(acquisitionCaption(acquisition), 'acq-megre · 2 series · 8 files');
  assert.equal(acquisitionCaption({ protocolName: 'acq-t1', totalFiles: 120 }), 'acq-t1 · 120 files');
});

test('each acquisition becomes a captioned table that marks varying rows', () => {
  const { document } = new JSDOM('').window;
  const [wrapper] = protocolTables([acquisition], document);
  const table = wrapper.querySelector('table.nd-data-table');
  assert.equal(table.caption.textContent, 'acq-megre · 2 series · 8 files');
  assert.equal(table.tBodies[0].rows.length, 4);
  assert.deepEqual([...table.querySelectorAll('tr[data-flag] td:first-child')].map((cell) => cell.textContent), ['EchoTime', 'ImageType']);
});
