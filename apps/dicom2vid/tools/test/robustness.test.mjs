// Malformed inputs must fail with a clean error, never hang, OOM, or crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDicom, DicomError } from '../../web/js/readers/dicom.js';
import { readNifti, NiftiError } from '../../web/js/readers/nifti.js';
import { readMgz, MgzError } from '../../web/js/readers/mgz.js';

test('parseDicom rejects a too-small buffer', () => {
  assert.throws(() => parseDicom(new ArrayBuffer(10)), DicomError);
});

test('parseDicom rejects a DICM file with a compressed transfer syntax', () => {
  // Preamble + DICM, then a file-meta TransferSyntaxUID of JPEG Baseline.
  const buf = new ArrayBuffer(256);
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  b[128] = 0x44; b[129] = 0x49; b[130] = 0x43; b[131] = 0x4d; // DICM
  let off = 132;
  // (0002,0010) UI, len = 20, value = '1.2.840.10008.1.2.4.50'
  dv.setUint16(off, 0x0002, true); dv.setUint16(off + 2, 0x0010, true);
  b[off + 4] = 0x55; b[off + 5] = 0x49; // 'UI'
  const uid = '1.2.840.10008.1.2.4.50\0';
  dv.setUint16(off + 6, uid.length, true);
  for (let i = 0; i < uid.length; i++) b[off + 8 + i] = uid.charCodeAt(i);
  assert.throws(() => parseDicom(buf), /compressed|Unsupported/i);
});

test('readNifti rejects a non-NIfTI buffer', async () => {
  await assert.rejects(readNifti(new Uint8Array(400).fill(7).buffer), NiftiError);
});

test('readNifti rejects dims larger than the file (no OOM)', async () => {
  const buf = new ArrayBuffer(400);
  const dv = new DataView(buf);
  dv.setInt32(0, 348, true);          // sizeof_hdr
  dv.setInt16(40, 3, true);           // dim[0]
  dv.setInt16(42, 10000, true);       // huge nx
  dv.setInt16(44, 10000, true);       // huge ny
  dv.setInt16(46, 10000, true);       // huge nz
  dv.setInt16(70, 16, true);          // float32
  dv.setFloat32(108, 352, true);      // vox_offset
  dv.setUint8(344, 0x6e); dv.setUint8(345, 0x2b); dv.setUint8(346, 0x31); // n+1
  await assert.rejects(readNifti(buf), NiftiError);
});

test('readMgz rejects a garbage buffer', async () => {
  await assert.rejects(readMgz(new Uint8Array(400).fill(3).buffer), MgzError);
});
