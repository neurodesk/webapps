// Regressions for the two confirmed security-review findings:
//  1. gzip decompression bomb -> bounded gunzip (CWE-409)
//  2. ReDoS in DICOM string trimming -> linear scan (CWE-1333)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { gunzip, MAX_DECOMPRESSED } from '../../web/js/readers/gzip.js';
import { readDicomHeader } from '../../web/js/readers/dicom.js';

test('gunzip rejects output larger than the cap (decompression bomb)', async () => {
  const raw = Buffer.alloc(50000, 0); // tiny gzip, inflates to 50000 bytes
  const gz = zlib.gzipSync(raw);
  const ab = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  await assert.rejects(gunzip(ab, 1000), /exceeds the size limit/);
  const out = await gunzip(ab, 1 << 20);
  assert.equal(out.byteLength, 50000);
});

test('gunzip default cap is generous but finite', () => {
  assert.ok(MAX_DECOMPRESSED >= 512 * 1024 * 1024 && MAX_DECOMPRESSED <= 2 * 1024 * 1024 * 1024);
});

test('DICOM string trimming does not ReDoS on a huge padded value', () => {
  // Explicit VR LE dataset with one UT element: many spaces then a non-space byte.
  const pad = 120000;
  const valueLen = pad + 1;
  const header = 132;   // 128 preamble + 'DICM'
  const elemHead = 12;  // group(2) element(2) VR(2) reserved(2) length(4)
  const buf = new ArrayBuffer(header + elemHead + valueLen);
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  b[128] = 0x44; b[129] = 0x49; b[130] = 0x43; b[131] = 0x4d; // DICM
  let off = header;
  dv.setUint16(off, 0x0009, true); dv.setUint16(off + 2, 0x0010, true); // private tag, group <= 0x0028
  b[off + 4] = 0x55; b[off + 5] = 0x54; // 'UT' (long VR)
  dv.setUint32(off + 8, valueLen, true);
  off += elemHead;
  for (let i = 0; i < pad; i++) b[off + i] = 0x20; // spaces
  b[off + pad] = 0x41; // 'X'

  const t0 = Date.now();
  const h = readDicomHeader(buf, 'evil.dcm');
  const dt = Date.now() - t0;
  assert.ok(h, 'header parsed');
  assert.ok(dt < 2000, `parse took ${dt}ms, expected < 2000ms (ReDoS regression)`);
});
