import assert from 'node:assert/strict';
import test from 'node:test';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { parseDicomHeader } from '../src/readers/dicom.js';

const LONG = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);

function explicit(group, element, vr, value) {
  let data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (data.length % 2) data = Buffer.concat([data, Buffer.from([vr === 'UI' ? 0 : 32])]);
  const undefinedLength = vr === 'SQ' && value.undefinedLength;
  const head = Buffer.alloc(LONG.has(vr) ? 12 : 8);
  head.writeUInt16LE(group);
  head.writeUInt16LE(element, 2);
  head.write(vr, 4);
  if (LONG.has(vr)) head.writeUInt32LE(undefinedLength ? 0xffffffff : data.length, 8);
  else head.writeUInt16LE(data.length, 6);
  return Buffer.concat([head, data]);
}

function implicit(group, element, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const head = Buffer.alloc(8);
  head.writeUInt16LE(group);
  head.writeUInt16LE(element, 2);
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}

function item(body, undefinedLength = false) {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0xfffe);
  head.writeUInt16LE(0xe000, 2);
  head.writeUInt32LE(undefinedLength ? 0xffffffff : body.length, 4);
  const end = Buffer.from([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]);
  return Buffer.concat([head, body, ...(undefinedLength ? [end] : [])]);
}

function undefinedSequence(items) {
  const end = Buffer.from([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
  return Object.assign(Buffer.concat([...items, end]), { undefinedLength: true });
}

function file(transferSyntax, body) {
  return Buffer.concat([
    Buffer.alloc(128),
    Buffer.from('DICM'),
    explicit(2, 0x10, 'UI', transferSyntax),
    ...body,
  ]);
}

const us = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test('the header holds every element before the pixel data, the file meta group and private groups included', () => {
  const [slice] = dicomSeries({ series: 3, slices: 1 });
  const header = parseDicomHeader(arrayBuffer(slice.buffer));
  assert.equal(header.complete, true);
  assert.equal(header.meta.get(0x00020010).str, '1.2.840.10008.1.2.1');
  assert.equal(header.map.get(0x0008103e).str, 'test_scan_3');
  assert.deepEqual(header.map.get(0x00280010).numbers, [16]);
  assert.equal(header.map.has(0x7fe00010), false, 'pixel data is never read');
});

test('nested sequences keep their items, whichever length encoding they use', () => {
  const nested = explicit(0x0040, 0xa730, 'SQ', undefinedSequence([
    item(explicit(0x0040, 0xa040, 'CS', 'TEXT'), true),
    item(Buffer.concat([
      explicit(0x0040, 0xa040, 'CS', 'CODE'),
      explicit(0x0040, 0xa730, 'SQ', item(explicit(0x0008, 0x0100, 'SH', '113000'))),
    ])),
  ]));
  const buffer = file('1.2.840.10008.1.2.1', [
    explicit(0x0008, 0x0060, 'CS', 'SR'),
    explicit(0x0029, 0x0010, 'LO', 'SIEMENS CSA HEADER'),
    explicit(0x0029, 0x1010, 'OB', Buffer.from([1, 2, 3, 4])),
    nested,
    explicit(0x0040, 0xa0b0, 'US', Buffer.concat([us(1), us(2)])),
  ]);
  const { map, complete } = parseDicomHeader(arrayBuffer(buffer));
  assert.equal(complete, false, 'a file without pixel data is never complete');
  assert.equal(map.get(0x00291010).bytes.length, 4);
  const [first, second] = map.get(0x0040a730).items;
  assert.equal(first.get(0x0040a040).str, 'TEXT');
  assert.equal(second.get(0x0040a730).items[0].get(0x00080100).str, '113000');
  assert.deepEqual(map.get(0x0040a0b0).numbers, [1, 2], 'parsing resumes after the sequence');
});

test('a compressed transfer syntax still yields its header, and a cut prefix is incomplete', () => {
  const pixels = Buffer.concat([
    Buffer.from([0xe0, 0x7f, 0x10, 0x00]),
    Buffer.from('OB'),
    Buffer.from([0, 0, 0xff, 0xff, 0xff, 0xff]),
  ]);
  const buffer = file('1.2.840.10008.1.2.4.70', [
    explicit(0x0008, 0x0060, 'CS', 'CT'),
    explicit(0x0020, 0x5000, 'AT', Buffer.from([0x20, 0x00, 0x32, 0x00])),
    explicit(0x0028, 0x0010, 'US', us(512)),
    pixels,
  ]);
  const whole = parseDicomHeader(arrayBuffer(buffer));
  assert.equal(whole.complete, true);
  assert.equal(whole.transferSyntax, '1.2.840.10008.1.2.4.70');
  assert.deepEqual(whole.map.get(0x00205000).numbers, [0x00200032]);
  const prefix = parseDicomHeader(arrayBuffer(buffer.subarray(0, buffer.length - pixels.length - 4)));
  assert.equal(prefix.complete, false);
  assert.equal(prefix.map.get(0x00080060).str, 'CT');
  assert.equal(prefix.map.has(0x00280010), false, 'a truncated element is left out, not misread');
});

test('Implicit VR elements take their VR from the dictionary the caller supplies', () => {
  const body = [
    implicit(0x0008, 0x0060, 'MR'),
    implicit(0x0018, 0x9117, item(implicit(0x0018, 0x9087, Buffer.from(new Float64Array([1000]).buffer)))),
    implicit(0x0028, 0x0010, us(64)),
    implicit(0x7fe0, 0x0010, Buffer.alloc(4)),
  ];
  const buffer = file('1.2.840.10008.1.2', body);
  const vrs = new Map([[0x00180087, 'DS'], [0x00189117, 'SQ'], [0x00189087, 'FD']]);
  const { map, implicitVR, complete } = parseDicomHeader(arrayBuffer(buffer), { vrOf: (tag) => vrs.get(tag) });
  assert.equal(implicitVR, true);
  assert.equal(complete, true);
  assert.deepEqual(map.get(0x00189117).items[0].get(0x00189087).numbers, [1000]);
  const unknown = parseDicomHeader(arrayBuffer(buffer)).map.get(0x00189117);
  assert.equal(unknown.vr, 'UN', 'without a dictionary a defined-length sequence stays opaque');
});
