import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dicomFile, dicomSeries, implicit, uint16 } from '../../../test-utils/dicom-fixture.mjs';
import { indexDicom, indexFiles, readRecord } from '../src/dicom-index.js';
import { seriesLabel, seriesSummary } from '../src/series-text.js';

const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
const toFile = ({ name, buffer }, path) => Object.assign(new File([buffer], name), { _webkitRelativePath: path ?? `scan/${name}` });

// Rewrites a DS value of the same length in place, e.g. EchoTime '20' to '30'.
function withValue(file, group, element, from, to) {
  const buffer = Buffer.from(file.buffer);
  const tag = Buffer.from([group & 0xff, group >> 8, element & 0xff, element >> 8]);
  const at = buffer.indexOf(Buffer.concat([tag, Buffer.from('DS')]));
  assert.equal(buffer.toString('latin1', at + 8, at + 8 + from.length), from);
  buffer.write(to, at + 8, 'latin1');
  return { ...file, buffer };
}

test('files group into series ordered by series number, their instances by instance number', async () => {
  const files = [...dicomSeries({ series: 7, slices: 3 }), ...dicomSeries({ series: 2, slices: 4 })].reverse().map((file) => toFile(file));
  const { series, skipped } = await indexFiles(files);
  assert.deepEqual(skipped, []);
  assert.deepEqual(series.map((entry) => entry.number), [2, 7]);
  assert.deepEqual(series[0].files.map((record) => record.instanceNumber), [1, 2, 3, 4]);
  assert.equal(series[0].files[0].path, 'scan/scan2_1.dcm');
  assert.equal(series[0].description, 'test_scan_2');
  assert.equal(series[0].protocolName, 'test_scan_2');
  assert.equal(series[0].modality, 'MR');
  assert.deepEqual([series[0].rows, series[0].cols], [16, 16]);
  assert.equal(series[0].summary.repetitionTime, 2000);
  assert.equal(series[0].summary.echoTime, 20);
  assert.equal(series[0].kind, 't1', 'TE 20 ms, TR 2000 ms reads as T1-weighted');
});

test('only the attributes that differ between instances vary; instance identifiers are left out', async () => {
  const files = dicomSeries({ series: 4, slices: 3 }).map((file) => toFile(file));
  const [series] = (await indexFiles(files)).series;
  assert.deepEqual([...series.varyingTags], [0x00200032], 'ImagePositionPatient');
  const echoes = dicomSeries({ series: 5, slices: 2 });
  echoes[1] = withValue(echoes[1], 0x0018, 0x0081, '20', '35');
  const [multiEcho] = (await indexFiles(echoes.map((file) => toFile(file)))).series;
  assert.ok(multiEcho.varyingTags.has(0x00180081));
  assert.equal(multiEcho.summary.echoTime, '20–35 (2 values)');
  assert.match(seriesSummary(multiEcho), /TE 20–35 \(2 values\)/);
});

test('a tag past where one prefix was cut is not reported as varying', () => {
  const [whole, other] = dicomSeries({ series: 6, slices: 2 });
  const cut = whole.buffer.indexOf(Buffer.from([0x28, 0x00, 0x30, 0x00]));
  const records = [
    readRecord(toFile(whole), 'a.dcm', arrayBuffer(whole.buffer.subarray(0, cut + 4))),
    readRecord(toFile(other), 'b.dcm', arrayBuffer(other.buffer)),
  ];
  assert.equal(records[0].complete, false);
  assert.equal(records[1].complete, true);
  const [series] = indexDicom(records).series;
  assert.equal(series.varyingTags.has(0x00280030), false, 'PixelSpacing is missing only from the cut prefix');
  assert.equal(series.varyingTags.has(0x00200032), true);
});

test('an Implicit VR file still yields its modality and protocol name', () => {
  const buffer = dicomFile('1.2.840.10008.1.2', [
    implicit(0x0008, 0x0060, 'MR'),
    implicit(0x0018, 0x1030, 't1_mpr '),
    implicit(0x0020, 0x000e, '1.2.3\0'),
    implicit(0x0028, 0x0010, uint16(64)),
  ]);
  const record = readRecord(new File([buffer], 'i.dcm'), 'i.dcm', arrayBuffer(buffer));
  assert.deepEqual([record.fields.modality, record.fields.protocolName, record.fields.seriesUid, record.fields.rows], ['MR', 't1_mpr', '1.2.3', 64]);
});

test('files that are not DICOM images are skipped with a reason', async () => {
  const notes = Object.assign(new File(['hello'], 'notes.txt'), { webkitRelativePath: 'scan/notes.txt' });
  const files = [...dicomSeries({ series: 1, slices: 1 }).map((file) => toFile(file)), notes];
  const { series, skipped } = await indexFiles(files);
  assert.equal(series.length, 1);
  assert.deepEqual(skipped, [{ path: 'scan/notes.txt', reason: 'not a DICOM file' }]);
});

test('indexing reports progress per batch and stops when cancelled', async () => {
  const files = dicomSeries({ series: 3, slices: 40 }).map((file) => toFile(file));
  const seen = [];
  await indexFiles(files, { onProgress: (done, total) => seen.push([done, total]) });
  assert.deepEqual(seen, [[32, 40], [40, 40]]);
  const controller = new AbortController();
  const cancelled = indexFiles(files, { signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(cancelled, { name: 'AbortError' });
});

test('the series list line names the series, modality and image count', async () => {
  const [series] = (await indexFiles(dicomSeries({ series: 9, slices: 4 }).map((file) => toFile(file)))).series;
  assert.equal(seriesLabel(series), '9 · test_scan_9 · MR · 4 images');
  assert.equal(seriesSummary(series), 'T1 · 16 × 16 · TR 2000 ms · TE 20 ms · slice 1 mm · 1 field varies');
});
