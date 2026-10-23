import { test } from 'node:test';
import assert from 'node:assert/strict';
import dcmjsDictionary from 'dcmjs/dictionary';
import { parseDicomHeader } from '@neurodesk/mri2vid/readers/dicom.js';
import { arrayBuffer, dicomFile, explicit, implicit, item, uint16 } from '../../../test-utils/dicom-fixture.mjs';
import { createDictionary, filterRows, headerRows, rowsToCsv, sidecarRows } from '../src/header-rows.js';

const dictionary = createDictionary(dcmjsDictionary);

const explicitFile = dicomFile('1.2.840.10008.1.2.1', [
  explicit(0x0008, 0x0060, 'CS', 'MR'),
  explicit(0x0008, 0x1140, 'SQ', item(Buffer.concat([
    explicit(0x0008, 0x1150, 'UI', '1.2.840.10008.5.1.4.1.1.4'),
    explicit(0x0008, 0x1155, 'UI', '1.2.3'),
  ]))),
  explicit(0x0018, 0x0080, 'DS', '2300'),
  explicit(0x0029, 0x0010, 'LO', 'SIEMENS CSA HEADER'),
  explicit(0x0029, 0x1010, 'OB', Buffer.from([1, 2, 3, 4])),
  explicit(0x0029, 0x1099, 'OB', Buffer.from([5, 6])),
  explicit(0x7fe0, 0x0010, 'OW', Buffer.alloc(4)),
]);

async function rows(buffer, varying) {
  const header = await parseDicomHeader(arrayBuffer(buffer), { vrOf: dictionary.vrOf });
  return headerRows(header, dictionary, varying);
}

test('rows name public and private tags from the DICOM dictionary, file meta first', async () => {
  const all = await rows(explicitFile);
  assert.deepEqual(all[0], { tag: '(0002,0010)', keyword: 'TransferSyntaxUID', vr: 'UI', value: '1.2.840.10008.1.2.1', depth: 0, varies: false });
  const byTag = new Map(all.map((row) => [row.tag, row]));
  assert.equal(byTag.get('(0008,0060)').keyword, 'Modality');
  assert.equal(byTag.get('(0018,0080)').keyword, 'RepetitionTime');
  assert.equal(byTag.get('(0029,0010)').keyword, 'PrivateCreator');
  assert.equal(byTag.get('(0029,1010)').keyword, 'CSAImageHeaderInfo (SIEMENS CSA HEADER)');
  assert.equal(byTag.get('(0029,1010)').value, '4 bytes: 01 02 03 04');
  assert.equal(byTag.get('(0029,1099)').keyword, 'Private (SIEMENS CSA HEADER)', 'an unlisted private element keeps its creator');
  assert.equal(byTag.has('(7FE0,0010)'), false, 'pixel data is not a header row');
});

test('sequence items follow their sequence, indented and flagged with it', async () => {
  const all = await rows(explicitFile, new Set([0x00081140]));
  const start = all.findIndex((row) => row.tag === '(0008,1140)');
  assert.deepEqual(all.slice(start, start + 4).map(({ tag, keyword, value, depth, varies }) => [tag, keyword, value, depth, varies]), [
    ['(0008,1140)', 'ReferencedImageSequence', '1 item', 0, true],
    ['(FFFE,E000)', 'Item 1', '', 1, true],
    ['(0008,1150)', 'ReferencedSOPClassUID', '1.2.840.10008.5.1.4.1.1.4', 2, true],
    ['(0008,1155)', 'ReferencedSOPInstanceUID', '1.2.3', 2, true],
  ]);
  assert.equal(all.find((row) => row.tag === '(0008,0060)').varies, false);
});

test('Implicit VR values are read as the dictionary says, private creators included', async () => {
  const groupLength = Buffer.alloc(4);
  groupLength.writeUInt32LE(18);
  const implicitFile = dicomFile('1.2.840.10008.1.2', [
    implicit(0x0018, 0x0000, groupLength),
    implicit(0x0019, 0x0010, 'SIEMENS MR HEADER '),
    implicit(0x0019, 0x1015, Buffer.alloc(8)),
    implicit(0x0028, 0x0107, uint16(507)),
    implicit(0x0028, 0x1050, '210 '),
    implicit(0x00e1, 0x0010, 'ELSCINT1'),
    implicit(0x00e1, 0x1001, uint16(3)),
  ]);
  const byTag = new Map((await rows(implicitFile)).map((row) => [row.tag, row]));
  assert.deepEqual([byTag.get('(00E1,1001)').keyword, byTag.get('(00E1,1001)').value], ['DataDictionaryVersion (ELSCINT1)', '3'], 'upper-case private dictionary keys match');
  assert.deepEqual([byTag.get('(0028,0107)').vr, byTag.get('(0028,0107)').value], ['US', '507']);
  assert.equal(byTag.get('(0028,1050)').value, '210');
  assert.deepEqual([byTag.get('(0018,0000)').keyword, byTag.get('(0018,0000)').value], ['GroupLength', '18']);
  assert.equal(byTag.get('(0019,0010)').value, 'SIEMENS MR HEADER');
  assert.equal(byTag.get('(0019,1015)').keyword, 'Private (SIEMENS MR HEADER)');
});

test('the filter matches tag, keyword or value, and can keep only varying fields', async () => {
  const all = await rows(explicitFile, new Set([0x00180080]));
  const tags = (query, varyingOnly = false) => filterRows(all, { query, varyingOnly }).map((row) => row.tag);
  assert.deepEqual(tags('modality'), ['(0008,0060)']);
  assert.deepEqual(tags('00180080'), ['(0018,0080)']);
  assert.deepEqual(tags('(0018,0080)'), ['(0018,0080)']);
  assert.deepEqual(tags('0018,0080'), ['(0018,0080)']);
  assert.deepEqual(tags('2300'), ['(0018,0080)']);
  assert.deepEqual(tags('', true), ['(0018,0080)']);
  assert.equal(tags('').length, all.length);
});

test('rows export as CSV with quoted values and a sidecar becomes rows of its keys', () => {
  const sidecar = sidecarRows({ EchoTime: 0.00297, ImageType: ['ORIGINAL', 'PRIMARY'], SeriesDescription: 'T1, "sag"' });
  assert.deepEqual(sidecar.map((row) => [row.keyword, row.value]), [
    ['EchoTime', '0.00297'],
    ['ImageType', '["ORIGINAL","PRIMARY"]'],
    ['SeriesDescription', 'T1, "sag"'],
  ]);
  assert.equal(rowsToCsv(sidecar.slice(2)), 'tag,keyword,vr,value,depth,varies\n,SeriesDescription,,"T1, ""sag""",0,false\n');
});
